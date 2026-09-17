import { describe, expect, it } from "bun:test";
import {
  HEALTH_WINDOW_MS,
  HISTOGRAM_EDGES_MS,
  MEASUREMENT_VERSION,
  RAW_TAIL_PER_FLUSH,
  RESIDUAL_EDGES_MS,
  STATUS_BUCKETS,
  edgeTableMismatch,
  edgeTables,
  type RequestResult
} from "@apigw/shared";
import { aggregateBatch, selectTail } from "./aggregate.js";

let seq = 0;
function mk(over: Partial<RequestResult> = {}): RequestResult {
  return {
    runId: "r1", requestId: `req${++seq}`, ts: 1_800_000_000_000, protocol: "rest",
    endpoint: "GET /api/pets", class: "small-rest", method: "GET", status: 200,
    latencyMs: 100, ttfbMs: 40, serverMs: 10,
    measurementVersion: MEASUREMENT_VERSION, timingReason: null,
    bytesReq: 10, bytesResp: 100, reachedBackend: true, error: null,
    ...over
  };
}

const total = (h: number[]): number => h.reduce((a, b) => a + b, 0);

describe("source-side aggregation", () => {
  it("rolls a batch into one cell per minute, protocol, endpoint and class", () => {
    const t = 1_800_000_000_000;
    const agg = aggregateBatch({
      batchId: "b1",
      results: [
        mk({ ts: t }),
        mk({ ts: t + 10 }),
        mk({ ts: t + 60_000 }),                       // next minute
        mk({ ts: t, class: "soap", protocol: "soap", endpoint: "SOAP getPetById" })
      ]
    });
    expect(agg.cells).toHaveLength(3);
    const first = agg.cells.find((c) => c.bucketTs === t && c.cls === "small-rest")!;
    expect(first.count).toBe(2);
    expect(first.firstTs).toBe(t);
    expect(first.lastTs).toBe(t + 10);
  });

  it("carries the same counters the store would have derived per request", () => {
    const agg = aggregateBatch({
      batchId: "b2",
      results: [
        mk({ status: 200, latencyMs: 10 }),
        mk({ status: 503, latencyMs: 40, reachedBackend: false }),
        mk({ status: 404, latencyMs: 20, reachedBackend: false }),   // gateway said no
        mk({ status: 404, latencyMs: 30, reachedBackend: true })     // backend said no
      ]
    });
    const c = agg.cells[0]!;
    expect(c.count).toBe(4);
    expect(c.ok2xx).toBe(1);
    expect(c.errors).toBe(1);
    expect(c.rejected4xx).toBe(2);
    // the distinction the deliberately-invalid slice is scored on
    expect(c.rejected4xxGw).toBe(1);
    expect(c.reachedBackend).toBe(2);
    expect(c.latencySumMs).toBe(100);
    expect(c.maxLatencyMs).toBe(40);
    expect(total(c.hist)).toBe(4);
    expect(total(c.statusHist)).toBe(4);
    expect(c.hist).toHaveLength(HISTOGRAM_EDGES_MS.length + 1);
    expect(c.statusHist).toHaveLength(STATUS_BUCKETS.length);
  });

  it("keys residuals by health window, not by minute", () => {
    // the control plane withholds contaminated windows. At minute grain that
    // choice would be between discarding a whole minute and keeping a stall.
    const t = 1_800_000_000_000;
    const agg = aggregateBatch({
      batchId: "b3",
      results: [mk({ ts: t }), mk({ ts: t + HEALTH_WINDOW_MS })]
    });
    const gw = agg.residuals.filter((r) => r.path === "gw").map((r) => r.windowTs).sort();
    expect(gw).toEqual([t, t + HEALTH_WINDOW_MS]);
    expect(agg.residuals[0]!.hist).toHaveLength(RESIDUAL_EDGES_MS.length + 1);
  });

  it("admits a residual only when both clocks are present and the schema matches", () => {
    const agg = aggregateBatch({
      batchId: "b4",
      results: [
        mk(),                                              // counted
        mk({ serverMs: null }),                            // gateway answered it
        mk({ ttfbMs: null }),                              // no headers arrived
        mk({ timingReason: "local event-loop stall" }),    // generator unwell
        mk({ measurementVersion: 2 })                      // a different quantity
      ],
      baseline: [{ ts: 1_800_000_000_000, class: "small-rest", residualMs: 0.25 }]
    });
    const gw = agg.residuals.filter((r) => r.path === "gw");
    expect(gw).toHaveLength(1);
    expect(gw[0]!.count).toBe(1);
    expect(gw[0]!.sumMs).toBe(30);
    // the direct arm rides the same batch, so a window's two distributions
    // always commit over matching time
    const direct = agg.residuals.filter((r) => r.path === "direct");
    expect(direct).toHaveLength(1);
    expect(direct[0]!.sumMs).toBe(0.25);
    // and all five requests still count toward throughput and latency
    expect(agg.cells[0]!.count).toBe(5);
  });

  it("takes connection acquisition out of the residual", () => {
    // a DNS lookup, a TCP handshake and a TLS handshake all sit inside ttfb and
    // none of them is per-request gateway cost. Left in, a gateway is charged
    // for every connection the pool failed to keep — and the reference stream,
    // running a near-idle pool of its own, pays that on a different schedule
    // entirely, so the difference would land squarely in the Δ.
    const agg = aggregateBatch({
      batchId: "c1",
      results: [mk({ ttfbMs: 40, serverMs: 10, connectMs: 12, connReused: false })]
    });
    expect(agg.residuals[0]!.sumMs).toBe(18);
    const c = agg.cells[0]!;
    expect(c.connSetups).toBe(1);
    expect(c.connSetupSumMs).toBe(12);
    expect(c.connMeasured).toBe(1);
  });

  it("counts a pool hit as measured but not as a setup", () => {
    // a hit that waited on the pool waited on *us*, so its cost still comes off
    // the residual — it is simply not evidence of the gateway churning sockets
    const agg = aggregateBatch({
      batchId: "c2",
      results: [mk({ ttfbMs: 40, serverMs: 10, connectMs: 0.05, connReused: true })]
    });
    expect(agg.residuals[0]!.sumMs).toBeCloseTo(29.95, 10);
    const c = agg.cells[0]!;
    expect(c.connMeasured).toBe(1);
    expect(c.connSetups).toBe(0);
    expect(c.connSetupSumMs).toBe(0);
  });

  it("does not read an unmeasured connection as a free one", () => {
    // null is "this generator cannot see connection events" (the in-process
    // driver), which must not be reported as perfect reuse — hence the share
    // being a fraction of connMeasured rather than of the request count
    const agg = aggregateBatch({
      batchId: "c3",
      results: [mk({ ttfbMs: 40, serverMs: 10, connectMs: null })]
    });
    expect(agg.residuals[0]!.sumMs).toBe(30);
    expect(agg.cells[0]!.connMeasured).toBe(0);
    expect(agg.cells[0]!.connSetups).toBe(0);
  });

  it("counts each run's contribution to each minute exactly", () => {
    const t = 1_800_000_000_000;
    const agg = aggregateBatch({
      batchId: "b5",
      results: [mk({ ts: t, runId: "a" }), mk({ ts: t, runId: "b" }), mk({ ts: t, runId: "a" })]
    });
    const a = agg.runs.find((r) => r.runId === "a")!;
    expect(a.count).toBe(2);
    expect(agg.runs.find((r) => r.runId === "b")!.count).toBe(1);
  });

  it("rejects a result with no run identity rather than storing an orphan row", () => {
    expect(() => aggregateBatch({ batchId: "b6", results: [mk({ runId: "" })] }))
      .toThrow("runId");
  });
});

describe("raw tail selection", () => {
  it("keeps everything that fits and bounds what does not", () => {
    const small = Array.from({ length: 10 }, () => mk());
    expect(selectTail(small)).toHaveLength(10);
    const huge = Array.from({ length: 50_000 }, () => mk());
    expect(selectTail(huge)).toHaveLength(RAW_TAIL_PER_FLUSH);
  });

  it("takes failures and rare classes first, then fills with ordinary traffic", () => {
    const rows = [
      ...Array.from({ length: 5_000 }, (_, i) => mk({ ts: 1_800_000_000_000 + i })),
      ...Array.from({ length: 7 }, () => mk({ status: 500, error: "boom" })),
      ...Array.from({ length: 3 }, () => mk({ class: "soap" }))
    ];
    const tail = selectTail(rows);
    expect(tail).toHaveLength(RAW_TAIL_PER_FLUSH);
    expect(tail.filter((r) => r.status >= 500)).toHaveLength(7);
    expect(tail.filter((r) => r.class === "soap")).toHaveLength(3);
    // and it still reads as a timeline rather than errors-then-crud
    for (let i = 1; i < tail.length; i++) expect(tail[i]!.ts).toBeGreaterThanOrEqual(tail[i - 1]!.ts);
  });

  it("does not let a flood of failures exceed the budget either", () => {
    const rows = Array.from({ length: 10_000 }, () => mk({ status: 500, error: "boom" }));
    expect(selectTail(rows)).toHaveLength(RAW_TAIL_PER_FLUSH);
  });
});

describe("bucket-table agreement between producers", () => {
  it("accepts an identical declaration", () => {
    expect(edgeTableMismatch(edgeTables())).toBeNull();
    // a JSON round trip must not be a mismatch — this is how it arrives
    expect(edgeTableMismatch(JSON.parse(JSON.stringify(edgeTables())) as never)).toBeNull();
  });

  it("names the first divergence rather than silently mixing two layouts", () => {
    // these arrays merge positionally on disk, so a producer that disagrees
    // about one edge writes a different distribution into the same column and
    // every percentile read back is wrong — for as long as the database lives
    const t = edgeTables();
    expect(edgeTableMismatch({ ...t, latency: t.latency.slice(0, -1) }))
      .toContain("latency: producer has 39 buckets");
    const bent = [...t.residual];
    bent[3] = (bent[3] as number) + 1;
    expect(edgeTableMismatch({ ...t, residual: bent })).toContain("residual[3]");
    expect(edgeTableMismatch({ ...t, status: [...t.status.slice(0, -1), "6xx"] })).toContain("status[17]");
    expect(edgeTableMismatch(undefined)).toBe("producer declared no bucket tables");
  });
});
