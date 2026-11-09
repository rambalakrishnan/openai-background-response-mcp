/**
 * Ledger schema (`src/db/schema.ts`) — LedgerDO SQLite schemas, migrations, and SQL error classification.
 *
 * Copied from `flex-orchestrator/src/db/schema.ts` (REUSE.md row 7) and stripped to the
 * ledger domain: keeps the migration runner (`runSchemaMigrations`, `SchemaMigrationStep`,
 * `skipIfPresent`), the `_sql_schema_migrations` table, error mapping, webhook-inbox DDL,
 * and diagnostics helpers. Drops every JobDO/Registry table and migration.
 *
 * Reworked for the ledger (ARCHITECTURE.md §4):
 * - `response_routes` is NOT copied: `response_id` is the `submissions` primary key,
 *   so no route map is needed.
 * - `webhook_inbox.job_id` is reworked to a nullable `response_id` (NULL until matched
 *   to a ledger row). There is no `job_id` column.
 *
 * Every numeric limit is sourced from `src/constants.ts`; `ArtifactGuardError` passthrough
 * matches the orchestrator's `withSqlErrorMapping` contract.
 */

import { ARTIFACT_ROW_GUARD_BYTES, ROW_GUARD_BYTES } from "../constants.ts";
import { ArtifactGuardError } from "../lib/guards.ts";

/** Current schema version for `LedgerDO`. */
export const CURRENT_SCHEMA_VERSION = 1;

// ============================================================================
// Minimal Structural SQL Interfaces (Compatible with Cloudflare SqlStorage)
// ============================================================================

/** Valid column value types supported by Durable Object SQLite storage. */
export type SqlPrimitiveValue = ArrayBuffer | Uint8Array | string | number | null;

/** Minimal synchronous cursor interface matching `SqlStorageCursor`. */
export interface SchemaSqlCursor<T extends Record<string, SqlPrimitiveValue> = Record<string, SqlPrimitiveValue>>
  extends Iterable<T> {
  toArray(): T[];
  one(): T;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** Minimal synchronous SQL executor matching `ctx.storage.sql`. */
export interface SchemaSqlStorage {
  exec<T extends Record<string, SqlPrimitiveValue> = Record<string, SqlPrimitiveValue>>(
    query: string,
    ...bindings: SqlPrimitiveValue[]
  ): SchemaSqlCursor<T>;
  readonly databaseSize?: number;
}

/** Minimal synchronous transaction host matching `ctx.storage`. */
export interface SchemaTransactionalStorage {
  readonly sql: SchemaSqlStorage;
  transactionSync<T>(closure: () => T): T;
  deleteAll?(): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

// ============================================================================
// Explicit Errors (No Truncation, Distinct SQLITE_FULL)
// ============================================================================

/**
 * Raised when a SQLite-backed Durable Object reaches its storage ceiling (`SQLITE_FULL`).
 */
export class StorageFullError extends Error {
  readonly code = "SQLITE_FULL" as const;
  override readonly cause: unknown;

  constructor(message = "Durable Object SQLite storage is full (SQLITE_FULL)", cause?: unknown) {
    super(message);
    this.name = "StorageFullError";
    this.cause = cause;
  }
}

/**
 * Raised when a schema migration fails inside `blockConcurrencyWhile`.
 */
export class SchemaMigrationError extends Error {
  readonly code = "SCHEMA_MIGRATION_FAILED" as const;
  readonly targetName: string;
  readonly version: number;
  override readonly cause: unknown;

  constructor(targetName: string, version: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Schema migration failed for ${targetName} at version ${version}: ${detail}`);
    this.name = "SchemaMigrationError";
    this.targetName = targetName;
    this.version = version;
    this.cause = cause;
  }
}

// ============================================================================
// SQL Error Classification (`SQLITE_FULL` Mapping)
// ============================================================================

/**
 * Inspects an unknown error and returns `true` when it represents `SQLITE_FULL`.
 */
export function isSqliteFullError(error: unknown): boolean {
  if (error instanceof StorageFullError) {
    return true;
  }
  if (error instanceof Error) {
    return (
      error.message.includes("SQLITE_FULL") ||
      error.message.includes("database or disk is full")
    );
  }
  if (typeof error === "string") {
    return error.includes("SQLITE_FULL") || error.includes("database or disk is full");
  }
  return false;
}

/**
 * Wraps synchronous SQL execution so `SQLITE_FULL` is rethrown as a distinct,
 * catchable `StorageFullError` and `ArtifactGuardError` passes through untouched.
 */
export function withSqlErrorMapping<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof ArtifactGuardError || error instanceof StorageFullError) {
      throw error;
    }
    if (isSqliteFullError(error)) {
      throw new StorageFullError(
        error instanceof Error ? error.message : "database or disk is full: SQLITE_FULL",
        error
      );
    }
    throw error;
  }
}

// ============================================================================
// Migration Tracking Table (`_sql_schema_migrations` — NEVER `PRAGMA user_version`)
// ============================================================================

export const CREATE_SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
`.trim();

export interface SchemaMigrationRow extends Record<string, SqlPrimitiveValue> {
  id: number;
  applied_at: string;
}

// ============================================================================
// LedgerDO Schema (Strict Tables + 1.5 MB Artifact & Row Guards)
// ============================================================================

/**
 * `submissions` — One row per OpenAI background Response submission.
 * `response_id` is assigned by OpenAI at submit time (the POST response carries it,
 * so no placeholder PK is needed). `request_blob` holds the exact UTF-8 bytes POSTed
 * to `/v1/responses` (no auth headers, ever); `response_blob` holds the latest exact
 * bytes observed (submit response, status GET, or webhook payload).
 */
export const CREATE_SUBMISSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS submissions (
  response_id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'submitted',
      'queued',
      'in_progress',
      'completed',
      'failed',
      'cancelled',
      'incomplete'
    )
  ),
  model TEXT,
  previous_response_id TEXT,
  service_tier TEXT NOT NULL DEFAULT 'flex',
  store INTEGER NOT NULL DEFAULT 1 CHECK (store IN (0, 1)),
  request_blob BLOB NOT NULL CHECK (length(request_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  request_bytes INTEGER NOT NULL CHECK (
    request_bytes > 0 AND
    request_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    length(request_blob) = request_bytes
  ),
  response_blob BLOB CHECK (
    response_blob IS NULL OR
    length(response_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
  response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (
    response_bytes >= 0 AND
    response_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    COALESCE(length(response_blob), 0) = response_bytes
  ),
  response_source TEXT CHECK (
    response_source IS NULL OR
    response_source IN ('submit', 'poll', 'webhook')
  ),
  observed_at_ms INTEGER CHECK (observed_at_ms IS NULL OR observed_at_ms >= 0),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= request_bytes + response_bytes AND
    row_bytes <= ${ROW_GUARD_BYTES}
  ),
  CHECK (
    length(request_blob) +
    COALESCE(length(response_blob), 0) +
    length(response_id) +
    length(client_request_id) +
    COALESCE(length(model), 0) +
    COALESCE(length(previous_response_id), 0) +
    COALESCE(length(service_tier), 0) +
    COALESCE(length(response_source), 0) +
    COALESCE(length(usage_json), 0) +
    COALESCE(length(error_json), 0) <= ${ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

/**
 * `webhook_inbox` — Durable inbox of signature-verified OpenAI webhook deliveries.
 * Copied router-inbox shape with `job_id` reworked to a nullable `response_id`
 * (NULL until the delivery is matched to a ledger row). Stores the exact raw
 * verified payload in `raw_body_blob` with 1.5 MB artifact and row guards.
 */
export const CREATE_WEBHOOK_INBOX_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS webhook_inbox (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'response.completed',
      'response.cancelled',
      'response.failed',
      'response.incomplete'
    )
  ),
  response_id TEXT,
  delivery_timestamp_sec INTEGER NOT NULL CHECK (delivery_timestamp_sec >= 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'unmatched', 'delivered', 'duplicate', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  next_attempt_at_ms INTEGER,
  raw_body_blob BLOB NOT NULL CHECK (length(raw_body_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  raw_body_bytes INTEGER NOT NULL CHECK (
    raw_body_bytes > 0 AND
    raw_body_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    length(raw_body_blob) = raw_body_bytes
  ),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= raw_body_bytes AND
    row_bytes <= ${ROW_GUARD_BYTES}
  ),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(raw_body_blob) +
    length(webhook_id) +
    length(event_type) +
    COALESCE(length(response_id), 0) +
    COALESCE(length(last_error), 0) <= ${ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

export const LEDGER_DO_INDEX_SQL_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_submissions_status_updated ON submissions (status, updated_at_ms);",
  "CREATE INDEX IF NOT EXISTS idx_submissions_previous_response ON submissions (previous_response_id);",
  "CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions (created_at_ms);",
  "CREATE INDEX IF NOT EXISTS idx_submissions_model_status ON submissions (model, status);",
  "CREATE INDEX IF NOT EXISTS idx_webhook_inbox_response ON webhook_inbox (response_id, webhook_id);",
  "CREATE INDEX IF NOT EXISTS idx_webhook_inbox_due ON webhook_inbox (status, next_attempt_at_ms, webhook_id);",
];

// ============================================================================
// Grouped DDL Collections
// ============================================================================

export const LEDGER_DO_TABLE_DDL: readonly string[] = [
  CREATE_SUBMISSIONS_TABLE_SQL,
  CREATE_WEBHOOK_INBOX_TABLE_SQL,
];

export const ALL_SCHEMA_TABLE_DDL: readonly string[] = [...LEDGER_DO_TABLE_DDL];

// ============================================================================
// Typed Row Interfaces (Mirroring STRICT SQLite Columns)
// ============================================================================

export type SubmissionStatus =
  | "submitted"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

export type ResponseSource = "submit" | "poll" | "webhook";

export type WebhookEventType =
  | "response.completed"
  | "response.cancelled"
  | "response.failed"
  | "response.incomplete";

export type WebhookInboxStatus =
  | "pending"
  | "unmatched"
  | "delivered"
  | "duplicate"
  | "failed";

/** `submissions` summary row omitting `request_blob`/`response_blob` for list queries. */
export interface SubmissionSummaryRow extends Record<string, SqlPrimitiveValue> {
  response_id: string;
  client_request_id: string;
  status: SubmissionStatus;
  model: string | null;
  previous_response_id: string | null;
  service_tier: string;
  store: number;
  request_bytes: number;
  response_bytes: number;
  response_source: ResponseSource | null;
  observed_at_ms: number | null;
  usage_json: string | null;
  error_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  row_bytes: number;
}

/** `submissions` row including blobs. Omit blobs in list queries (`SubmissionSummaryRow`). */
export interface SubmissionRow extends SubmissionSummaryRow {
  request_blob: ArrayBuffer | Uint8Array;
  response_blob: ArrayBuffer | Uint8Array | null;
}

/** `webhook_inbox` summary row omitting `raw_body_blob` for list queries. */
export interface WebhookInboxSummaryRow extends Record<string, SqlPrimitiveValue> {
  webhook_id: string;
  event_type: WebhookEventType;
  response_id: string | null;
  delivery_timestamp_sec: number;
  received_at_ms: number;
  status: WebhookInboxStatus;
  delivery_attempts: number;
  next_attempt_at_ms: number | null;
  raw_body_bytes: number;
  row_bytes: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** `webhook_inbox` row including `raw_body_blob`. Omit the blob in list queries. */
export interface WebhookInboxRow extends WebhookInboxSummaryRow {
  raw_body_blob: ArrayBuffer | Uint8Array;
}

// ============================================================================
// BLOB-Free Column Projections for List Queries
// ============================================================================

export const SUBMISSIONS_SUMMARY_COLUMNS =
  "response_id, client_request_id, status, model, previous_response_id, service_tier, store, request_bytes, response_bytes, response_source, observed_at_ms, usage_json, error_json, created_at_ms, updated_at_ms, row_bytes";

export const WEBHOOK_INBOX_SUMMARY_COLUMNS =
  "webhook_id, event_type, response_id, delivery_timestamp_sec, received_at_ms, status, delivery_attempts, next_attempt_at_ms, raw_body_bytes, row_bytes, last_error, created_at, updated_at";

// ============================================================================
// Migration Runner & Schema Introspection Helpers
// ============================================================================

export interface SchemaMigrationStep {
  readonly version: number;
  readonly statements: readonly string[];
  readonly indexStatements?: readonly string[];
  /**
   * Optional guard evaluated before running `statements`. When it returns
   * true the statements are skipped but the version is still recorded as
   * applied — used for `ADD COLUMN` steps, which fail on fresh databases
   * where the v1 DDL already declares the column (SQLite has no
   * `ADD COLUMN IF NOT EXISTS`).
   */
  readonly skipIfPresent?: (sql: SchemaSqlStorage) => boolean;
}

export const LEDGER_DO_MIGRATIONS: readonly SchemaMigrationStep[] = [
  {
    version: 1,
    statements: LEDGER_DO_TABLE_DDL,
    indexStatements: LEDGER_DO_INDEX_SQL_STATEMENTS,
  },
];

/**
 * Reads the current schema version from `_sql_schema_migrations` (`COALESCE(MAX(id), 0)`).
 * Never caches version state in memory across Durable Object evictions or resets.
 */
export function getCurrentSchemaVersion(sql: SchemaSqlStorage): number {
  sql.exec(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL);
  const row = sql
    .exec<{ version: number }>(
      "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations"
    )
    .one();
  return typeof row.version === "number" ? row.version : Number(row.version);
}

/**
 * Checks whether a column already exists on `tableName` using `PRAGMA table_info`.
 * Used to guard `ALTER TABLE ... ADD COLUMN` idempotently since SQLite lacks `ADD COLUMN IF NOT EXISTS`.
 */
export function hasTableColumn(
  sql: SchemaSqlStorage,
  tableName: string,
  columnName: string
): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid SQLite identifier: ${tableName}`);
  }
  const columns = sql
    .exec<{ name: string }>(`PRAGMA table_info(${tableName})`)
    .toArray();
  return columns.some((c) => c.name === columnName);
}

/**
 * Checks whether a table exists using `PRAGMA table_list`.
 */
export function hasTable(sql: SchemaSqlStorage, tableName: string): boolean {
  const tables = sql.exec<{ name: string }>("PRAGMA table_list").toArray();
  return tables.some((t) => t.name === tableName);
}

/**
 * Runs a set of versioned migrations synchronously inside `storage.transactionSync`.
 *
 * - Never uses `PRAGMA user_version`.
 * - Executes one SQL statement per `sql.exec(...)` call inside `transactionSync`.
 * - Records each version in `_sql_schema_migrations` only after all statements for that version succeed.
 * - Runs `PRAGMA optimize` after index-creating versions.
 * - Re-reads `_sql_schema_migrations` on every invocation (no module-level in-memory cache).
 */
export function runSchemaMigrations(
  storage: SchemaTransactionalStorage,
  targetName: string,
  steps: readonly SchemaMigrationStep[]
): { readonly version: number; readonly appliedVersions: readonly number[] } {
  return withSqlErrorMapping(() => {
    const sql = storage.sql;
    const currentVersion = getCurrentSchemaVersion(sql);
    const appliedVersions: number[] = [];

    for (const step of steps) {
      if (step.version <= currentVersion) {
        continue;
      }

      let createdIndexes = false;
      const skipStatements =
        step.skipIfPresent !== undefined && step.skipIfPresent(sql);
      try {
        storage.transactionSync(() => {
          if (!skipStatements) {
            for (const stmt of step.statements) {
              sql.exec(stmt);
            }
          }
          if (step.indexStatements && step.indexStatements.length > 0) {
            for (const indexStmt of step.indexStatements) {
              sql.exec(indexStmt);
            }
            createdIndexes = true;
          }
          sql.exec(
            "INSERT INTO _sql_schema_migrations (id) VALUES (?)",
            step.version
          );
        });
      } catch (error: unknown) {
        if (isSqliteFullError(error)) {
          throw new StorageFullError(
            error instanceof Error ? error.message : "database or disk is full: SQLITE_FULL",
            error
          );
        }
        throw new SchemaMigrationError(targetName, step.version, error);
      }

      if (createdIndexes) {
        sql.exec("PRAGMA optimize");
      }
      appliedVersions.push(step.version);
    }

    const finalVersion =
      appliedVersions.length > 0
        ? appliedVersions[appliedVersions.length - 1]!
        : currentVersion;

    return { version: finalVersion, appliedVersions };
  });
}

/** Convenience migration entrypoint for `LedgerDO` constructor `blockConcurrencyWhile`. */
export function migrateLedgerDoSchema(storage: SchemaTransactionalStorage): {
  readonly version: number;
  readonly appliedVersions: readonly number[];
} {
  return runSchemaMigrations(storage, "LedgerDO", LEDGER_DO_MIGRATIONS);
}

// ============================================================================
// Diagnostics & Storage Reset Helpers
// ============================================================================

export interface DatabaseDiagnostics {
  readonly schemaVersion: number;
  readonly databaseSizeBytes: number;
  readonly artifactByteLimit: number;
  readonly rowByteLimit: number;
}

/**
 * Surfaces current schema version and `sql.databaseSize` for diagnostics endpoints.
 */
export function getDatabaseDiagnostics(sql: SchemaSqlStorage): DatabaseDiagnostics {
  const schemaVersion = getCurrentSchemaVersion(sql);
  const databaseSizeBytes = typeof sql.databaseSize === "number" ? sql.databaseSize : 0;
  return {
    schemaVersion,
    databaseSizeBytes,
    artifactByteLimit: ARTIFACT_ROW_GUARD_BYTES,
    rowByteLimit: ROW_GUARD_BYTES,
  };
}

/**
 * Resets a Durable Object's storage and explicitly deletes any scheduled alarm
 * so older compatibility configurations cannot leave an orphan alarm behind.
 */
export async function resetDurableObjectStorage(
  storage: SchemaTransactionalStorage
): Promise<void> {
  if (typeof storage.deleteAlarm === "function") {
    await storage.deleteAlarm();
  }
  if (typeof storage.deleteAll === "function") {
    await storage.deleteAll();
  }
}
