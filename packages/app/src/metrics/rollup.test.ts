import { describe, expect, it } from "bun:test";
import { RESIDUAL_EDGES_MS } from "@apigw/shared";
import {
  addToResidualHistogram,
  emptyResidualHistogram,
  residualBucketIndex,
  residualPercentile
} from "./rollup.js";

describe("residual histogram layout", () => {
  it("is strictly increasing and straddles zero", () => {
    // This array IS the on-disk format: stored rows merge positionally, so a
    // duplicate edge would silently create a bucket nothing can land in, and a
    // reordering would reinterpret every row already written.
    for (let i = 1; i < RESIDUAL_EDGES_MS.length; i++) {
      expect(RESIDUAL_EDGES_MS[i]!).toBeGreaterThan(RESIDUAL_EDGES_MS[i - 1]!);
    }
    expect(RESIDUAL_EDGES_MS[0]!).toBeLessThan(0);
    expect(RESIDUAL_EDGES_MS).toContain(0);
    expect(RESIDUAL_EDGES_MS[RESIDUAL_EDGES_MS.length - 1]!).toBeGreaterThan(40_000);
  });

  it("resolves the sub-millisecond range non-backend time actually lives in", () => {
    // The latency histogram starts at 1ms, which would put a whole distribution
    // of local hops in one bucket and report every gateway as "0 to 1ms".
    expect(residualBucketIndex(0.05)).not.toBe(residualBucketIndex(0.5));
    expect(residualBucketIndex(0.1)).not.toBe(residualBucketIndex(0.2));
  });

  it("keeps negatives on their own side of zero", () => {
    expect(residualBucketIndex(-0.3)).toBeLessThan(residualBucketIndex(0));
    expect(residualBucketIndex(0)).toBeLessThan(residualBucketIndex(0.03));
  });

  it("reports a percentile below zero when most observations are", () => {
    // Without this a fast local hop is floored at zero and every percentile
    // above it is lifted by exactly the amount floored away.
    const h = emptyResidualHistogram();
    for (let i = 0; i < 100; i++) addToResidualHistogram(h, -2);
    expect(residualPercentile(h, 50)!).toBeLessThan(0);
  });

  it("has no percentile at all for an empty distribution", () => {
    // null, not 0: "we measured nothing" and "we measured zero" are different
    // answers, and only one of them may be subtracted from anything.
    expect(residualPercentile(emptyResidualHistogram(), 50)).toBeNull();
  });

  it("estimates a percentile within the bucket width", () => {
    const h = emptyResidualHistogram();
    for (let i = 0; i < 1_000; i++) addToResidualHistogram(h, 12);
    const p = residualPercentile(h, 50)!;
    expect(p).toBeGreaterThan(12 * 0.8);
    expect(p).toBeLessThan(12 * 1.2);
  });
});
