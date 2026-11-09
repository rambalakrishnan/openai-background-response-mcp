import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Gate test (TRANSPORT_DECISION.md): OMP's actual legacy handshake must work
// against the bare SDK handler. OMP initializes at protocol 2025-11-25,
// sends notifications/initialized, then tools/list. Its background GET
// listener must get a clean 405 (silently disables itself).

const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;
const BASE = "https://mcp.test";

async function postRpc(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return mainWorker.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
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

describe("scaffold gate: OMP legacy handshake", () => {
  it("answers initialize at 2025-11-25, initialized, and tools/list", async () => {
    const initRes = await postRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { roots: {} },
        clientInfo: { name: "omp-gate", version: "0.0.0" },
      },
    });
    expect(initRes.status).toBe(200);
    const initBody = await readRpc<{ result?: { protocolVersion?: string } }>(initRes);
    expect(initBody.result?.protocolVersion).toBeDefined();

    const notifiedRes = await postRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect([200, 202]).toContain(notifiedRes.status);

    const listRes = await postRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listRes.status).toBe(200);
    const listBody = await readRpc<{
      result?: { tools?: Array<{ name?: string }> };
    }>(listRes);
    expect(listBody.result?.tools?.map((t) => t.name)).toContain("ping");
  });

  it("rejects GET with 405 so OMP's background listener disables itself", async () => {
    const res = await mainWorker.fetch(`${BASE}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
  });

  it("calls the ping tool", async () => {
    const res = await postRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = await readRpc<{
      result?: { content?: Array<{ type?: string; text?: string }> };
    }>(res);
    expect(body.result?.content?.[0]?.text).toBe("pong");
  });
});
