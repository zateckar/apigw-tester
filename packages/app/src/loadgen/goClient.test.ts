import { describe, expect, test } from "bun:test";
import type { AggregateBatch } from "@apigw/shared";
import { GoWorkerClient } from "./goClient.js";

/**
 * What GoWorkerClient's ingest path is allowed to do to a batch.
 *
 * The answer is now: nothing, except refuse one whose histogram layout it
 * cannot read. This used to be where per-window health verdicts were applied,
 * dropping measurements taken while the worker was stalled; that filter is gone
 * because it deleted evidence silently and on exactly the batches most worth
 * looking at. These exercise the path without a worker process; the end-to-end
 * path is covered by driver.go.test.ts.
 */

function batch(over: Partial<AggregateBatch> = {}): AggregateBatch {
  return { batchId: "b", cells: [], runs: [], tail: [], ...over };
}

function deliver(b: AggregateBatch, client: GoWorkerClient): void {
  (client as unknown as { deliver: (x: AggregateBatch) => void }).deliver(b);
}

describe("GoWorkerClient ingest", () => {
  test("hands a batch on untouched", () => {
    let got: AggregateBatch | null = null;
    const client = new GoWorkerClient({
      onBatch: (x) => { got = x; }, onStatus: () => {}, onStopped: () => {}
    });
    const sent = batch({
      batchId: "b1",
      cells: [{ nonBackendCount: 3 } as unknown as AggregateBatch["cells"][number]],
      tail: [{ ts: Date.now() } as unknown as AggregateBatch["tail"][number]]
    });

    deliver(sent, client);

    expect(got).toBe(sent);
  });

  test("delivers a batch even when the worker reports itself unwell", () => {
    // The generator's health is reported, not enforced: a stalled window shows
    // up as a fat tail in the histogram and in the run's validity verdict,
    // both of which an operator can see. Dropping the window instead left them
    // with a missing number and no way to ask for it back.
    let delivered = 0;
    const client = new GoWorkerClient({
      onBatch: () => { delivered++; }, onStatus: () => {}, onStopped: () => {}
    });

    deliver(batch({
      cells: [{ nonBackendCount: 10 } as unknown as AggregateBatch["cells"][number]],
      health: [{ windowTs: 0, fromTs: 0, toTs: 2_000, samples: 8, schedP99Ms: 900, schedMaxMs: 2_000, cpuPct: 99, goroutines: 40 }]
    }), client);

    expect(delivered).toBe(1);
  });

  test("a batch from a worker with mismatched bucket tables is not delivered at all", () => {
    // positional histograms merge silently; a wrong percentile outlives the run
    let delivered = 0;
    const client = new GoWorkerClient({ onBatch: () => { delivered++; }, onStatus: () => {}, onStopped: () => {} });
    (client as unknown as { bucketsOk: boolean }).bucketsOk = false;

    deliver(batch(), client);

    expect(delivered).toBe(0);
  });
});
