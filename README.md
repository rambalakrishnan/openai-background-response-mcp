# flex-mcp — durable OpenAI background-Responses ledger as an MCP server

Remote (Streamable HTTP) MCP server on Cloudflare Workers. When an agent —
not the orchestrator — drives the loop, this server is its memory and
hands for `service_tier: "flex"` background Responses:

- **Submit** a background Response with arbitrary flags/options.
- **Poll/status** any submission by response id.
- **Search** the ledger: status of `resp_123`? which submissions chained
  off it via `previous_response_id`? what failed this week?
- **Audit**: every submission stores the exact bytes sent to and received
  from the Responses API endpoint (minus credentials).

## Status

Requirements gathering. See `docs/REQUIREMENTS.md` (once drafted).

## Public-repo hygiene

`wrangler.toml` is safe to publish: no hostnames, no IDs, no secrets.
All personal values (hostnames, API keys, account IDs) are **required
secrets** set via `wrangler secret put`, never `[vars]`, never dashboard
env vars.
