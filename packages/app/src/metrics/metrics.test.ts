import { describe, expect, it } from "vitest";
import { LIMITS, type RequestResult } from "@apigw/shared";
import { createMetricsStore } from "./server.js";

function mk(over: Partial<RequestResult> = {}): RequestResult {
  return {
    runId: "r1", ts: Date.now(), protocol: "rest", endpoint: "GET /api/pets",
    class: "small-rest", method: "GET", status: 200,
    latencyMs: 100, baselineMs: 0, overheadMs: 100,
    bytesReq: 10, bytesResp: 100, error: null,
    ...over
  };
}

describe("summary counting", () => {
  it("counts rows in the current minute exactly once", () => {
    // regression: roll-ups are written during ingest, and summary() also added a
    // "live tail" of the same raw rows, doubling everything in the open bucket
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({ batchId: "b1", results: Array.from({ length: 10 }, () => mk({ ts: now })) });

    const sum = s.summary(300_000);
    expect(sum.total).toBe(10);
    expect(sum.bytes.resp).toBe(1000);
    expect(sum.bytes.req).toBe(100);
    s.close();
  });

  it("counts rows from an earlier minute exactly once", () => {
    const s = createMetricsStore(":memory:");
    s.ingestBatch({ batchId: "b2", results: Array.from({ length: 10 }, () => mk({ ts: Date.now() - 120_000 })) });
    expect(s.summary(300_000).total).toBe(10);
    s.close();
  });

  it("reconciles: perEndpoint and perClass both sum to the headline total", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({
      batchId: "b3",
      results: [
        ...Array.from({ length: 7 }, () => mk({ ts: now })),
        ...Array.from({ length: 3 }, () => mk({ ts: now, protocol: "soap", endpoint: "SOAP getPetById", class: "soap" })),
        ...Array.from({ length: 2 }, () => mk({ ts: now - 90_000, endpoint: "POST /api/pets" }))
      ]
    });
    const sum = s.summary(300_000);
    expect(sum.total).toBe(12);
    expect(sum.perEndpoint.reduce((a, e) => a + e.total, 0)).toBe(sum.total);
    expect(sum.perClass.reduce((a, c) => a + c.total, 0)).toBe(sum.total);
    expect(sum.perProtocol.reduce((a, p) => a + p.total, 0)).toBe(sum.total);
    s.close();
  });

  it("lists an endpoint once even when several classes hit it", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({
      batchId: "b3b",
      results: [
        ...Array.from({ length: 4 }, () => mk({ ts: now, endpoint: "GET /api/pets", class: "small-rest" })),
        ...Array.from({ length: 6 }, () => mk({ ts: now, endpoint: "GET /api/pets", class: "concurrency" }))
      ]
    });
    const sum = s.summary(300_000);
    const rows = sum.perEndpoint.filter((e) => e.endpoint === "GET /api/pets");
    expect(rows.length).toBe(1);
    expect(rows[0]?.total).toBe(10);
    // but the class breakdown still separates them
    expect(sum.perClass.length).toBe(2);
    expect(sum.perEndpoint.reduce((a, e) => a + e.total, 0)).toBe(sum.total);
    s.close();
  });

  it("tracks contract violations and whether they were rejected", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({
      batchId: "b4",
      results: [
        ...Array.from({ length: 8 }, () => mk({ ts: now, class: "invalid", endpoint: "POST /api/pets [invalid]", status: 400 })),
        ...Array.from({ length: 2 }, () => mk({ ts: now, class: "invalid", endpoint: "POST /api/pets [invalid]", status: 201 }))
      ]
    });
    const c = s.summary(300_000).contract;
    expect(c.invalidSent).toBe(10);
    expect(c.rejected4xx).toBe(8);
    expect(c.wronglyAccepted).toBe(2); // the gateway let 2 through — that's the alarm
    s.close();
  });
});

describe("ingest durability", () => {
  it("is atomic: a bad row commits nothing and the batch can be retried", () => {
    const s = createMetricsStore(":memory:");
    const good = mk();
    const poison = mk({ runId: undefined as unknown as string });

    expect(() => s.ingestBatch({ batchId: "mixed", results: [good, poison] })).toThrow();
    // nothing from the failed batch is visible
    expect(s.summary(300_000).total).toBe(0);

    // and the batch id was not burned, so an at-least-once client can retry
    const retry = s.ingestBatch({ batchId: "mixed", results: [good] });
    expect(retry.duplicate).toBeUndefined();
    expect(retry.ingested).toBe(1);
    expect(s.summary(300_000).total).toBe(1);
    s.close();
  });

  it("still dedupes a genuinely repeated batch", () => {
    const s = createMetricsStore(":memory:");
    expect(s.ingestBatch({ batchId: "dup", results: [mk()] }).ingested).toBe(1);
    expect(s.ingestBatch({ batchId: "dup", results: [mk()] }).duplicate).toBe(true);
    expect(s.summary(300_000).total).toBe(1);
    s.close();
  });
});

describe("query bounds", () => {
  it("clamps an absurd timeseries range instead of allocating it", () => {
    // regression: from=0 produced ~30M point objects and OOM-killed the process
    const s = createMetricsStore(":memory:");
    const ts = s.timeseries(60, 0, Date.now());
    expect(ts.points.length).toBeLessThanOrEqual(LIMITS.timeseriesPoints);
    expect(ts.truncated).toBe(true);
    s.close();
  });

  it("handles a reversed or non-finite range without throwing", () => {
    const s = createMetricsStore(":memory:");
    expect(s.timeseries(60, Date.now(), Date.now() - 10_000).points.length).toBeGreaterThanOrEqual(0);
    expect(s.timeseries(60, Number.NaN, Number.NaN).points.length).toBeGreaterThanOrEqual(0);
    s.close();
  });

  it("never returns more rows than asked, even for negative or NaN limits", () => {
    // regression: SQLite reads LIMIT -1 as "no limit", so recent(-1) dumped the table
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({ batchId: "many", results: Array.from({ length: 50 }, (_, i) => mk({ ts: now - i })) });
    expect(s.recent(-1).length).toBeLessThanOrEqual(LIMITS.recentLimit);
    expect(s.recent(-1).length).toBeGreaterThan(0);
    expect(s.recent(Number.NaN).length).toBeLessThanOrEqual(LIMITS.recentLimit);
    expect(s.recent(5).length).toBe(5);
    expect(s.recent(10_000).length).toBeLessThanOrEqual(LIMITS.recentLimit);
    s.close();
  });
});

describe("long-window summaries", () => {
  it("uses the hour layer for wide windows and still totals correctly", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({
      batchId: "wide",
      results: [
        mk({ ts: now }),
        mk({ ts: now - 2 * 3600_000 }),
        mk({ ts: now - 20 * 3600_000 })
      ]
    });
    expect(s.summary(86_400_000).total).toBe(3);   // 24h → hour buckets
    expect(s.summary(300_000).total).toBe(1);      // 5m → minute buckets
    s.close();
  });
});

describe("timeseries partial buckets", () => {
  const MIN = 60_000;

  it("marks the current bucket partial when it has data", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({ batchId: "cur", results: [mk({ ts: now })] });
    const ts = s.timeseries(60, now - 5 * MIN, now);
    const cur = ts.points[ts.points.length - 1];
    expect(cur?.total).toBe(1);
    expect(cur?.partial).toBe(true);
    s.close();
  });

  it("marks the current bucket and the zero tail partial only while traffic is live", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    // data 2 minutes ago, nothing since: the tail is empty but the store saw
    // a batch just now, so those zeros are still "no data yet", not silence
    s.ingestBatch({ batchId: "tail", results: [mk({ ts: now - 2 * MIN })] });
    const ts = s.timeseries(60, now - 5 * MIN, now);
    const curB = Math.floor(now / MIN) * MIN;
    for (const p of ts.points) {
      if (p.ts === now - 2 * MIN - (now % MIN)) {
        expect(p.total).toBe(1);
        expect(p.partial).toBeUndefined();
      }
      if (p.ts > now - 2 * MIN && p.ts < curB) {
        expect(p.total).toBe(0);
        expect(p.partial).toBe(true);
      }
    }
    expect(ts.points[ts.points.length - 1]?.partial).toBe(true);
    s.close();
  });

  it("treats the tail as honest zeros once a run has ended", () => {
    // no batch ever ingested -> store has no notion of live traffic
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    const ts = s.timeseries(60, now - 5 * MIN, now);
    expect(ts.points.some((p) => p.partial)).toBe(false);
    s.close();
  });

  it("never marks partial for a historical window", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({ batchId: "hist", results: [mk({ ts: now - 30 * MIN })] });
    const ts = s.timeseries(60, now - 35 * MIN, now - 20 * MIN);
    expect(ts.points.some((p) => p.partial)).toBe(false);
    s.close();
  });
});

describe("recent-tail sampling", () => {
  it("keeps every row below the sampling threshold", () => {
    // 100 rows over a 5s flush = 20 rps — sampling must be a no-op here
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({ batchId: "small", results: Array.from({ length: 100 }, (_, i) => mk({ ts: now - i })) });
    expect(s.recent(500).length).toBe(100);
    s.close();
  });

  it("downsamples crud at high rates while errors and non-crud classes survive", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    // 5000 rows / 5s flush = 1000 rps → k = 10 for crud classes
    const results: ReturnType<typeof mk>[] = [
      ...Array.from({ length: 4990 }, (_, i) => mk({ ts: now - i })),
      ...Array.from({ length: 5 }, (_, i) => mk({ ts: now - i, status: 500, error: "boom" })),
      ...Array.from({ length: 5 }, (_, i) => mk({ ts: now - i, class: "soap", endpoint: "SOAP getPetById" }))
    ];
    s.ingestBatch({ batchId: "huge", results });

    const tail = s.recent(500);
    expect(tail.length).toBeGreaterThanOrEqual(400);
    expect(tail.length).toBeLessThan(600);
    expect(tail.filter((r) => r.status >= 500).length).toBe(5);
    expect(tail.filter((r) => r.class === "soap").length).toBe(5);
    // roll-ups are exact regardless of the raw sampling
    expect(s.summary(300_000).total).toBe(5000);
    s.close();
  });
});

describe("reset and prune", () => {
  it("resetAll wipes metrics and runs but keeps config rows", () => {
    const s = createMetricsStore(":memory:");
    s.ingestBatch({ batchId: "wipe", results: [mk(), mk({ ts: Date.now() - 2 * 3600_000 })] });
    s.recordRunStart("run-1", { mode: "constant" });
    s.recordRunStop("run-1");
    s.writeGateway({ rest: { baseUrl: "http://x", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "" },
                     soap: { baseUrl: "http://y", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "" } });

    s.resetAll();

    expect(s.summary(7 * 86_400_000).total).toBe(0);
    expect(s.recent(10)).toEqual([]);
    expect(s.listRuns()).toEqual([]);
    // a repeat of the same batch id must not be swallowed as a duplicate
    expect(s.ingestBatch({ batchId: "wipe", results: [mk()] }).ingested).toBe(1);
    expect(s.readGateway()).toBeTruthy();
    s.close();
  });

  it("pruneRuns removes old stopped runs but never an unstopped one", async () => {
    const s = createMetricsStore(":memory:");
    s.recordRunStart("stopped-run", {});
    s.recordRunStart("still-running", {});
    s.recordRunStop("stopped-run");
    // let "now" move past started_at so a zero-length horizon matches them
    await new Promise((r) => setTimeout(r, 5));

    expect(s.pruneRuns(0)).toBe(1);
    const remaining = s.listRuns().map((r) => r.runId);
    expect(remaining).not.toContain("stopped-run");
    expect(remaining).toContain("still-running");
    s.close();
  });
});
