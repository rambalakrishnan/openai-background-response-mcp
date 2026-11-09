/**
 * Provider Responses client (`src/lib/openai.ts`) — one-shot OpenAI
 * background-Responses create, retrieve, and cancel.
 *
 * Copied from `flex-orchestrator/src/lib/openai.ts` (see docs/REUSE.md
 * row 8) and stripped to the ledger domain. Kept: API root/timeout,
 * secret resolution, `dispatchResponsesCreate`, `retrieveProviderResponse`,
 * `cancelProviderResponse`, retry-after parsing. Stripped: token counting
 * (`POST /responses/input_tokens`), Files upload/delete, model listing,
 * Chat Completions, judge/pricing chains (no model registry, no cost
 * estimation — usage rows carry raw token counts only; spend is estimated
 * by the usage summarizer which treats unknown pricing as explicit).
 *
 * Invariants:
 * 1. Depends only on HTTP (`src/http.ts`) and contracts
 *    (`src/constants.ts`, `src/lib/clock.ts`, `src/lib/redaction.ts`,
 *    `src/env.d.ts`). Never imports across repos.
 * 2. Credentials are resolved at call time via `resolveEnvSecret` and are
 *    never included in stored request blobs, logs, or exports.
 * 3. Every response body read is bounded by `ARTIFACT_ROW_GUARD_BYTES`
 *    (1,500,000 bytes).
 * 4. The ledger never calls this module from inside `transactionSync`;
 *    all OpenAI calls happen in the Worker, which hands exact bytes to
 *    the DO for storage.
 */

import { ARTIFACT_ROW_GUARD_BYTES } from "../constants.ts";
import { now } from "./clock.ts";
import { redactSensitiveText } from "./redaction.ts";
import { HttpError, fetchWithAbort, readBoundedBytes } from "../http.ts";

/** OpenAI response identifier assigned at submit time (ledger PK). */
export type ResponseId = string;

/** Agent-supplied idempotency key sent as `Idempotency-Key`. */
export type IdempotencyKey = string;

/**
 * Ledger-shaped usage record: raw provider token counts only. No cost
 * estimate, no pricing-known flag, no context tier — those are
 * judge/pricing-chain concerns resolved by the usage summarizer.
 */
export interface TokenUsageRecord {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

/** Default OpenAI v1 API root URL. */
export const OPENAI_DEFAULT_API_ROOT = "https://api.openai.com/v1" as const;

/** Default one-shot HTTP request timeout in milliseconds (60 seconds). */
export const DEFAULT_OPENAI_TIMEOUT_MS = 60_000 as const;

const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** Secret bindings this module is allowed to resolve. */
export type OpenAIClientSecretName =
  | "MCP_HOST"
  | "HOOKS_HOST"
  | "OPENAI_API_KEY"
  | "OPENAI_WEBHOOK_SECRET";

/**
 * Resolves a runtime secret by name from the Worker `Env` binding at call time.
 * Throws an explicit `Error` when the secret is missing or not a non-empty string.
 */
export function resolveEnvSecret(env: Env, secretName: OpenAIClientSecretName): string {
  const value = env[secretName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Missing or empty Worker secret binding");
  }
  return value;
}

/**
 * Normalizes an API root URL by stripping trailing slashes.
 */
export function normalizeApiRoot(apiRoot?: string | null): string {
  const root = (apiRoot ?? OPENAI_DEFAULT_API_ROOT).trim();
  if (root.length === 0) {
    return OPENAI_DEFAULT_API_ROOT;
  }
  return root.replace(/\/+$/, "");
}

/**
 * Copies a `Uint8Array` or `ArrayBuffer` into a standalone `ArrayBuffer` suitable
 * for `RequestInit.body`, `BlobPart`, and `structuredClone` across Durable Object RPC.
 */
function toExactArrayBuffer(input: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input.slice(0);
  }
  const out = new ArrayBuffer(input.byteLength);
  new Uint8Array(out).set(input);
  return out;
}

/**
 * Parses an HTTP `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(
  retryAfterHeader: string | null | undefined,
  nowMs: number = now(),
): number | null {
  if (!retryAfterHeader) {
    return null;
  }
  const trimmed = retryAfterHeader.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedDateMs)) {
    return Math.max(0, parsedDateMs - nowMs);
  }
  return null;
}

interface ParsedProviderError {
  readonly code: string | null;
  readonly type: string | null;
  readonly message: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_PROVIDER_ERROR_CODE_LENGTH = 64;

function normalizeProviderErrorCode(code: string | null): string | null {
  if (code === null || code.length === 0) return null;
  const trimmed = code.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PROVIDER_ERROR_CODE_LENGTH ||
    !/^[A-Za-z0-9_.:-]+$/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function extractProviderError(
  parsedBody: unknown,
  fallbackStatus: number,
  secrets: readonly string[] = [],
): ParsedProviderError {
  if (isPlainRecord(parsedBody)) {
    const errObj = isPlainRecord(parsedBody.error) ? parsedBody.error : parsedBody;
    const code = normalizeProviderErrorCode(
      typeof errObj.code === "string" && errObj.code.length > 0 ? errObj.code : null,
    );
    const type = typeof errObj.type === "string" && errObj.type.length > 0 ? errObj.type : null;
    const rawMessage =
      typeof errObj.message === "string" && errObj.message.length > 0
        ? errObj.message
        : `Provider returned HTTP ${fallbackStatus}`;
    const redacted = redactSensitiveText(rawMessage, secrets);
    const message =
      redacted.length > MAX_PROVIDER_ERROR_MESSAGE_LENGTH
        ? `${redacted.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH)}...`
        : redacted;
    return { code, type, message };
  }
  return {
    code: null,
    type: null,
    message: `Provider returned HTTP ${fallbackStatus}`,
  };
}

function isCapacityErrorCode(code: string | null, type: string | null, message: string): boolean {
  const combined = `${code ?? ""} ${type ?? ""} ${message}`.toLowerCase();
  return (
    combined.includes("rate_limit") ||
    combined.includes("insufficient_capacity") ||
    combined.includes("server_is_overloaded") ||
    combined.includes("flex_capacity") ||
    combined.includes("overloaded") ||
    combined.includes("capacity")
  );
}

async function performRequest(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
  if (options.fetchImpl) {
    return options.fetchImpl(url, init);
  }
  return fetchWithAbort(url, init, {
    timeoutMs,
    signal: options.signal,
    forwardRequestSignal: false,
  });
}

function classifyCatchReason(err: unknown): "timeout" | "network_error" {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError" || err.message.includes("timed out")) {
      return "timeout";
    }
  }
  return "network_error";
}

export type DispatchOutcome =
  | {
      readonly kind: "dispatched";
      readonly responseId: ResponseId;
      readonly status: "queued" | "in_progress" | "completed";
      readonly rawResponseBytes: ArrayBuffer;
    }
  | {
      readonly kind: "capacity_unavailable";
      readonly statusCode: number;
      readonly retryAfterMs: number | null;
      readonly message: string;
    }
  | {
      readonly kind: "ambiguous_dispatch";
      readonly reason: "network_error" | "timeout" | "unparseable_response" | "server_5xx";
      readonly message: string;
    }
  | {
      readonly kind: "terminal_error";
      readonly statusCode: number;
      readonly errorCode: string | null;
      readonly message: string;
    };

export interface DispatchResponsesCreateParams {
  readonly apiKey: string;
  readonly apiRoot?: string;
  readonly requestBytes: Uint8Array | ArrayBuffer;
  readonly idempotencyKey: IdempotencyKey;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Performs a one-shot `POST /responses` call with the exact stored UTF-8 request bytes
 * and `Idempotency-Key`. Never retries internally.
 */
export async function dispatchResponsesCreate(
  params: DispatchResponsesCreateParams,
): Promise<DispatchOutcome> {
  const apiRoot = normalizeApiRoot(params.apiRoot);
  const url = `${apiRoot}/responses`;
  const bodyBuffer = toExactArrayBuffer(params.requestBytes);

  let response: Response;
  try {
    response = await performRequest(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": params.idempotencyKey,
        },
        body: bodyBuffer,
      },
      params,
    );
  } catch (err: unknown) {
    const reason = classifyCatchReason(err);
    const message = redactSensitiveText(
      err instanceof Error ? err.message : String(err),
      [params.apiKey],
    );
    return {
      kind: "ambiguous_dispatch",
      reason,
      message,
    };
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = await readBoundedBytes(response, ARTIFACT_ROW_GUARD_BYTES, params.signal);
  } catch (err: unknown) {
    if (err instanceof HttpError && err.status === 413) {
      return {
        kind: "terminal_error",
        statusCode: 413,
        errorCode: err.code,
        message: redactSensitiveText(err.message, [params.apiKey]),
      };
    }
    return {
      kind: "ambiguous_dispatch",
      reason: classifyCatchReason(err),
      message: redactSensitiveText(
        err instanceof Error ? err.message : String(err),
        [params.apiKey],
      ),
    };
  }

  const rawText = utf8Decoder.decode(rawBytes);
  let parsed: unknown = null;
  let jsonValid = false;
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
  }

  if (response.status === 429) {
    const errInfo = extractProviderError(parsed, response.status, [params.apiKey]);
    return {
      kind: "capacity_unavailable",
      statusCode: 429,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      message: errInfo.message,
    };
  }

  if (response.status === 503) {
    const errInfo = extractProviderError(parsed, response.status, [params.apiKey]);
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs !== null || isCapacityErrorCode(errInfo.code, errInfo.type, errInfo.message)) {
      return {
        kind: "capacity_unavailable",
        statusCode: 503,
        retryAfterMs,
        message: errInfo.message,
      };
    }
    return {
      kind: "ambiguous_dispatch",
      reason: "server_5xx",
      message: errInfo.message,
    };
  }

  if (response.status >= 500) {
    const errInfo = extractProviderError(parsed, response.status, [params.apiKey]);
    return {
      kind: "ambiguous_dispatch",
      reason: "server_5xx",
      message: errInfo.message,
    };
  }

  if (response.status >= 400) {
    const errInfo = extractProviderError(parsed, response.status, [params.apiKey]);
    return {
      kind: "terminal_error",
      statusCode: response.status,
      errorCode: errInfo.code,
      message: errInfo.message,
    };
  }

  if (!jsonValid || !isPlainRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) {
    return {
      kind: "ambiguous_dispatch",
      reason: "unparseable_response",
      message: "Provider returned 2xx without a valid response id",
    };
  }

  const rawStatus = typeof parsed.status === "string" ? parsed.status : "queued";
  const status: "queued" | "in_progress" | "completed" =
    rawStatus === "in_progress" || rawStatus === "completed" ? rawStatus : "queued";

  return {
    kind: "dispatched",
    responseId: parsed.id,
    status,
    rawResponseBytes: toExactArrayBuffer(rawBytes),
  };
}

function extractResponsesOutputAndRefusal(payload: Record<string, unknown>): {
  readonly outputText: string | null;
  readonly refusalText: string | null;
} {
  const outputChunks: string[] = [];
  const refusalChunks: string[] = [];

  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    outputChunks.push(payload.output_text);
  }

  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isPlainRecord(item)) continue;
      if (typeof item.refusal === "string" && item.refusal.length > 0) {
        refusalChunks.push(item.refusal);
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isPlainRecord(part)) continue;
          const partType = typeof part.type === "string" ? part.type : "";
          if (
            (partType === "output_text" || partType === "text") &&
            typeof part.text === "string" &&
            part.text.length > 0 &&
            outputChunks.length === 0
          ) {
            outputChunks.push(part.text);
          } else if (
            partType === "output_text" &&
            typeof part.text === "string" &&
            part.text.length > 0 &&
            typeof payload.output_text !== "string"
          ) {
            outputChunks.push(part.text);
          } else if (partType === "refusal") {
            const refusal =
              typeof part.refusal === "string"
                ? part.refusal
                : typeof part.text === "string"
                  ? part.text
                  : "";
            if (refusal.length > 0) {
              refusalChunks.push(refusal);
            }
          }
        }
      }
    }
  }

  // If `payload.output_text` was absent and multiple `output_text` blocks exist, collect all of them.
  if (outputChunks.length === 0 && Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isPlainRecord(item) || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (isPlainRecord(part) && typeof part.text === "string" && part.text.length > 0) {
          outputChunks.push(part.text);
        }
      }
    }
  }

  return {
    outputText: outputChunks.length > 0 ? outputChunks.join("") : null,
    refusalText: refusalChunks.length > 0 ? refusalChunks.join("\n") : null,
  };
}

/**
 * Projects a provider `usage` object onto the ledger usage record (raw
 * counts only; no pricing). Returns `null` when required counters are
 * absent so callers store an explicit missing-usage observation.
 */
function extractTokenUsage(payload: Record<string, unknown>): TokenUsageRecord | null {
  if (!isPlainRecord(payload.usage)) {
    return null;
  }
  const usage = payload.usage;
  const inputTokens =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : null;
  const outputTokens =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : null;

  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  const inputDetails = isPlainRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isPlainRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : null;
  const outputDetails = isPlainRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : isPlainRecord(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : null;

  const cachedInputTokens =
    inputDetails && typeof inputDetails.cached_tokens === "number"
      ? inputDetails.cached_tokens
      : 0;
  const reasoningTokens =
    outputDetails && typeof outputDetails.reasoning_tokens === "number"
      ? outputDetails.reasoning_tokens
      : 0;
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

export type ProviderResponseRetrieval =
  | {
      readonly kind: "still_running";
      readonly responseId: ResponseId;
      readonly status: "queued" | "in_progress";
    }
  | {
      readonly kind: "settled";
      readonly responseId: ResponseId;
      readonly status: "completed" | "incomplete" | "failed" | "cancelled";
      readonly outputText: string | null;
      readonly refusalText: string | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
      readonly usage: TokenUsageRecord | null;
      readonly rawResponseBytes: ArrayBuffer;
    };

export interface RetrieveProviderResponseParams {
  readonly apiKey: string;
  readonly apiRoot?: string;
  readonly responseId: ResponseId;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Retrieves authoritative OpenAI Response state (`GET /responses/{id}`).
 */
export async function retrieveProviderResponse(
  params: RetrieveProviderResponseParams,
): Promise<ProviderResponseRetrieval> {
  const apiRoot = normalizeApiRoot(params.apiRoot);
  const url = `${apiRoot}/responses/${encodeURIComponent(params.responseId)}`;

  const response = await performRequest(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "application/json",
      },
    },
    params,
  );

  const rawBytes = await readBoundedBytes(response, ARTIFACT_ROW_GUARD_BYTES, params.signal);
  const rawText = utf8Decoder.decode(rawBytes);

  let parsed: unknown = null;
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new HttpError(502, "invalid_provider_json", "Provider response was not valid JSON");
    }
  }

  if (!response.ok) {
    const errInfo = extractProviderError(parsed, response.status, [params.apiKey]);
    throw new HttpError(response.status, errInfo.code ?? "provider_error", errInfo.message);
  }

  if (!isPlainRecord(parsed)) {
    throw new HttpError(502, "invalid_provider_response", "Provider response was not a JSON object");
  }

  const responseId = typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : params.responseId;
  const rawStatus = typeof parsed.status === "string" ? parsed.status : "completed";

  if (rawStatus === "queued" || rawStatus === "in_progress") {
    return {
      kind: "still_running",
      responseId,
      status: rawStatus,
    };
  }

  const settledStatus: "completed" | "incomplete" | "failed" | "cancelled" =
    rawStatus === "incomplete" || rawStatus === "failed" || rawStatus === "cancelled"
      ? rawStatus
      : "completed";

  const { outputText, refusalText } = extractResponsesOutputAndRefusal(parsed);
  const usage = extractTokenUsage(parsed);

  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  if (isPlainRecord(parsed.error)) {
    errorCode = typeof parsed.error.code === "string" ? parsed.error.code : null;
    errorMessage = typeof parsed.error.message === "string" ? parsed.error.message : null;
  } else if (settledStatus === "incomplete" && isPlainRecord(parsed.incomplete_details)) {
    errorCode =
      typeof parsed.incomplete_details.reason === "string"
        ? parsed.incomplete_details.reason
        : "incomplete";
  }

  return {
    kind: "settled",
    responseId,
    status: settledStatus,
    outputText,
    refusalText,
    errorCode,
    errorMessage,
    usage,
    rawResponseBytes: toExactArrayBuffer(rawBytes),
  };
}

export interface CancelProviderResponseParams {
  readonly apiKey: string;
  readonly apiRoot?: string;
  readonly responseId: ResponseId;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Cancels an in-flight background response (`POST /responses/{id}/cancel`).
 */
export async function cancelProviderResponse(
  params: CancelProviderResponseParams,
): Promise<{ readonly ok: boolean; readonly status: number }> {
  const apiRoot = normalizeApiRoot(params.apiRoot);
  const url = `${apiRoot}/responses/${encodeURIComponent(params.responseId)}/cancel`;

  const response = await performRequest(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "application/json",
      },
    },
    params,
  );

  await readBoundedBytes(response, ARTIFACT_ROW_GUARD_BYTES, params.signal);
  return {
    ok: response.ok,
    status: response.status,
  };
}
