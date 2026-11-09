/**
 * Ledger + RPC-safe wire types (`src/types.ts`).
 *
 * Fresh module (see `docs/REUSE.md`): plain interfaces and discriminated
 * unions only — no classes, no functions. Every type is safe across
 * `structuredClone` / Durable Object RPC (plain data, `Uint8Array` blobs,
 * `readonly` arrays; never `Date`, `Map`, or class instances).
 *
 * Naming follows the ledger schema (`docs/ARCHITECTURE.md` §4):
 * `snake_case` fields mirror SQLite columns; blobs are exact bytes.
 */

// ============================================================================
// 1. Identifiers & Primitives
// ============================================================================

/** OpenAI-assigned response identifier; primary key of `submissions`. */
export type ResponseId = string;

/** Agent-supplied idempotency key stored as `client_request_id`. */
export type ClientRequestId = string;

/** Signature-verified webhook delivery identifier; primary key of `webhook_inbox`. */
export type WebhookEventId = string;

/** Epoch milliseconds (fits safely in 52-bit JS number). */
export type EpochMs = number;

/** Epoch seconds (fits safely in 52-bit JS number). */
export type EpochSeconds = number;

// ============================================================================
// 2. Submission Status & Observation Source
// ============================================================================

/**
 * Ledger status (`docs/ARCHITECTURE.md` §4). CHECK-constrained in SQLite.
 */
export type SubmissionStatus =
  | "submitted"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

/** Statuses that refuse `flex_cancel` (already terminal). */
export type TerminalSubmissionStatus = "completed" | "failed" | "cancelled" | "incomplete";

/** Statuses that accept `flex_cancel` and refuse `flex_delete`. */
export type InFlightSubmissionStatus = "submitted" | "queued" | "in_progress";

/** Where the latest stored response bytes were observed. */
export type ResponseSource = "submit" | "poll" | "webhook";

/** Service tier for generation requests (always `"flex"` in background mode). */
export type ServiceTier = "flex";

/** OpenAI webhook event types the ledger accepts; anything else is rejected. */
export type OpenAIWebhookEventType =
  | "response.completed"
  | "response.cancelled"
  | "response.failed"
  | "response.incomplete";

// ============================================================================
// 3. Ledger Rows
// ============================================================================

/** Latest token usage object stored as `usage_json` (provider shape, camel-cased). */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

/**
 * One `submissions` row. `request_bytes` is the exact UTF-8 payload POSTed
 * to `/v1/responses` (no auth headers, ever); `response_bytes` is the latest
 * exact bytes observed (submit response, status GET, or webhook payload).
 */
export interface SubmissionRecord {
  readonly response_id: ResponseId;
  readonly client_request_id: ClientRequestId;
  readonly status: SubmissionStatus;
  readonly model: string;
  readonly previous_response_id: ResponseId | null;
  readonly service_tier: ServiceTier;
  readonly store: boolean;
  readonly request_bytes: Uint8Array;
  readonly response_bytes: Uint8Array | null;
  readonly response_source: ResponseSource | null;
  readonly observed_at_ms: EpochMs | null;
  readonly usage: TokenUsage | null;
  readonly error_json: string | null;
  readonly created_at_ms: EpochMs;
  readonly updated_at_ms: EpochMs;
}

/**
 * `webhook_inbox` summary (no blob). `response_id` stays `null` until the
 * delivery is matched against a ledger submission.
 */
export interface WebhookInboxRecord {
  readonly webhook_id: WebhookEventId;
  readonly event_type: OpenAIWebhookEventType;
  readonly response_id: ResponseId | null;
  readonly state: WebhookInboxState;
  readonly delivery_timestamp_sec: EpochSeconds;
  readonly received_at_ms: EpochMs;
  readonly delivery_attempts: number;
  readonly next_retry_at_ms: EpochMs | null;
  readonly raw_body_bytes: number;
  readonly row_bytes: number;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Inbox delivery lifecycle. */
export type WebhookInboxState = "pending" | "delivered" | "unmatched" | "duplicate";

/** Full inbox row including the exact verified payload bytes. */
export interface WebhookInboxRow extends WebhookInboxRecord {
  readonly raw_body: Uint8Array;
}

/**
 * Signature-verified webhook event handed from the ingress handler to
 * `LedgerDO.enqueueWebhook` (raw bytes verified before enqueue, never
 * re-serialized).
 */
export interface VerifiedWebhookEvent {
  readonly webhookId: WebhookEventId;
  readonly timestampSeconds: EpochSeconds;
  readonly eventType: OpenAIWebhookEventType;
  readonly responseId: ResponseId | null;
  readonly rawPayload: Uint8Array;
  readonly receivedAtMs: EpochMs;
}

// ============================================================================
// 4. Durable Object RPC Wire Contracts
// ============================================================================

/** Persists a fresh submission: exact request bytes + submit-response bytes. */
export interface RecordSubmissionCommand {
  readonly response_id: ResponseId;
  readonly client_request_id: ClientRequestId;
  readonly status: SubmissionStatus;
  readonly model: string;
  readonly previous_response_id: ResponseId | null;
  readonly service_tier: ServiceTier;
  readonly store: boolean;
  readonly request_bytes: Uint8Array;
  readonly response_bytes: Uint8Array;
  readonly response_source: ResponseSource;
  readonly observed_at_ms: EpochMs;
  readonly usage: TokenUsage | null;
  readonly error_json: string | null;
  readonly now_ms: EpochMs;
}

/** Records a later observation (status GET or webhook delivery) over a row. */
export interface RecordObservationCommand {
  readonly response_id: ResponseId;
  readonly status: SubmissionStatus;
  readonly response_bytes: Uint8Array;
  readonly response_source: ResponseSource;
  readonly observed_at_ms: EpochMs;
  readonly usage: TokenUsage | null;
  readonly error_json: string | null;
  readonly now_ms: EpochMs;
}

/** Idempotent inbox insert (`webhook_id` dedupe) for a verified delivery. */
export interface EnqueueWebhookCommand {
  readonly webhook_id: WebhookEventId;
  readonly event_type: OpenAIWebhookEventType;
  readonly response_id: ResponseId | null;
  readonly delivery_timestamp_sec: EpochSeconds;
  readonly received_at_ms: EpochMs;
  readonly raw_body: Uint8Array;
}

/** Receipt returned after durable enqueue (ack follows only on success). */
export type WebhookIngressReceipt =
  | { readonly kind: "accepted"; readonly webhookId: WebhookEventId }
  | { readonly kind: "duplicate"; readonly webhookId: WebhookEventId };

/** Outcome of a `flex_cancel` request against a ledger row. */
export type CancelOutcome =
  | { readonly kind: "cancelled"; readonly record: SubmissionRecord }
  | { readonly kind: "missing"; readonly responseId: ResponseId }
  | { readonly kind: "refused"; readonly responseId: ResponseId; readonly status: SubmissionStatus };

/** Outcome of a `flex_delete` request against a ledger row. */
export type DeleteOutcome =
  | { readonly kind: "deleted"; readonly responseId: ResponseId }
  | { readonly kind: "missing"; readonly responseId: ResponseId }
  | { readonly kind: "refused"; readonly responseId: ResponseId; readonly status: SubmissionStatus };

// ============================================================================
// 5. Tool Wire Contracts
// ============================================================================

/** Blob-free submission summary returned by `flex_list` pages. */
export interface SubmissionSummary {
  readonly response_id: ResponseId;
  readonly status: SubmissionStatus;
  readonly model: string;
  readonly previous_response_id: ResponseId | null;
  readonly observed_at_ms: EpochMs | null;
  readonly created_at_ms: EpochMs;
  readonly updated_at_ms: EpochMs;
}

/** Newest-first page; `next_cursor` is an opaque ledger cursor (`null` = end). */
export interface ListPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

/** `flex_submit` result. */
export interface SubmitResult {
  readonly response_id: ResponseId;
  readonly status: SubmissionStatus;
}

/** `flex_status` result (`refreshed` = Worker performed a live GET). */
export interface StatusResult {
  readonly response_id: ResponseId;
  readonly status: SubmissionStatus;
  readonly model: string;
  readonly usage: TokenUsage | null;
  readonly error_json: string | null;
  readonly observed_at_ms: EpochMs | null;
  readonly refreshed: boolean;
}

/**
 * `flex_get` result. `text` carries extracted output text (explicit `null`
 * when the envelope holds none — never synthesized); `envelopes` carries the
 * raw stored `{request, response}` JSON pair.
 */
export type FlexGetResult =
  | {
      readonly kind: "text";
      readonly response_id: ResponseId;
      readonly status: SubmissionStatus;
      readonly model: string;
      readonly output_text: string | null;
      readonly usage: TokenUsage | null;
    }
  | {
      readonly kind: "envelopes";
      readonly response_id: ResponseId;
      readonly request: unknown;
      readonly response: unknown;
    };

/** Token sums for one day/model/status group (`flex_usage`). */
export interface UsageGroup {
  readonly day: string;
  readonly model: string;
  readonly status: SubmissionStatus;
  readonly submissions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** `flex_usage` report; spend is `null` whenever pricing is unknown. */
export interface UsageReport {
  readonly groups: readonly UsageGroup[];
  readonly totalTokens: number;
  readonly estimatedSpendUsd: number | null;
  readonly pricingKnown: boolean;
}

/** MCP `isError` result payload (tools never throw context-free 500s). */
export interface ToolError {
  readonly code: string;
  readonly message: string;
}
