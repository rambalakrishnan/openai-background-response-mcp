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

## Follow-up: Access applied + wet-run verified

The probe-3 gap is closed: Cloudflare Access now protects the MCP host
(self-hosted app + account-members Allow + service-token Service Auth
policy; unauthenticated probes 302 to `cloudflareaccess.com`), and the
webhook host remains correctly public. A full wet-run battery against
live OpenAI then verified submit → webhook completion with authoritative
retrieval → get → lineage → cancel/delete/usage, including external
`previous_response_id` chaining (see `docs/CLIENT_GUIDE.md` for the
standing client contract this verified).
