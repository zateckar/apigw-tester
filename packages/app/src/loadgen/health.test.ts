import { describe, expect, test } from "bun:test";
import { HEALTH_WINDOW_MS, VALIDITY_LIMITS, type ResidualCell, type WorkerHealthCell } from "@apigw/shared";
import { filterHealthyResiduals, stampHealthWindows, windowHealth, workerWindowHealth } from "./health.js";

const W = HEALTH_WINDOW_MS;
const t0 = Math.floor(Date.now() / W) * W;

function cell(over: Partial<WorkerHealthCell> = {}): WorkerHealthCell {
  return {
    windowTs: t0,
    fromTs: t0,
    toTs: t0 + W,
    samples: 8,
    schedP99Ms: 0.05,
    schedMaxMs: 0.4,
    cpuPct: 12,
    goroutines: 40,
    ...over
  };
}

function residual(windowTs: number): ResidualCell {
  return { windowTs, class: "small-rest", path: "gw", count: 10, sumMs: 3, hist: [] };
}

describe("workerWindowHealth", () => {
  test("a healthy window is not a reason", () => {
    const health = workerWindowHealth([cell()]);
    expect(health(t0)).toBeNull();
    expect(health(t0 + W - 1)).toBeNull();
  });

  test("a window nobody reported on is not assumed healthy", () => {
    // silence and health are different things: a residual with no evidence
    // behind it must be withheld, not waved through
    const health = workerWindowHealth([cell()]);
    expect(health(t0 + W)).toBe("generator health unavailable");
  });

  test("a window reported with no samples is not assumed healthy either", () => {
    const health = workerWindowHealth([cell({ samples: 0 })]);
    expect(health(t0)).toBe("generator health unavailable");
  });

  test("scheduling delay above the limit disqualifies the window", () => {
    const health = workerWindowHealth([cell({ schedP99Ms: VALIDITY_LIMITS.workerSchedP99Ms + 0.01 })]);
    expect(health(t0)).toBe("generator scheduling delay");
  });

  test("the limit itself passes", () => {
    const health = workerWindowHealth([cell({ schedP99Ms: VALIDITY_LIMITS.workerSchedP99Ms })]);
    expect(health(t0)).toBeNull();
  });

  test("a single bad wakeup does not disqualify the window", () => {
    // schedMaxMs is diagnostic only. Thresholding the worst event in a 2s
    // window is what made the metric this replaces reject good windows at the
    // host's timer granularity.
    const health = workerWindowHealth([cell({ schedP99Ms: 0.05, schedMaxMs: 400 })]);
    expect(health(t0)).toBeNull();
  });

  test("CPU saturation disqualifies the window", () => {
    const health = workerWindowHealth([cell({ cpuPct: VALIDITY_LIMITS.workerCpuPct + 1 })]);
    expect(health(t0)).toBe("generator CPU saturation");
  });

  test("a window reported twice keeps the worse report", () => {
    const bad = VALIDITY_LIMITS.workerSchedP99Ms + 5;
    expect(workerWindowHealth([cell(), cell({ schedP99Ms: bad })])(t0)).toBe("generator scheduling delay");
    expect(workerWindowHealth([cell({ schedP99Ms: bad }), cell()])(t0)).toBe("generator scheduling delay");
  });

  test("malformed cells are ignored rather than trusted", () => {
    const junk = [{ samples: 8 } as WorkerHealthCell, null as unknown as WorkerHealthCell];
    expect(workerWindowHealth(junk)(t0)).toBe("generator health unavailable");
  });

  test("both residual arms go through the one verdict", () => {
    // withholding contaminated residuals from the gateway arm only would shift
    // the reference distribution and understate the gateway by exactly the
    // generator's own stalls
    const health = workerWindowHealth([cell(), cell({ windowTs: t0 + W, schedP99Ms: 50 })]);
    const cells = [
      residual(t0),
      { ...residual(t0), path: "direct" },
      residual(t0 + W),
      { ...residual(t0 + W), path: "direct" }
    ];
    const kept = filterHealthyResiduals(cells, health);
    expect(kept.map((c) => `${c.windowTs - t0}/${c.path}`)).toEqual(["0/gw", "0/direct"]);
  });

  test("rows from a bad window are marked, not dropped", () => {
    // the request really was served; only its residual is in doubt
    const health = workerWindowHealth([cell({ schedP99Ms: 50 })]);
    const rows = [
      { ts: t0, timingReason: null },
      { ts: t0, timingReason: "already set" }
    ] as Parameters<typeof stampHealthWindows>[0];
    stampHealthWindows(rows, health);
    expect(rows.map((r) => r.timingReason)).toEqual(["generator scheduling delay", "already set"]);
  });
});

describe("windowHealth (control-plane fallback)", () => {
  test("asks the sampler once per window, not once per observation", () => {
    const asked: Array<[number, number]> = [];
    const health = windowHealth((from, to) => {
      asked.push([from, to]);
      return null;
    });
    for (let i = 0; i < 50; i++) health(t0 - W + i);
    health(t0 - 3 * W);
    expect(asked.length).toBe(2);
  });

  test("the right edge is clamped to now so the current window is answerable", () => {
    const asked: Array<[number, number]> = [];
    const health = windowHealth((from, to) => {
      asked.push([from, to]);
      return null;
    });
    health(Date.now());
    const [from, to] = asked[0]!;
    expect(to).toBeGreaterThan(from);
    expect(to).toBeLessThanOrEqual(Date.now());
  });
});
