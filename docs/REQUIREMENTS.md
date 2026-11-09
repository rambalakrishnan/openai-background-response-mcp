# flex-mcp requirements (draft 2 — 2026-11-09)

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

## Decisions (rounds 1–2)

- **Submit shape**: curated params + extras bag. First-class:
  `model`, `input` (message(s)), `reasoning`/`reasoning_effort`,
  `previous_response_id`, `service_tier` (default `"flex"`,
  client-overridable), `max_output_tokens`, `store` (default `true`,
  client-overridable), `metadata`, `tools`/`tool_choice`, plus
  `extras` object merged verbatim for any other Responses field.
  `background: true` is forced, never client-settable.
- **Ledger scope**: background Responses submitted via this MCP only.
- **Search**: targeted tools, not a DSL, not SQL.
- **Endpoint auth**: Cloudflare Access (same as orchestrator app host).
- **Submit semantics**: async only. Returns the response id immediately;
  never blocks for completion.
- **Retention**: agent deletes. No TTL janitor; `flex_delete` prunes
  terminal rows. Deleting an in-flight submission is refused (cancel
  first).
- **Cancel**: `flex_cancel` in v1.
- **Webhook path**: fixed `/openai`, orchestrator-style.
- **Usage**: record `usage` tokens from stored envelopes + a
  `flex_usage` summary tool (tokens / estimated spend by day, model,
  status; unknown pricing stays explicit).

## Placement (proposed: separate worker, recommended)

Reason to merge into flex-orchestrator: one webhook host/path to
operate (a hostname routes to exactly one Worker, so separate workers
need separate hooks hostnames) plus reuse of hardened code (signature
verification, artifact guards, OpenAI client).

Reasons to stay separate: blast radius (MCP iteration can't break
live orchestrator jobs or their timing-critical alarms, and vice
versa); auth evolution diverges (single-user app vs agent-facing MCP
may later want bearer/OAuth); a shared `/openai` must classify every
event as job-vs-ledger, where misrouting loses completions; no
migration coupling (orchestrator already at schema v4). The shared
code is small enough to copy. Recommendation: separate; accept the
second hooks hostname.

## Architecture

One Worker, one Durable Object class (`LEDGER_DO`, singleton):

- `POST /mcp` — Streamable HTTP MCP endpoint (behind Access).
- `POST /openai` on the hooks host — public OpenAI webhook receiver
  with signature verification (same pattern as flex-orchestrator's
  `lib/signature.ts`).
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

## Tools

| Tool | Input | Behavior |
|------|-------|----------|
| `flex_submit` | curated params + `extras` | Force `background:true`, default `service_tier:"flex"`, default `store:true`; POST to Responses; ledger row `submitted`; return `{response_id}` (or provider error verbatim). |
| `flex_status` | `response_id` | Ledger status + stored observation. If non-terminal, live-refresh via `GET /responses/{id}` and record the observation (cheap insurance, not a polling loop). |
| `flex_children` | `response_id` | Submissions whose `previous_response_id` equals it (lineage forward). |
| `flex_get` | `response_id`, `envelopes?` | Output text (+status/usage) by default; full stored request/response envelopes when `envelopes:true`. |
| `flex_list` | `status?`, `model?`, `limit`, `cursor` | Recent submissions, newest first. |
| `flex_cancel` | `response_id` | Cancel an in-flight response; record terminal `cancelled`. |
| `flex_delete` | `response_id` | Delete a terminal submission row + artifacts. Refused while in-flight. |
| `flex_usage` | `day?`, `model?`, `status?` | Tokens and estimated spend grouped by day/model/status. |

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
`MCP_HOST`, `HOOKS_HOST`. OpenAI API base
(`https://api.openai.com`) is public knowledge and hardcoded.
