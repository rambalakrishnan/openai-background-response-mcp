/**
 * LedgerDO (`src/do/ledger-do.ts`) — singleton submissions-ledger + webhook-inbox Durable Object.
 *
 * Owns the `submissions` + `webhook_inbox` SQLite tables (see `src/db/schema.ts` and
 * docs/ARCHITECTURE.md §3–§4). All SQLite work delegates to the pure functions in
 * `src/db/ledger.ts`; this class only wraps mutating calls in `transactionSync`,
 * schedules alarms from persisted deadlines, and delivers due inbox rows.
 *
 * Invariants (docs/ARCHITECTURE.md §7):
 * 1. The ledger performs network I/O in exactly one place: alarm-time
 *    authoritative retrieval (`GET /responses/{id}`) after a status-only
 *    webhook event, always OUTSIDE `transactionSync`. All other OpenAI calls
 *    happen in the Worker, which hands exact bytes to these RPC methods.
 * 2. No I/O and no `await` inside `transactionSync`. Ever. Dates are computed before
 *    transactions; alarm delivery claims a row synchronously, fetches outside
 *    the transaction, then applies the observation in a second transaction.
 * 3. Exact bytes stored: request/response blobs persist verbatim (minus credentials,
 *    which never reach this class). Nothing is re-serialized or truncated.
 * 4. 1.5 MB artifact/row guards enforced on every write by `src/db/ledger.ts`.
 * 5. Alarm redelivery is single-shot: a due inbox row settles on first delivery.
 *    Only `SQLITE_FULL` (`StorageFullError`) is retried with exponential backoff;
 *    every other outcome settles the row (`delivered`, `duplicate`, `failed`).
 * 6. Idempotency: a duplicate `webhook_id` never rewrites inbox state, and an
 *    already-terminal submission observing the same state is a no-op. Otherwise the
 *    latest observation wins (`observed_at_ms` advances).
 */

import { DurableObject } from "cloudflare:workers";
import { LIST_PAGE_LIMIT_MAX, OPENAI_WEBHOOK_EVENT_TYPES } from "../constants.ts";
import {
  SUBMISSIONS_SUMMARY_COLUMNS,
  isSqliteFullError,
  migrateLedgerDoSchema,
  withSqlErrorMapping,
  type SchemaTransactionalStorage,
  type SubmissionRow,
  type SubmissionSummaryRow,
  type WebhookInboxRow,
  type WebhookInboxSummaryRow,
} from "../db/schema.ts";
import {
  cancelSubmission as dbCancelSubmission,
  deleteSubmission as dbDeleteSubmission,
  enqueueWebhook as dbEnqueueWebhook,
  getSubmissionBlobs as dbGetSubmissionBlobs,
  listChildren as dbListChildren,
  listDueDeliveries as dbListDueDeliveries,
  listSubmissions as dbListSubmissions,
  recordDeliveryResult as dbRecordDeliveryResult,
  recordObservation as dbRecordObservation,
  recordSubmission as dbRecordSubmission,
  usageSourceRows as dbUsageSourceRows,
} from "../db/ledger.ts";
import { now } from "../lib/clock.ts";
import { HttpError } from "../http.ts";
import { resolveEnvSecret, retrieveProviderResponse } from "../lib/openai.ts";
import type { ProviderResponseRetrieval } from "../lib/openai.ts";
import type {
  CancelOutcome,
  DeleteOutcome,
  EnqueueWebhookCommand,
  ListPage,
  OpenAIWebhookEventType,
  RecordObservationCommand,
  RecordSubmissionCommand,
  ResponseId,
  SubmissionRecord,
  SubmissionStatus,
  SubmissionSummary,
  TokenUsage,
  WebhookIngressReceipt,
} from "../types.ts";
import type {
  CancelSubmissionInput,
  ListChildrenOptions,
  ListSubmissionsOptions,
  RecordDeliveryResultInput,
  UsageSourceFilters,
  UsageSourceRow,
} from "../db/ledger.ts";

// ============================================================================
// Local projections + policy constants (delivery policy, not tunables)
// ============================================================================

/** Full-column projection for single-row `submissions` reads that need blobs. */
const SUBMISSIONS_FULL_COLUMNS =
  `${SUBMISSIONS_SUMMARY_COLUMNS}, request_blob, response_blob` as const;

/** Full-column projection for single-row `webhook_inbox` reads (raw payload). */
const WEBHOOK_INBOX_FULL_COLUMNS =
  "webhook_id, event_type, response_id, delivery_timestamp_sec, received_at_ms, status, delivery_attempts, next_attempt_at_ms, raw_body_blob, raw_body_bytes, row_bytes, last_error, created_at, updated_at" as const;

/** Terminal ledger statuses: refuse `flex_cancel`, allow `flex_delete`. */
const TERMINAL_STATUSES: readonly SubmissionStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "incomplete",
];

/** Webhook event type → terminal ledger status applied on delivery. */
const WEBHOOK_EVENT_STATUS: Record<OpenAIWebhookEventType, SubmissionStatus> = {
  "response.completed": "completed",
  "response.cancelled": "cancelled",
  "response.failed": "failed",
  "response.incomplete": "incomplete",
};

/**
 * Validated inbox row requiring authoritative retrieval: the claim phase
 * settled everything else. Carries the event-implied status as fallback.
 */
interface DeliveryClaim {
  readonly webhookId: string;
  readonly responseId: ResponseId;
  readonly impliedStatus: SubmissionStatus;
}
/** Base delay for inbox redelivery after `SQLITE_FULL` (2 seconds). */
const SQLITE_FULL_BACKOFF_BASE_MS = 2_000 as const;

/** Ceiling for the `SQLITE_FULL` redelivery backoff (5 minutes). */
const SQLITE_FULL_BACKOFF_MAX_MS = 300_000 as const;

/** Maximum length of a persisted, sanitized inbox `last_error` message. */
const INBOX_ERROR_MAX_CHARS = 500 as const;

// ============================================================================
// Pure validation + mapping helpers (no I/O)
// ============================================================================

function requireNonEmptyString(value: string, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${context}: expected a non-empty string`);
  }
  return value;
}

function assertSubmissionStatus(value: string, context: string): SubmissionStatus {
  switch (value) {
    case "submitted":
    case "queued":
    case "in_progress":
    case "completed":
    case "failed":
    case "cancelled":
    case "incomplete":
      return value;
    default:
      throw new Error(`Invalid ${context}: unsupported submission status ${JSON.stringify(value)}`);
  }
}

function assertResponseSource(value: string, context: string): RecordObservationCommand["response_source"] {
  if (value === "submit" || value === "poll" || value === "webhook") {
    return value;
  }
  throw new Error(`Invalid ${context}: unsupported response source ${JSON.stringify(value)}`);
}

function assertWebhookEventType(value: string, context: string): OpenAIWebhookEventType {
  if ((OPENAI_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)) {
    return value as OpenAIWebhookEventType;
  }
  throw new Error(`Invalid ${context}: unsupported webhook event type ${JSON.stringify(value)}`);
}

/** Copies stored blob bytes out of SQLite-managed memory (never aliases storage). */
function copyBytes(blob: ArrayBuffer | Uint8Array): Uint8Array {
  if (blob instanceof Uint8Array) {
    return Uint8Array.from(blob);
  }
  return new Uint8Array(blob);
}

/** Decodes `usage_json`; returns `null` for missing or malformed payloads. */
function decodeUsage(usageJson: string | null): TokenUsage | null {
  if (usageJson === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(usageJson) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const fields = [
    record.inputTokens,
    record.cachedInputTokens,
    record.outputTokens,
    record.reasoningTokens,
    record.totalTokens,
  ];
  if (
    !fields.every(
      (field): field is number => typeof field === "number" && Number.isFinite(field),
    )
  ) {
    return null;
  }
  return {
    inputTokens: record.inputTokens as number,
    cachedInputTokens: record.cachedInputTokens as number,
    outputTokens: record.outputTokens as number,
    reasoningTokens: record.reasoningTokens as number,
    totalTokens: record.totalTokens as number,
  };
}

function toSubmissionRecord(row: SubmissionRow): SubmissionRecord {
  if (row.service_tier !== "flex") {
    throw new Error(`Unsupported service_tier in ledger row: ${JSON.stringify(row.service_tier)}`);
  }
  return {
    response_id: row.response_id,
    client_request_id: row.client_request_id,
    status: assertSubmissionStatus(row.status, "submissions.status"),
    model: row.model ?? "",
    previous_response_id: row.previous_response_id,
    service_tier: "flex",
    store: row.store === 1,
    request_bytes: copyBytes(row.request_blob),
    response_bytes: row.response_blob === null ? null : copyBytes(row.response_blob),
    response_source:
      row.response_source === null
        ? null
        : assertResponseSource(row.response_source, "submissions.response_source"),
    observed_at_ms: row.observed_at_ms,
    usage: decodeUsage(row.usage_json),
    error_json: row.error_json,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

/** Single-line, length-bounded inbox error (no payloads, no headers). */
function sanitizeInboxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message.replace(/\s+/gu, " ").trim().slice(0, INBOX_ERROR_MAX_CHARS);
  return singleLine.length > 0 ? singleLine : "webhook_delivery_failed";
}

/** Exponential `SQLITE_FULL` redelivery backoff, capped at 5 minutes. */
function computeSqliteFullBackoffMs(deliveryAttempts: number): number {
  const shift = Math.min(Math.max(deliveryAttempts - 1, 0), 8);
  return Math.min(SQLITE_FULL_BACKOFF_BASE_MS * 2 ** shift, SQLITE_FULL_BACKOFF_MAX_MS);
}

// ============================================================================
// LedgerDO
// ============================================================================

export class LedgerDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateLedgerDoSchema(this.durableStorage());
      await this.scheduleAlarmForDueWork();
    });
  }

  /**
   * Persists a fresh submission: exact request bytes POSTed to `/v1/responses`
   * plus the exact submit-response bytes. Strict insert — a conflicting
   * `response_id` throws rather than merging.
   */
  async recordSubmission(command: RecordSubmissionCommand): Promise<SubmissionSummary> {
    requireNonEmptyString(command.response_id, "recordSubmission.response_id");
    assertSubmissionStatus(command.status, "recordSubmission.status");
    assertResponseSource(command.response_source, "recordSubmission.response_source");
    const storage = this.durableStorage();
    return storage.transactionSync(() => dbRecordSubmission(storage.sql, command));
  }

  /**
   * Records a later observation (Worker `poll` GET, or `cancel` outcome) over an
   * existing row. Latest observation wins; oversized bytes are recorded as an
   * explicit error while the row keeps its prior bytes (see `src/db/ledger.ts`).
   */
  async recordObservation(command: RecordObservationCommand): Promise<SubmissionSummary> {
    requireNonEmptyString(command.response_id, "recordObservation.response_id");
    assertSubmissionStatus(command.status, "recordObservation.status");
    assertResponseSource(command.response_source, "recordObservation.response_source");
    const storage = this.durableStorage();
    return storage.transactionSync(() => dbRecordObservation(storage.sql, command));
  }

  /** Fetches one full submission record (with blobs), or `null` when missing. */
  async getSubmission(responseId: ResponseId): Promise<SubmissionRecord | null> {
    requireNonEmptyString(responseId, "getSubmission.response_id");
    const storage = this.durableStorage();
    const row = withSqlErrorMapping(
      () =>
        storage.sql
          .exec<SubmissionRow>(
            `SELECT ${SUBMISSIONS_FULL_COLUMNS} FROM submissions WHERE response_id = ?`,
            responseId,
          )
          .toArray()[0] ?? null,
    );
    return row === null ? null : toSubmissionRecord(row);
  }

  /**
   * Fetches exact stored blobs for one submission (request always present,
   * response `null` until first observed), or `null` when the row is missing.
   */
  async getBlobs(responseId: ResponseId): Promise<{
    readonly request_bytes: Uint8Array;
    readonly response_bytes: Uint8Array | null;
  } | null> {
    requireNonEmptyString(responseId, "getBlobs.response_id");
    const storage = this.durableStorage();
    const pair = dbGetSubmissionBlobs(storage.sql, responseId);
    if (pair === null) {
      return null;
    }
    return {
      request_bytes: copyBytes(pair.request),
      response_bytes: pair.response === null ? null : copyBytes(pair.response),
    };
  }

  /** Newest-first page of blob-free submission summaries with cursor paging. */
  async listSubmissions(options?: ListSubmissionsOptions): Promise<ListPage<SubmissionSummary>> {
    return dbListSubmissions(this.durableStorage().sql, options);
  }

  /** Blob-free summaries with `previous_response_id = responseId`, newest first. */
  async listChildren(
    responseId: ResponseId,
    options?: ListChildrenOptions,
  ): Promise<ListPage<SubmissionSummary>> {
    requireNonEmptyString(responseId, "listChildren.response_id");
    return dbListChildren(this.durableStorage().sql, responseId, options);
  }

  /**
   * Records the Worker's provider-cancel outcome as terminal `cancelled`.
   * Refused unless the row exists and is in-flight; missing rows report
   * `missing` (the provider cancel POST itself happens in the Worker).
   */
  async cancelSubmission(input: CancelSubmissionInput): Promise<CancelOutcome> {
    requireNonEmptyString(input.response_id, "cancelSubmission.response_id");
    const storage = this.durableStorage();
    return storage.transactionSync(() => dbCancelSubmission(storage.sql, input));
  }

  /**
   * Deletes a row and its blobs. Refused while the row is in-flight; missing
   * rows report `missing`.
   */
  async deleteSubmission(responseId: ResponseId): Promise<DeleteOutcome> {
    requireNonEmptyString(responseId, "deleteSubmission.response_id");
    const storage = this.durableStorage();
    return storage.transactionSync(() => dbDeleteSubmission(storage.sql, responseId));
  }

  /**
   * Blob-free usage source rows for the Worker-side usage summarizer
   * (token sums group by day/model/status there; unknown pricing stays explicit).
   */
  async usageSource(filters?: UsageSourceFilters): Promise<readonly UsageSourceRow[]> {
    return dbUsageSourceRows(this.durableStorage().sql, filters);
  }

  /**
   * Durably enqueues one signature-verified webhook delivery. Idempotent on
   * `webhook_id`: a redelivered id returns `duplicate` without rewriting state.
   * The 200 ack follows only after this commit; the alarm delivers afterwards.
   */
  async enqueueWebhook(command: EnqueueWebhookCommand): Promise<WebhookIngressReceipt> {
    requireNonEmptyString(command.webhook_id, "enqueueWebhook.webhook_id");
    assertWebhookEventType(command.event_type, "enqueueWebhook.event_type");
    const storage = this.durableStorage();
    const iso = new Date(now()).toISOString();
    const receipt = storage.transactionSync(() =>
      dbEnqueueWebhook(storage.sql, command, iso),
    );
    await this.scheduleAlarmForDueWork();
    return receipt;
  }

  /**
   * Delivers every due inbox row to `submissions`, then reschedules from
   * persisted deadlines only. Backoff applies solely to `SQLITE_FULL`; every
   * other outcome settles its row in a single shot.
   */
  override async alarm(): Promise<void> {
    const observedAtMs = now();
    const observedIso = new Date(observedAtMs).toISOString();
    const attempted = new Set<string>();
    for (;;) {
      const due = dbListDueDeliveries(
        this.durableStorage().sql,
        observedAtMs,
        LIST_PAGE_LIMIT_MAX,
      ).filter((row) => !attempted.has(row.webhook_id));
      if (due.length === 0) {
        break;
      }
      for (const summary of due) {
        attempted.add(summary.webhook_id);
        await this.deliverInboxRow(summary, observedAtMs, observedIso);
      }
      if (due.length < LIST_PAGE_LIMIT_MAX) {
        break;
      }
    }
    await this.scheduleAlarmForDueWork();
  }

  // -- private ---------------------------------------------------------------

  private durableStorage(): SchemaTransactionalStorage {
    return this.ctx.storage as unknown as SchemaTransactionalStorage;
  }

  /** Schedules one alarm at the earliest persisted due deadline, if any. */
  private async scheduleAlarmForDueWork(): Promise<void> {
    const storage = this.durableStorage();
    const earliest = withSqlErrorMapping(() => {
      const row =
        storage.sql
          .exec<{ earliest_ms: number | null }>(
            `SELECT MIN(next_attempt_at_ms) AS earliest_ms
             FROM webhook_inbox
             WHERE status = 'pending' AND next_attempt_at_ms IS NOT NULL`,
          )
          .toArray()[0] ?? null;
      const value = row?.earliest_ms ?? null;
      return typeof value === "number" ? value : null;
    });
    if (earliest === null) {
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > earliest) {
      await this.ctx.storage.setAlarm(earliest);
    }
  }

  /**
   * Delivers one due inbox row in three phases: claim synchronously (validate
   * + settle no-op/failure cases), fetch the authoritative response envelope
   * OUTSIDE any transaction (webhook event payloads are status-only and carry
   * no output or usage), then apply the observation in a second transaction.
   * Latest observation wins. Retrieval failure keeps the event's status signal
   * but records the error and leaves the row retryable with backoff.
   */
  private async deliverInboxRow(
    summary: WebhookInboxSummaryRow,
    observedAtMs: number,
    observedIso: string,
  ): Promise<void> {
    const storage = this.durableStorage();
    let claim: DeliveryClaim | null = null;
    try {
      claim = withSqlErrorMapping(() =>
        storage.transactionSync(() => this.claimInboxRow(storage, summary, observedAtMs, observedIso)),
      );
    } catch (error: unknown) {
      this.settleDeliveryError(summary, observedAtMs, observedIso, error);
      return;
    }
    if (claim === null) {
      return;
    }
    let retrieval: ProviderResponseRetrieval;
    try {
      const apiKey = resolveEnvSecret(this.env, "OPENAI_API_KEY");
      retrieval = await retrieveProviderResponse({ apiKey, responseId: claim.responseId });
    } catch (error: unknown) {
      this.settleRetrievalFailure(claim, observedAtMs, observedIso, error);
      return;
    }
    try {
      withSqlErrorMapping(() =>
        storage.transactionSync(() =>
          this.applyRetrievedObservation(storage, claim, retrieval, observedAtMs, observedIso),
        ),
      );
    } catch (error: unknown) {
      this.settleDeliveryError(summary, observedAtMs, observedIso, error);
    }
  }

  /**
   * Synchronous claim phase: validates the inbox row and settles every case
   * that needs no retrieval (missing row, non-pending, missing response id,
   * no matching submission, stale same-state duplicate). Returns the claim
   * for rows that require authoritative retrieval, or null when settled.
   * MUST be called inside `transactionSync`; performs no I/O.
   */
  private claimInboxRow(
    storage: SchemaTransactionalStorage,
    summary: WebhookInboxSummaryRow,
    observedAtMs: number,
    observedIso: string,
  ): DeliveryClaim | null {
    const sql = storage.sql;
    const inbox =
      sql
        .exec<WebhookInboxRow>(
          `SELECT ${WEBHOOK_INBOX_FULL_COLUMNS} FROM webhook_inbox WHERE webhook_id = ?`,
          summary.webhook_id,
        )
        .toArray()[0] ?? null;
    if (inbox === null || inbox.status !== "pending") {
      return null;
    }
    const failed = (lastError: string): null => {
      const input: RecordDeliveryResultInput = {
        webhook_id: inbox.webhook_id,
        outcome: "failed",
        last_error: lastError,
        now_ms: observedAtMs,
        now_iso: observedIso,
      };
      dbRecordDeliveryResult(sql, input);
      return null;
    };
    if (inbox.response_id === null) {
      return failed("missing_response_id");
    }
    const responseId: ResponseId = inbox.response_id;
    const submission =
      sql
        .exec<SubmissionSummaryRow>(
          `SELECT ${SUBMISSIONS_SUMMARY_COLUMNS} FROM submissions WHERE response_id = ?`,
          responseId,
        )
        .toArray()[0] ?? null;
    if (submission === null) {
      return failed("no_matching_submission");
    }
    const implied =
      WEBHOOK_EVENT_STATUS[
        assertWebhookEventType(inbox.event_type, "webhook_inbox.event_type")
      ];
    const currentStatus = assertSubmissionStatus(
      submission.status,
      "submissions.status",
    );
    if (TERMINAL_STATUSES.includes(currentStatus) && currentStatus === implied) {
      const input: RecordDeliveryResultInput = {
        webhook_id: inbox.webhook_id,
        outcome: "duplicate",
        now_ms: observedAtMs,
        now_iso: observedIso,
      };
      dbRecordDeliveryResult(sql, input);
      return null;
    }
    return { webhookId: inbox.webhook_id, responseId, impliedStatus: implied };
  }

  /**
   * Synchronous apply phase: records the authoritatively retrieved envelope
   * as the observation and marks the inbox row delivered. A `still_running`
   * retrieval keeps the event's status signal (the event is newer evidence
   * than the GET) but stores the live bytes. MUST be called inside
   * `transactionSync`; performs no I/O.
   */
  private applyRetrievedObservation(
    storage: SchemaTransactionalStorage,
    claim: DeliveryClaim,
    retrieval: ProviderResponseRetrieval,
    observedAtMs: number,
    observedIso: string,
  ): void {
    const sql = storage.sql;
    if (retrieval.kind === "still_running") {
      const observation: RecordObservationCommand = {
        response_id: claim.responseId,
        status: claim.impliedStatus,
        response_bytes: new TextEncoder().encode(
          JSON.stringify({ id: retrieval.responseId, status: retrieval.status }),
        ),
        response_source: "webhook",
        observed_at_ms: observedAtMs,
        usage: null,
        error_json: JSON.stringify({
          code: "retrieval_still_running",
          message: "Authoritative GET returned a non-terminal state after the terminal webhook event; status follows the event",
        }),
        now_ms: observedAtMs,
      };
      dbRecordObservation(sql, observation);
    } else {
      const usage = retrieval.usage;
      const errorJson =
        retrieval.errorCode === null && retrieval.errorMessage === null
          ? null
          : JSON.stringify({ code: retrieval.errorCode, message: retrieval.errorMessage });
      const observation: RecordObservationCommand = {
        response_id: claim.responseId,
        status: retrieval.status,
        response_bytes: new Uint8Array(retrieval.rawResponseBytes),
        response_source: "webhook",
        observed_at_ms: observedAtMs,
        usage,
        error_json: errorJson,
        now_ms: observedAtMs,
      };
      dbRecordObservation(sql, observation);
    }
    const delivered: RecordDeliveryResultInput = {
      webhook_id: claim.webhookId,
      outcome: "delivered",
      now_ms: observedAtMs,
      now_iso: observedIso,
    };
    dbRecordDeliveryResult(sql, delivered);
  }

  /**
   * Settles an authoritative-retrieval failure. Permanent provider errors
   * (4xx: the response is gone or unreachable) apply the event's status
   * signal with the retrieval error recorded and settle the row as delivered
   * — retrying would never succeed. Transient failures (5xx, network) leave
   * the submission untouched and the inbox row retryable with backoff, so a
   * later alarm re-attempts the full envelope.
   */
  private settleRetrievalFailure(
    claim: DeliveryClaim,
    observedAtMs: number,
    observedIso: string,
    error: unknown,
  ): void {
    const storage = this.durableStorage();
    const permanent =
      error instanceof HttpError && error.status >= 400 && error.status < 500;
    try {
      withSqlErrorMapping(() =>
        storage.transactionSync(() => {
          if (permanent) {
            const observation: RecordObservationCommand = {
              response_id: claim.responseId,
              status: claim.impliedStatus,
              response_bytes: new TextEncoder().encode(
                JSON.stringify({ id: claim.responseId, status: claim.impliedStatus }),
              ),
              response_source: "webhook",
              observed_at_ms: observedAtMs,
              usage: null,
              error_json: JSON.stringify({
                code: "authoritative_retrieval_failed",
                message: error instanceof Error ? error.message : String(error),
              }),
              now_ms: observedAtMs,
            };
            dbRecordObservation(storage.sql, observation);
          }
          const input: RecordDeliveryResultInput = permanent
            ? {
                webhook_id: claim.webhookId,
                outcome: "delivered",
                now_ms: observedAtMs,
                now_iso: observedIso,
              }
            : {
                webhook_id: claim.webhookId,
                outcome: "retry",
                next_attempt_at_ms: observedAtMs + SQLITE_FULL_BACKOFF_BASE_MS,
                last_error: "authoritative_retrieval_failed",
                now_ms: observedAtMs,
                now_iso: observedIso,
              };
          dbRecordDeliveryResult(storage.sql, input);
        }),
      );
    } catch (nested: unknown) {
      this.settleDeliveryError(
        { webhook_id: claim.webhookId } as WebhookInboxSummaryRow,
        observedAtMs,
        observedIso,
        nested,
      );
    }
  }

  /**
   * Settles a delivery that threw: `SQLITE_FULL` gets a fresh backoff deadline,
   * everything else settles the row as `failed`. Runs outside the rolled-back
   * delivery transaction; if the settle write itself hits `SQLITE_FULL` the row
   * stays pending and a later alarm retries it (the alarm loop skips rows it
   * already attempted this run, so this never busy-loops).
   */
  private settleDeliveryError(
    summary: WebhookInboxSummaryRow,
    observedAtMs: number,
    observedIso: string,
    error: unknown,
  ): void {
    const storage = this.durableStorage();
    const retry = isSqliteFullError(error);
    const input: RecordDeliveryResultInput = retry
      ? {
          webhook_id: summary.webhook_id,
          outcome: "retry",
          next_attempt_at_ms:
            observedAtMs + computeSqliteFullBackoffMs(summary.delivery_attempts + 1),
          last_error: sanitizeInboxError(error),
          now_ms: observedAtMs,
          now_iso: observedIso,
        }
      : {
          webhook_id: summary.webhook_id,
          outcome: "failed",
          last_error: sanitizeInboxError(error),
          now_ms: observedAtMs,
          now_iso: observedIso,
        };
    try {
      dbRecordDeliveryResult(storage.sql, input);
    } catch {
      // Row keeps its prior pending state and remains due; a later alarm retries it.
    }
  }
}
