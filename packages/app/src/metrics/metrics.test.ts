import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, type RequestResult, type SystemSample } from "@apigw/shared";
import { createMetricsStore } from "./server.js";
import { openDb } from "./db.js";

let seq = 0;

function mk(over: Partial<RequestResult> = {}): RequestResult {
  return {
    runId: "r1", requestId: `req${++seq}`, ts: Date.now(), protocol: "rest", endpoint: "GET /api/pets",
    class: "small-rest", method: "GET", status: 200,
    latencyMs: 100, ttfbMs: 80, baselineMs: 0, overheadMs: 100,
    bytesReq: 10, bytesResp: 100, reachedBackend: true, error: null,
    ...over
  };
}

/** n identical results, for the "the whole run looked like this" cases. */
function many(n: number, over: Partial<RequestResult> = {}): RequestResult[] {
  return Array.from({ length: n }, () => mk(over));
}

describe("status dimension", () => {
  it("a gateway rejecting every request does not read as a healthy run", () => {
    // regression: errors counted only 5xx and network failures, so a wrong API
    // key (401 on everything) or a tripped quota (429) reported errorPct = 0 —
    // the most likely first-run outcome, rendered as perfect health
    const s = createMetricsStore(":memory:");
    s.ingestBatch({ batchId: "all-401", results: many(20, { status: 401 }) });

    const sum = s.summary(300_000);
    expect(sum.status.unauthorized).toBe(20);
    expect(sum.status.ok).toBe(0);
    expect(sum.unexpectedFailures).toBe(20);
    expect(sum.unexpectedFailurePct).toBe(100);
    s.close();
  });

  it("keeps 502/503/504 apart from a backend 500", () => {
    const s = createMetricsStore(":memory:");
    s.ingestBatch({
      batchId: "mixed-5xx",
      results: [...many(3, { status: 500 }), ...many(2, { status: 502 }),
        ...many(1, { status: 504 }), ...many(4, { status: 0, error: "timeout/abort" })]
    });

    const sum = s.summary(300_000);
    const count = (b: string) => sum.status.buckets.find((x) => x.bucket === b)?.count ?? 0;
    expect(count("500")).toBe(3);
    expect(count("502")).toBe(2);
    expect(count("504")).toBe(1);
    expect(count("net")).toBe(4);
    // the gateway's own faults: everything except the backend's three 500s
    expect(sum.status.gatewayErrors).toBe(7);
    expect(sum.status.serverErrors).toBe(6);
    s.close();
  });

  it("does not count the deliberate invalid slice as a failure", () => {
    // the invalid class is *supposed* to be rejected; counting its 4xx as
    // failures would peg the headline number at the invalid ratio forever
    const s = createMetricsStore(":memory:");
    s.ingestBatch({
      batchId: "with-invalid",
      results: [
        ...many(90, { status: 200 }),
        ...many(10, { status: 400, class: "invalid", endpoint: "POST /api/pets [invalid]" })
      ]
    });

    const sum = s.summary(300_000);
    expect(sum.status.clientErrors).toBe(10);
    expect(sum.unexpectedFailures).toBe(0);
    s.close();
  });

  it("still blames the gateway when an invalid request fails the wrong way", () => {
    // a 502 on an invalid request is not "validation working", it is the
    // gateway falling over — that must not be excused by the class
    const s = createMetricsStore(":memory:");
    s.ingestBatch({
      batchId: "invalid-502",
      results: [...many(5, { status: 400, class: "invalid" }), ...many(2, { status: 502, class: "invalid" })]
    });
    expect(s.summary(300_000).unexpectedFailures).toBe(2);
    s.close();
  });

  it("merges status counts across batches landing in the same bucket", () => {
    // the roll-up upsert sums the status histogram element-wise in SQL; a run
    // flushes every 5s, so a one-minute bucket is almost always written several
    // times and a broken merge would silently lose or double statuses
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    s.ingestBatch({ batchId: "m1", results: [...many(5, { ts, status: 200 }), ...many(2, { ts, status: 429 })] });
    s.ingestBatch({ batchId: "m2", results: [...many(3, { ts, status: 200 }), ...many(1, { ts, status: 502 })] });

    const sum = s.summary(300_000);
    const count = (b: string) => sum.status.buckets.find((x) => x.bucket === b)?.count ?? 0;
    expect(count("2xx")).toBe(8);
    expect(count("429")).toBe(2);
    expect(count("502")).toBe(1);
    // and the distribution still reconciles with the headline total
    expect(sum.status.buckets.reduce((a, b) => a + b.count, 0)).toBe(sum.total);
    s.close();
  });

  it("upgrades a database written before the status dimension existed", () => {
    // every existing deployment hits this path on its first restart after the
    // upgrade: the new columns must be added, old buckets must survive, and
    // their missing status counts must read as absent rather than fabricated
    const dir = mkdtempSync(join(tmpdir(), "apigw-migrate-"));
    const dbPath = join(dir, "metrics.db");
    const ts = Date.now();
    try {
      const old = createMetricsStore(dbPath);
      old.ingestBatch({ batchId: "before", results: many(6, { ts, status: 200 }) });
      old.close();

      // rewind to the pre-upgrade schema
      const raw = openDb(dbPath);
      for (const table of ["rollup_minute", "rollup_hour"]) {
        for (const col of ["status_hist", "reached_backend", "rejected4xx_gw"]) {
          raw.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
        }
      }
      raw.exec("ALTER TABLE requests_raw DROP COLUMN request_id");
      raw.exec("ALTER TABLE requests_raw DROP COLUMN reached_backend");
      raw.close();

      // reopening runs migrate(); the old rows must still be there and usable
      const upgraded = createMetricsStore(dbPath);
      expect(upgraded.summary(300_000).total).toBe(6);
      // the pre-upgrade bucket contributes no statuses — better an honest gap
      // than six invented 2xx that were never actually classified
      expect(upgraded.summary(300_000).status.buckets).toEqual([]);

      // and new traffic in that same bucket still records and merges cleanly
      upgraded.ingestBatch({ batchId: "after", results: many(2, { ts, status: 503 }) });
      const sum = upgraded.summary(300_000);
      expect(sum.total).toBe(8);
      expect(sum.status.gatewayErrors).toBe(2);
      expect(upgraded.recent(10).length).toBeGreaterThan(0);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits each class into client and gateway errors", () => {
    const s = createMetricsStore(":memory:");
    s.ingestBatch({
      batchId: "per-class",
      results: [
        ...many(4, { status: 200, class: "soap", protocol: "soap", endpoint: "SOAP getPetById" }),
        ...many(3, { status: 429, class: "soap", protocol: "soap", endpoint: "SOAP getPetById" }),
        ...many(2, { status: 503, class: "soap", protocol: "soap", endpoint: "SOAP getPetById" })
      ]
    });
    const soap = s.summary(300_000).perClass.find((c) => c.cls === "soap");
    expect(soap?.clientErrors).toBe(3);
    expect(soap?.gatewayErrors).toBe(2);
    s.close();
  });
});

describe("measurement validity", () => {
  const health = (over: Partial<SystemSample> = {}): SystemSample => ({
    ts: Date.now(), cpuProcessPct: 10, cpuSystemPct: 20,
    memUsedBytes: 1, memTotalBytes: 2, procRssBytes: 1, procHeapUsedBytes: 1,
    eventLoopP50ms: 1, eventLoopP99ms: 5,
    procReadBps: null, procWriteBps: null, netRxBps: null, netTxBps: null,
    diskReadBps: null, diskWriteBps: null, appInBps: 0, appOutBps: 0,
    ...over
  });

  it("a clean window carries no caveats", () => {
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    s.ingestBatch({ batchId: "clean", results: many(100, { ts }) });
    s.recordHealth(health({ ts }));
    const v = s.summary(300_000).validity;
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.droppedRequests).toBe(0);
    s.close();
  });

  it("flags a window where the concurrency cap shed load", () => {
    // coordinated omission: when the target slows down the rig quietly issues
    // less load, and the latency chart looks BETTER for it. The window has to
    // say so rather than presenting a confident percentile.
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    const bucketTs = Math.floor(ts / 60_000) * 60_000;
    s.ingestBatch({
      batchId: "shed",
      results: many(100, { ts }),
      shed: [{ bucketTs, dropped: 400, targetSum: 5000, ticks: 10 }]
    });

    const v = s.summary(300_000).validity;
    expect(v.droppedRequests).toBe(400);
    // 400 dropped of 500 intended
    expect(v.shedPct).toBeCloseTo(80, 1);
    expect(v.targetRps).toBe(500);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/never issued/);
    s.close();
  });

  it("flags a saturated generator separately from shed load", () => {
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    s.ingestBatch({ batchId: "hot", results: many(10, { ts }) });
    s.recordHealth(health({ ts, cpuProcessPct: 97, eventLoopP99ms: 8 }));
    s.recordHealth(health({ ts, cpuProcessPct: 12, eventLoopP99ms: 450 }));

    const v = s.summary(300_000).validity;
    expect(v.ok).toBe(false);
    expect(v.cpuProcessPctMax).toBe(97);
    expect(v.eventLoopP99MsMax).toBe(450);
    expect(v.reasons.some((r) => r.includes("CPU"))).toBe(true);
    expect(v.reasons.some((r) => r.includes("event-loop"))).toBe(true);
    s.close();
  });

  it("reports unknown rather than healthy when nothing was sampled", () => {
    // an absent measurement must not read as a good one
    const s = createMetricsStore(":memory:");
    s.ingestBatch({ batchId: "nohealth", results: many(5) });
    const v = s.summary(300_000).validity;
    expect(v.cpuProcessPctMax).toBeNull();
    expect(v.eventLoopP99MsMax).toBeNull();
    expect(v.targetRps).toBeNull();
    s.close();
  });

  it("sums shed accounting across the batches that report it", () => {
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    const bucketTs = Math.floor(ts / 60_000) * 60_000;
    s.ingestBatch({ batchId: "s1", results: many(10, { ts }), shed: [{ bucketTs, dropped: 5, targetSum: 100, ticks: 10 }] });
    s.ingestBatch({ batchId: "s2", results: many(10, { ts }), shed: [{ bucketTs, dropped: 7, targetSum: 100, ticks: 10 }] });
    const v = s.summary(300_000).validity;
    expect(v.droppedRequests).toBe(12);
    expect(v.targetRps).toBe(10); // 200 target-sum over 20 ticks
    s.close();
  });
});

describe("summaryBetween", () => {
  it("scopes a summary to one run's own span", () => {
    // per-run comparison is the whole point of a report: window-only summaries
    // cannot answer "how did THIS run do"
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    const old = now - 40 * 60_000;
    s.ingestBatch({ batchId: "run-a", results: many(30, { ts: old, status: 500 }) });
    s.ingestBatch({ batchId: "run-b", results: many(10, { ts: now, status: 200 }) });

    const justOld = s.summaryBetween(old - 60_000, old + 60_000);
    expect(justOld.total).toBe(30);
    expect(justOld.errors).toBe(30);

    const justNew = s.summaryBetween(now - 60_000, now + 60_000);
    expect(justNew.total).toBe(10);
    expect(justNew.errors).toBe(0);
    s.close();
  });

  it("says how much of a report window belongs to some other run", () => {
    // roll-up buckets carry no run id, so two short runs in the same minute are
    // reported as each other unless the report admits the overlap
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({ batchId: "b1", results: many(30, { ts: now, runId: "run-mine" }) });
    s.ingestBatch({ batchId: "b2", results: many(10, { ts: now, runId: "run-theirs" }) });

    const scope = s.windowScope("run-mine", now, now);
    expect(scope.totalRequests).toBe(40);
    expect(scope.foreignRequests).toBe(10);
    expect(scope.foreignPct).toBeCloseTo(25, 5);

    // a run that had the minute to itself reports a clean window
    const alone = s.windowScope("run-mine", now - 40 * 60_000, now - 40 * 60_000);
    expect(alone).toEqual({ foreignRequests: 0, totalRequests: 0, foreignPct: 0 });
    s.close();
  });
});

describe("contract attribution", () => {
  it("credits a rejection to the gateway only when the backend was never reached", () => {
    // the bundled SUT validates its own input, so "answered 4xx" used to read
    // ~100% blocked whether or not gateway validation was even switched on
    const s = createMetricsStore(":memory:");
    s.ingestBatch({
      batchId: "contract",
      results: [
        ...many(6, { status: 400, class: "invalid", reachedBackend: false }),
        ...many(3, { status: 400, class: "invalid", reachedBackend: true }),
        ...many(1, { status: 201, class: "invalid", reachedBackend: true })
      ]
    });

    const c = s.summary(300_000).contract;
    expect(c.invalidSent).toBe(10);
    expect(c.rejectedByGateway).toBe(6);
    expect(c.rejectedByBackend).toBe(3);
    // 3 caught by the backend + 1 accepted outright = 4 the gateway let past
    expect(c.leakedToBackend).toBe(4);
    expect(c.wronglyAccepted).toBe(1);
    expect(c.rejected4xx).toBe(9);
    s.close();
  });

  it("reports zero gateway rejections when the gateway validates nothing", () => {
    const s = createMetricsStore(":memory:");
    s.ingestBatch({
      batchId: "no-validation",
      results: many(10, { status: 400, class: "invalid", reachedBackend: true })
    });
    const c = s.summary(300_000).contract;
    expect(c.rejectedByGateway).toBe(0);
    expect(c.leakedToBackend).toBe(10);
    s.close();
  });
});

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
    s.writeGateway({ rest: { baseUrl: "http://x", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "", forwardBasicAuth: "auto" },
                     soap: { baseUrl: "http://y", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "", forwardBasicAuth: "auto" } });

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
