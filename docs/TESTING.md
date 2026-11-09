# TESTING.md — flex-mcp test plan

Toolchain mirrors the orchestrator: `vitest` +
`@cloudflare/vitest-pool-workers` (miniflare DO SQLite), `bun check`
for types. No live OpenAI calls in tests: fetch is mocked at the
`openai.ts` boundary; webhook tests use HMAC-signed fixtures.

## Unit (no DO)

1. **Submit body builder.** Curated params + extras merge; `background`
   forced true; `background` inside `extras` rejected; defaults
   (`service_tier:"flex"`, `store:true`) applied and overridable;
   `previous_response_id` passthrough. Cover: `handlers/tools.ts`
   builder (pure function, extracted for testability).
2. **Guards.** 1.5 MB request/response blobs accepted at the boundary,
   rejected above; row guard accounts metadata. Cover: `lib/guards.ts`
   (copied behavior, pinned).
3. **Signature verification.** Valid HMAC passes; wrong secret, stale
   timestamp (>300s), unknown event, and re-serialized body fail.
   Cover: `lib/signature.ts`, `handlers/webhook.ts` parse.
4. **Envelope extraction.** `flex_get` output-text extraction from
   stored envelopes: completed-with-text, completed-empty (explicit
   empty, not error), failed/incomplete (error surfaced), missing
   envelope (explicit not-found). Cover: `handlers/tools.ts`
   extractor.
5. **Usage aggregation.** Token sums group by day/model/status;
   missing usage rows skipped explicitly; unknown pricing yields
   `estimated_spend: null` with `pricing: "unknown"`, never a made-up
   rate. Cover: usage summarizer.

## DO integration (miniflare)

6. **Ledger CRUD + guards.** Submit persists request bytes; status
   refresh swaps response bytes + source + timestamp; oversized
   observation pauses... (no — v1 has no pause states; oversized
   observation is recorded as an explicit error, row keeps prior
   bytes). Cover: `db/ledger.ts`, `do/ledger-do.ts`.
7. **Lineage + list.** `flex_children` returns exact
   `previous_response_id` matches; `flex_list` filters, newest-first
   order, cursor pagination, limit clamp 1..100. Cover: query
   functions.
8. **Cancel/delete fences.** Cancel refused unless in-flight; delete
   refused while in-flight; delete removes row + blobs. Cover: RPC
   methods.
9. **Webhook inbox.** Signed `response.completed` → 200 → inbox row →
   alarm delivery updates submission to terminal with webhook bytes;
   duplicate `webhook_id` deduped; unknown event → 400, nothing
   stored; bad signature → 401/403, nothing stored. Cover:
   `handlers/webhook.ts`, inbox ops, alarm.
10. **Status self-heal.** Non-terminal row + `flex_status` with mocked
    completed GET → row becomes terminal with `response_source:
    "poll"`. Webhook arriving later for the same terminal state is a
    no-op (idempotent, keeps earliest terminal bytes? or latest?
    DECISION: latest observation wins, `observed_at_ms` advances —
    simpler, matches "latest exact bytes observed").

## MCP protocol

11. **Tool surface.** `tools/list` exposes exactly the 8 tools with
    valid input schemas; `tools/call` on each with a mocked ledger
    returns well-formed content blocks; unknown tool → MCP method
    error; malformed args → MCP validation error (`isError`, not a
    500). Cover via handler-level tests against the server factory.
12. **Routing.** Wrong host → 404; `/mcp` non-POST → 405; `/openai`
    non-POST → 405; unknown path → 404. Cover: `index.ts`.

## Manual (pre-deploy checklist)

- [ ] `wrangler deploy` to a dev worker; `tools/list` via MCP
      inspector through Access.
- [ ] Real `flex_submit` (cheap model) → webhook completes the row;
      `flex_get` returns text; `flex_usage` shows tokens.
- [ ] `wrangler.toml` contains no personal values; all four secrets
      set via `wrangler secret put`.
