# REUSE.md — orchestrator copy manifest

Reuse-not-share: flex-mcp copies these modules from
`flex-orchestrator` at build time and owns the copies. No imports
across repos, no shared packages. Copy order follows dependencies.

## Copy as-is

| # | Source | Provides | Notes |
|---|--------|----------|-------|
| 1 | `src/lib/clock.ts` | `now`, ms helpers | dep of signature |
| 2 | `src/lib/redaction.ts` | secret scrubbing | check exports at copy time |
| 3 | `src/http.ts` | bounded body/JSON/abort, error responses | optionally drop `streamResponse`, CF-metadata helpers; watch `clampPageLimit` name collision with guards |
| 4 | `src/lib/signature.ts` | webhook HMAC verify, timestamp check | no key caching, no re-serialization |

## Copy and strip

| # | Source | Keep | Strip |
|---|--------|------|-------|
| 5 | `src/constants.ts` | artifact guards, platform limits, JSON body cap, page limits, bind-chunk cap, webhook tolerance + event types + `/openai` path, block-concurrency/alarm/`waitUntil` platform constants | compatibility flags, file/branch sizes, turn index min, retention, continuation/retry budgets, capacity backoff, fallback poll, browser poll, all judge + model-registry sections |
| 6 | `src/lib/guards.ts` | `ArtifactGuardError`, byte measure, guarded blobs, artifact+row asserts, numeric page clamp, bind chunking | `assertTurnIndex`, branch/file size asserts |
| 7 | `src/db/schema.ts` | migration runner (`runSchemaMigrations`, `SchemaMigrationStep`, `skipIfPresent`), `_sql_schema_migrations` table, error mapping, webhook-inbox DDL, diagnostics helpers | JobDO + Registry DDL/rows/migrations; rework `response_routes` out (response_id is the PK); rework inbox `job_id` → `response_id` |
| 8 | `src/lib/openai.ts` | API root/timeout, secret resolution, `dispatchResponsesCreate`, `retrieveProviderResponse`, `cancelProviderResponse`, retry-after parsing | token counting, files upload/delete, model listing, chat completions, judge/pricing chains |
| 9 | `src/handlers/webhook.ts` | verify-before-ack ingress, verified-payload parse, rejection helper | rewire `ROUTER_DO` → `LEDGER_DO`; ledger event type |
| 10 | `src/db/router.ts` → `src/db/ledger.ts` | inbox ops (enqueue, list, due-deliveries, record-result), race-safe `transactionSync` patterns | rework to submissions domain; add submissions CRUD + lineage/list/usage queries (fresh) |

## Fresh (not copied)

- `src/types.ts` — ledger + wire types, RPC-safe.
- `src/lib/mcp.ts` — server factory, 8 tool registrations, zod schemas.
- `src/handlers/tools.ts` — tool implementations (Worker-side OpenAI I/O).
- `src/do/ledger-do.ts` — LedgerDO RPC + alarm redelivery.
- `src/index.ts`, `src/env.d.ts` — host dispatch, Env.
- `src/db/ledger.ts` submissions queries (shape follows router.ts).

## Skip entirely

Judge, tag, continuity, dispatch, alarm-scheduling, tokens, markdown,
views, jobs/tokens/files/health handlers, JobDO, RegistryDO, RouterDO.
