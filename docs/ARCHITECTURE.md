# ARCHITECTURE.md — flex-mcp

## §1 — What this is

A remote MCP server on Cloudflare Workers giving an MCP client (agent)
durable custody of OpenAI **background** Responses with a **flex
default** service tier. The agent orchestrates; this server remembers
and acts. Eight tools: `flex_submit`, `flex_status`, `flex_children`,
`flex_get`, `flex_list`, `flex_cancel`, `flex_delete`, `flex_usage`.

Companion worker to `flex-orchestrator`, deliberately separate (see
REQUIREMENTS.md §Placement). Copies — never imports — hardened
orchestrator modules; the reuse manifest is `docs/REUSE.md`.

## §2 — Deployment diagram

```text
MCP client (agent) -> mcp.example.com/mcp, protected by Cloudflare Access
 |
 ▼
 Worker (stateless per-request MCP handler)
 +- POST /mcp: Streamable HTTP, Agents SDK createMcpHandler, zod tool schemas
 +- LEDGER_DO (singleton "ledger"): submissions ledger + webhook inbox
 |   +- SQLite: submissions, webhook_inbox, _sql_schema_migrations
 |   +- alarms: webhook redelivery backoff only (no polling loop)
 +- POST /openai on hooks host: public, signature-verified webhook ingress

OpenAI Responses API <-> Worker (submit POST, status GET, cancel POST)
OpenAI webhooks -> hooks.example.com/openai -> verify -> inbox -> ledger
```

Hostnames above are placeholders. Real values are required secrets
(`MCP_HOST`, `HOOKS_HOST`); `workers.dev` and preview URLs are
disabled.

## §3 — Request flows

### MCP tool call (agent → ledger)

```text
POST /mcp (Host: MCP_HOST, Access JWT)
 -> index.ts: host dispatch, Access is edge-enforced (no code)
 -> MCP handler (stateless, fresh server per request):
     initialize / tools/list / tools/call (+ legacy-stateless lane)
 -> tool handler in handlers/tools.ts:
     validate zod input -> LedgerDO stub ("ledger") RPC
 -> LedgerDO: SQLite read/write in transactionSync (no I/O inside)
 -> tool result content blocks (JSON text)
```

`flex_submit` and live-refresh `flex_status` perform OpenAI fetch calls
from the **Worker** (not inside any transaction): build request →
POST/GET OpenAI → persist exact bytes to the ledger. The ledger never
calls OpenAI; it only stores what the Worker hands it.

### Webhook completion (OpenAI → ledger)

```text
POST /openai (Host: HOOKS_HOST, public)
 -> index.ts: host dispatch
 -> handlers/webhook.ts: verify signature BEFORE ack (401/403 on failure)
 -> LedgerDO.enqueueWebhook: idempotent inbox insert (webhook_id dedupe)
 -> 200 ack immediately after durable enqueue
 -> LedgerDO alarm: claim row, fetch authoritative GET (outside txn), apply full envelope (backoff on SQLite-full or retrieval failure)
```

Same trap discipline as the orchestrator: verify-before-ack,
parse-once, await-enqueue-before-ack, no invented state, unknown
event types rejected, timestamp tolerance 300s.

## §4 — Ledger schema (v1)

`submissions`:

- `response_id TEXT PRIMARY KEY` — assigned by OpenAI at submit time
  (the POST response carries it, so no placeholder PK is needed).
- `client_request_id TEXT NOT NULL` — agent-supplied idempotency key.
- `status TEXT` — `submitted | queued | in_progress | completed |
  failed | cancelled | incomplete`. CHECK-constrained.
- `model TEXT`, `previous_response_id TEXT NULL`,
  `service_tier TEXT`, `store INTEGER 0/1`.
- `request_blob BLOB NOT NULL` — exact UTF-8 bytes POSTed to
  `/v1/responses` (no auth headers, ever).
- `response_blob BLOB NULL` — latest exact bytes observed (submit
  response, status GET, or webhook payload), with `response_source
  TEXT` (`submit | poll | webhook`) and `observed_at_ms`.
- `usage_json TEXT NULL` — latest usage object, for `flex_usage`.
- `error_json TEXT NULL` — provider error / incomplete details.
- `created_at_ms`, `updated_at_ms`; 1.5 MB artifact + row guards.

Indexes: `(status, updated_at_ms)`, `(previous_response_id)`,
`(created_at_ms)`, `(model, status)`.

`webhook_inbox`: copied router-inbox shape, `job_id` reworked to
`response_id` (nullable until matched). `response_routes` table is
NOT copied: `response_id` is the ledger PK, so no route map is needed.

## §5 — Tool contracts

- `flex_submit`: zod input `{model, input, reasoning?, reasoning_effort?,
  previous_response_id?, service_tier="flex", max_output_tokens?,
  store=true, metadata?, tools?, tool_choice?, extras?}`. Forbids
  `background` in `extras` (forced true). Builds canonical body →
  POST → persists request bytes + submit-response bytes →
  returns `{response_id, status}`. Provider errors returned verbatim
  (no row, or row with `failed`? — v1: no row; the submission never
  existed server-side).
- `flex_status`: ledger row; if non-terminal, Worker live-refreshes
  via `GET /responses/{id}` and records the observation, then returns
  `{response_id, status, model, usage?, error?, observed_at_ms,
  refreshed: boolean}`.
- `flex_children`: rows with `previous_response_id = id`, newest first.
- `flex_get`: `{response_id, envelopes=false}` → output text (+status,
  usage) extracted from the stored response envelope; `envelopes=true`
  → `{request, response}` raw JSON. Missing output text is explicit,
  never synthesized.
- `flex_list`: `{status?, model?, limit 1..100, cursor?}` newest-first
  page of summaries (no blobs).
- `flex_cancel`: refused unless in-flight (`submitted|queued|
  in_progress`); POST `/responses/{id}/cancel`; record terminal
  `cancelled` with observed bytes.
- `flex_delete`: refused while in-flight; deletes row + blobs.
- `flex_usage`: `{day?, model?, status?}` → token sums from
  `usage_json` grouped by day/model/status + estimated spend; unknown
  pricing explicit (no invented rates).

All tool results are `content: [{type: "text", text: <json>}]`.
Tool errors are MCP `isError` results with `{code, message}` — never
throws that collapse to 500s without context.

## §6 — Module map

```text
src/
  index.ts          host dispatch (MCP_HOST / HOOKS_HOST), fetch export
  env.d.ts          Env: LEDGER_DO, MCP_HOST, HOOKS_HOST, OPENAI_API_KEY,
                    OPENAI_WEBHOOK_SECRET (all secrets; no APP_HOST)
  constants.ts      guard/webhook/platform subset (copied, stripped)
  types.ts          ledger + wire types (fresh, RPC-safe)
  http.ts           bounded body/JSON/abort helpers (copied as-is)
  lib/
    guards.ts       artifact guards (copied as-is minus turn asserts)
    signature.ts    webhook HMAC verify (copied as-is)
    clock.ts        now/ms helpers (copied as-is)
    redaction.ts    secret scrubbing (copied as-is)
    openai.ts       Responses POST/GET/cancel (copied, stripped)
    mcp.ts          server factory: tool registrations, zod schemas
  db/
    schema.ts       DDL + _sql_schema_migrations runner (copied, stripped)
    ledger.ts       submissions + inbox ops (fresh, router.ts-shaped)
  handlers/
    tools.ts        MCP tool implementations (Worker-side OpenAI I/O)
    webhook.ts      verify-then-enqueue ingress (copied, rewired)
  do/
    ledger-do.ts    LedgerDO: RPC, alarm redelivery with authoritative GET (outside txn)
```

## §7 — Invariants

1. Sync Responses are refused: `background` is forced true; any
   client attempt to unset it is a validation error.
2. The ledger performs network I/O in exactly one place: alarm-time
   authoritative retrieval (`GET /responses/{id}`) after a status-only
   webhook event, always OUTSIDE `transactionSync` (claim → fetch →
   apply). All other OpenAI calls happen in the Worker.
3. No I/O or `await` inside `transactionSync`. Ever.
4. Exact bytes stored: request bodies and observed responses are
   persisted verbatim (minus credentials). Nothing is re-serialized,
   truncated, or summarized into the record.
5. No invented state: unknown webhook events rejected; unknown pricing
   explicit; missing output text explicit.
6. `wrangler.toml` is publish-safe: zero personal values; all four
   hostnames/keys are required secrets.
