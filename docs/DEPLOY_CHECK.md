# DEPLOY_CHECK.md — live verification 2026-11-09 22:03 UTC

Both custom domains resolved immediately (no propagation wait needed).

## Battery results (all pass)

| # | Probe | Expected | Got |
|---|-------|----------|-----|
| 1 | `GET /mcp` (MCP host) | 405 | 405 |
| 2 | `GET /nope` (MCP host) | 404 | 404 |
| 3 | `POST /mcp` initialize 2025-11-25 | 200 or 401/403-if-Access | **200** |
| 4 | `POST /openai` unsigned (hooks host) | 401/403 | 401 |
| 5 | `GET /` (hooks host) | 404 | 404 |
| 6 | `POST /mcp` tools/list | 8 flex_* tools | 8 tools served |
| 7 | `POST /mcp` tools/call flex_list | empty page JSON | `{"items":[],"next_cursor":null}` |

## Action required: Access not yet applied

Probe 3 returned 200, so Cloudflare Access is NOT yet protecting
`flex-mcp.5900209.xyz` — the MCP endpoint is publicly reachable right
now. Apply the self-hosted Access app + Allow policy (and service
token) per the deployment runbook before treating this as done.
The webhook host correctly requires no Access (signature auth
verified by probe 4's 401).
