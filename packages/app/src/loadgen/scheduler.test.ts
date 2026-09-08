import { describe, expect, it } from "vitest";
import { targetRpsAt, TokenBucket } from "./scheduler.js";
import type { LoadProfile } from "@apigw/shared";
import { DEFAULT_LOAD_PROFILE } from "@apigw/shared";

const base: LoadProfile = { ...DEFAULT_LOAD_PROFILE, mode: "constant", rps: 10 };

describe("targetRpsAt", () => {
  const t0 = Date.now();

  it("constant mode", () => {
    expect(targetRpsAt({ ...base, mode: "constant", rps: 42 }, t0, t0)).toBe(42);
  });

  it("ramp mode from 10 to 110 over 10 min", () => {
    const p: LoadProfile = { ...base, mode: "ramp", rampFrom: 10, rampTo: 110, rampMinutes: 10 };
    expect(targetRpsAt(p, t0, t0)).toBe(10);
    const mid = targetRpsAt(p, t0 + 5 * 60_000, t0);
    expect(mid).toBeGreaterThan(45);
    expect(mid).toBeLessThan(75);
    expect(targetRpsAt(p, t0 + 20 * 60_000, t0)).toBe(110);
  });

  it("spike mode alternates base/peak", () => {
    const p: LoadProfile = {
      ...base, mode: "spike",
      spikeBase: 5, spikePeak: 100, spikeEveryMinutes: 10, spikeDurationSeconds: 60
    };
    expect(targetRpsAt(p, t0 + 30_000, t0)).toBe(100); // inside first spike
    expect(targetRpsAt(p, t0 + 5 * 60_000, t0)).toBe(5); // between spikes
    expect(targetRpsAt(p, t0 + 10.5 * 60_000, t0)).toBe(100); // second spike
  });

  it("sine-daily stays inside [min, max]", () => {
    const p: LoadProfile = { ...base, mode: "sine-daily", sineMin: 2, sineMax: 50 };
    for (let h = 0; h < 48; h++) {
      const v = targetRpsAt(p, t0 + h * 30 * 60_000, t0);
      expect(v).toBeGreaterThanOrEqual(1.99);
      expect(v).toBeLessThanOrEqual(50.01);
    }
  });
});

describe("TokenBucket", () => {
  it("issues roughly target rate per second", () => {
    const tb = new TokenBucket();
    const t0 = Date.now();
    let totalDue = 0;
    for (let i = 0; i < 20; i++) {
      const { due, targetRps } = tb.tick(t0 + i * 100, base, t0);
      expect(targetRps).toBe(10);
      totalDue += due;
    }
    expect(totalDue).toBeGreaterThanOrEqual(19);
    expect(totalDue).toBeLessThanOrEqual(21);
  });

  it("zero rps emits nothing and resets debt", () => {
    const tb = new TokenBucket();
    const p0: LoadProfile = { ...base, rps: 0 };
    const t0 = Date.now();
    let due = 0;
    for (let i = 0; i < 10; i++) due += tb.tick(t0 + i * 100, p0, t0).due;
    expect(due).toBe(0);
    const next = tb.tick(t0 + 10_000, { ...base, rps: 10 }, t0);
    expect(next.due).toBeLessThanOrEqual(10);
  });
});
