# flex-mcp Client Guide — for agents

Use these tools to run cheap OpenAI background jobs and keep a durable,
searchable record of every submission. There is no UI, no approval flow,
and no orchestrator in the loop: **you** decide what to submit, when to
check it, and what to do with the output.

## Setup (one minute, human does this once)

Add to the agent's MCP config (user scope — the token is personal):

```json
{ "mcpServers": { "flex-llm": {
  "type": "http",
  "url": "https://<mcp-host>/mcp",
  "headers": {
    "CF-Access-Client-Id": "${CF_MCP_CLIENT_ID}",
    "CF-Access-Client-Secret": "${CF_MCP_SECRET}"
  }
}}}
```

Then reload MCP and confirm 8 `flex_*` tools appear. If connection fails
with 404, the `/mcp` suffix is missing from the URL. If 401/403, the
service-token headers are wrong or missing.

## Core loop

1. **Submit** with `flex_submit`. Returns `{response_id, status}` immediately;
   the model runs in the background on the flex tier (cheapest, slowest —
   expect tens of seconds to minutes).
2. **Do other work.** Do not poll in a tight loop.
3. **Check** with `flex_status`. It live-refreshes in-flight rows, so the
   answer is always current. Repeat every 60–120s until terminal.
4. **Read** with `flex_get`. Default returns the output text; pass
   `envelopes: true` only when you need the raw request/response audit trail.

## The 8 tools

| Tool | Input | Returns | Fails with |
|---|---|---|---|
| `flex_submit` | `model`*, `input`* (string or message array), `reasoning`?, `reasoning_effort`?, `previous_response_id`?, `service_tier`? (default `flex`), `max_output_tokens`?, `store`? (default true), `metadata`?, `tools`?, `tool_choice`?, `extras`? (merged verbatim; `background` forbidden) | `{response_id, status}` | provider error verbatim; nothing stored |
| `flex_status` | `response_id` | `{response_id, status, model, usage, error, observed_at_ms, refreshed}` (`refreshed` = a new provider observation was just recorded; false on terminal rows, failed refreshes, and still-running polls) | `not_found` |
| `flex_children` | `response_id`, `cursor?`, `limit?` | newest-first page of submissions chained off this id (empty page, never an error, when none) | — |
| `flex_get` | `response_id`, `envelopes?` | output text + status + usage; or raw `{request, response}` JSON | `not_found` (no row, or row with no response bytes yet) |
| `flex_list` | `status?`, `model?`, `limit?` (1–100), `cursor?` | newest-first blob-free summaries | — |
| `flex_cancel` | `response_id` | `{response_id, status: "cancelled"}` | `not_found`; `refused` unless in-flight |
| `flex_delete` | `response_id` | `{response_id, deleted: true}` | `not_found`; `refused` while in-flight |
| `flex_usage` | `day?` (YYYY-MM-DD), `model?`, `status?` | token sums by day/model/status; `estimatedSpendUsd: null`, `pricingKnown: false` (pricing unknown — never estimated) | — |

Statuses: `submitted → queued → in_progress → completed | failed | cancelled | incomplete`. The first three are in-flight; the last four are terminal.

## Chaining (multi-turn work)

Pass `previous_response_id` to continue a conversation server-side: the
provider keeps the history, and the ledger indexes the edge so
`flex_children` walks it forward. The parent id does **not** need to
exist in the ledger — ids minted outside this tool (dashboard,
scripts, other agents) chain fine; the edge is recorded on the child.

## Rules that will save you

- **Background only.** Sync (foreground) requests are refused by design.
  Every submission is async; there is no wait flag.
- **Spend control is `max_output_tokens`.** Always set it on probes and
  drafts. Flex pricing is cheap, but an unbounded long-form request is not.
- **Completions arrive via webhook; your reads self-heal.** If a webhook
  is delayed, the next `flex_status` refreshes from the provider. Never
  assume `queued` is stuck until several minutes pass.
- **`incomplete` means the cap hit**, usually `max_output_tokens`.
  `flex_get` surfaces the error rather than partial text. Resubmit with a
  bigger cap (optionally chaining off the truncated response).
- **Cancel-then-delete.** In-flight rows refuse deletion; cancel first.
  There is no TTL janitor — prune finished work with `flex_delete` or
  the ledger grows forever.
- **Errors are data.** `not_found` / `refused` / provider errors arrive
  as structured results, never 500s. A failed `flex_submit` stores no row.
- **Envelopes contain no credentials.** Safe to paste into context, but
  large — prefer plain `flex_get` unless auditing.

## Worked example: draft → review → revise

```
// 1. Draft (cheap, capped)
flex_submit{model, input: "Draft a one-paragraph summary of X. Reply with the paragraph only.", max_output_tokens: 256}
// → {response_id: "resp_draft", status: "queued"}

// 2. ... do other work for a few minutes ...

// 3. Check
flex_status{response_id: "resp_draft"}
// → {status: "completed", usage: {...}, refreshed: true}

// 4. Read
flex_get{response_id: "resp_draft"}
// → {output_text: "...", ...}

// 5. Revise, chained (provider keeps the draft in context)
flex_submit{model, input: "Tighten that to one sentence.", previous_response_id: "resp_draft", max_output_tokens: 128}
// → {response_id: "resp_rev", ...}

// 6. Confirm lineage later
flex_children{response_id: "resp_draft"}
// → {items: [{response_id: "resp_rev", ...}]}
```

## Limits

- 1.5 MB per stored artifact and per ledger row (request/response bytes).
  Oversized observations are recorded as explicit errors, never truncated.
- Lists clamp to 1–100 items per page with opaque cursors.
- One ledger, shared across all clients of this deployment: coordinate
  `flex_delete` with teammates (there is no per-agent namespace).
