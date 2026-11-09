// Covers: TESTING.md item 2 (guards). Pins the behavior copied from
// flex-orchestrator `src/lib/guards.ts` (see `docs/REUSE.md` row 6):
// 1.5 MB request/response blobs accepted at the boundary, rejected above;
// row guard accounts metadata. Turn/branch/file asserts are stripped.

import { describe, expect, it } from "vitest";
import {
  ARTIFACT_ROW_GUARD_BYTES,
  LIST_PAGE_LIMIT_DEFAULT,
  LIST_PAGE_LIMIT_MAX,
  LIST_PAGE_LIMIT_MIN,
  ROW_GUARD_BYTES,
  SQL_MAX_BOUND_PARAMS,
} from "../../src/constants.ts";
import * as guardsModule from "../../src/lib/guards.ts";
import {
  ArtifactGuardError,
  assertArtifactAndRowSize,
  assertArtifactSize,
  chunkRowsForBindLimit,
  clampPageLimit,
  guardBytes,
  measureByteLength,
  toGuardedBlob,
} from "../../src/lib/guards.ts";

/** Captures the thrown `ArtifactGuardError` so its fields can be asserted. */
function captureArtifactGuardError(fn: () => unknown): ArtifactGuardError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ArtifactGuardError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ArtifactGuardError to be thrown");
}

describe("ledger guard strip", () => {
  it("does not export turn/branch/file asserts", () => {
    const exported: unknown = guardsModule;
    expect(exported).not.toBeUndefined();
    expect("assertTurnIndex" in guardsModule).toBe(false);
    expect("assertBranchSnapshotSize" in guardsModule).toBe(false);
    expect("assertFileUploadSize" in guardsModule).toBe(false);
  });
});

describe("limit constants", () => {
  it("pins the 1.5 MB artifact/row guard and paging/bind caps", () => {
    expect(ARTIFACT_ROW_GUARD_BYTES).toBe(1_500_000);
    expect(ROW_GUARD_BYTES).toBe(1_500_000);
    expect(LIST_PAGE_LIMIT_MIN).toBe(1);
    expect(LIST_PAGE_LIMIT_MAX).toBe(100);
    expect(LIST_PAGE_LIMIT_DEFAULT).toBe(50);
    expect(SQL_MAX_BOUND_PARAMS).toBe(100);
  });
});

describe("measureByteLength", () => {
  it("returns 0 for null and undefined", () => {
    expect(measureByteLength(null)).toBe(0);
    expect(measureByteLength(undefined)).toBe(0);
  });

  it("returns exact UTF-8 byte length for strings", () => {
    expect(measureByteLength("")).toBe(0);
    expect(measureByteLength("abc")).toBe(3);
    expect(measureByteLength("héllo")).toBe(6);
    expect(measureByteLength("😀")).toBe(4);
  });

  it("returns exact byteLength for buffers and views", () => {
    expect(measureByteLength(new ArrayBuffer(16))).toBe(16);
    const backing = new ArrayBuffer(16);
    expect(measureByteLength(new Uint8Array(backing, 4, 6))).toBe(6);
    expect(measureByteLength(new DataView(backing, 8, 4))).toBe(4);
  });

  it("throws ArtifactGuardError for a non-byte payload type", () => {
    const error = captureArtifactGuardError(() => measureByteLength(42 as unknown as string));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.context).toBe("invalid_payload_type");
    expect(Number.isNaN(error.actualBytes)).toBe(true);
  });
});

describe("guardBytes", () => {
  it("accepts zero and exactly the limit", () => {
    expect(guardBytes(0)).toBe(0);
    expect(guardBytes(1_500_000)).toBe(1_500_000);
  });

  it("rejects limit + 1 with default kind/limit/context", () => {
    const error = captureArtifactGuardError(() => guardBytes(1_500_001));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.actualBytes).toBe(1_500_001);
    expect(error.limitBytes).toBe(ARTIFACT_ROW_GUARD_BYTES);
    expect(error.context).toBe("artifact");
    expect(error.code).toBe("ARTIFACT_GUARD_EXCEEDED");
    expect(error.name).toBe("ArtifactGuardError");
  });

  it("rejects negative, NaN, Infinity, and non-integer values", () => {
    for (const invalid of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
    ]) {
      const error = captureArtifactGuardError(() => guardBytes(invalid));
      expect(error).toBeInstanceOf(ArtifactGuardError);
    }
  });

  it("rejects non-numeric input at runtime", () => {
    const error = captureArtifactGuardError(() => guardBytes("12" as unknown as number));
    expect(error.kind).toBe("artifact_bytes");
  });
});

describe("assertArtifactSize", () => {
  it("accepts the 1.5 MB boundary, rejects 1.5 MB + 1", () => {
    expect(assertArtifactSize(0)).toBe(0);
    expect(assertArtifactSize(1_500_000)).toBe(1_500_000);
    const error = captureArtifactGuardError(() => assertArtifactSize(1_500_001));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.actualBytes).toBe(1_500_001);
    expect(error.limitBytes).toBe(ARTIFACT_ROW_GUARD_BYTES);
    expect(error.context).toBe("artifact");
  });

  it("propagates a caller-supplied context label", () => {
    const error = captureArtifactGuardError(() =>
      assertArtifactSize(1_500_001, "request_blob"),
    );
    expect(error.context).toBe("request_blob");
  });
});

describe("assertArtifactAndRowSize", () => {
  it("returns the computed artifact/metadata/row triple", () => {
    expect(assertArtifactAndRowSize(0)).toEqual({ artifactBytes: 0, metadataBytes: 0, rowBytes: 0 });
    expect(assertArtifactAndRowSize(1_000_000, 500_000)).toEqual({
      artifactBytes: 1_000_000,
      metadataBytes: 500_000,
      rowBytes: 1_500_000,
    });
  });

  it("accepts the exact 1.5 MB combined row boundary", () => {
    expect(assertArtifactAndRowSize(1_500_000, 0).rowBytes).toBe(1_500_000);
    expect(assertArtifactAndRowSize(1_499_999, 1).rowBytes).toBe(1_500_000);
  });

  it("rejects an artifact alone above 1.5 MB under the artifact guard", () => {
    const error = captureArtifactGuardError(() => assertArtifactAndRowSize(1_500_001, 0, "row"));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.context).toBe("row.artifact");
  });

  it("rejects artifact + metadata above 1.5 MB under the row guard", () => {
    const error = captureArtifactGuardError(() => assertArtifactAndRowSize(1_000_000, 500_001, "row"));
    expect(error.kind).toBe("row_bytes");
    expect(error.context).toBe("row");
    expect(error.actualBytes).toBe(1_500_001);
    expect(error.limitBytes).toBe(ROW_GUARD_BYTES);
  });

  it("rejects metadata alone above the row limit under the metadata guard", () => {
    const error = captureArtifactGuardError(() => assertArtifactAndRowSize(0, 1_500_001, "row"));
    expect(error.kind).toBe("row_bytes");
    expect(error.context).toBe("row.metadata");
  });

  it("rejects negative or non-integer sizes", () => {
    expect(captureArtifactGuardError(() => assertArtifactAndRowSize(-1, 0)).kind).toBe(
      "artifact_bytes",
    );
    expect(captureArtifactGuardError(() => assertArtifactAndRowSize(1, -1)).kind).toBe("row_bytes");
    expect(captureArtifactGuardError(() => assertArtifactAndRowSize(1, 1.5)).kind).toBe(
      "row_bytes",
    );
  });
});

describe("toGuardedBlob", () => {
  it("round-trips a small string through exact UTF-8 bytes", () => {
    const result = toGuardedBlob("héllo");
    expect(result.blob).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBe(6);
    expect(new TextDecoder().decode(result.blob)).toBe("héllo");
  });

  it("accepts a request/response blob at exactly 1.5 MB", () => {
    const result = toGuardedBlob("x".repeat(1_500_000), "response_blob");
    expect(result.byteLength).toBe(1_500_000);
    expect(result.blob.byteLength).toBe(1_500_000);
  });

  it("rejects a blob at 1.5 MB + 1 and never returns a partial value", () => {
    let returned: unknown = "not-returned";
    const error = captureArtifactGuardError(() => {
      returned = toGuardedBlob("x".repeat(1_500_001), "request_blob");
    });
    expect(returned).toBe("not-returned");
    expect(error.kind).toBe("artifact_bytes");
    expect(error.context).toBe("request_blob");
    expect(error.actualBytes).toBe(1_500_001);
    expect(error.limitBytes).toBe(ARTIFACT_ROW_GUARD_BYTES);
  });
});

describe("clampPageLimit", () => {
  it("defaults to 50 for undefined, null, and NaN", () => {
    expect(clampPageLimit(undefined)).toBe(50);
    expect(clampPageLimit(null)).toBe(50);
    expect(clampPageLimit(Number.NaN)).toBe(50);
    expect(clampPageLimit()).toBe(LIST_PAGE_LIMIT_DEFAULT);
  });

  it("clamps to the inclusive 1..100 range", () => {
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(1)).toBe(1);
    expect(clampPageLimit(100)).toBe(100);
    expect(clampPageLimit(101)).toBe(100);
    expect(clampPageLimit(-5)).toBe(1);
  });

  it("truncates fractional limits before clamping", () => {
    expect(clampPageLimit(49.9)).toBe(49);
    expect(clampPageLimit(0.5)).toBe(1);
  });
});

describe("chunkRowsForBindLimit", () => {
  const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

  it("returns an empty array for empty input", () => {
    expect(chunkRowsForBindLimit([], 8)).toEqual([]);
  });

  it("keeps rows * paramsPerRow <= 100 and preserves order", () => {
    const rows = range(25);
    const chunks = chunkRowsForBindLimit(rows, 8);
    expect(chunks.map((chunk) => chunk.length)).toEqual([12, 12, 1]);
    for (const chunk of chunks) {
      expect(chunk.length * 8).toBeLessThanOrEqual(SQL_MAX_BOUND_PARAMS);
    }
    expect(chunks.flat()).toEqual(rows);
  });

  it("handles the exact 100-row boundary with one parameter per row", () => {
    expect(chunkRowsForBindLimit(range(100), 1)).toHaveLength(1);
    expect(chunkRowsForBindLimit(range(101), 1).map((chunk) => chunk.length)).toEqual([100, 1]);
  });

  it("throws for paramsPerRow outside 1..maxBoundParams or non-integer", () => {
    for (const invalid of [0, -1, 101, 2.5, Number.NaN]) {
      const error = captureArtifactGuardError(() => chunkRowsForBindLimit(range(3), invalid));
      expect(error.kind).toBe("sql_bound_params");
      expect(error.context).toBe("params_per_row");
      expect(error.limitBytes).toBe(SQL_MAX_BOUND_PARAMS);
    }
  });
});
