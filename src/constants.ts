/**
 * Guard, webhook, and platform-fixed limits for flex-mcp.
 *
 * Copied subset of `flex-orchestrator/src/constants.ts` (see `docs/REUSE.md`
 * row 5): artifact guards, platform limits, JSON body cap, page limits,
 * bind-chunk cap, webhook tolerance + event types + `/openai` path, and
 * block-concurrency/alarm/`waitUntil` platform constants. Everything else
 * from the orchestrator module (compatibility flags, file/branch sizes,
 * turn/retry budgets, polling, judge + model registry) is intentionally
 * omitted.
 */

/**
 * Project-enforced guard on every individual artifact BLOB/text field and every
 * resulting SQLite row (1,500,000 bytes).
 *
 * IMPORTANT: This is NOT the Cloudflare Durable Object SQLite hard ceiling
 * (which is 2 MB / 2,097,152 bytes). The 1,500,000-byte guard leaves ~500 KB of
 * headroom for bounded control metadata and diagnostics sharing the row.
 * Oversized artifacts must fail explicitly and never be silently truncated.
 */
export const ARTIFACT_ROW_GUARD_BYTES = 1_500_000 as const;

/** Alias for `ARTIFACT_ROW_GUARD_BYTES` used by schema and artifact validators. */
export const ARTIFACT_GUARD_BYTES = ARTIFACT_ROW_GUARD_BYTES;

/** Alias for `ARTIFACT_ROW_GUARD_BYTES` for row-level size budget checks. */
export const ROW_GUARD_BYTES = ARTIFACT_ROW_GUARD_BYTES;

/**
 * Platform-fixed Durable Object SQLite maximum string, BLOB, or row size (2 MB).
 * Documented for reference only; application logic must enforce `ARTIFACT_ROW_GUARD_BYTES`.
 */
export const PLATFORM_SQLITE_MAX_ROW_BYTES = 2_097_152 as const;

/**
 * Platform-fixed Durable Object isolate memory ceiling (128 MB shared across
 * all DO instances on the same isolate).
 */
export const PLATFORM_ISOLATE_MEMORY_BYTES = 134_217_728 as const;

/**
 * Default bounded JSON control-payload limit for ordinary API requests (262,144 bytes).
 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 262_144 as const;

/** Minimum page size for primary-key cursor pagination. */
export const LIST_PAGE_LIMIT_MIN = 1 as const;

/** Maximum page size for primary-key cursor pagination (omits BLOBs). */
export const LIST_PAGE_LIMIT_MAX = 100 as const;

/** Default page size for primary-key cursor pagination when unspecified. */
export const LIST_PAGE_LIMIT_DEFAULT = 50 as const;

/** Hard Durable Object SQLite limit on bound parameters per query. */
export const SQL_MAX_BOUND_PARAMS = 100 as const;

/**
 * Standard Webhooks delivery-timestamp tolerance in seconds (300 seconds / 5 minutes).
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300 as const;

/** OpenAI webhook event types subscribed to and handled by LedgerDO. */
export const OPENAI_WEBHOOK_EVENT_TYPES = [
  "response.completed",
  "response.cancelled",
  "response.failed",
  "response.incomplete",
] as const;
export type OpenAIWebhookEventType = (typeof OPENAI_WEBHOOK_EVENT_TYPES)[number];

/** Webhook endpoint pathname served exclusively on the configured `env.HOOKS_HOST`. */
export const WEBHOOK_OPENAI_PATH = "/openai" as const;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Maximum automatic retries performed by the
 * Cloudflare Durable Objects runtime when `alarm()` throws. There is no API
 * to raise or configure this budget; handlers must reschedule before exhausting it.
 */
export const PLATFORM_ALARM_MAX_RETRIES = 6 as const;

/** Alias for `PLATFORM_ALARM_MAX_RETRIES` (platform-fixed, non-tunable). */
export const ALARM_MAX_RETRIES = PLATFORM_ALARM_MAX_RETRIES;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Initial backoff delay in milliseconds (2 seconds)
 * used by Cloudflare Durable Objects when retrying a failed `alarm()` invocation.
 */
export const PLATFORM_ALARM_RETRY_BASE_DELAY_MS = 2_000 as const;

/** Alias for `PLATFORM_ALARM_RETRY_BASE_DELAY_MS` (platform-fixed, non-tunable). */
export const ALARM_RETRY_BASE_DELAY_MS = PLATFORM_ALARM_RETRY_BASE_DELAY_MS;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Hard 30-second timeout applied by the runtime
 * to `state.blockConcurrencyWhile()` callbacks. Exceeding this resets the Durable
 * Object. Slow migrations must be split rather than attempting to raise this value.
 */
export const PLATFORM_BLOCK_CONCURRENCY_TIMEOUT_MS = 30_000 as const;

/** Alias for `PLATFORM_BLOCK_CONCURRENCY_TIMEOUT_MS` (platform-fixed, non-tunable). */
export const MIGRATION_LOCK_TIMEOUT_MS = PLATFORM_BLOCK_CONCURRENCY_TIMEOUT_MS;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Maximum wall-clock execution time (15 minutes)
 * for a single Durable Object `alarm()` invocation.
 */
export const PLATFORM_ALARM_MAX_WALL_TIME_MS = 900_000 as const;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Maximum tail lifetime (30 seconds) for
 * `ctx.waitUntil()` after the HTTP response has been returned.
 */
export const PLATFORM_WAIT_UNTIL_MAX_TAIL_MS = 30_000 as const;
