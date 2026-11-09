/**
 * Environment bindings (`src/env.d.ts`).
 *
 * Single source of truth for the Worker `Env` contract derived from
 * `wrangler.toml` and runtime secrets. Merges into `Cloudflare.Env` and
 * declares the global `Env` interface so ambient references (`env: Env`,
 * `ExportedHandler<Env>`, and `DurableObject<Env>` / `Cloudflare.Env`)
 * resolve identically without drift.
 *
 * Notes:
 * - Every personal value is a required secret (`wrangler.toml [secrets]`):
 *   `MCP_HOST`, `HOOKS_HOST`, `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`.
 *   There is no `[vars]` block; this file and `wrangler.toml` are safe to
 *   publish.
 * - Secrets arrive as raw `string` bindings at the Worker boundary; never
 *   `CryptoKey`s (which must be imported inside handlers because Durable
 *   Objects evict in-memory state).
 * - There is deliberately no `APP_HOST` binding: MCP traffic is served only
 *   on `env.MCP_HOST` (`POST /mcp`) and webhook ingress only on
 *   `env.HOOKS_HOST` (`POST /openai`); every other host/path combination
 *   is a 404.
 */

declare namespace Cloudflare {
  interface Env {
    /** Singleton submissions-ledger + webhook-inbox SQLite Durable Object namespace (`LedgerDO`, id `"ledger"`). */
    readonly LEDGER_DO: DurableObjectNamespace;

    /** Public MCP hostname configured as a required secret (only `POST /mcp` is served on this host). */
    readonly MCP_HOST: string;

    /** Public webhook hostname configured as a required secret (only `POST /openai` is served on this host). */
    readonly HOOKS_HOST: string;

    /** OpenAI API key secret used for Responses create / retrieve / cancel operations. */
    readonly OPENAI_API_KEY: string;

    /** Standard Webhooks signing secret used to verify OpenAI webhook deliveries. */
    readonly OPENAI_WEBHOOK_SECRET: string;
  }
}

/**
 * Global `Env` binding contract shared across the Worker entrypoint
 * (`satisfies ExportedHandler<Env>`) and the `LedgerDO` class.
 */
interface Env extends Cloudflare.Env {}
