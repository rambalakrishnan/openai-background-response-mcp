/**
 * Worker entrypoint (`src/index.ts`) — host dispatch, `LedgerDO` export, fetch export.
 *
 * Routing contract (docs/ARCHITECTURE.md §2–§3, docs/TESTING.md §12):
 * - `env.MCP_HOST` serves only `POST /mcp` (bare-SDK Streamable HTTP handler,
 *   legacy-stateless default; DNS-rebinding guards in front). `GET`/`DELETE`
 *   (and any other non-POST) on `/mcp` is 405; every other path is 404.
 * - `env.HOOKS_HOST` serves only `POST /openai` via `handlers/webhook.ts`
 *   (verify-before-ack ingress); the handler itself answers 404 for other
 *   paths and 405 for non-POST.
 * - Every other host/path combination is 404. Hostnames are never hardcoded;
 *   callers compare against `env.MCP_HOST` / `env.HOOKS_HOST`.
 *
 * `LedgerDO` is re-exported (REQUIRED for workerd Durable Object
 * instantiation). The ledger never performs network I/O; all OpenAI calls
 * happen in the Worker via the MCP tool handlers.
 */

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { LedgerDO } from "./do/ledger-do.ts";
import { handleWebhookRequest } from "./handlers/webhook.ts";
import { createFlexServer } from "./lib/mcp.ts";
import { getRequestHostname, methodNotAllowed, notFound } from "./http.ts";

export { LedgerDO };

/** MCP Streamable HTTP pathname served exclusively on the configured `env.MCP_HOST`. */
const MCP_PATH = "/mcp" as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = getRequestHostname(request);
    const pathname = new URL(request.url).pathname;

    if (host === env.MCP_HOST) {
      if (pathname !== MCP_PATH) {
        return notFound();
      }
      if (request.method !== "POST") {
        // Covers GET/DELETE session operations (OMP's background GET listener
        // disables itself on 405) plus any other non-POST method.
        return methodNotAllowed(["POST"]);
      }
      // DNS-rebinding guards stay in front of the handler; the entry itself
      // performs no token verification (Access is edge-enforced, no code).
      // Synthetic miniflare SELF.fetch traffic carries no `Host` header, so
      // the host guard only runs when the signal is present — the URL-host
      // dispatch above already pinned the host in that case.
      const hostHeader = request.headers.get("host");
      const rejected =
        (hostHeader !== null
          ? hostHeaderValidationResponse(request, [env.MCP_HOST])
          : undefined) ?? originValidationResponse(request, [env.MCP_HOST]);
      if (rejected !== undefined) {
        return rejected;
      }
      // Stateless per-request handler: a fresh server from the sibling-owned
      // factory serves this single exchange (legacy-stateless default).
      const handler = createMcpHandler(() => createFlexServer(env));
      return handler.fetch(request);
    }

    if (host === env.HOOKS_HOST) {
      return handleWebhookRequest(request, env);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
