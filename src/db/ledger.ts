/**
 * LedgerDB (`src/db/ledger.ts`) — pure SQLite operations for `submissions` + `webhook_inbox`.
 *
 * Every export is a pure function of (`sql`, `input`): no Durable Object access,
 * no `fetch`, no `Date` (callers pass `ms`/`iso` in). The owning `LedgerDO` wraps
 * mutating calls in `storage.transactionSync` — this module never opens its own
 * transaction and never performs I/O inside one.
 *
 * Guard discipline (mirrors `docs/ARCHITECTURE.md` §4 and `docs/TESTING.md` §6):
 * - Each request/response artifact is guarded at 1,500,000 bytes; the resulting
 *   row (artifacts + metadata bytes) is guarded at the same 1,500,000-byte ceiling.
 * - Oversized observations are recorded as explicit `error_json` entries while
 *   keeping the prior response bytes — the row is never thrown away.
 * - List queries are blob-free; blobs are only readable via single-row getters.
 */

import { ARTIFACT_ROW_GUARD_BYTES, ROW_GUARD_BYTES } from "../constants.ts";
import {
  ArtifactGuardError,
  assertArtifactSize,
  clampPageLimit,
  guardBytes,
  measureByteLength,
  toGuardedBlob,
} from "../lib/guards.ts";
import {
  SUBMISSIONS_SUMMARY_COLUMNS,
  WEBHOOK_INBOX_SUMMARY_COLUMNS,
  withSqlErrorMapping,
  type SchemaSqlStorage,
  type SqlPrimitiveValue,
  type SubmissionRow,
  type SubmissionSummaryRow,
  type WebhookInboxSummaryRow,
} from "./schema.ts";
import type {
  CancelOutcome,
  DeleteOutcome,
  EnqueueWebhookCommand,
  ListPage,
  RecordObservationCommand,
  RecordSubmissionCommand,
  ResponseSource,
  ServiceTier,
  SubmissionRecord,
  SubmissionStatus,
  SubmissionSummary,
  TokenUsage,
  WebhookIngressReceipt,
} from "../types.ts";

// ============================================================================
// Status fences
// ============================================================================

/** Statuses that accept `flex_cancel` and refuse `flex_delete`. */
const IN_FLIGHT_STATUSES: readonly SubmissionStatus[] = ["submitted", "queued", "in_progress"];

/** Every known ledger status (for filter validation). */
const KNOWN_STATUSES: readonly SubmissionStatus[] = [
  "submitted",
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
];

/** In-flight fence shared by cancel (accepts) and delete (refuses): `submitted|queued|in_progress`. */

// ============================================================================
// Cursor codec (opaque composite; callers must not parse it)
// ============================================================================

/** Encodes a newest-first page cursor from the last row's sort key. */
function encodeLedgerCursor(createdAtMs: number, responseId: string): string {
  return `${createdAtMs}:${responseId}`;
}

/** Decodes a page cursor back into its sort key; throws on malformed input. */
function decodeLedgerCursor(cursor: string): { readonly createdAtMs: number; readonly responseId: string } {
  const separator = cursor.indexOf(":");
  if (separator <= 0) {
    throw new Error(`Invalid ledger cursor: ${cursor}`);
  }
  const createdAtMs = Number(cursor.slice(0, separator));
  const responseId = cursor.slice(separator + 1);
  if (!Number.isInteger(createdAtMs) || createdAtMs < 0 || responseId.length === 0) {
    throw new Error(`Invalid ledger cursor: ${cursor}`);
  }
  return { createdAtMs, responseId };
}

// ============================================================================
// Row mapping + size accounting
// ============================================================================

/** Normalizes a stored BLOB column into a `Uint8Array` view. */
function toUint8Bytes(blob: ArrayBuffer | Uint8Array): Uint8Array {
  return blob instanceof Uint8Array ? blob : new Uint8Array(blob);
}

/** Parses stored `usage_json` into `TokenUsage`; `null` on absent/invalid shape. */
function parseTokenUsage(json: string | null): TokenUsage | null {
  if (json === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const inputTokens = record["inputTokens"];
  const cachedInputTokens = record["cachedInputTokens"];
  const outputTokens = record["outputTokens"];
  const reasoningTokens = record["reasoningTokens"];
  const totalTokens = record["totalTokens"];
  if (
    typeof inputTokens !== "number" ||
    typeof cachedInputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof reasoningTokens !== "number" ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(cachedInputTokens) ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(reasoningTokens) ||
    !Number.isFinite(totalTokens)
  ) {
    return null;
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

/** Maps a blob-free summary row to its wire contract. */
function toSubmissionSummary(row: SubmissionSummaryRow): SubmissionSummary {
  return {
    response_id: row.response_id,
    status: row.status,
    model: row.model ?? "",
    previous_response_id: row.previous_response_id,
    observed_at_ms: row.observed_at_ms,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

/** Maps a full submission row (single-row read) to its wire contract. */
function toSubmissionRecord(row: SubmissionRow): SubmissionRecord {
  return {
    response_id: row.response_id,
    client_request_id: row.client_request_id,
    status: row.status,
    model: row.model ?? "",
    previous_response_id: row.previous_response_id,
    service_tier: row.service_tier as ServiceTier,
    store: row.store === 1,
    request_bytes: toUint8Bytes(row.request_blob),
    response_bytes: row.response_blob === null ? null : toUint8Bytes(row.response_blob),
    response_source: row.response_source,
    observed_at_ms: row.observed_at_ms,
    usage: parseTokenUsage(row.usage_json),
    error_json: row.error_json,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

/** Sums the metadata (non-blob) bytes that count toward the row guard. */
function submissionMetadataBytes(input: {
  readonly responseId: string;
  readonly clientRequestId: string;
  readonly model: string | null;
  readonly previousResponseId: string | null;
  readonly serviceTier: string;
  readonly responseSource: ResponseSource | null;
  readonly usageJson: string | null;
  readonly errorJson: string | null;
}): number {
  return (
    measureByteLength(input.responseId) +
    measureByteLength(input.clientRequestId) +
    measureByteLength(input.model) +
    measureByteLength(input.previousResponseId) +
    measureByteLength(input.serviceTier) +
    measureByteLength(input.responseSource) +
    measureByteLength(input.usageJson) +
    measureByteLength(input.errorJson)
  );
}

/**
 * Enforces the per-artifact 1.5 MB guards plus the resulting-row 1.5 MB guard.
 * Returns the stored `row_bytes`.
 */
function assertSubmissionRowBytes(
  requestBytes: number,
  responseBytes: number,
  metadataBytes: number,
  context: string,
): number {
  assertArtifactSize(requestBytes, `${context}.request`);
  assertArtifactSize(responseBytes, `${context}.response`);
  guardBytes(metadataBytes, ROW_GUARD_BYTES, "row_bytes", `${context}.metadata`);
  return guardBytes(requestBytes + responseBytes + metadataBytes, ROW_GUARD_BYTES, "row_bytes", context);
}

/** Reads one full submission row (blobs included) or `null` when absent. */
function selectSubmissionRow(sql: SchemaSqlStorage, responseId: string): SubmissionRow | null {
  const rows = sql
    .exec<SubmissionRow>(
      `SELECT ${SUBMISSIONS_SUMMARY_COLUMNS}, request_blob, response_blob FROM submissions WHERE response_id = ?`,
      responseId,
    )
    .toArray();
  return rows[0] ?? null;
}

/** Reads one blob-free submission summary or `null` when absent. */
function selectSubmissionSummaryRow(sql: SchemaSqlStorage, responseId: string): SubmissionSummaryRow | null {
  const rows = sql
    .exec<SubmissionSummaryRow>(
      `SELECT ${SUBMISSIONS_SUMMARY_COLUMNS} FROM submissions WHERE response_id = ?`,
      responseId,
    )
    .toArray();
  return rows[0] ?? null;
}

/** Serializes `TokenUsage` for storage (`null` stays `null`). */
function stringifyUsage(usage: TokenUsage | null): string | null {
  return usage === null ? null : JSON.stringify(usage);
}

/** Builds the explicit error payload stored when an observation exceeds the guard. */
function oversizeObservationError(incomingBytes: number, source: ResponseSource): string {
  return JSON.stringify({
    code: "observation_oversized",
    message: `Observation of ${incomingBytes} bytes exceeds the ${ARTIFACT_ROW_GUARD_BYTES}-byte guard; kept prior response bytes.`,
    bytes: incomingBytes,
    source,
  });
}

// ============================================================================
// Submissions: write path
// ============================================================================

/**
 * Persists a fresh submission: exact request bytes plus the submit-response
 * bytes. Enforces artifact + row guards; returns the blob-free summary.
 */
export function recordSubmission(sql: SchemaSqlStorage, cmd: RecordSubmissionCommand): SubmissionSummary {
  return withSqlErrorMapping(() => {
    const requestBytes = cmd.request_bytes.byteLength;
    const responseBytes = cmd.response_bytes.byteLength;
    const usageJson = stringifyUsage(cmd.usage);
    const metadataBytes = submissionMetadataBytes({
      responseId: cmd.response_id,
      clientRequestId: cmd.client_request_id,
      model: cmd.model,
      previousResponseId: cmd.previous_response_id,
      serviceTier: cmd.service_tier,
      responseSource: cmd.response_source,
      usageJson,
      errorJson: cmd.error_json,
    });
    const rowBytes = assertSubmissionRowBytes(requestBytes, responseBytes, metadataBytes, "submissions.row_bytes");

    sql.exec(
      `INSERT INTO submissions (
        response_id,
        client_request_id,
        status,
        model,
        previous_response_id,
        service_tier,
        store,
        request_blob,
        request_bytes,
        response_blob,
        response_bytes,
        response_source,
        observed_at_ms,
        usage_json,
        error_json,
        created_at_ms,
        updated_at_ms,
        row_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cmd.response_id,
      cmd.client_request_id,
      cmd.status,
      cmd.model,
      cmd.previous_response_id,
      cmd.service_tier,
      cmd.store ? 1 : 0,
      cmd.request_bytes,
      requestBytes,
      cmd.response_bytes,
      responseBytes,
      cmd.response_source,
      cmd.observed_at_ms,
      usageJson,
      cmd.error_json,
      cmd.now_ms,
      cmd.now_ms,
      rowBytes,
    );

    const row = selectSubmissionSummaryRow(sql, cmd.response_id);
    if (row === null) {
      throw new Error(`Submission not found after insert: ${cmd.response_id}`);
    }
    return toSubmissionSummary(row);
  });
}

/**
 * Records a later observation (status GET or webhook delivery) over a row.
 * Latest observation wins: response bytes, source, timestamp, status, usage,
 * and error are all swapped. Oversized observations keep the prior response
 * bytes and are recorded as explicit `error_json` instead.
 */
export function recordObservation(sql: SchemaSqlStorage, cmd: RecordObservationCommand): SubmissionSummary {
  return withSqlErrorMapping(() => {
    const existing = selectSubmissionRow(sql, cmd.response_id);
    if (existing === null) {
      throw new Error(`Submission not found: ${cmd.response_id}`);
    }
    const usageJson = stringifyUsage(cmd.usage);
    const incomingBytes = cmd.response_bytes.byteLength;

    if (incomingBytes > ARTIFACT_ROW_GUARD_BYTES) {
      const errorJson = oversizeObservationError(incomingBytes, cmd.response_source);
      const metadataBytes = submissionMetadataBytes({
        responseId: existing.response_id,
        clientRequestId: existing.client_request_id,
        model: existing.model,
        previousResponseId: existing.previous_response_id,
        serviceTier: existing.service_tier,
        responseSource: existing.response_source,
        usageJson,
        errorJson,
      });
      const rowBytes = guardBytes(
        existing.request_bytes + existing.response_bytes + metadataBytes,
        ROW_GUARD_BYTES,
        "row_bytes",
        "submissions.row_bytes",
      );
      sql.exec(
        `UPDATE submissions
         SET status = ?, usage_json = ?, error_json = ?, updated_at_ms = ?, row_bytes = ?
         WHERE response_id = ?`,
        cmd.status,
        usageJson,
        errorJson,
        cmd.now_ms,
        rowBytes,
        cmd.response_id,
      );
      const updated = selectSubmissionSummaryRow(sql, cmd.response_id);
      if (updated === null) {
        throw new Error(`Submission not found after update: ${cmd.response_id}`);
      }
      return toSubmissionSummary(updated);
    }

    const metadataBytes = submissionMetadataBytes({
      responseId: existing.response_id,
      clientRequestId: existing.client_request_id,
      model: existing.model,
      previousResponseId: existing.previous_response_id,
      serviceTier: existing.service_tier,
      responseSource: cmd.response_source,
      usageJson,
      errorJson: cmd.error_json,
    });
    const rowBytes = assertSubmissionRowBytes(
      existing.request_bytes,
      incomingBytes,
      metadataBytes,
      "submissions.row_bytes",
    );
    sql.exec(
      `UPDATE submissions
       SET status = ?,
           response_blob = ?,
           response_bytes = ?,
           response_source = ?,
           observed_at_ms = ?,
           usage_json = ?,
           error_json = ?,
           updated_at_ms = ?,
           row_bytes = ?
       WHERE response_id = ?`,
      cmd.status,
      cmd.response_bytes,
      incomingBytes,
      cmd.response_source,
      cmd.observed_at_ms,
      usageJson,
      cmd.error_json,
      cmd.now_ms,
      rowBytes,
      cmd.response_id,
    );
    const updated = selectSubmissionSummaryRow(sql, cmd.response_id);
    if (updated === null) {
      throw new Error(`Submission not found after update: ${cmd.response_id}`);
    }
    return toSubmissionSummary(updated);
  });
}

// ============================================================================
// Submissions: read path (blob-free except single-row getters)
// ============================================================================

/** Fetches one blob-free submission summary, or `null` when absent. */
export function getSubmissionSummary(sql: SchemaSqlStorage, responseId: string): SubmissionSummary | null {
  return withSqlErrorMapping(() => {
    const row = selectSubmissionSummaryRow(sql, responseId);
    return row === null ? null : toSubmissionSummary(row);
  });
}

/** Single-row blob pair for one submission; `null` when the row is absent. */
export interface SubmissionBlobPair {
  readonly request: Uint8Array;
  readonly response: Uint8Array | null;
}

/** Fetches the exact stored bytes for one submission (never used in lists). */
export function getSubmissionBlobs(sql: SchemaSqlStorage, responseId: string): SubmissionBlobPair | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<SubmissionBlobColumns>(
        "SELECT request_blob, response_blob FROM submissions WHERE response_id = ?",
        responseId,
      )
      .toArray();
    const row = rows[0] ?? null;
    if (row === null) {
      return null;
    }
    return {
      request: toUint8Bytes(row.request_blob),
      response: row.response_blob === null ? null : toUint8Bytes(row.response_blob),
    };
  });
}

/** Blob column projection for the single-row blob getter. */
interface SubmissionBlobColumns extends Record<string, SqlPrimitiveValue> {
  request_blob: ArrayBuffer | Uint8Array;
  response_blob: ArrayBuffer | Uint8Array | null;
}

/** Filters for `listSubmissions`. */
export interface ListSubmissionsOptions {
  readonly status?: SubmissionStatus;
  readonly model?: string;
  readonly cursor?: string | null;
  readonly limit?: number | null;
}

/**
 * Lists blob-free submission summaries newest-first (`created_at_ms DESC,
 * response_id DESC`) with opaque cursor pagination. Limit clamps to 1..100.
 */
export function listSubmissions(
  sql: SchemaSqlStorage,
  options?: ListSubmissionsOptions,
): ListPage<SubmissionSummary> {
  return withSqlErrorMapping(() => {
    if (options?.status !== undefined && !KNOWN_STATUSES.includes(options.status)) {
      throw new Error(`Unknown submission status filter: ${options.status}`);
    }
    const limit = clampPageLimit(options?.limit);
    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];
    if (options?.status !== undefined) {
      conditions.push("status = ?");
      bindings.push(options.status);
    }
    if (options?.model !== undefined) {
      conditions.push("model = ?");
      bindings.push(options.model);
    }
    if (options?.cursor !== undefined && options.cursor !== null) {
      const cursor = decodeLedgerCursor(options.cursor);
      conditions.push("(created_at_ms < ? OR (created_at_ms = ? AND response_id < ?))");
      bindings.push(cursor.createdAtMs, cursor.createdAtMs, cursor.responseId);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    bindings.push(limit + 1);
    const rows = sql
      .exec<SubmissionSummaryRow>(
        `SELECT ${SUBMISSIONS_SUMMARY_COLUMNS} FROM submissions ${whereClause} ORDER BY created_at_ms DESC, response_id DESC LIMIT ?`,
        ...bindings,
      )
      .toArray();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1] ?? null;
    return {
      items: page.map(toSubmissionSummary),
      next_cursor: hasMore && last !== null ? encodeLedgerCursor(last.created_at_ms, last.response_id) : null,
    };
  });
}

/** Pagination options for `listChildren`. */
export interface ListChildrenOptions {
  readonly cursor?: string | null;
  readonly limit?: number | null;
}

/**
 * Lists blob-free summaries whose `previous_response_id` exactly matches,
 * newest-first with opaque cursor pagination. Limit clamps to 1..100.
 */
export function listChildren(
  sql: SchemaSqlStorage,
  previousResponseId: string,
  options?: ListChildrenOptions,
): ListPage<SubmissionSummary> {
  return withSqlErrorMapping(() => {
    const limit = clampPageLimit(options?.limit);
    const conditions: string[] = ["previous_response_id = ?"];
    const bindings: SqlPrimitiveValue[] = [previousResponseId];
    if (options?.cursor !== undefined && options.cursor !== null) {
      const cursor = decodeLedgerCursor(options.cursor);
      conditions.push("(created_at_ms < ? OR (created_at_ms = ? AND response_id < ?))");
      bindings.push(cursor.createdAtMs, cursor.createdAtMs, cursor.responseId);
    }
    bindings.push(limit + 1);
    const rows = sql
      .exec<SubmissionSummaryRow>(
        `SELECT ${SUBMISSIONS_SUMMARY_COLUMNS} FROM submissions WHERE ${conditions.join(" AND ")} ORDER BY created_at_ms DESC, response_id DESC LIMIT ?`,
        ...bindings,
      )
      .toArray();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1] ?? null;
    return {
      items: page.map(toSubmissionSummary),
      next_cursor: hasMore && last !== null ? encodeLedgerCursor(last.created_at_ms, last.response_id) : null,
    };
  });
}

// ============================================================================
// Submissions: cancel + delete fences
// ============================================================================

/** Input for `cancelSubmission` (bytes optional; fence is in-flight only). */
export interface CancelSubmissionInput {
  readonly response_id: string;
  readonly now_ms: number;
  readonly response_bytes?: Uint8Array | null;
  readonly response_source?: ResponseSource | null;
  readonly observed_at_ms?: number | null;
  readonly usage?: TokenUsage | null;
  readonly error_json?: string | null;
}

/**
 * Marks a submission `cancelled`. Refused unless in flight
 * (`submitted|queued|in_progress`); missing rows report `missing`.
 * Supplied response bytes swap like an observation (oversized bytes keep the
 * prior payload with an explicit error); omitted bytes keep prior state.
 */
export function cancelSubmission(sql: SchemaSqlStorage, input: CancelSubmissionInput): CancelOutcome {
  return withSqlErrorMapping(() => {
    const existing = selectSubmissionRow(sql, input.response_id);
    if (existing === null) {
      return { kind: "missing", responseId: input.response_id };
    }
    if (!IN_FLIGHT_STATUSES.includes(existing.status)) {
      return { kind: "refused", responseId: input.response_id, status: existing.status };
    }

    const usageJson =
      input.usage === undefined ? existing.usage_json : stringifyUsage(input.usage ?? null);
    const errorJsonOverride =
      input.error_json === undefined ? existing.error_json : (input.error_json ?? null);

    if (input.response_bytes === undefined || input.response_bytes === null) {
      const metadataBytes = submissionMetadataBytes({
        responseId: existing.response_id,
        clientRequestId: existing.client_request_id,
        model: existing.model,
        previousResponseId: existing.previous_response_id,
        serviceTier: existing.service_tier,
        responseSource: existing.response_source,
        usageJson,
        errorJson: errorJsonOverride,
      });
      const rowBytes = guardBytes(
        existing.request_bytes + existing.response_bytes + metadataBytes,
        ROW_GUARD_BYTES,
        "row_bytes",
        "submissions.row_bytes",
      );
      sql.exec(
        `UPDATE submissions
         SET status = 'cancelled', usage_json = ?, error_json = ?, updated_at_ms = ?, row_bytes = ?
         WHERE response_id = ?`,
        usageJson,
        errorJsonOverride,
        input.now_ms,
        rowBytes,
        input.response_id,
      );
    } else {
      const incomingBytes = input.response_bytes.byteLength;
      const source = input.response_source ?? existing.response_source;
      const observedAt = input.observed_at_ms ?? existing.observed_at_ms;
      if (incomingBytes > ARTIFACT_ROW_GUARD_BYTES) {
        const errorJson = oversizeObservationError(incomingBytes, source ?? "poll");
        const metadataBytes = submissionMetadataBytes({
          responseId: existing.response_id,
          clientRequestId: existing.client_request_id,
          model: existing.model,
          previousResponseId: existing.previous_response_id,
          serviceTier: existing.service_tier,
          responseSource: existing.response_source,
          usageJson,
          errorJson,
        });
        const rowBytes = guardBytes(
          existing.request_bytes + existing.response_bytes + metadataBytes,
          ROW_GUARD_BYTES,
          "row_bytes",
          "submissions.row_bytes",
        );
        sql.exec(
          `UPDATE submissions
           SET status = 'cancelled', usage_json = ?, error_json = ?, updated_at_ms = ?, row_bytes = ?
           WHERE response_id = ?`,
          usageJson,
          errorJson,
          input.now_ms,
          rowBytes,
          input.response_id,
        );
      } else {
        const metadataBytes = submissionMetadataBytes({
          responseId: existing.response_id,
          clientRequestId: existing.client_request_id,
          model: existing.model,
          previousResponseId: existing.previous_response_id,
          serviceTier: existing.service_tier,
          responseSource: source,
          usageJson,
          errorJson: errorJsonOverride,
        });
        const rowBytes = assertSubmissionRowBytes(
          existing.request_bytes,
          incomingBytes,
          metadataBytes,
          "submissions.row_bytes",
        );
        sql.exec(
          `UPDATE submissions
           SET status = 'cancelled',
               response_blob = ?,
               response_bytes = ?,
               response_source = ?,
               observed_at_ms = ?,
               usage_json = ?,
               error_json = ?,
               updated_at_ms = ?,
               row_bytes = ?
           WHERE response_id = ?`,
          input.response_bytes,
          incomingBytes,
          source,
          observedAt,
          usageJson,
          errorJsonOverride,
          input.now_ms,
          rowBytes,
          input.response_id,
        );
      }
    }

    const updated = selectSubmissionRow(sql, input.response_id);
    if (updated === null) {
      throw new Error(`Submission not found after cancel: ${input.response_id}`);
    }
    return { kind: "cancelled", record: toSubmissionRecord(updated) };
  });
}

/**
 * Deletes a submission row plus its blobs. Refused while in flight; missing
 * rows report `missing`.
 */
export function deleteSubmission(sql: SchemaSqlStorage, responseId: string): DeleteOutcome {
  return withSqlErrorMapping(() => {
    const existing = selectSubmissionSummaryRow(sql, responseId);
    if (existing === null) {
      return { kind: "missing", responseId };
    }
    if (IN_FLIGHT_STATUSES.includes(existing.status)) {
      return { kind: "refused", responseId, status: existing.status };
    }
    sql.exec("DELETE FROM submissions WHERE response_id = ?", responseId);
    return { kind: "deleted", responseId };
  });
}

// ============================================================================
// Usage source rows (feeds the `flex_usage` summarizer; blob-free)
// ============================================================================

/** One blob-free usage source row for the summarizer. */
export interface UsageSourceRow {
  readonly response_id: string;
  readonly model: string | null;
  readonly status: SubmissionStatus;
  readonly created_at_ms: number;
  readonly usage_json: string | null;
}

/** Filters for `usageSourceRows` (time bounds are inclusive `ms`, passed in). */
export interface UsageSourceFilters {
  readonly model?: string;
  readonly status?: SubmissionStatus;
  readonly start_ms?: number | null;
  readonly end_ms?: number | null;
}

/** Column projection for usage source reads. */
interface UsageSourceRowColumns extends Record<string, SqlPrimitiveValue> {
  response_id: string;
  model: string | null;
  status: SubmissionStatus;
  created_at_ms: number;
  usage_json: string | null;
}

/**
 * Reads blob-free `(model, status, created_at_ms, usage_json)` rows for the
 * `flex_usage` summarizer. Rows without `usage_json` are included so the
 * summarizer can explicitly skip them.
 */
export function usageSourceRows(sql: SchemaSqlStorage, filters?: UsageSourceFilters): UsageSourceRow[] {
  return withSqlErrorMapping(() => {
    if (filters?.status !== undefined && !KNOWN_STATUSES.includes(filters.status)) {
      throw new Error(`Unknown submission status filter: ${filters.status}`);
    }
    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];
    if (filters?.model !== undefined) {
      conditions.push("model = ?");
      bindings.push(filters.model);
    }
    if (filters?.status !== undefined) {
      conditions.push("status = ?");
      bindings.push(filters.status);
    }
    if (filters?.start_ms !== undefined && filters.start_ms !== null) {
      conditions.push("created_at_ms >= ?");
      bindings.push(filters.start_ms);
    }
    if (filters?.end_ms !== undefined && filters.end_ms !== null) {
      conditions.push("created_at_ms < ?");
      bindings.push(filters.end_ms);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return sql
      .exec<UsageSourceRowColumns>(
        `SELECT response_id, model, status, created_at_ms, usage_json FROM submissions ${whereClause} ORDER BY created_at_ms ASC, response_id ASC`,
        ...bindings,
      )
      .toArray()
      .map(
        (row): UsageSourceRow => ({
          response_id: row.response_id,
          model: row.model,
          status: row.status,
          created_at_ms: row.created_at_ms,
          usage_json: row.usage_json,
        }),
      );
  });
}

// ============================================================================
// Webhook inbox ops (router-inbox shaped, `response_id` is the ledger PK)
// ============================================================================

/**
 * Enqueues a signature-verified webhook delivery. `webhook_id` dedupes without
 * overwriting existing state. Rows whose `response_id` already has a ledger
 * submission land `pending`; the rest land `unmatched`.
 */
export function enqueueWebhook(
  sql: SchemaSqlStorage,
  cmd: EnqueueWebhookCommand,
  nowIso: string,
): WebhookIngressReceipt {
  return withSqlErrorMapping(() => {
    const duplicate = sql
      .exec<WebhookInboxSummaryRow>(
        `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS} FROM webhook_inbox WHERE webhook_id = ?`,
        cmd.webhook_id,
      )
      .toArray()[0] ?? null;
    if (duplicate !== null) {
      return { kind: "duplicate", webhookId: cmd.webhook_id };
    }

    const { blob, byteLength: rawBodyBytes } = toGuardedBlob(cmd.raw_body, "webhook_inbox.raw_body_blob");
    if (rawBodyBytes <= 0) {
      throw new ArtifactGuardError(
        "artifact_bytes",
        rawBodyBytes,
        ARTIFACT_ROW_GUARD_BYTES,
        "webhook_inbox.raw_body_blob",
      );
    }

    const matched =
      cmd.response_id === null
        ? null
        : (sql
            .exec<MatchedSubmissionColumn>(
              "SELECT 1 AS matched FROM submissions WHERE response_id = ?",
              cmd.response_id,
            )
            .toArray()[0] ?? null);
    const status: WebhookInboxSummaryRow["status"] = matched !== null ? "pending" : "unmatched";
    const metadataBytes =
      measureByteLength(cmd.webhook_id) +
      measureByteLength(cmd.event_type) +
      measureByteLength(cmd.response_id);
    const rowBytes = guardBytes(
      rawBodyBytes + metadataBytes,
      ROW_GUARD_BYTES,
      "row_bytes",
      "webhook_inbox.row_bytes",
    );

    sql.exec(
      `INSERT INTO webhook_inbox (
        webhook_id,
        event_type,
        response_id,
        delivery_timestamp_sec,
        received_at_ms,
        status,
        delivery_attempts,
        next_attempt_at_ms,
        raw_body_blob,
        raw_body_bytes,
        row_bytes,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?)`,
      cmd.webhook_id,
      cmd.event_type,
      cmd.response_id,
      cmd.delivery_timestamp_sec,
      cmd.received_at_ms,
      status,
      cmd.received_at_ms,
      blob,
      rawBodyBytes,
      rowBytes,
      nowIso,
      nowIso,
    );
    return { kind: "accepted", webhookId: cmd.webhook_id };
  });
}

/** Presence probe for inbox matching. */
interface MatchedSubmissionColumn extends Record<string, SqlPrimitiveValue> {
  matched: number;
}

/**
 * Lists due `pending` deliveries (`next_attempt_at_ms <= nowMs`), ordered by
 * `next_attempt_at_ms ASC, webhook_id ASC`, omitting blobs. Limit clamps 1..100.
 */
export function listDueDeliveries(
  sql: SchemaSqlStorage,
  nowMs: number,
  limit?: number | null,
): WebhookInboxSummaryRow[] {
  return withSqlErrorMapping(() => {
    const clampedLimit = clampPageLimit(limit);
    return sql
      .exec<WebhookInboxSummaryRow>(
        `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS}
         FROM webhook_inbox
         WHERE status = 'pending'
           AND next_attempt_at_ms IS NOT NULL
           AND next_attempt_at_ms <= ?
         ORDER BY next_attempt_at_ms ASC, webhook_id ASC
         LIMIT ?`,
        nowMs,
        clampedLimit,
      )
      .toArray();
  });
}

/** Delivery outcome for `recordDeliveryResult`. */
export type InboxDeliveryOutcome = "delivered" | "duplicate" | "retry" | "failed";

/** Input for `recordDeliveryResult` (`ms`/`iso` passed in; no clock reads). */
export interface RecordDeliveryResultInput {
  readonly webhook_id: string;
  readonly outcome: InboxDeliveryOutcome;
  readonly next_attempt_at_ms?: number | null;
  readonly last_error?: string | null;
  readonly now_ms: number;
  readonly now_iso: string;
}

/**
 * Records a delivery attempt: bumps `delivery_attempts`, transitions status
 * (`retry` stays `pending` with a new attempt time; terminal outcomes clear
 * it), and refreshes `row_bytes`/`last_error`/`updated_at`.
 */
export function recordDeliveryResult(sql: SchemaSqlStorage, input: RecordDeliveryResultInput): void {
  withSqlErrorMapping(() => {
    const existing =
      sql
        .exec<WebhookInboxSummaryRow>(
          `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS} FROM webhook_inbox WHERE webhook_id = ?`,
          input.webhook_id,
        )
        .toArray()[0] ?? null;
    if (existing === null) {
      throw new Error(`Webhook inbox record not found: ${input.webhook_id}`);
    }

    const nextStatus: WebhookInboxSummaryRow["status"] =
      input.outcome === "retry" ? "pending" : input.outcome;
    const nextAttemptAtMs =
      input.outcome === "retry" ? (input.next_attempt_at_ms ?? input.now_ms) : null;
    const lastError =
      input.outcome === "delivered" || input.outcome === "duplicate"
        ? (input.last_error ?? null)
        : (input.last_error ?? existing.last_error);
    const metadataBytes =
      measureByteLength(existing.webhook_id) +
      measureByteLength(existing.event_type) +
      measureByteLength(existing.response_id) +
      measureByteLength(lastError);
    const rowBytes = guardBytes(
      existing.raw_body_bytes + metadataBytes,
      ROW_GUARD_BYTES,
      "row_bytes",
      "webhook_inbox.row_bytes",
    );

    sql.exec(
      `UPDATE webhook_inbox
       SET status = ?,
           delivery_attempts = delivery_attempts + 1,
           next_attempt_at_ms = ?,
           row_bytes = ?,
           last_error = ?,
           updated_at = ?
       WHERE webhook_id = ?`,
      nextStatus,
      nextAttemptAtMs,
      rowBytes,
      lastError,
      input.now_iso,
      input.webhook_id,
    );
  });
}
