// Covers: TESTING.md items 1 (submit-body builder), 4 (output-text
// extractor), 5 (usage summarizer) — pure unit tests, no DO, no fetch.

import { describe, expect, it } from "vitest";
import { buildSubmitBody, extractOutputText, summarizeUsage } from "../../src/handlers/tools.ts";
import type { UsageSourceRow } from "../../src/db/ledger.ts";

describe("buildSubmitBody", () => {
  it("forces background true with flex/store defaults and passes input through", () => {
    const built = buildSubmitBody({ model: "gpt-5-mini", input: "hello" });
    expect(built.body).toMatchObject({
      model: "gpt-5-mini",
      input: "hello",
      background: true,
      service_tier: "flex",
      store: true,
    });
    expect(built.serviceTier).toBe("flex");
    expect(built.store).toBe(true);
  });

  it("lets service_tier/store overrides win", () => {
    const built = buildSubmitBody({ model: "m", input: "i", store: false });
    expect(built.body).toMatchObject({ store: false, service_tier: "flex" });
    expect(built.store).toBe(false);
  });

  it("merges curated params with extras without clobbering", () => {
    const built = buildSubmitBody({
      model: "m",
      input: "i",
      max_output_tokens: 64,
      metadata: { run: "a" },
      extras: { top_p: 0.5, max_output_tokens: 999 },
    });
    expect(built.body).toMatchObject({
      top_p: 0.5,
      max_output_tokens: 64,
      metadata: { run: "a" },
      background: true,
    });
  });

  it("passes previous_response_id through only when provided", () => {
    expect(buildSubmitBody({ model: "m", input: "i" }).body).not.toHaveProperty(
      "previous_response_id",
    );
    expect(
      buildSubmitBody({ model: "m", input: "i", previous_response_id: "resp_1" }).body,
    ).toMatchObject({ previous_response_id: "resp_1" });
  });

  it("rejects background inside extras", () => {
    expect(() =>
      buildSubmitBody({ model: "m", input: "i", extras: { background: false } }),
    ).toThrow(/background/);
    expect(() =>
      buildSubmitBody({ model: "m", input: "i", extras: { background: true } }),
    ).toThrow(/background/);
  });

  it("maps reasoning_effort onto a reasoning.effort object", () => {
    const built = buildSubmitBody({
      model: "m",
      input: "i",
      reasoning: { summary: "auto" },
      reasoning_effort: "low",
    });
    expect(built.body).toMatchObject({ reasoning: { summary: "auto", effort: "low" } });
  });

  it("passes reasoning through untouched when no effort is given", () => {
    const reasoning = { summary: "auto" };
    expect(buildSubmitBody({ model: "m", input: "i", reasoning }).body).toMatchObject({
      reasoning,
    });
  });
});

describe("extractOutputText", () => {
  it("extracts completed-with-text from output_text and content parts", () => {
    const extracted = extractOutputText({
      id: "resp_1",
      status: "completed",
      output_text: "hello world",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "ignored when top-level present" }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    });
    expect(extracted.text).toBe("hello world");
    expect(extracted.errorCode).toBeNull();
    expect(extracted.errorMessage).toBeNull();
  });

  it("joins content parts when top-level output_text is absent", () => {
    const extracted = extractOutputText({
      id: "resp_2",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "foo " }] },
        { type: "message", content: [{ type: "output_text", text: "bar" }] },
      ],
    });
    expect(extracted.text).toBe("foo bar");
  });

  it("returns explicit empty string for completed-empty envelopes", () => {
    const extracted = extractOutputText({
      id: "resp_3",
      status: "completed",
      output: [],
    });
    expect(extracted.text).toBe("");
    expect(extracted.errorCode).toBeNull();
  });

  it("surfaces failed provider errors verbatim", () => {
    const extracted = extractOutputText({
      id: "resp_4",
      status: "failed",
      output: [],
      error: { code: "server_error", message: "boom" },
    });
    expect(extracted.errorCode).toBe("server_error");
    expect(extracted.errorMessage).toBe("boom");
  });

  it("maps incomplete_details.reason onto the error code", () => {
    const extracted = extractOutputText({
      id: "resp_5",
      status: "incomplete",
      output: [],
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(extracted.errorCode).toBe("max_output_tokens");
  });

  it("unwraps webhook event wrappers via data", () => {
    const extracted = extractOutputText({
      type: "response.completed",
      data: { id: "resp_6", status: "completed", output_text: "via webhook" },
    });
    expect(extracted.text).toBe("via webhook");
  });

  it("returns explicit missing for non-record envelopes", () => {
    for (const envelope of [null, undefined, 42, "nope", []] as const) {
      const extracted = extractOutputText(envelope);
      expect(extracted.text).toBeNull();
      expect(extracted.errorCode).toBeNull();
      expect(extracted.errorMessage).toBeNull();
    }
  });
});

function usageRow(
  responseId: string,
  createdAtMs: number,
  usage: { input: number; output: number; total: number } | null,
  model: string | null = "gpt-5-mini",
  status: UsageSourceRow["status"] = "completed",
): UsageSourceRow {
  return {
    response_id: responseId,
    model,
    status,
    created_at_ms: createdAtMs,
    usage_json:
      usage === null
        ? null
        : JSON.stringify({
            inputTokens: usage.input,
            cachedInputTokens: 0,
            outputTokens: usage.output,
            reasoningTokens: 0,
            totalTokens: usage.total,
          }),
  };
}

describe("summarizeUsage", () => {
  const dayMs = Date.UTC(2026, 10, 8);

  it("groups token sums by day/model/status", () => {
    const summary = summarizeUsage([
      usageRow("r1", dayMs + 1_000, { input: 10, output: 5, total: 15 }),
      usageRow("r2", dayMs + 2_000, { input: 20, output: 10, total: 30 }),
      usageRow("r3", dayMs + 3_000, { input: 1, output: 1, total: 2 }, "other-model"),
      usageRow("r4", dayMs + 86_400_000, { input: 7, output: 7, total: 14 }),
    ]);
    expect(summary.groups).toHaveLength(3);
    const main = summary.groups.find((g) => g.model === "gpt-5-mini" && g.day === "2026-11-08");
    expect(main).toMatchObject({
      submissions: 2,
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
    });
    expect(summary.totalTokens).toBe(15 + 30 + 2 + 14);
    expect(summary.skippedMissingUsage).toBe(0);
  });

  it("skips rows with missing usage explicitly", () => {
    const summary = summarizeUsage([
      usageRow("r1", dayMs, { input: 4, output: 4, total: 8 }),
      usageRow("r2", dayMs, null),
      {
        response_id: "r3",
        model: "gpt-5-mini",
        status: "completed",
        created_at_ms: dayMs,
        usage_json: "not-json",
      },
    ]);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({ submissions: 1, totalTokens: 8 });
    expect(summary.totalTokens).toBe(8);
    expect(summary.skippedMissingUsage).toBe(2);
  });

  it("reports unknown pricing explicitly, never a made-up rate", () => {
    const summary = summarizeUsage([usageRow("r1", dayMs, { input: 1, output: 1, total: 2 })]);
    expect(summary.estimatedSpendUsd).toBeNull();
    expect(summary.pricingKnown).toBe(false);
  });
});
