/**
 * MCP tool implementations (`src/handlers/tools.ts`) — Worker-side handlers for the
 * eight flex tools (see `docs/ARCHITECTURE.md` §5).
 *
 * Split of responsibilities (ARCH §3, invariant 2):
 * - Pure, unit-testable helpers live here with no I/O: `buildSubmitBody`,
 *   `extractOutputText`, `summarizeUsage`.
 * - Tool handlers perform Worker-side OpenAI I/O via `src/lib/openai.ts`
 *   (submit POST, status live-refresh GET, cancel POST) and persist exact
 *   bytes to the ledger through the `LedgerDO` singleton (`"ledger"`).
 *   The ledger never calls OpenAI; it only stores what the Worker hands it.
 * - Tool failures are MCP `isError` results carrying `{code, message}`
 *   (see `ToolError`); handlers never throw context-free errors.
 * - Provider errors are returned verbatim in the `isError` message.
 * - No invented state: unknown pricing stays explicit (`pricingKnown: false`),
 *   missing output text stays explicit (`null`), unknown webhook event types
 *   are rejected upstream of here.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
  FlexGetResult,
  RecordObservationCommand,
  RecordSubmissionCommand,
  ServiceTier,
  StatusResult,
  SubmissionRecord,
  SubmissionStatus,
  SubmitResult,
  TokenUsage,
  ToolError,
  UsageGroup,
  UsageReport,
} from "../types.ts";
import type { UsageSourceRow } from "../db/ledger.ts";
import { ArtifactGuardError, assertArtifactSize } from "../lib/guards.ts";
import { now } from "../lib/clock.ts";
import {
  cancelProviderResponse,
  dispatchResponsesCreate,
  resolveEnvSecret,
  retrieveProviderResponse,
} from "../lib/openai.ts";

// ============================================================================
// Shared plumbing
// ============================================================================

/** Minimal structural view of the `LedgerDO` RPC surface used by tool handlers. */
export interface LedgerClient {
  recordSubmission(cmd: RecordSubmissionCommand): Promise<unknown>;
  recordObservation(cmd: RecordObservationCommand): Promise<unknown>;
  getSubmission(responseId: string): Promise<SubmissionRecord | null>;
  getBlobs(responseId: string): Promise<{
    readonly request_bytes: Uint8Array;
    readonly response_bytes: Uint8Array | null;
  } | null>;
  listSubmissions(options?: {
    readonly status?: SubmissionStatus;
    readonly model?: string;
    readonly cursor?: string | null;
    readonly limit?: number | null;
  }): Promise<unknown>;
  listChildren(
    responseId: string,
    options?: { readonly cursor?: string | null; readonly limit?: number | null },
  ): Promise<unknown>;
  cancelSubmission(input: {
    readonly response_id: string;
    readonly now_ms: number;
  }): Promise<
    | { readonly kind: "cancelled"; readonly record: SubmissionRecord }
    | { readonly kind: "missing"; readonly responseId: string }
    | { readonly kind: "refused"; readonly responseId: string; readonly status: SubmissionStatus }
  >;
  deleteSubmission(responseId: string): Promise<
    | { readonly kind: "deleted"; readonly responseId: string }
    | { readonly kind: "missing"; readonly responseId: string }
    | { readonly kind: "refused"; readonly responseId: string; readonly status: SubmissionStatus }
  >;
  usageSource(filters?: {
    readonly model?: string;
    readonly status?: SubmissionStatus;
    readonly start_ms?: number | null;
    readonly end_ms?: number | null;
  }): Promise<readonly UsageSourceRow[]>;
}

/** Returns a structural RPC client for the singleton ledger (`idFromName("ledger")`). */
function ledgerFor(env: Env): LedgerClient {
  const id = env.LEDGER_DO.idFromName("ledger");
  const stub = env.LEDGER_DO.get(id);
  return stub as unknown as LedgerClient;
}

/** Successful tool result: single JSON text block. */
function okResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Failed tool result: `isError` with a verbatim `{code, message}` payload. */
function errResult(code: string, message: string): CallToolResult {
  const payload = { code, message } satisfies ToolError;
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

/** True for plain JSON objects (arrays excluded). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Statuses that accept `flex_cancel` and live-refresh, and refuse `flex_delete`. */
const IN_FLIGHT_STATUSES: readonly SubmissionStatus[] = ["submitted", "queued", "in_progress"];

/** Empty-id guard shared by every `{response_id}` tool (the SDK schema enforces this too). */
function invalidResponseId(responseId: string): boolean {
  return responseId.trim().length === 0;
}

// ============================================================================
// 1. Submit body builder (pure; TESTING.md §1)
// ============================================================================

/** Curated `flex_submit` arguments (mirrors the zod input schema in `src/lib/mcp.ts`). */
export interface FlexSubmitArgs {
  readonly model: string;
  readonly input: string | readonly unknown[];
  readonly reasoning?: Record<string, unknown>;
  readonly reasoning_effort?: string;
  readonly previous_response_id?: string;
  readonly service_tier?: ServiceTier;
  readonly max_output_tokens?: number;
  readonly store?: boolean;
  readonly metadata?: Record<string, string>;
  readonly tools?: readonly unknown[];
  readonly tool_choice?: unknown;
  readonly extras?: Record<string, unknown>;
}

/** Output of `buildSubmitBody`: the canonical POST body plus resolved ledger columns. */
export interface BuiltSubmitBody {
  readonly body: Record<string, unknown>;
  readonly serviceTier: ServiceTier;
  readonly store: boolean;
}

/**
 * Builds the canonical `/v1/responses` POST body from curated params merged over
 * `extras`. `background` is forced `true`; any `background` key inside `extras`
 * is rejected. Defaults (`service_tier: "flex"`, `store: true`) apply unless
 * overridden; `previous_response_id` passes through only when provided.
 * Throws an `Error` when `extras` tries to set `background`.
 */
export function buildSubmitBody(params: FlexSubmitArgs): BuiltSubmitBody {
  const extras = params.extras ?? {};
  if (Object.prototype.hasOwnProperty.call(extras, "background")) {
    throw new Error(
      'flex_submit: "background" must not appear in extras (background responses are forced)',
    );
  }
  const serviceTier: ServiceTier = params.service_tier ?? "flex";
  const store: boolean = params.store ?? true;
  const body: Record<string, unknown> = { ...extras };
  body["model"] = params.model;
  body["input"] = params.input;
  body["background"] = true;
  body["service_tier"] = serviceTier;
  body["store"] = store;
  if (params.reasoning_effort !== undefined) {
    const base: Record<string, unknown> =
      params.reasoning !== undefined ? { ...params.reasoning } : {};
    base["effort"] = params.reasoning_effort;
    body["reasoning"] = base;
  } else if (params.reasoning !== undefined) {
    body["reasoning"] = params.reasoning;
  }
  if (params.previous_response_id !== undefined) {
    body["previous_response_id"] = params.previous_response_id;
  }
  if (params.max_output_tokens !== undefined) {
    body["max_output_tokens"] = params.max_output_tokens;
  }
  if (params.metadata !== undefined) {
    body["metadata"] = params.metadata;
  }
  if (params.tools !== undefined) {
    body["tools"] = params.tools;
  }
  if (params.tool_choice !== undefined) {
    body["tool_choice"] = params.tool_choice;
  }
  return { body, serviceTier, store };
}

// ============================================================================
// 2. Output-text extractor (pure; TESTING.md §4)
// ============================================================================

/** Pure extraction of user-visible output text plus provider error detail. */
export interface ExtractedOutput {
  /** Joined output text; `""` when the envelope holds none; `null` when missing. */
  readonly text: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * Unwraps a stored envelope into its Responses object. Webhook deliveries store
 * the event wrapper (`{type: "response.*", data: {...}}`); submit/GET responses
 * store the bare object. Anything else yields `null` (explicit missing).
 */
function unwrapResponseEnvelope(envelope: unknown): Record<string, unknown> | null {
  if (!isRecord(envelope)) {
    return null;
  }
  const type = envelope["type"];
  const data = envelope["data"];
  if (typeof type === "string" && type.startsWith("response.") && isRecord(data)) {
    return data;
  }
  return envelope;
}

/**
 * Collects joined output text from a Responses object. The canonical
 * top-level `output_text` wins when present (even when empty); otherwise every
 * non-empty `output_text`/`text` content part is joined. Returns `""` when the
 * object holds no text — explicit empty, never an error.
 */
function collectOutputText(response: Record<string, unknown>): string {
  const top = response["output_text"];
  if (typeof top === "string") {
    return top;
  }
  const chunks: string[] = [];
  const output = response["output"];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) {
        continue;
      }
      const content = item["content"];
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (!isRecord(part)) {
          continue;
        }
        const partType = part["type"];
        const text = part["text"];
        if (
          (partType === "output_text" || partType === "text") &&
          typeof text === "string" &&
          text.length > 0
        ) {
          chunks.push(text);
        }
      }
    }
  }
  return chunks.join("");
}

/** Collects refusal text from a Responses object, or `null` when absent. */
function collectRefusalText(response: Record<string, unknown>): string | null {
  const chunks: string[] = [];
  const output = response["output"];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) {
        continue;
      }
      const itemRefusal = item["refusal"];
      if (typeof itemRefusal === "string" && itemRefusal.length > 0) {
        chunks.push(itemRefusal);
      }
      const content = item["content"];
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (!isRecord(part)) {
          continue;
        }
        if (part["type"] === "refusal") {
          const refusal = part["refusal"];
          const text = part["text"];
          if (typeof refusal === "string" && refusal.length > 0) {
            chunks.push(refusal);
          } else if (typeof text === "string" && text.length > 0) {
            chunks.push(text);
          }
        }
      }
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : null;
}

/** Reads provider error detail: `error.{code,message}`, `incomplete_details.reason`, refusal. */
function readEnvelopeError(response: Record<string, unknown>): {
  readonly code: string | null;
  readonly message: string | null;
} | null {
  const err = response["error"];
  if (isRecord(err)) {
    const code = typeof err["code"] === "string" ? err["code"] : null;
    const message = typeof err["message"] === "string" ? err["message"] : null;
    if (code !== null || message !== null) {
      return { code, message };
    }
  }
  const details = response["incomplete_details"];
  if (isRecord(details)) {
    const reason = details["reason"];
    if (typeof reason === "string" && reason.length > 0) {
      return { code: reason, message: null };
    }
  }
  const refusal = collectRefusalText(response);
  if (refusal !== null) {
    return { code: null, message: refusal };
  }
  return null;
}

/**
 * Extracts user-visible output text (plus provider error detail) from a stored
 * response envelope. Non-record input yields `text: null` (explicit missing);
 * a record without text yields `text: ""` (explicit empty, not an error).
 */
export function extractOutputText(envelope: unknown): ExtractedOutput {
  const response = unwrapResponseEnvelope(envelope);
  if (response === null) {
    return { text: null, errorCode: null, errorMessage: null };
  }
  const error = readEnvelopeError(response);
  return {
    text: collectOutputText(response),
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
  };
}

// ============================================================================
// 3. Usage summarizer (pure; TESTING.md §5)
// ============================================================================

/** `flex_usage` report plus an explicit count of rows skipped for missing usage. */
export interface UsageSummary extends UsageReport {
  readonly skippedMissingUsage: number;
}

/** Parses stored `usage_json`; `null` when absent or malformed. */
function parseUsageJson(usageJson: string | null): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
} | null {
  if (usageJson === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(usageJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const inputTokens = parsed["inputTokens"];
  const outputTokens = parsed["outputTokens"];
  const totalTokens = parsed["totalTokens"];
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(totalTokens)
  ) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}

/** Formats `created_at_ms` as a UTC `YYYY-MM-DD` day; `null` when unrepresentable. */
function dayStringFor(createdAtMs: number): string | null {
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  try {
    return new Date(createdAtMs).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Aggregates token sums grouped by day/model/status. Rows without usable usage
 * are skipped and counted in `skippedMissingUsage`. Pricing is always unknown
 * in v1 (`estimatedSpendUsd: null`, `pricingKnown: false`) — never a made-up
 * rate.
 */
export function summarizeUsage(rows: readonly UsageSourceRow[]): UsageSummary {
  const grouped = new Map<
    string,
    {
      readonly day: string;
      readonly model: string;
      readonly status: SubmissionStatus;
      submissions: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  >();
  let skippedMissingUsage = 0;
  let totalTokens = 0;
  for (const row of rows) {
    const usage = parseUsageJson(row.usage_json);
    const day = dayStringFor(row.created_at_ms);
    if (usage === null || day === null) {
      skippedMissingUsage += 1;
      continue;
    }
    const model = row.model ?? "unknown";
    const key = JSON.stringify([day, model, row.status]);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        day,
        model,
        status: row.status,
        submissions: 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      });
    } else {
      existing.submissions += 1;
      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.totalTokens += usage.totalTokens;
    }
    totalTokens += usage.totalTokens;
  }
  const groups: UsageGroup[] = [...grouped.values()]
    .sort((a, b) => {
      if (a.day !== b.day) {
        return a.day < b.day ? -1 : 1;
      }
      if (a.model !== b.model) {
        return a.model < b.model ? -1 : 1;
      }
      if (a.status !== b.status) {
        return a.status < b.status ? -1 : 1;
      }
      return 0;
    })
    .map(
      (entry): UsageGroup => ({
        day: entry.day,
        model: entry.model,
        status: entry.status,
        submissions: entry.submissions,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
      }),
    );
  return {
    groups,
    totalTokens,
    estimatedSpendUsd: null,
    pricingKnown: false,
    skippedMissingUsage,
  };
}

// ============================================================================
// Tool handlers (Worker-side OpenAI I/O + LedgerDO RPC)
// ============================================================================

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** Parses stored JSON bytes; throws a ledger-shaped `Error` when unparseable. */
function parseStoredJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as unknown;
  } catch {
    throw new Error(`Stored ${what} bytes are not valid JSON`);
  }
}

/** Builds a provider-error JSON string for `error_json`, or `null` when clean. */
function providerErrorJson(errorCode: string | null, errorMessage: string | null): string | null {
  if (errorCode === null && errorMessage === null) {
    return null;
  }
  return JSON.stringify({ code: errorCode, message: errorMessage });
}

/** `flex_submit`: build body → POST OpenAI → persist exact bytes → `{response_id, status}`. */
export async function handleFlexSubmit(env: Env, args: FlexSubmitArgs): Promise<CallToolResult> {
  let built: BuiltSubmitBody;
  try {
    built = buildSubmitBody(args);
  } catch (err: unknown) {
    return errResult("invalid_args", err instanceof Error ? err.message : String(err));
  }
  try {
    const requestBytes = utf8Encoder.encode(JSON.stringify(built.body));
    try {
      assertArtifactSize(requestBytes.byteLength, "flex_submit.request");
    } catch (err: unknown) {
      if (err instanceof ArtifactGuardError) {
        return errResult("payload_too_large", err.message);
      }
      throw err;
    }
    const apiKey = resolveEnvSecret(env, "OPENAI_API_KEY");
    const clientRequestId = crypto.randomUUID();
    const outcome = await dispatchResponsesCreate({
      apiKey,
      requestBytes,
      idempotencyKey: clientRequestId,
    });
    if (outcome.kind === "capacity_unavailable") {
      return errResult("capacity_unavailable", outcome.message);
    }
    if (outcome.kind === "ambiguous_dispatch") {
      return errResult(outcome.reason, outcome.message);
    }
    if (outcome.kind === "terminal_error") {
      return errResult(outcome.errorCode ?? "provider_error", outcome.message);
    }
    const observedAtMs = now();
    const command: RecordSubmissionCommand = {
      response_id: outcome.responseId,
      client_request_id: clientRequestId,
      status: outcome.status,
      model: args.model,
      previous_response_id: args.previous_response_id ?? null,
      service_tier: built.serviceTier,
      store: built.store,
      request_bytes: requestBytes,
      response_bytes: new Uint8Array(outcome.rawResponseBytes),
      response_source: "submit",
      observed_at_ms: observedAtMs,
      usage: null,
      error_json: null,
      now_ms: observedAtMs,
    };
    const client = ledgerFor(env);
    const summary = (await client.recordSubmission(command)) as {
      readonly response_id: string;
      readonly status: SubmissionStatus;
    };
    const result: SubmitResult = { response_id: summary.response_id, status: summary.status };
    return okResult(result);
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** Arguments for `flex_status`. */
export interface FlexStatusArgs {
  readonly response_id: string;
}

/**
 * `flex_status`: ledger row; when non-terminal, live-refresh via
 * `GET /responses/{id}` and record the observation. A failed refresh still
 * returns the ledger row with `refreshed: false`.
 */
export async function handleFlexStatus(env: Env, args: FlexStatusArgs): Promise<CallToolResult> {
  if (invalidResponseId(args.response_id)) {
    return errResult("invalid_args", "response_id must be a non-empty string");
  }
  try {
    const client = ledgerFor(env);
    const row = await client.getSubmission(args.response_id);
    if (row === null) {
      return errResult("not_found", `No submission for response_id "${args.response_id}"`);
    }
    if (!IN_FLIGHT_STATUSES.includes(row.status)) {
      const settled: StatusResult = {
        response_id: row.response_id,
        status: row.status,
        model: row.model,
        usage: row.usage,
        error_json: row.error_json,
        observed_at_ms: row.observed_at_ms,
        refreshed: false,
      };
      return okResult(settled);
    }
    const apiKey = resolveEnvSecret(env, "OPENAI_API_KEY");
    let refreshed: StatusResult;
    try {
      const retrieval = await retrieveProviderResponse({ apiKey, responseId: args.response_id });
      if (retrieval.kind === "still_running") {
        refreshed = {
          response_id: row.response_id,
          status: row.status,
          model: row.model,
          usage: row.usage,
          error_json: row.error_json,
          observed_at_ms: row.observed_at_ms,
          refreshed: false,
        };
      } else {
        const observedAtMs = now();
        const usage: TokenUsage | null = retrieval.usage;
        const errorJson = providerErrorJson(retrieval.errorCode, retrieval.errorMessage);
        const observation: RecordObservationCommand = {
          response_id: args.response_id,
          status: retrieval.status,
          response_bytes: new Uint8Array(retrieval.rawResponseBytes),
          response_source: "poll",
          observed_at_ms: observedAtMs,
          usage,
          error_json: errorJson,
          now_ms: observedAtMs,
        };
        await client.recordObservation(observation);
        refreshed = {
          response_id: args.response_id,
          status: retrieval.status,
          model: row.model,
          usage,
          error_json: errorJson,
          observed_at_ms: observedAtMs,
          refreshed: true,
        };
      }
    } catch {
      refreshed = {
        response_id: row.response_id,
        status: row.status,
        model: row.model,
        usage: row.usage,
        error_json: row.error_json,
        observed_at_ms: row.observed_at_ms,
        refreshed: false,
      };
    }
    return okResult(refreshed);
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** Arguments for `flex_children`. */
export interface FlexChildrenArgs {
  readonly response_id: string;
  readonly cursor?: string | null;
  readonly limit?: number | null;
}

/** `flex_children`: rows with `previous_response_id = id`, newest first. */
export async function handleFlexChildren(env: Env, args: FlexChildrenArgs): Promise<CallToolResult> {
  if (invalidResponseId(args.response_id)) {
    return errResult("invalid_args", "response_id must be a non-empty string");
  }
  try {
    const client = ledgerFor(env);
    const page = await client.listChildren(args.response_id, {
      cursor: args.cursor ?? null,
      limit: args.limit ?? null,
    });
    return okResult(page);
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** Arguments for `flex_get`. */
export interface FlexGetArgs {
  readonly response_id: string;
  readonly envelopes?: boolean;
}

/**
 * `flex_get`: output text by default; `{request, response}` raw JSON envelopes
 * when `envelopes` is true. Terminal non-completed rows surface the stored
 * provider error verbatim as an `isError`.
 */
export async function handleFlexGet(env: Env, args: FlexGetArgs): Promise<CallToolResult> {
  if (invalidResponseId(args.response_id)) {
    return errResult("invalid_args", "response_id must be a non-empty string");
  }
  try {
    const client = ledgerFor(env);
    const row = await client.getSubmission(args.response_id);
    if (row === null) {
      return errResult("not_found", `No submission for response_id "${args.response_id}"`);
    }
    const blobs = await client.getBlobs(args.response_id);
    if (blobs === null || blobs.response_bytes === null) {
      return errResult("not_found", `No response observed yet for "${args.response_id}"`);
    }
    let responseEnvelope: unknown;
    try {
      responseEnvelope = parseStoredJson(blobs.response_bytes, "response");
    } catch (err: unknown) {
      return errResult("invalid_envelope", err instanceof Error ? err.message : String(err));
    }
    if (args.envelopes === true) {
      let requestEnvelope: unknown;
      try {
        requestEnvelope = parseStoredJson(blobs.request_bytes, "request");
      } catch (err: unknown) {
        return errResult("invalid_envelope", err instanceof Error ? err.message : String(err));
      }
      const result: FlexGetResult = {
        kind: "envelopes",
        response_id: args.response_id,
        request: requestEnvelope,
        response: responseEnvelope,
      };
      return okResult(result);
    }
    if (row.status === "failed" || row.status === "incomplete") {
      const extracted = extractOutputText(responseEnvelope);
      const code = extracted.errorCode ?? row.status;
      const message =
        extracted.errorMessage ??
        row.error_json ??
        `Response "${args.response_id}" is ${row.status}`;
      return errResult(code, message);
    }
    const extracted = extractOutputText(responseEnvelope);
    const result: FlexGetResult = {
      kind: "text",
      response_id: args.response_id,
      status: row.status,
      model: row.model,
      output_text: extracted.text,
      usage: row.usage,
    };
    return okResult(result);
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** Arguments for `flex_list`. */
export interface FlexListArgs {
  readonly status?: SubmissionStatus;
  readonly model?: string;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

/** `flex_list`: newest-first page of blob-free submission summaries. */
export async function handleFlexList(env: Env, args: FlexListArgs): Promise<CallToolResult> {
  try {
    const client = ledgerFor(env);
    const page = await client.listSubmissions({
      status: args.status,
      model: args.model,
      cursor: args.cursor ?? null,
      limit: args.limit ?? null,
    });
    return okResult(page);
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** Arguments for `flex_cancel`. */
export interface FlexCancelArgs {
  readonly response_id: string;
}

/**
 * `flex_cancel`: refused unless in-flight; otherwise POSTs the provider cancel
 * and records terminal `cancelled` with the prior bytes kept.
 */
export async function handleFlexCancel(env: Env, args: FlexCancelArgs): Promise<CallToolResult> {
  if (invalidResponseId(args.response_id)) {
    return errResult("invalid_args", "response_id must be a non-empty string");
  }
  try {
    const client = ledgerFor(env);
    const row = await client.getSubmission(args.response_id);
    if (row === null) {
      return errResult("not_found", `No submission for response_id "${args.response_id}"`);
    }
    if (!IN_FLIGHT_STATUSES.includes(row.status)) {
      return errResult(
        "refused",
        `flex_cancel refused: "${args.response_id}" is ${row.status}`,
      );
    }
    const apiKey = resolveEnvSecret(env, "OPENAI_API_KEY");
    let providerOutcome: { readonly ok: boolean; readonly status: number };
    try {
      providerOutcome = await cancelProviderResponse({ apiKey, responseId: args.response_id });
    } catch (err: unknown) {
      return errResult("provider_error", err instanceof Error ? err.message : String(err));
    }
    if (!providerOutcome.ok) {
      return errResult(
        "provider_error",
        `OpenAI cancel returned HTTP ${providerOutcome.status} for "${args.response_id}"`,
      );
    }
    const outcome = await client.cancelSubmission({ response_id: args.response_id, now_ms: now() });
    if (outcome.kind === "missing") {
      return errResult("not_found", `No submission for response_id "${args.response_id}"`);
    }
    if (outcome.kind === "refused") {
      return errResult("refused", `flex_cancel refused: "${args.response_id}" is ${outcome.status}`);
    }
    return okResult({ response_id: outcome.record.response_id, status: outcome.record.status });
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** Arguments for `flex_delete`. */
export interface FlexDeleteArgs {
  readonly response_id: string;
}

/** `flex_delete`: refused while in-flight; otherwise deletes the row and blobs. */
export async function handleFlexDelete(env: Env, args: FlexDeleteArgs): Promise<CallToolResult> {
  if (invalidResponseId(args.response_id)) {
    return errResult("invalid_args", "response_id must be a non-empty string");
  }
  try {
    const client = ledgerFor(env);
    const outcome = await client.deleteSubmission(args.response_id);
    if (outcome.kind === "missing") {
      return errResult("not_found", `No submission for response_id "${args.response_id}"`);
    }
    if (outcome.kind === "refused") {
      return errResult("refused", `flex_delete refused: "${args.response_id}" is ${outcome.status}`);
    }
    return okResult({ response_id: outcome.responseId, deleted: true });
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}

/** Arguments for `flex_usage`. */
export interface FlexUsageArgs {
  readonly day?: string;
  readonly model?: string;
  readonly status?: SubmissionStatus;
}

/** Parses a `YYYY-MM-DD` day into inclusive-`start_ms`/exclusive-`end_ms` UTC bounds. */
function parseDayBounds(day: string): { readonly startMs: number; readonly endMs: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return null;
  }
  const [, yearRaw, monthRaw, dayRaw] = match;
  if (yearRaw === undefined || monthRaw === undefined || dayRaw === undefined) {
    return null;
  }
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const dayOfMonth = Number(dayRaw);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) {
    return null;
  }
  const startMs = Date.UTC(year, month - 1, dayOfMonth);
  const check = new Date(startMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }
  return { startMs, endMs: startMs + 86_400_000 };
}

/**
 * `flex_usage`: token sums from `usage_json` grouped by day/model/status.
 * Unknown pricing stays explicit (`estimatedSpendUsd: null`, `pricingKnown: false`).
 */
export async function handleFlexUsage(env: Env, args: FlexUsageArgs): Promise<CallToolResult> {
  try {
    let startMs: number | null = null;
    let endMs: number | null = null;
    if (args.day !== undefined) {
      const bounds = parseDayBounds(args.day);
      if (bounds === null) {
        return errResult("invalid_args", `day must be a valid YYYY-MM-DD date, got "${args.day}"`);
      }
      startMs = bounds.startMs;
      endMs = bounds.endMs;
    }
    const client = ledgerFor(env);
    const rows = await client.usageSource({
      model: args.model,
      status: args.status,
      start_ms: startMs,
      end_ms: endMs,
    });
    return okResult(summarizeUsage(rows));
  } catch (err: unknown) {
    return errResult("internal_error", err instanceof Error ? err.message : String(err));
  }
}
