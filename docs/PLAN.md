# PLAN.md — flex-mcp build plan

## Phase 0 — Scaffold (integration owner, no delegation)

1. `bun init -y` in `flex-mcp/`; add `wrangler`, `typescript`,
   `@cloudflare/workers-types`, `vitest`,
   `@cloudflare/vitest-pool-workers` (dev), and the three pinned
   transport deps: `agents`, `@modelcontextprotocol/server@2.3.1`,
   `zod` (exact versions per installed Agents release docs).
2. Copy `tsconfig.json` + `vitest.config.ts` from the orchestrator;
   adapt miniflare bindings to the four flex-mcp secrets
   (`MCP_HOST`, `HOOKS_HOST`, `OPENAI_API_KEY`,
   `OPENAI_WEBHOOK_SECRET` as test values).
3. `.gitignore` (node_modules, .wrangler, .dev.vars).
4. Extend `wrangler.toml`: keep publish-safe shape; no `[vars]`.
5. Commit: `chore(scaffold): ...`.

## Phase 1 — Copied foundation (one batch, 6 subagents)

Shared context: ARCHITECTURE.md §6–§7 + REUSE.md + "validate with
LSP, never `bunx tsc`; strict TS, zero `any`, zero TODOs".

| Agent | Reads (orchestrator src + flex-mcp docs) | Writes |
|-------|------------------------------------------|--------|
| EnvTypes | REUSE.md, ARCHITECTURE §6 | `src/env.d.ts`, `src/types.ts` skeleton |
| Constants | `constants.ts`, REUSE.md row 5 | `src/constants.ts` (stripped subset) |
| HttpSig | `http.ts`, `lib/signature.ts`, `lib/clock.ts`, `lib/redaction.ts` | `src/http.ts`, `src/lib/signature.ts`, `src/lib/clock.ts`, `src/lib/redaction.ts` |
| Guards | `lib/guards.ts`, REUSE.md row 6 | `src/lib/guards.ts` (stripped) |
| Schema | `db/schema.ts`, ARCHITECTURE §4, REUSE.md row 7 | `src/db/schema.ts` (ledger DDL + runner) + mock-row DDL test script |
| OpenAI | `lib/openai.ts`, REUSE.md row 8 | `src/lib/openai.ts` (Responses-only) |

Owner then: LSP sweep, run DDL script, commit each file separately.

## Phase 2 — Ledger + DO (one batch, 2 subagents)

| Agent | Reads | Writes |
|-------|-------|--------|
| LedgerDb | `db/router.ts`, `db/schema.ts` (new), TESTING §6–8 | `src/db/ledger.ts` (submissions CRUD, lineage, list, usage-source query, inbox ops) |
| LedgerDO | `db/ledger.ts` (fresh), ARCHITECTURE §3 | `src/do/ledger-do.ts` (RPC, alarm redelivery, constructor migration) |

Owner: DO integration tests (§6–10) — write or delegate as one slice;
LSP; commit separately.

## Phase 3 — MCP + webhook ingress (one batch, 2 subagents)

| Agent | Reads | Writes |
|-------|-------|--------|
| McpSurface | bare `@modelcontextprotocol/server` v2 docs (see TRANSPORT_DECISION.md), ARCHITECTURE §5, TESTING §11 | `src/lib/mcp.ts` (factory + 8 zod schemas), `src/handlers/tools.ts` (implementations; pure builder + extractor for TESTING §1/§4) |
| Webhook | `handlers/webhook.ts`, REUSE.md row 9, TESTING §9 | `src/handlers/webhook.ts` (rewired), `src/index.ts` (host dispatch per TESTING §12) |

Owner: protocol + routing tests (§11–12), full suite, manual
checklist, commit separately.

## Phase 4 — Harden + deploy

- Full `npm test` green, LSP clean, no `any`/TODO.
- `wrangler deploy` (dev) + manual checklist from TESTING.md.
- Usage summarizer review: confirm no invented pricing.
- Tag `v1`, push, done.

## Delegation rules (all phases)

- One owner file per agent; shared contracts (`types.ts`, schema
  column names, RPC method names) frozen in ARCHITECTURE.md before
  batch dispatch — agents never negotiate interfaces mid-flight.
- Agents copy from the orchestrator tree read-only; they never edit it.
- Owner runs all tests + commits; agents never commit or push.
