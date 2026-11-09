/**
 * Webhook ingress (`src/handlers/webhook.ts`) — verified OpenAI webhook route.
 *
 * Owns no storage: it verifies the exact raw request bytes with the Standard
 * Webhooks implementation in `src/lib/signature.ts` (300-second delivery
 * tolerance), parses the verified payload exactly once, and durably enqueues
 * the event via `LedgerDO.enqueueWebhook` before acknowledging. The 200 ack
 * follows only after the inbox commit; the DO alarm delivers afterwards. It
 * never calls OpenAI, never re-serializes the verified bytes, and stores
 * nothing on verification failure (401/413) or unknown event types (400).
 */

import { now } from "../lib/clock.ts";
import {
  DEFAULT_MAX_WEBHOOK_BYTES,
  WEBHOOK_TOLERANCE_SECONDS,
  verifyWebhookRequest,
} from "../lib/signature.ts";
import {
  OPENAI_WEBHOOK_EVENT_TYPES,
  WEBHOOK_OPENAI_PATH,
} from "../constants.ts";
import type { LedgerDO } from "../do/ledger-do.ts";
import type { EnqueueWebhookCommand } from "../types.ts";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  toErrorResponse,
} from "../http.ts";

/** Subscribed OpenAI webhook event types accepted by this ingress. */
type SubscribedWebhookEventType = (typeof OPENAI_WEBHOOK_EVENT_TYPES)[number];

const subscribedEventTypes: ReadonlySet<string> = new Set(
  OPENAI_WEBHOOK_EVENT_TYPES,
);

/**
 * Narrows an untrusted JSON value to one of the subscribed OpenAI event types.
 */
function isSubscribedWebhookEventType(
  value: unknown,
): value is SubscribedWebhookEventType {
  return typeof value === "string" && subscribedEventTypes.has(value);
}

/**
 * Extracts event metadata from an already-verified raw payload.
 *
 * Parsing happens exactly once, after signature verification, and only
 * `id` / `type` / `data.id` are read. The raw bytes handed to the inbox are
 * never rebuilt from this parsed object.
 */
function parseVerifiedPayload(
  rawText: string,
): {
  readonly eventType: SubscribedWebhookEventType;
  readonly responseId: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  if (!("id" in parsed) || !("type" in parsed) || !("data" in parsed)) {
    return null;
  }

  const eventId = parsed.id;
  if (typeof eventId !== "string" || eventId.length === 0) {
    return null;
  }

  const eventType = parsed.type;
  if (!isSubscribedWebhookEventType(eventType)) {
    return null;
  }

  const data = parsed.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  if (!("id" in data)) {
    return null;
  }

  const responseId = data.id;
  if (typeof responseId !== "string" || responseId.length === 0) {
    return null;
  }

  return { eventType, responseId };
}

/**
 * Handles OpenAI webhook deliveries for `POST /openai`.
 *
 * The route accepts only POST on the configured webhook path; verification
 * runs on the exact bounded raw bytes with the 300-second delivery-timestamp
 * tolerance, and the verified event is awaited into `LedgerDO` before a 200
 * acknowledgement. Duplicate deliveries dedupe in the inbox and ack 200.
 */
export function handleWebhookRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== WEBHOOK_OPENAI_PATH) {
    return Promise.resolve(notFound());
  }

  if (request.method !== "POST") {
    return Promise.resolve(methodNotAllowed(["POST"]));
  }

  return handleOpenAiWebhook(request, env);
}

/**
 * Verifies, validates, and durably enqueues one webhook delivery.
 */
async function handleOpenAiWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  // One injectable clock read drives both the tolerance window and the event's
  // received-at timestamp so tests and production agree exactly.
  const receivedAtMs = now();

  const verification = await verifyWebhookRequest(
    request,
    env.OPENAI_WEBHOOK_SECRET,
    {
      nowMs: receivedAtMs,
      toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
      maxBodyBytes: DEFAULT_MAX_WEBHOOK_BYTES,
    },
  );

  if (!verification.ok) {
    return errorResponse(
      verification.status,
      verification.code,
      verification.message,
    );
  }

  const metadata = parseVerifiedPayload(verification.rawText);
  if (metadata === null) {
    return errorResponse(
      400,
      "unknown_event_type",
      "Webhook payload is not a subscribed OpenAI event.",
    );
  }

  // Copy the verified bytes into an exact-length buffer for the RPC so the
  // inbox stores precisely what was signed.
  const command: EnqueueWebhookCommand = {
    webhook_id: verification.webhookId,
    event_type: metadata.eventType,
    response_id: metadata.responseId,
    delivery_timestamp_sec: verification.timestampSeconds,
    received_at_ms: receivedAtMs,
    raw_body: verification.rawBody.slice(),
  };

  try {
    // `env.LEDGER_DO` is a bare `DurableObjectNamespace`; parameterize the
    // singleton stub with the documented LedgerDO RPC. The singleton id is
    // the documented `"ledger"` (see `src/env.d.ts`).
    const stub = env.LEDGER_DO.get(env.LEDGER_DO.idFromName("ledger")) as
      DurableObjectStub<LedgerDO>;
    const receipt = await stub.enqueueWebhook(command);

    return jsonResponse(receipt, 200);
  } catch (error: unknown) {
    // Sanitized failure: the sender retries with the same webhook-id, which
    // the inbox deduplicates. Never acknowledge before durable acceptance.
    return toErrorResponse(error);
  }
}
