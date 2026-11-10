# flex-mcp — durable OpenAI background-Responses ledger as an MCP server

Remote (Streamable HTTP) MCP server on Cloudflare Workers. When an agent —
not an orchestrator, not a human clicking a UI (there is none) — drives the
loop, this server is its memory and hands for `service_tier: "flex"`
background Responses: submit cheap async jobs, poll them, chain them via
`previous_response_id`, and audit the exact bytes of every submission.

**Start here:** [`docs/CLIENT_GUIDE.md`](docs/CLIENT_GUIDE.md) — setup,
the 8 tools, the core loop, chaining, spend control, and a worked example.
Written for agents; humans welcome.

## What it does

- **Submit** background Responses with curated params plus an `extras` bag
  for any other API field (`background` forced true, tier defaults to flex).
- **Track** every submission in a durable SQLite ledger: status, model,
  lineage, usage, error, and the exact request/response bytes (no creds).
- **Complete** via OpenAI webhooks with status self-heal on read — a
  delayed webhook never loses a completion.
- **Search** the ledger: status of `resp_123`? what chained off it? what
  failed today? how many tokens this week?

## Status

v1 deployed and wet-run verified end-to-end against live OpenAI
(submit → webhook completion → get → lineage → cancel/delete/usage;
88 tests green). Eight tools: `flex_submit`, `flex_status`,
`flex_children`, `flex_get`, `flex_list`, `flex_cancel`, `flex_delete`,
`flex_usage`.

## Docs

| Doc | Audience |
|---|---|
| `docs/CLIENT_GUIDE.md` | Agents using the tools (read this first) |
| `docs/REQUIREMENTS.md` | What v1 is and is not |
| `docs/ARCHITECTURE.md` | Worker/DO layout, flows, schema, invariants |
| `docs/TRANSPORT_DECISION.md` | Why bare SDK v2 (OMCP is a legacy-era client) |
| `docs/TESTING.md` | Test plan (12 items, all covered) |
| `docs/REUSE.md` | What was copied from flex-orchestrator (sibling project) |
| `docs/PLAN.md` | How v1 was built (historical) |
| `docs/PRIOR_ART.md` | Why nothing existing sufficed |
| `docs/DEPLOY_CHECK.md` | Live deployment verification record |

## Operators

Deploy: set the four required secrets (`OPENAI_API_KEY`,
`OPENAI_WEBHOOK_SECRET`, `MCP_HOST`, `HOOKS_HOST`) via
`wrangler secret put`, attach the two hostnames in the Cloudflare
Dashboard (**Access on the MCP host only** — never on the webhook host),
register `https://<hooks-host>/openai` in the OpenAI dashboard with the
four `response.*` events, then `wrangler deploy`.

## Public-repo hygiene

`wrangler.toml` is safe to publish: no hostnames, no IDs, no secrets.
All personal values (hostnames, API keys, account IDs) are **required
secrets** set via `wrangler secret put`, never `[vars]`, never dashboard
env vars.
