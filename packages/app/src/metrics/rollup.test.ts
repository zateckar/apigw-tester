import { describe, expect, it } from "vitest";
import { HISTOGRAM_EDGES_MS } from "@apigw/shared";
import {
  bucketIndex,
  emptyHistogram,
  addToHistogram,
  mergeHistograms,
  totalInHistogram,
  percentile
} from "./rollup.js";

describe("histogram buckets", () => {
  it("has 41 buckets (40 edges + overflow)", () => {
    expect(emptyHistogram().length).toBe(41);
    expect(HISTOGRAM_EDGES_MS.length).toBe(40);
  });

  it("edges are strictly increasing", () => {
    for (let i = 1; i < HISTOGRAM_EDGES_MS.length; i++) {
      expect(HISTOGRAM_EDGES_MS[i]).toBeGreaterThan(HISTOGRAM_EDGES_MS[i - 1] as number);
    }
  });

  it("bucketIndex finds the lower bucket", () => {
    expect(bucketIndex(0.5)).toBe(0);
    expect(bucketIndex(1)).toBe(0);
    expect(bucketIndex(1.1)).toBe(1);
    expect(bucketIndex(1e9)).toBe(40);
  });
});

describe("percentile", () => {
  it("zero on empty histogram", () => {
    expect(percentile(emptyHistogram(), 50)).toBe(0);
  });

  it("single sample returns that latency within the bucket", () => {
    const h = emptyHistogram();
    addToHistogram(h, 50);
    expect(percentile(h, 50)).toBeGreaterThanOrEqual(0);
    expect(percentile(h, 50)).toBeLessThanOrEqual(HISTOGRAM_EDGES_MS[bucketIndex(50)] as number);
  });

  it("monotone: p50 <= p90 <= p99 for a wide distribution", () => {
    const h = emptyHistogram();
    for (let i = 0; i < 1000; i++) addToHistogram(h, 1 + (i % 500));
    const p50 = percentile(h, 50);
    const p90 = percentile(h, 90);
    const p99 = percentile(h, 99);
    expect(p50).toBeLessThanOrEqual(p90);
    expect(p90).toBeLessThanOrEqual(p99);
    expect(p99).toBeGreaterThan(p50);
  });

  it("mergeHistograms is additive", () => {
    const a = emptyHistogram();
    const b = emptyHistogram();
    addToHistogram(a, 10, 3);
    addToHistogram(b, 10, 2);
    addToHistogram(b, 1000, 1);
    mergeHistograms(a, b);
    expect(totalInHistogram(a)).toBe(6);
    expect(a[bucketIndex(10)]).toBe(5);
  });
});
