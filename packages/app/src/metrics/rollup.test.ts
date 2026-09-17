import { describe, expect, it } from "bun:test";
import { RESIDUAL_EDGES_MS, minSamplesForPercentile, referenceRps } from "@apigw/shared";
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

  it("resolves the sub-millisecond range a local residual actually lives in", () => {
    // The latency histogram starts at 1ms, which would put an entire reference
    // distribution in one bucket and report every gateway as costing "0 to 1ms".
    expect(residualBucketIndex(0.05)).not.toBe(residualBucketIndex(0.5));
    expect(residualBucketIndex(0.1)).not.toBe(residualBucketIndex(0.2));
  });

  it("keeps negatives on their own side of zero", () => {
    expect(residualBucketIndex(-0.3)).toBeLessThan(residualBucketIndex(0));
    expect(residualBucketIndex(0)).toBeLessThan(residualBucketIndex(0.03));
  });

  it("reports a percentile below zero when most observations are", () => {
    // Without this the reference arm is floored at zero and the gateway is
    // understated by exactly the amount floored away.
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

describe("measurement sizing", () => {
  it("demands ten observations beyond the percentile being reported", () => {
    expect(minSamplesForPercentile(50)).toBe(20);
    expect(minSamplesForPercentile(90)).toBe(100);
    expect(minSamplesForPercentile(95)).toBe(200);
    expect(minSamplesForPercentile(99)).toBe(1_000);
  });

  it("scales the reference stream with the load, inside fixed bounds", () => {
    // it must not perturb a small run, and must not run too thin to support a
    // tail percentile on a large one
    expect(referenceRps(0)).toBe(0);
    expect(referenceRps(10)).toBe(2);        // floor
    expect(referenceRps(1_000)).toBe(20);    // 2%
    expect(referenceRps(10_000)).toBe(200);  // still 2% at the top of the range
  });

  it("keeps the declared share across the whole supported rate range", () => {
    // regression: the ceiling was 50, so above 2,500 rps the share silently
    // fell away — 1% at 5k, 0.5% at 10k — and the control arm became the
    // binding constraint on every percentile the Δ could report
    for (const rps of [2_500, 5_000, 10_000]) {
      expect(referenceRps(rps)).toBe(rps * 0.02);
    }
  });
});
