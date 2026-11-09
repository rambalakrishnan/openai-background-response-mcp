# flex-mcp requirements (draft 1 — 2026-11-09)

## Goal

A remote MCP server on Cloudflare Workers that gives an MCP client
(agent) durable custody of OpenAI **background** Responses with a
**flex default** service tier. The agent orchestrates; this server
remembers and acts.

## Non-goals

- Sync (non-background) Responses: refused. Minimizes code surface.
- Files, Batch, Vector Stores, Fine-tune, Images, Audio: out of scope.
- Prompt engineering, judging, branching, exports: that is the
  orchestrator's job (`flex-orchestrator`).
- Polling fallback loop: not built unless webhooks prove unreliable
  (see Completion).

## Decisions (round 1)

- **Submit shape**: curated params + extras bag. First-class:
  `model`, `input` (message(s)), `reasoning`/`reasoning_effort`,
  `previous_response_id`, `service_tier` (default `"flex"`,
  client-overridable), `max_output_tokens`, `store`, `metadata`,
  `tools`/`tool_choice`(?), plus `extras` object merged verbatim for
  any other Responses field. `background: true` is forced, never
  client-settable.
- **Ledger scope**: background Responses submitted via this MCP only.
- **Search**: targeted tools, not a DSL, not SQL.
- **Endpoint auth**: Cloudflare Access (same as orchestrator app host).
- **Submit semantics**: async only. Returns the response id immediately;
  never blocks for completion.

## Architecture

One Worker, one Durable Object class (`LEDGER_DO`, singleton):

- `POST /mcp` — Streamable HTTP MCP endpoint (behind Access).
- `POST <webhook-path>` on a separate hostname — public OpenAI
  webhook receiver with signature verification (same pattern as
  flex-orchestrator's `lib/signature.ts`).
- DO SQLite ledger, one row per submission:
  - `response_id` (PK once known), client request id, status
    (`submitted` → `queued`/`in_progress` → `completed`/`failed`/
    `cancelled`/`incomplete`), model, `previous_response_id`,
    `service_tier`, timestamps.
  - Exact bytes sent (request body) and received (latest GET /
    webhook payload), minus credentials. Same 1.5 MB artifact
    guards as the orchestrator.
  - Indexes on `(status)`, `(previous_response_id)`,
    `(created_at)`.

## Tools (proposed)

| Tool | Input | Behavior |
|------|-------|----------|
| `flex_submit` | curated params + `extras` | Force `background:true`, default `service_tier:"flex"`; POST to Responses; ledger row `submitted`; return `{response_id}` (or provider error verbatim). |
| `flex_status` | `response_id` | Ledger status + stored observation. If non-terminal, live-refresh via `GET /responses/{id}` and record the observation (cheap insurance, not a polling loop). |
| `flex_children` | `response_id` | Submissions whose `previous_response_id` equals it (lineage forward). |
| `flex_get` | `response_id` | Full stored envelope and/or output text (round-2 Q). |
| `flex_list` | `status?`, `model?`, `limit`, `cursor` | Recent submissions, newest first. |
| `flex_cancel` | `response_id` | Cancel an in-flight response (round-2 Q). |

## Completion

- Primary: OpenAI webhook (`response.completed`, `response.failed`,
  `response.cancelled`, `response.incomplete`) → verify signature →
  durable inbox → ledger update. Same trap discipline as the
  orchestrator: verify-before-ack, idempotent delivery, no invented
  state.
- Agent-driven freshness: `flex_status` live-refreshes non-terminal
  rows on read, so a missing/delayed webhook self-heals the next
  time the agent asks.
- No alarm polling loop in v1. Revisit only with evidence of
  webhook gaps.
- "Streaming status": MCP notifications over Streamable HTTP exist
  but client support is uneven; v1 designs for agent polling of
  `flex_status`. A notifications layer is a possible v2, not a v1
  promise.

## Public-repo hygiene

`wrangler.toml` contains zero personal values: no hostnames, no IDs,
no keys. All personal values are **required secrets**
(`wrangler secret put`): `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`,
`MCP_HOST`, `HOOKS_HOST`, `WEBHOOK_PATH`(?). OpenAI API base
(`https://api.openai.com`) is public knowledge and hardcoded.

## Open questions (round 2)

1. Retention: keep submissions forever, or TTL + delete tool?
2. `flex_get` payload: full request/response envelopes, output text
   only, or both with a flag?
3. `flex_cancel`: include in v1?
4. Webhook path: fixed (`/openai`, orchestrator-style) or a secret
   path segment for obscurity?
5. `store` default: `true` (retrievable + countable) or agent's choice
   defaulting true?
6. Usage/cost accounting per submission: record `usage` tokens (cheap,
   ledger already stores the envelope) — and should any tool expose
   spend summaries?
