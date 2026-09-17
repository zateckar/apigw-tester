import { describe, expect, test } from "bun:test";
import { HEALTH_WINDOW_MS, type AggregateBatch, type ResidualCell, type WorkerHealthCell } from "@apigw/shared";
import { GoWorkerClient } from "./goClient.js";

/**
 * Which health gate a batch is judged by.
 *
 * These exercise GoWorkerClient's ingest path without a worker process: the
 * choice between "the generator reported on itself" and "ask the control plane"
 * is made per batch, and getting it wrong does not fail — it silently applies
 * the wrong gate and either keeps contaminated residuals or discards good ones.
 * The end-to-end path is covered by driver.go.test.ts.
 */

const W = HEALTH_WINDOW_MS;
const t0 = Math.floor(Date.now() / W) * W;

function healthCell(over: Partial<WorkerHealthCell> = {}): WorkerHealthCell {
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

function batch(over: Partial<AggregateBatch> = {}): AggregateBatch {
  return { batchId: "b", cells: [], residuals: [], runs: [], tail: [], ...over };
}

/** Feed a batch through the ingest path and return what came out the far side. */
function ingest(b: AggregateBatch, client?: GoWorkerClient): { client: GoWorkerClient; got: AggregateBatch } {
  let got: AggregateBatch | null = null;
  const c = client ?? new GoWorkerClient({
    onBatch: (x) => { got = x; },
    onStatus: () => {},
    onStopped: () => {}
  });
  if (client) {
    // reuse across batches: rebind the sink so each call reports its own batch
    (c as unknown as { events: { onBatch: (x: AggregateBatch) => void } }).events.onBatch = (x) => { got = x; };
  }
  (c as unknown as { stampAndDeliver: (x: AggregateBatch) => void }).stampAndDeliver(b);
  if (got === null) throw new Error("batch was not delivered");
  return { client: c, got };
}

describe("GoWorkerClient health gating", () => {
  test("a batch carrying health is judged by the generator, not this event loop", () => {
    let asked = 0;
    const client = new GoWorkerClient({ onBatch: () => {}, onStatus: () => {}, onStopped: () => {} });
    client.setHealthCheck(() => { asked++; return "control plane unwell"; });

    const { got } = ingest(batch({ health: [healthCell()], residuals: [residual(t0)] }), client);

    expect(got.residuals).toHaveLength(1);
    expect(asked).toBe(0);
  });

  test("an empty health array is a verdict of its own, not a request to ask elsewhere", () => {
    // `[]` means "this generator measures itself and reported nothing for this
    // window"; falling back to the control plane there would judge the worker's
    // clock by a process that timed none of it
    let asked = 0;
    const client = new GoWorkerClient({ onBatch: () => {}, onStatus: () => {}, onStopped: () => {} });
    client.setHealthCheck(() => { asked++; return null; });

    const { got } = ingest(batch({ health: [], residuals: [residual(t0)] }), client);

    expect(got.residuals).toHaveLength(0);
    expect(asked).toBe(0);
  });

  test("a generator too old to report health falls back to the control-plane gate", () => {
    const client = new GoWorkerClient({ onBatch: () => {}, onStatus: () => {}, onStopped: () => {} });
    const asked: Array<[number, number]> = [];
    client.setHealthCheck((from, to) => { asked.push([from, to]); return null; });

    const { got } = ingest(batch({ residuals: [residual(t0 - W)] }), client);

    expect(got.residuals).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  test("the control-plane gate still withholds what it does not vouch for", () => {
    const client = new GoWorkerClient({ onBatch: () => {}, onStatus: () => {}, onStopped: () => {} });
    client.setHealthCheck(() => "event loop stalled");

    const { got } = ingest(batch({ residuals: [residual(t0 - W)], tail: [
      { ts: t0 - W, timingReason: null } as AggregateBatch["tail"][number]
    ] }), client);

    expect(got.residuals).toHaveLength(0);
    expect(got.tail[0]?.timingReason).toBe("event loop stalled");
  });

  test("health from an earlier batch still qualifies residuals in a later one", () => {
    // the two drains share a clock reading, so they normally travel together —
    // but a split socket write must not cost the run its residuals
    const { client } = ingest(batch({ batchId: "b1", health: [healthCell()] }));
    const { got } = ingest(batch({ batchId: "b2", health: [], residuals: [residual(t0)] }), client);

    expect(got.residuals).toHaveLength(1);
  });

  test("remembered health is bounded, and forgetting is not the same as passing", () => {
    // the memory exists to survive a batch split, not to accumulate for the
    // lifetime of the run; once it is trimmed, a window with no cell behind it
    // goes back to being unqualified
    const cells: WorkerHealthCell[] = [];
    for (let i = 0; i < 32; i++) cells.push(healthCell({ windowTs: t0 + i * W }));
    const newest = t0 + 31 * W;
    const { got } = ingest(batch({ health: cells, residuals: [residual(t0), residual(newest)] }));

    expect(got.residuals.map((c) => c.windowTs)).toEqual([newest]);
  });

  test("a batch from a worker with mismatched bucket tables is not delivered at all", () => {
    // positional histograms merge silently; a wrong percentile outlives the run
    let delivered = 0;
    const client = new GoWorkerClient({ onBatch: () => { delivered++; }, onStatus: () => {}, onStopped: () => {} });
    (client as unknown as { bucketsOk: boolean }).bucketsOk = false;

    (client as unknown as { stampAndDeliver: (x: AggregateBatch) => void }).stampAndDeliver(batch());

    expect(delivered).toBe(0);
  });
});
