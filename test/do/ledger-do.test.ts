// Covers: TESTING §6-10 (ledger CRUD, lineage/list, cancel/delete fences,
// webhook inbox, status self-heal).
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { LedgerDO } from "../../src/do/ledger-do.ts";
import type {
  EnqueueWebhookCommand,
  RecordObservationCommand,
  RecordSubmissionCommand,
  SubmissionStatus,
  TokenUsage,
} from "../../src/types.ts";

type Stub = DurableObjectStub<LedgerDO>;

function stub(name = "ledger"): Stub {
  return env.LEDGER_DO.get(env.LEDGER_DO.idFromName(name)) as Stub;
}

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const NOW = 1_800_000_000_000;
const USAGE: TokenUsage = {
  inputTokens: 100,
  cachedInputTokens: 10,
  outputTokens: 50,
  reasoningTokens: 20,
  totalTokens: 150,
};

function submitCmd(overrides: Partial<RecordSubmissionCommand> = {}): RecordSubmissionCommand {
  return {
    response_id: "resp_test_1",
    client_request_id: "client-1",
    status: "submitted",
    model: "gpt-test",
    previous_response_id: null,
    service_tier: "flex",
    store: true,
    request_bytes: new TextEncoder().encode('{"model":"gpt-test"}'),
    response_bytes: new TextEncoder().encode('{"id":"resp_test_1","status":"queued"}'),
    response_source: "submit",
    observed_at_ms: NOW,
    usage: null,
    error_json: null,
    now_ms: NOW,
    ...overrides,
  };
}

function observeCmd(overrides: Partial<RecordObservationCommand> = {}): RecordObservationCommand {
  return {
    response_id: "resp_test_1",
    status: "in_progress",
    response_bytes: new TextEncoder().encode('{"id":"resp_test_1","status":"in_progress"}'),
    response_source: "poll",
    observed_at_ms: NOW + 1000,
    usage: null,
    error_json: null,
    now_ms: NOW + 1000,
    ...overrides,
  };
}

describe("ledger CRUD + guards (§6)", () => {
  it("records a submission and reads it back with exact bytes", async () => {
    const s = stub();
    const summary = await s.recordSubmission(submitCmd());
    expect(summary.response_id).toBe("resp_test_1");
    expect(summary.status).toBe("submitted");

    const blobs = await s.getBlobs("resp_test_1");
    expect(blobs).not.toBeNull();
    expect(new TextDecoder().decode(blobs!.request_bytes)).toBe('{"model":"gpt-test"}');
    expect(new TextDecoder().decode(blobs!.response_bytes!)).toContain("queued");
  });

  it("latest observation wins, swapping bytes + source + timestamp", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd());
    const updated = await s.recordObservation(observeCmd({ status: "completed", usage: USAGE }));
    expect(updated.status).toBe("completed");

    const record = await s.getSubmission("resp_test_1");
    expect(record!.response_source).toBe("poll");
    expect(record!.observed_at_ms).toBe(NOW + 1000);
    expect(record!.usage).toMatchObject({ totalTokens: 150 });
    expect(new TextDecoder().decode(record!.response_bytes!)).toContain("in_progress");
  });

  it("records oversized observations as explicit errors, keeping prior bytes", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd());
    const huge = new Uint8Array(1_500_001).fill(120);
    const updated = await s.recordObservation(observeCmd({ response_bytes: huge }));
    expect(updated.status).toBe("in_progress");

    const record = await s.getSubmission("resp_test_1");
    expect(new TextDecoder().decode(record!.response_bytes!)).toContain("queued");
    expect(record!.error_json).toContain("1");
  });
});

describe("lineage + list (§7)", () => {
  it("lists children by exact previous_response_id match", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd({ response_id: "resp_parent" }));
    await s.recordSubmission(
      submitCmd({ response_id: "resp_child", previous_response_id: "resp_parent", now_ms: NOW + 1 }),
    );
    await s.recordSubmission(submitCmd({ response_id: "resp_other", now_ms: NOW + 2 }));

    const page = await s.listChildren("resp_parent");
    expect(page.items.map((i) => i.response_id)).toEqual(["resp_child"]);
    expect(page.next_cursor).toBeNull();
  });

  it("lists newest-first with filters and cursor pagination", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd({ response_id: "resp_a", model: "m1", now_ms: NOW }));
    await s.recordSubmission(
      submitCmd({ response_id: "resp_b", model: "m2", now_ms: NOW + 1 }),
    );
    await s.recordSubmission(
      submitCmd({ response_id: "resp_c", model: "m1", now_ms: NOW + 2 }),
    );

    const filtered = await s.listSubmissions({ model: "m1" });
    expect(filtered.items.map((i) => i.response_id)).toEqual(["resp_c", "resp_a"]);

    const first = await s.listSubmissions({ limit: 2 });
    expect(first.items.map((i) => i.response_id)).toEqual(["resp_c", "resp_b"]);
    expect(first.next_cursor).not.toBeNull();

    const second = await s.listSubmissions({ limit: 2, cursor: first.next_cursor });
    expect(second.items.map((i) => i.response_id)).toEqual(["resp_a"]);
    expect(second.next_cursor).toBeNull();
  });

  it("clamps limits", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd());
    const clamped = await s.listSubmissions({ limit: 500 });
    expect(clamped.items).toHaveLength(1);
  });

  it("rejects unknown status filters", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd());
    // Run inside the isolate: miniflare re-emits DO RPC rejections as
    // unhandled even when the caller catches them, so assert in-DO.
    const message = await runInDurableObject(s, async (instance: LedgerDO) => {
      try {
        await instance.listSubmissions({ status: "bogus" as SubmissionStatus });
        return null;
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(message).toMatch(/unknown submission status/i);
  });
});

describe("cancel/delete fences (§8)", () => {
  it("cancels in-flight rows and refuses terminal rows", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd({ response_id: "resp_fly" }));
    await s.recordSubmission(submitCmd({ response_id: "resp_done", status: "completed" }));

    const cancelled = await s.cancelSubmission({ response_id: "resp_fly", now_ms: NOW + 5 });
    expect(cancelled.kind).toBe("cancelled");

    const refused = await s.cancelSubmission({ response_id: "resp_done", now_ms: NOW + 5 });
    expect(refused.kind).toBe("refused");

    const missing = await s.cancelSubmission({ response_id: "resp_nope", now_ms: NOW + 5 });
    expect(missing.kind).toBe("missing");
  });

  it("deletes terminal rows only, removing blobs", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd({ response_id: "resp_fly" }));
    await s.recordSubmission(submitCmd({ response_id: "resp_done", status: "completed" }));

    const refused = await s.deleteSubmission("resp_fly");
    expect(refused.kind).toBe("refused");

    const deleted = await s.deleteSubmission("resp_done");
    expect(deleted.kind).toBe("deleted");
    expect(await s.getSubmission("resp_done")).toBeNull();
    expect(await s.getBlobs("resp_done")).toBeNull();
  });
});

describe("webhook inbox (§9)", () => {
  function webhookCmd(overrides: Partial<EnqueueWebhookCommand> = {}): EnqueueWebhookCommand {
    const receivedAt = Date.now();
    return {
      webhook_id: "wh_1",
      event_type: "response.completed",
      response_id: "resp_test_1",
      delivery_timestamp_sec: Math.floor(receivedAt / 1000),
      received_at_ms: receivedAt,
      raw_body: new TextEncoder().encode(
        '{"id":"resp_test_1","status":"completed","usage":{"input_tokens":10}}',
      ),
      ...overrides,
    };
  }

  it("delivers a completed webhook to the submission via the alarm", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd());
    const receipt = await s.enqueueWebhook(webhookCmd());
    expect(receipt.kind).toBe("accepted");

    await runInDurableObject(s, async (instance: LedgerDO) => {
      await instance.alarm();
    });

    const record = await s.getSubmission("resp_test_1");
    expect(record!.status).toBe("completed");
    expect(record!.response_source).toBe("webhook");
  });

  it("dedupes duplicate webhook ids", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd());
    expect((await s.enqueueWebhook(webhookCmd())).kind).toBe("accepted");
    expect((await s.enqueueWebhook(webhookCmd())).kind).toBe("duplicate");
  });

  it("treats a late webhook for the same terminal state as a no-op", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd());
    await s.recordObservation(observeCmd({ status: "completed", observed_at_ms: NOW + 1000 }));
    await s.enqueueWebhook(webhookCmd());
    await runInDurableObject(s, async (instance: LedgerDO) => {
      await instance.alarm();
    });

    const record = await s.getSubmission("resp_test_1");
    expect(record!.status).toBe("completed");
    expect(record!.observed_at_ms).toBe(NOW + 1000);
  });
});

describe("usage source (§10 support)", () => {
  it("exposes usage rows for the summarizer", async () => {
    const s = stub();
    await s.recordSubmission(submitCmd({ response_id: "resp_u1" }));
    await s.recordObservation(
      observeCmd({ response_id: "resp_u1", status: "completed", usage: USAGE }),
    );
    await s.recordSubmission(submitCmd({ response_id: "resp_u2", now_ms: NOW + 1 }));

    const rows = await s.usageSource({});
    expect(rows).toHaveLength(2);
    const used = rows.find((r) => r.response_id === "resp_u1");
    expect(used!.usage_json).toContain("150");
  });
});
