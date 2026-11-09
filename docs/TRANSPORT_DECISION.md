# TRANSPORT_DECISION.md — bare official SDK v2 (decided 2026-11-09)

## Decision

`POST /mcp` is served by the official SDK v2 directly:
`@modelcontextprotocol/server` (`createMcpHandler` + `McpServer` +
`hostHeaderValidationResponse` + `originValidationResponse`) plus
`zod` for tool schemas. No `agents` framework, no FastMCP/ViteMCP, no
hand-rolled dispatcher.

## Why

- OMP — the primary and likely only client — is a **legacy-era**
  client: Streamable HTTP with `initialize` handshake at protocol
  `2025-11-25`, `Mcp-Session-Id` tracking, and a background GET SSE
  listener (see harness docs `mcp-protocol-transports.md`,
  `mcp-runtime-lifecycle.md`). A modern-only server breaks OMP. Any
  framework must serve the 2025-11-25 lane.
- Bare SDK v2 is the lightest thing that serves OMP: 2 deps, no
  framework wrapper, no Node adapter, front door stays ours (host
  dispatch + `/openai` remain first-party code in `index.ts`).
- Agents SDK (`createMcpHandler` from `agents/mcp/server`) is the
  documented fallback: same `McpServer.registerTool` API, so tool
  registrations transfer verbatim.
- FastMCP is legacy-native but frozen on the deprecated protocol
  against its author's guidance; ViteMCP defaults to the wrong era
  with a hedged transitional legacy lane and owns the front door
  (`export default server`). DIY for the legacy surface (sessions,
  handshake, GET streams, `Last-Event-ID` resumption) is far larger
  than modern-only DIY was.

## Scaffold gate — PASSED 2026-11-09

`test/gate.test.ts` (kept as a permanent protocol smoke test):
OMP's `initialize` at `2025-11-25` → `notifications/initialized` →
`tools/list` → `tools/call` all pass against bare SDK 2.4.0 in
miniflare; GET returns 405. No `nodejs_compat` flag required.

## References

- SDK v2 web-standard serving:
  https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard
- Streamable HTTP transport spec (2026-07-28):
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Cloudflare Agents `createMcpHandler` (fallback):
  https://developers.cloudflare.com/agents/api-reference/mcp-handler-api
- FastMCP legacy-only notice:
  https://jsr.io/@punkpeye/fastmcp/4.16.4/README.md
- ViteMCP current-spec framework (rejected):
  https://jsr.io/@vitemcp/server/1.9.2/README.md
