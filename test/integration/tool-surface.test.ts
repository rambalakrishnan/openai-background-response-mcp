// Covers TESTING.md §11 (tool surface: list/call surface, unknown-tool and
// malformed-args validation, per-tool happy paths) and §10 (status self-heal
// records `response_source: "poll"`) via the real Worker + LedgerDO.
// OpenAI network I/O is mocked by stubbing `globalThis.fetch` in this test
// worker (saved/restored per test); only `api.openai.com` URLs are
// intercepted, everything else passes through to the real fetch. Rows are
// seeded via the DO stub directly. Hostnames use the `mcp.test` test binding
// (see `vitest.config.ts`); no real hostname is hardcoded.
import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LedgerDO } from "../../src/do/ledger-do.ts";
import type {
  RecordObservationCommand,
  RecordSubmissionCommand,
  TokenUsage,
} from "../../src/types.ts";

const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;
const BASE = "https://mcp.test";

const EXPECTED_TOOLS = [
  "flex_submit",
  "flex_status",
  "flex_children",
  "flex_get",
  "flex_list",
  "flex_cancel",
  "flex_delete",
  "flex_usage",
] as const;

async function postRpc(body: unknown): Promise<Response> {
  return mainWorker.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function readRpc<T>(res: Response): Promise<T> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("data:"));
    if (dataLine === undefined) {
      throw new Error(`SSE response carried no data frame: ${text.slice(0, 200)}`);
    }
    return JSON.parse(dataLine.slice("data:".length).trim()) as T;
  }
  return JSON.parse(text) as T;
}

interface RpcEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

let rpcId = 1000;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: RpcEnvelope }> {
  const res = await postRpc({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return { status: res.status, body: await readRpc<RpcEnvelope>(res) };
}
/** Extracts the single JSON text block from a tool result; throws on JSON-RPC errors. */
function toolResult(body: RpcEnvelope): { readonly isError?: true; readonly text: string } {
  if (body.error !== undefined) {
    throw new Error(`expected a tool result, got JSON-RPC error: ${body.error.message ?? "?"}`);
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("expected a tool result envelope");
  }
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("expected at least one content block");
  }
  const first = content[0];
  if (typeof first !== "object" || first === null || !("text" in first)) {
    throw new Error("expected a JSON text block");
  }
  const text = first.text;
  if (typeof text !== "string") {
    throw new Error("expected a JSON text block");
  }
  const isError = "isError" in result && result.isError === true;
  return isError ? { isError: true, text } : { text };
}

/** Reads the JSON-RPC error from an envelope, or null when it is a tool result. */
function rpcError(body: RpcEnvelope): { readonly code?: number; readonly message?: string } | null {
  return body.error ?? null;
}

type Stub = DurableObjectStub<LedgerDO>;

function ledger(): Stub {
  return env.LEDGER_DO.get(env.LEDGER_DO.idFromName("ledger")) as Stub;
}

const NOW = 1_800_000_000_000;
const enc = new TextEncoder();

const USAGE: TokenUsage = {
  inputTokens: 100,
  cachedInputTokens: 10,
  outputTokens: 50,
  reasoningTokens: 20,
  totalTokens: 150,
};

function submitCmd(overrides: Partial<RecordSubmissionCommand> = {}): RecordSubmissionCommand {
  return {
    response_id: "resp_tool_1",
    client_request_id: "client-tool-1",
    status: "submitted",
    model: "gpt-5-mini",
    previous_response_id: null,
    service_tier: "flex",
    store: true,
    request_bytes: enc.encode('{"model":"gpt-5-mini"}'),
    response_bytes: enc.encode('{"id":"resp_tool_1","status":"queued"}'),
    response_source: "submit",
    observed_at_ms: NOW,
    usage: null,
    error_json: null,
    now_ms: NOW,
    ...overrides,
  };
}

function observeCmd(overrides: Partial<RecordObservationCommand> = {}): RecordObservationCommand {
  return {
    response_id: "resp_tool_1",
    status: "completed",
    response_bytes: enc.encode('{"id":"resp_tool_1","status":"completed","output_text":"done"}'),
    response_source: "poll",
    observed_at_ms: NOW + 1,
    usage: null,
    error_json: null,
    now_ms: NOW + 1,
    ...overrides,
  };
}

function completedEnvelope(id: string, text: string): string {
  return JSON.stringify({
    id,
    status: "completed",
    output_text: text,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// OpenAI fetch mock: stub `globalThis.fetch` in this test worker. Only
// `api.openai.com` URLs are intercepted; everything else passes through.
// ---------------------------------------------------------------------------

type OpenAiMock = (url: string, init: RequestInit) => Response | Promise<Response>;

let savedFetch: typeof fetch | null = null;
let openAiMock: OpenAiMock | null = null;
const openAiCalls: Array<{ readonly url: string; readonly method: string }> = [];

beforeEach(() => {
  openAiCalls.length = 0;
  openAiMock = null;
  savedFetch = globalThis.fetch;
  const passthrough = savedFetch;
  const stubFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.openai.com")) {
      openAiCalls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (openAiMock === null) {
        throw new Error(`Unexpected OpenAI fetch (no mock set): ${url}`);
      }
      return openAiMock(url, init ?? {});
    }
    return passthrough(input, init);
  };
  globalThis.fetch = stubFetch;
});

afterEach(async () => {
  if (savedFetch !== null) {
    globalThis.fetch = savedFetch;
  }
  savedFetch = null;
  openAiMock = null;
  await reset();
  await abortAllDurableObjects();
});

beforeAll(async () => {
  const initRes = await postRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "tool-surface", version: "0.0.0" },
    },
  });
  expect(initRes.status).toBe(200);
  await initRes.text();
  const notifiedRes = await postRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect([200, 202]).toContain(notifiedRes.status);
  await notifiedRes.text();
});

describe("tool surface (§11)", () => {
  it("lists exactly the eight flex_* tools with valid input schemas", async () => {
    const res = await postRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const body = await readRpc<{
      result?: {
        tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
      };
    }>(res);
    const tools = body.result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
      const schema = tool.inputSchema;
      if (typeof schema !== "object" || schema === null || !("type" in schema)) {
        throw new Error(`tool ${tool.name ?? "?"} is missing a valid inputSchema`);
      }
      expect(schema.type).toBe("object");
      if (!("properties" in schema)) {
        throw new Error(`tool ${tool.name ?? "?"} inputSchema has no properties`);
      }
      const properties = schema.properties;
      if (typeof properties !== "object" || properties === null) {
        throw new Error(`tool ${tool.name ?? "?"} inputSchema has no properties`);
      }
      expect(Object.keys(properties).length).toBeGreaterThan(0);
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const submitSchema = byName.get("flex_submit")?.inputSchema;
    if (typeof submitSchema !== "object" || submitSchema === null || !("properties" in submitSchema)) {
      throw new Error("flex_submit is missing a valid input schema");
    }
    const submitProperties = submitSchema.properties;
    if (typeof submitProperties !== "object" || submitProperties === null) {
      throw new Error("flex_submit is missing a valid input schema");
    }
    expect(Object.keys(submitProperties)).toEqual(
      expect.arrayContaining(["model", "input"]),
    );
    const submitRequired = "required" in submitSchema ? submitSchema.required : undefined;
    expect(submitRequired).toEqual(expect.arrayContaining(["model", "input"]));

    for (const name of ["flex_status", "flex_get", "flex_cancel", "flex_delete"] as const) {
      const schema = byName.get(name)?.inputSchema;
      if (typeof schema !== "object" || schema === null || !("properties" in schema)) {
        throw new Error(`${name} is missing a valid input schema`);
      }
      const properties = schema.properties;
      if (typeof properties !== "object" || properties === null) {
        throw new Error(`${name} is missing a valid input schema`);
      }
      expect(Object.keys(properties)).toContain("response_id");
    }
  });

  it("rejects an unknown tool with a JSON-RPC error (no 500)", async () => {
    const { status, body } = await callTool("flex_nope", {});
    expect(status).toBe(200);
    expect(status).not.toBe(500);
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toMatch(/not found/i);
  });

  it("rejects malformed args without a 500 (schema error; blank ids are isError)", async () => {
    // Missing `response_id` fails SDK schema validation → isError result.
    const missing = await callTool("flex_get", {});
    expect(missing.status).toBe(200);
    expect(missing.status).not.toBe(500);
    const missingResult = toolResult(missing.body);
    expect(missingResult.isError).toBe(true);
    expect(missingResult.text).toMatch(/invalid arguments/i);

    // A present-but-blank id passes the schema yet fails handler validation → isError.
    const blank = await callTool("flex_get", { response_id: "   " });
    expect(blank.status).toBe(200);
    expect(blank.status).not.toBe(500);
    const result = toolResult(blank.body);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.text) as { code?: string };
    expect(payload.code).toBe("invalid_args");
  });
});

describe("per-tool happy paths against the real DO (mocked OpenAI fetch)", () => {
  it("flex_submit persists a submitted row and returns its id", async () => {
    openAiMock = (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect((init.method ?? "POST").toUpperCase()).toBe("POST");
      return jsonResponse({ id: "resp_submit_1", status: "queued", model: "gpt-5-mini" });
    };

    const { status, body } = await callTool("flex_submit", {
      model: "gpt-5-mini",
      input: "hello from tool-surface",
    });
    expect(status).toBe(200);
    const result = toolResult(body);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.text) as { response_id?: string; status?: string };
    expect(payload.response_id).toBe("resp_submit_1");
    expect(payload.status).toBe("queued");

    const row = await ledger().getSubmission("resp_submit_1");
    expect(row?.status).toBe("queued");
    expect(row?.model).toBe("gpt-5-mini");
    expect(openAiCalls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("flex_status on non-terminal live-refreshes and records poll (§10 self-heal)", async () => {
    const stub = ledger();
    await stub.recordSubmission(
      submitCmd({
        response_id: "resp_heal_1",
        status: "in_progress",
        response_bytes: enc.encode('{"id":"resp_heal_1","status":"in_progress"}'),
      }),
    );
    const completed = completedEnvelope("resp_heal_1", "healed text");
    openAiMock = (url, init) => {
      expect((init.method ?? "GET").toUpperCase()).toBe("GET");
      expect(url).toContain("/responses/resp_heal_1");
      return jsonResponse(JSON.parse(completed) as unknown);
    };

    const { status, body } = await callTool("flex_status", { response_id: "resp_heal_1" });
    expect(status).toBe(200);
    const result = toolResult(body);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.text) as {
      status?: string;
      refreshed?: boolean;
      usage?: { totalTokens?: number } | null;
    };
    expect(payload.status).toBe("completed");
    expect(payload.refreshed).toBe(true);
    expect(payload.usage?.totalTokens).toBe(15);

    const row = await stub.getSubmission("resp_heal_1");
    expect(row?.status).toBe("completed");
    expect(row?.response_source).toBe("poll");
    expect(openAiCalls.length).toBeGreaterThan(0);
  });

  it("flex_status on terminal rows performs no fetch", async () => {
    const stub = ledger();
    await stub.recordSubmission(
      submitCmd({
        response_id: "resp_settled_1",
        status: "completed",
        response_bytes: enc.encode(completedEnvelope("resp_settled_1", "already done")),
        usage: USAGE,
      }),
    );
    openAiMock = () => {
      throw new Error("terminal flex_status must not fetch");
    };

    const { status, body } = await callTool("flex_status", { response_id: "resp_settled_1" });
    expect(status).toBe(200);
    const result = toolResult(body);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.text) as { status?: string; refreshed?: boolean };
    expect(payload.status).toBe("completed");
    expect(payload.refreshed).toBe(false);
    expect(openAiCalls).toHaveLength(0);
  });

  it("flex_children returns exact previous_response_id matches", async () => {
    const stub = ledger();
    await stub.recordSubmission(submitCmd({ response_id: "resp_parent_1" }));
    await stub.recordSubmission(
      submitCmd({
        response_id: "resp_child_1",
        previous_response_id: "resp_parent_1",
        now_ms: NOW + 1,
      }),
    );
    await stub.recordSubmission(submitCmd({ response_id: "resp_other_1", now_ms: NOW + 2 }));

    const { status, body } = await callTool("flex_children", { response_id: "resp_parent_1" });
    expect(status).toBe(200);
    const result = toolResult(body);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.text) as {
      items?: Array<{ response_id?: string }>;
      next_cursor?: string | null;
    };
    expect(payload.items?.map((item) => item.response_id)).toEqual(["resp_child_1"]);
    expect(payload.next_cursor).toBeNull();
  });

  it("flex_get extracts output text and raw envelopes", async () => {
    const stub = ledger();
    await stub.recordSubmission(submitCmd({ response_id: "resp_get_1" }));
    await stub.recordObservation(
      observeCmd({
        response_id: "resp_get_1",
        response_bytes: enc.encode(completedEnvelope("resp_get_1", "get me")),
        usage: USAGE,
      }),
    );

    const textCall = await callTool("flex_get", { response_id: "resp_get_1" });
    expect(textCall.status).toBe(200);
    const textResult = toolResult(textCall.body);
    expect(textResult.isError).toBeUndefined();
    const textPayload = JSON.parse(textResult.text) as {
      kind?: string;
      status?: string;
      output_text?: string | null;
      usage?: { totalTokens?: number } | null;
    };
    expect(textPayload.kind).toBe("text");
    expect(textPayload.status).toBe("completed");
    expect(textPayload.output_text).toBe("get me");
    expect(textPayload.usage?.totalTokens).toBe(150);

    const envCall = await callTool("flex_get", { response_id: "resp_get_1", envelopes: true });
    expect(envCall.status).toBe(200);
    const envResult = toolResult(envCall.body);
    expect(envResult.isError).toBeUndefined();
    const envPayload = JSON.parse(envResult.text) as {
      kind?: string;
      request?: unknown;
      response?: { id?: string };
    };
    expect(envPayload.kind).toBe("envelopes");
    expect(envPayload.response?.id).toBe("resp_get_1");
    expect(envPayload.request).toBeDefined();
  });

  it("flex_list pages newest-first with filters", async () => {
    const stub = ledger();
    await stub.recordSubmission(submitCmd({ response_id: "resp_list_a", model: "m1" }));
    await stub.recordSubmission(
      submitCmd({ response_id: "resp_list_b", model: "m2", now_ms: NOW + 1 }),
    );

    const all = await callTool("flex_list", {});
    expect(all.status).toBe(200);
    const allPayload = JSON.parse(toolResult(all.body).text) as {
      items?: Array<{ response_id?: string; model?: string }>;
      next_cursor?: string | null;
    };
    expect(allPayload.items?.map((item) => item.response_id)).toEqual([
      "resp_list_b",
      "resp_list_a",
    ]);

    const filtered = await callTool("flex_list", { model: "m1" });
    expect(filtered.status).toBe(200);
    const filteredPayload = JSON.parse(toolResult(filtered.body).text) as {
      items?: Array<{ response_id?: string }>;
    };
    expect(filteredPayload.items?.map((item) => item.response_id)).toEqual(["resp_list_a"]);
  });

  it("flex_cancel cancels an in-flight row via the provider", async () => {
    const stub = ledger();
    await stub.recordSubmission(
      submitCmd({ response_id: "resp_cancel_1", status: "in_progress" }),
    );
    openAiMock = (url, init) => {
      expect((init.method ?? "POST").toUpperCase()).toBe("POST");
      expect(url).toContain("/responses/resp_cancel_1/cancel");
      return jsonResponse({ id: "resp_cancel_1", status: "cancelled" });
    };

    const { status, body } = await callTool("flex_cancel", { response_id: "resp_cancel_1" });
    expect(status).toBe(200);
    const result = toolResult(body);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.text) as { response_id?: string; status?: string };
    expect(payload.response_id).toBe("resp_cancel_1");
    expect(payload.status).toBe("cancelled");

    const row = await stub.getSubmission("resp_cancel_1");
    expect(row?.status).toBe("cancelled");
    expect(openAiCalls).toHaveLength(1);
  });

  it("flex_delete removes a terminal row and its blobs", async () => {
    const stub = ledger();
    await stub.recordSubmission(
      submitCmd({
        response_id: "resp_delete_1",
        status: "completed",
        response_bytes: enc.encode(completedEnvelope("resp_delete_1", "bye")),
      }),
    );

    const { status, body } = await callTool("flex_delete", { response_id: "resp_delete_1" });
    expect(status).toBe(200);
    const result = toolResult(body);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.text) as { response_id?: string; deleted?: boolean };
    expect(payload.response_id).toBe("resp_delete_1");
    expect(payload.deleted).toBe(true);

    expect(await stub.getSubmission("resp_delete_1")).toBeNull();
    expect(await stub.getBlobs("resp_delete_1")).toBeNull();
  });

  it("flex_usage aggregates token sums with unknown pricing", async () => {
    const stub = ledger();
    await stub.recordSubmission(submitCmd({ response_id: "resp_use_1" }));
    await stub.recordObservation(
      observeCmd({ response_id: "resp_use_1", usage: USAGE }),
    );

    const { status, body } = await callTool("flex_usage", {});
    expect(status).toBe(200);
    const result = toolResult(body);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.text) as {
      groups?: Array<{ totalTokens?: number; submissions?: number }>;
      totalTokens?: number;
      estimatedSpendUsd?: number | null;
      pricingKnown?: boolean;
    };
    expect(payload.totalTokens).toBe(150);
    expect(payload.groups?.length).toBeGreaterThan(0);
    expect(payload.groups?.[0]?.totalTokens).toBe(150);
    expect(payload.pricingKnown).toBe(false);
    expect(payload.estimatedSpendUsd).toBeNull();
  });
});
