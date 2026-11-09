// Covers: TESTING §3 (signature behavior through HTTP) + §9 (webhook inbox
// via the alarm) and §12 (routing). Drives the worker dispatch on
// https://hooks.test and https://mcp.test; signs fixtures with
// `signWebhookPayload` using the test secret `whsec_test`.
import { env, exports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { LedgerDO } from "../../src/do/ledger-do.ts";
import { signWebhookPayload } from "../../src/lib/signature.ts";
import type { RecordSubmissionCommand } from "../../src/types.ts";

const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;
const HOOKS = "https://hooks.test";
const MCP = "https://mcp.test";
const WEBHOOK_SECRET = "whsec_test";
const WRONG_SECRET = "whsec_dGVzdA";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

async function seedSubmission(
  responseId: string,
): Promise<DurableObjectStub<LedgerDO>> {
  const stub = env.LEDGER_DO.get(
    env.LEDGER_DO.idFromName("ledger"),
  ) as DurableObjectStub<LedgerDO>;
  const nowMs = Date.now();
  const cmd: RecordSubmissionCommand = {
    response_id: responseId,
    client_request_id: `client-${responseId}`,
    status: "submitted",
    model: "gpt-test",
    previous_response_id: null,
    service_tier: "flex",
    store: true,
    request_bytes: new TextEncoder().encode('{"model":"gpt-test"}'),
    response_bytes: new TextEncoder().encode(
      `{"id":"${responseId}","status":"queued"}`,
    ),
    response_source: "submit",
    observed_at_ms: nowMs,
    usage: null,
    error_json: null,
    now_ms: nowMs,
  };
  await stub.recordSubmission(cmd);
  return stub;
}

async function driveAlarm(stub: DurableObjectStub<LedgerDO>): Promise<void> {
  await runInDurableObject(stub, async (instance: LedgerDO) => {
    await instance.alarm();
  });
}

function completedBody(responseId: string, eventId: string): string {
  return JSON.stringify({
    id: eventId,
    type: "response.completed",
    data: { id: responseId },
  });
}

async function postWebhook(
  body: string,
  opts: {
    secret?: string;
    timestampSec?: number;
    webhookId?: string;
  } = {},
): Promise<{ readonly res: Response; readonly webhookId: string }> {
  const webhookId = opts.webhookId ?? nextId("wh");
  const timestampSec = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const raw = new TextEncoder().encode(body);
  const signature = await signWebhookPayload(
    opts.secret ?? WEBHOOK_SECRET,
    webhookId,
    timestampSec,
    raw,
  );
  const res = await mainWorker.fetch(`${HOOKS}/openai`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestampSec),
      "webhook-signature": signature,
    },
    body: raw,
  });
  return { res, webhookId };
}

interface Receipt {
  readonly kind: "accepted" | "duplicate";
  readonly webhookId: string;
}

async function readReceipt(res: Response): Promise<Receipt> {
  return (await res.json()) as Receipt;
}

describe("webhook signature through HTTP (§3, §9)", () => {
  it("accepts a signed response.completed, stores the inbox row, and flips the submission terminal after the alarm", async () => {
    const responseId = nextId("resp");
    const stub = await seedSubmission(responseId);
    const body = completedBody(responseId, nextId("evt"));

    const { res, webhookId } = await postWebhook(body);
    expect(res.status).toBe(200);
    const receipt = await readReceipt(res);
    expect(receipt).toMatchObject({ kind: "accepted", webhookId });

    // Inbox row exists: redelivering the same webhook-id dedupes.
    const redelivery = await postWebhook(body, { webhookId });
    expect(redelivery.res.status).toBe(200);
    expect((await readReceipt(redelivery.res)).kind).toBe("duplicate");

    await driveAlarm(stub);

    const record = await stub.getSubmission(responseId);
    expect(record?.status).toBe("completed");
    expect(record?.response_source).toBe("webhook");
  });

  it("rejects a wrong-secret delivery and stores nothing", async () => {
    const responseId = nextId("resp");
    const stub = await seedSubmission(responseId);
    const body = completedBody(responseId, nextId("evt"));

    const { res, webhookId } = await postWebhook(body, {
      secret: WRONG_SECRET,
    });
    expect([401, 403]).toContain(res.status);

    await driveAlarm(stub);
    const record = await stub.getSubmission(responseId);
    expect(record?.status).toBe("submitted");

    // Nothing stored: the same webhook-id is still fresh for a valid retry.
    const retry = await postWebhook(body, { webhookId });
    expect(retry.res.status).toBe(200);
    expect((await readReceipt(retry.res)).kind).toBe("accepted");
  });

  it("rejects a stale timestamp (>300s) and stores nothing", async () => {
    const responseId = nextId("resp");
    const stub = await seedSubmission(responseId);
    const body = completedBody(responseId, nextId("evt"));
    const staleSec = Math.floor(Date.now() / 1000) - 600;

    const { res, webhookId } = await postWebhook(body, {
      timestampSec: staleSec,
    });
    expect([401, 403]).toContain(res.status);

    await driveAlarm(stub);
    const record = await stub.getSubmission(responseId);
    expect(record?.status).toBe("submitted");

    // Nothing stored: the same webhook-id is accepted with a fresh timestamp.
    const retry = await postWebhook(body, { webhookId });
    expect(retry.res.status).toBe(200);
    expect((await readReceipt(retry.res)).kind).toBe("accepted");
  });

  it("rejects an unknown event type with 400 and stores nothing", async () => {
    const responseId = nextId("resp");
    const stub = await seedSubmission(responseId);
    const body = JSON.stringify({
      id: nextId("evt"),
      type: "response.made_up",
      data: { id: responseId },
    });

    const { res, webhookId } = await postWebhook(body);
    expect(res.status).toBe(400);

    await driveAlarm(stub);
    const record = await stub.getSubmission(responseId);
    expect(record?.status).toBe("submitted");

    // Nothing stored: the same webhook-id is accepted for a subscribed event.
    const retry = await postWebhook(completedBody(responseId, nextId("evt")), {
      webhookId,
    });
    expect(retry.res.status).toBe(200);
    expect((await readReceipt(retry.res)).kind).toBe("accepted");
  });

  it("rejects malformed JSON with 400 and stores nothing", async () => {
    const responseId = nextId("resp");
    const stub = await seedSubmission(responseId);

    const { res, webhookId } = await postWebhook("{not valid json{{{");
    expect([400, 413]).toContain(res.status);

    await driveAlarm(stub);
    const record = await stub.getSubmission(responseId);
    expect(record?.status).toBe("submitted");

    // Nothing stored: the same webhook-id is accepted for a well-formed event.
    const retry = await postWebhook(completedBody(responseId, nextId("evt")), {
      webhookId,
    });
    expect(retry.res.status).toBe(200);
    expect((await readReceipt(retry.res)).kind).toBe("accepted");
  });
});

describe("routing (§12)", () => {
  it("returns 404 for a wrong host", async () => {
    const hooksRes = await mainWorker.fetch("https://wrong.test/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(hooksRes.status).toBe(404);

    const mcpRes = await mainWorker.fetch("https://wrong.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(mcpRes.status).toBe(404);
  });

  it("returns 405 for GET /mcp", async () => {
    const res = await mainWorker.fetch(`${MCP}/mcp`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("returns 405 for DELETE /mcp", async () => {
    const res = await mainWorker.fetch(`${MCP}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("returns 405 for GET /openai", async () => {
    const res = await mainWorker.fetch(`${HOOKS}/openai`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown paths on both hosts", async () => {
    const mcpRes = await mainWorker.fetch(`${MCP}/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(mcpRes.status).toBe(404);

    const hooksRes = await mainWorker.fetch(`${HOOKS}/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(hooksRes.status).toBe(404);
  });
});
