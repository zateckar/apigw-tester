import { describe, expect, it } from "vitest";
import { sampleLatency, decideChaos, DEFAULT_CHAOS } from "./latency.js";

describe("sampleLatency", () => {
  it("fixed returns the exact value", () => {
    expect(sampleLatency({ kind: "fixed", ms: 42 }, Math.random)).toBe(42);
  });

  it("uniform stays inside [min,max]", () => {
    for (let i = 0; i < 500; i++) {
      const v = sampleLatency({ kind: "uniform", minMs: 10, maxMs: 100 }, Math.random);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("normal is centered near the mean", () => {
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) sum += sampleLatency({ kind: "normal", meanMs: 100, stddevMs: 20 }, Math.random);
    const mean = sum / n;
    expect(mean).toBeGreaterThan(92);
    expect(mean).toBeLessThan(108);
  });

  it("normal never returns negatives", () => {
    for (let i = 0; i < 200; i++) {
      expect(sampleLatency({ kind: "normal", meanMs: 0, stddevMs: 50 }, Math.random)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("decideChaos", () => {
  it("returns ok when chaos is disabled", () => {
    for (let i = 0; i < 100; i++) expect(decideChaos(DEFAULT_CHAOS, Math.random)).toBe("ok");
  });

  it("respects configured rates roughly", () => {
    const counts = { ok: 0, error: 0, timeout: 0 };
    for (let i = 0; i < 20000; i++) {
      counts[decideChaos({ errorRatePct: 10, timeoutRatePct: 5 }, Math.random)]++;
    }
    expect(counts.error / 20000).toBeGreaterThan(0.07);
    expect(counts.error / 20000).toBeLessThan(0.13);
    expect(counts.timeout / 20000).toBeGreaterThan(0.03);
    expect(counts.timeout / 20000).toBeLessThan(0.08);
  });
});
