import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, MEASUREMENT_VERSION, RAW_TAIL_PER_FLUSH, type RequestResult, type SystemSample, type WorkerHealthCell } from "@apigw/shared";
import { createMetricsStore } from "./server.js";
import { aggregateBatch } from "./aggregate.js";
import { openDb } from "./db.js";

let seq = 0;

function mk(over: Partial<RequestResult> = {}): RequestResult {
  return {
    runId: "r1", requestId: `req${++seq}`, ts: Date.now(), protocol: "rest", endpoint: "GET /api/pets",
    class: "small-rest", method: "GET", status: 200,
    latencyMs: 100, ttfbMs: 100, serverMs: 90, measurementVersion: MEASUREMENT_VERSION,
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

  it("flags lost measurements separately from shed load", () => {
    // shed load and lost measurements demand opposite conclusions: the first
    // says the gateway was never offered the traffic, the second says it
    // served traffic we failed to record. Folding them into one counter told
    // the operator the wrong story at exactly the rates where it matters.
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    const bucketTs = Math.floor(ts / 60_000) * 60_000;
    s.ingestBatch({
      batchId: "lost",
      results: many(100, { ts }),
      shed: [{ bucketTs, dropped: 0, resultsLost: 50, targetSum: 1000, ticks: 10 }]
    });

    const v = s.summary(300_000).validity;
    expect(v.resultsLost).toBe(50);
    expect(v.droppedRequests).toBe(0);
    expect(v.shedPct).toBe(0);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/measurements .* were lost/);
    // 50 lost of 150 served
    expect(v.reasons.join(" ")).toMatch(/33\.3%/);
    s.close();
  });

  it("flags requests that never reached the target, separately again", () => {
    // Three different failures, three different conclusions: shed load was
    // never issued, lost measurements were served but not recorded, and these
    // were issued and could not be connected. Only the last one is the
    // generator failing at its job, and none of the three is the gateway.
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    const bucketTs = Math.floor(ts / 60_000) * 60_000;
    s.ingestBatch({
      batchId: "genfault",
      results: many(100, { ts }),
      shed: [{ bucketTs, dropped: 0, genFaults: 40, targetSum: 1000, ticks: 10 }]
    });

    const v = s.summary(300_000).validity;
    expect(v.genFaults).toBe(40);
    expect(v.droppedRequests).toBe(0);
    expect(v.resultsLost).toBe(0);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/never reached the target/);
    // and it names the generator rather than the gateway
    expect(v.reasons.join(" ")).toMatch(/not the gateway/);
    s.close();
  });

  it("does not invalidate a window for a single stray connection failure", () => {
    // the limit is tight but not zero: one refused connect in a big window is
    // noise, and a gate that fires on noise gets ignored when it matters
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    const bucketTs = Math.floor(ts / 60_000) * 60_000;
    s.ingestBatch({
      batchId: "one-stray",
      results: many(5000, { ts }),
      shed: [{ bucketTs, dropped: 0, genFaults: 1, targetSum: 5000, ticks: 10 }]
    });
    const v = s.summary(300_000).validity;
    expect(v.genFaults).toBe(1);
    expect(v.reasons).toEqual([]);
    expect(v.ok).toBe(true);
    s.close();
  });

  it("a generator that cannot tell the two apart reports no faults, not zero faults", () => {
    // genFaults is absent from the in-process TS driver, whose fetch failures
    // are not separable. Absent must read as "nothing claimed" and leave the
    // window judged on everything else.
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    const bucketTs = Math.floor(ts / 60_000) * 60_000;
    s.ingestBatch({
      batchId: "no-claim",
      results: many(50, { ts }),
      shed: [{ bucketTs, dropped: 0, targetSum: 500, ticks: 10 }]
    });
    const v = s.summary(300_000).validity;
    expect(v.genFaults).toBe(0);
    expect(v.ok).toBe(true);
    s.close();
  });

  it("a window that recorded everything reports no loss", () => {
    const s = createMetricsStore(":memory:");
    const ts = Date.now();
    const bucketTs = Math.floor(ts / 60_000) * 60_000;
    s.ingestBatch({
      batchId: "nolost",
      results: many(10, { ts }),
      shed: [{ bucketTs, dropped: 0, targetSum: 100, ticks: 10 }]
    });
    const v = s.summary(300_000).validity;
    expect(v.resultsLost).toBe(0);
    expect(v.reasons).toEqual([]);
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
    expect(v.workerSchedP99MsMax).toBeNull();
    expect(v.targetRps).toBeNull();
    s.close();
  });

  describe("judging the process that held the clock", () => {
    const workerCell = (ts: number, over: Partial<WorkerHealthCell> = {}): WorkerHealthCell => ({
      windowTs: Math.floor(ts / 2_000) * 2_000, fromTs: ts, toTs: ts + 2_000,
      samples: 8, schedP99Ms: 0.05, schedMaxMs: 0.4, cpuPct: 20, goroutines: 40, ...over
    });

    it("ignores this process's event loop when the worker generated the load", () => {
      // The crux. With the Go backend every clock is read inside the worker, so
      // this loop is idle bookkeeping — and on Windows an idle Bun process
      // reports an event-loop p99 of up to ~21ms at 0% CPU. Consulting it here
      // disqualified windows for the host's timer granularity: a run at 20 rps
      // on an unloaded machine came back "not trustworthy".
      const s = createMetricsStore(":memory:");
      const ts = Date.now();
      s.ingestAggregate(aggregateBatch({ batchId: "gowin", results: many(10, { ts }) }));
      s.ingestAggregate({ ...aggregateBatch({ batchId: "gohealth", results: [] }), health: [workerCell(ts)] });
      s.recordHealth(health({ ts, cpuProcessPct: 1, eventLoopP99ms: 450 }));

      const v = s.summary(300_000).validity;
      expect(v.ok).toBe(true);
      expect(v.eventLoopP99MsMax).toBeNull();
      expect(v.workerSchedP99MsMax).toBeCloseTo(0.05, 10);
      s.close();
    });

    it("fails the window when the worker's own scheduler was the delay", () => {
      const s = createMetricsStore(":memory:");
      const ts = Date.now();
      s.ingestAggregate({
        ...aggregateBatch({ batchId: "stalled", results: many(10, { ts }) }),
        health: [workerCell(ts), workerCell(ts, { schedP99Ms: 40, schedMaxMs: 120 })]
      });

      const v = s.summary(300_000).validity;
      expect(v.ok).toBe(false);
      // the max across the minute's windows, not a mean: one stalled 2s window
      // is the event worth surfacing and an average would bury it
      expect(v.workerSchedP99MsMax).toBe(40);
      expect(v.reasons.some((r) => r.includes("scheduling latency"))).toBe(true);
      s.close();
    });

    it("still judges this event loop when the in-process driver generated the load", () => {
      // no worker health for the window means nothing else was holding the
      // clock, and then this loop's delay is in every number the window reports
      const s = createMetricsStore(":memory:");
      const ts = Date.now();
      s.ingestBatch({ batchId: "tsdriver", results: many(10, { ts }) });
      s.recordHealth(health({ ts, cpuProcessPct: 1, eventLoopP99ms: 450 }));

      const v = s.summary(300_000).validity;
      expect(v.ok).toBe(false);
      expect(v.eventLoopP99MsMax).toBe(450);
      expect(v.reasons.some((r) => r.includes("event-loop"))).toBe(true);
      s.close();
    });

    it("does not fire on a loop delay that is the platform's floor rather than ours", () => {
      // 21ms is what an idle Bun process on Windows reports with no application
      // in it. A limit under that is not a gate, it is a permanent fail.
      const s = createMetricsStore(":memory:");
      const ts = Date.now();
      s.ingestBatch({ batchId: "floor", results: many(10, { ts }) });
      s.recordHealth(health({ ts, cpuProcessPct: 0, eventLoopP99ms: 21 }));

      const v = s.summary(300_000).validity;
      expect(v.ok).toBe(true);
      s.close();
    });

    it("flags a worker burning its own CPU", () => {
      const s = createMetricsStore(":memory:");
      const ts = Date.now();
      s.ingestAggregate({
        ...aggregateBatch({ batchId: "hotworker", results: many(10, { ts }) }),
        health: [workerCell(ts, { cpuPct: 97 })]
      });

      const v = s.summary(300_000).validity;
      expect(v.ok).toBe(false);
      expect(v.workerCpuPctMax).toBe(97);
      expect(v.reasons.some((r) => r.includes("available CPU"))).toBe(true);
      s.close();
    });
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

describe("pre-aggregated ingest", () => {
  it("stores a generator's cells identically to the same traffic sent raw", () => {
    // the generators ship cells and /api/ingest ships requests; both must land
    // on the same rows, or the backend a run used would change its numbers
    const now = Date.now();
    const results = [
      ...many(40, { ts: now, latencyMs: 12 }),
      ...many(5, { ts: now, status: 500, latencyMs: 300 }),
      ...many(3, { ts: now, class: "soap", protocol: "soap", endpoint: "SOAP getPetById" })
    ];

    const raw = createMetricsStore(":memory:");
    raw.ingestBatch({ batchId: "raw", results });
    const pre = createMetricsStore(":memory:");
    pre.ingestAggregate(aggregateBatch({ batchId: "pre", results }));

    const a = raw.summary(300_000);
    const b = pre.summary(300_000);
    expect(b.total).toBe(a.total);
    expect(b.errorPct).toBe(a.errorPct);
    expect(b.p95).toBe(a.p95);
    expect(b.nonBackendMs.count).toBe(a.nonBackendMs.count);
    expect(b.nonBackendMs.p50).toBe(a.nonBackendMs.p50);
    expect(b.nonBackendMs.p99).toBe(a.nonBackendMs.p99);
    raw.close();
    pre.close();
  });

  it("folds a batch that straddles a minute into one hour row", () => {
    // a cell is minute-keyed, so a flush spanning a boundary carries two cells
    // for the same endpoint that share an hour — the hour layer must merge them
    // rather than let the second overwrite the first
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    const edge = Math.floor(now / 60_000) * 60_000;
    s.ingestAggregate(aggregateBatch({
      batchId: "straddle",
      results: [...many(10, { ts: edge - 1 }), ...many(10, { ts: edge + 1 })]
    }));
    const hour = s.timeseries(3600, now - 2 * 3600_000, now);
    expect(hour.points.reduce((n, p) => n + p.total, 0)).toBe(20);
    expect(s.summary(300_000).total).toBe(20);
    s.close();
  });

  it("accumulates non-backend time across flushes into the same minute", () => {
    // it rides the ordinary cell, so a second flush for the same minute must add
    // to the stored histogram rather than replace it — otherwise a long run
    // reports only its last second of evidence
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    const at = (id: string) => aggregateBatch({
      batchId: id,
      results: many(40, { ts: now, ttfbMs: 100, serverMs: 90 })
    });
    s.ingestAggregate(at("w1"));
    s.ingestAggregate(at("w2"));

    const nb = s.summary(300_000).nonBackendMs;
    expect(nb.count).toBe(80);
    expect(nb.avg!).toBeCloseTo(10, 5);
    s.close();
  });

  it("reports connection reuse as a share of what could be measured", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({
      batchId: "conn",
      results: [
        ...many(90, { ts: now, connectMs: 0.05, connReused: true }),
        ...many(10, { ts: now, connectMs: 20, connReused: false })
      ]
    });
    const c = s.summary(300_000).connSetup;
    expect(c.measured).toBe(100);
    expect(c.setups).toBe(10);
    expect(c.pct).toBeCloseTo(10, 6);
    expect(c.avgMs).toBeCloseTo(20, 6);
    s.close();
  });

  it("says nothing rather than 'perfect reuse' when the generator cannot see connections", () => {
    // the in-process driver reports connectMs = null. A share computed off the
    // request count would read 0% setups there, which is a claim about the
    // gateway that nothing measured.
    const s = createMetricsStore(":memory:");
    s.ingestBatch({ batchId: "blind", results: many(50, { connectMs: null }) });
    const c = s.summary(300_000).connSetup;
    expect(c.measured).toBe(0);
    expect(c.pct).toBeNull();
    expect(c.avgMs).toBeNull();
    s.close();
  });

  it("refuses to write a batch that is not a batch", () => {
    const s = createMetricsStore(":memory:");
    expect(() => s.ingestAggregate({ batchId: "", cells: [] } as never)).toThrow();
    expect(() => s.ingestAggregate({ batchId: "x" } as never)).toThrow();
    // a cell with no bucket has nowhere to go and must not be guessed at
    expect(() => s.ingestAggregate({ batchId: "y", cells: [{} as never], runs: [], tail: [] }))
      .toThrow("bucketTs");
    s.close();
  });

  it("is idempotent on batchId whichever shape the batch arrived in", () => {
    const s = createMetricsStore(":memory:");
    const agg = aggregateBatch({ batchId: "dup", results: many(5) });
    expect(s.ingestAggregate(agg).ingested).toBe(5);
    expect(s.ingestAggregate(agg).duplicate).toBe(true);
    expect(s.summary(300_000).total).toBe(5);
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

describe("recent-tail bounding", () => {
  it("keeps every row of a batch that fits in the tail budget", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({ batchId: "small", results: Array.from({ length: 100 }, (_, i) => mk({ ts: now - i })) });
    expect(s.recent(500).length).toBe(100);
    s.close();
  });

  it("caps the raw tail per flush while errors and non-crud classes survive", () => {
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    const results: ReturnType<typeof mk>[] = [
      ...Array.from({ length: 4990 }, (_, i) => mk({ ts: now - i })),
      ...Array.from({ length: 5 }, (_, i) => mk({ ts: now - i, status: 500, error: "boom" })),
      ...Array.from({ length: 5 }, (_, i) => mk({ ts: now - i, class: "soap", endpoint: "SOAP getPetById" }))
    ];
    s.ingestBatch({ batchId: "huge", results });

    // the tail is bounded by what the recent-requests table can show, not by a
    // fraction of the rate: 5000 results or 500k, the write is the same size
    const tail = s.recent(500);
    expect(tail.length).toBe(RAW_TAIL_PER_FLUSH);
    // the rows anyone actually opens that table for are taken first
    expect(tail.filter((r) => r.status >= 500).length).toBe(5);
    expect(tail.filter((r) => r.class === "soap").length).toBe(5);
    // every aggregate stays exact regardless of what the tail kept
    expect(s.summary(300_000).total).toBe(5000);
    s.close();
  });

  it("keeps the per-run attribution exact even though the tail is a sample", () => {
    // foreignPct used to be counted off the raw table. Once that became a
    // bounded tail, counting it there would have reported the mix of the
    // sample — which is deliberately biased toward errors and rare classes.
    const s = createMetricsStore(":memory:");
    const now = Date.now();
    s.ingestBatch({
      batchId: "mixed",
      results: [
        ...Array.from({ length: 3000 }, (_, i) => mk({ ts: now - i, runId: "mine" })),
        ...Array.from({ length: 1000 }, (_, i) => mk({ ts: now - i, runId: "theirs" }))
      ]
    });
    const scope = s.windowScope("mine", now - 60_000, now);
    expect(scope.totalRequests).toBe(4000);
    expect(scope.foreignRequests).toBe(1000);
    expect(scope.foreignPct).toBeCloseTo(25, 6);
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


describe("non-backend time and durable coverage", () => {
  it("uses the same full minute for the rate numerator and denominator", () => {
    const store = createMetricsStore(":memory:");
    try {
      const start = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
      store.ingestBatch({ batchId: "boundary", results: Array.from({ length: 60 }, (_, i) => mk({ ts: start + i * 1000 })) });
      const sum = store.summaryBetween(start + 59_000, start + 60_000);
      expect(sum.total).toBe(60);
      expect(sum.windowSec).toBe(60);
      expect(sum.rps).toBe(1);
    } finally { store.close(); }
  });

  it("retains identical rates after raw history expires and the store reopens", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-"));
    const path = join(dir, "test.sqlite");
    const start = Math.floor((Date.now() - 72 * 3600_000) / 3600_000) * 3600_000;
    let store = createMetricsStore(path);
    try {
      store.ingestBatch({ batchId: "history", results: Array.from({ length: 48 * 60 }, (_, i) => mk({ ts: start + i * 60_000 })) });
      const before = store.summaryBetween(start, start + 48 * 3600_000);
      store.close();
      const db = openDb(path);
      db.prepare("DELETE FROM requests_raw WHERE ts < ?").run(start + 24 * 3600_000);
      db.close(true);
      store = createMetricsStore(path);
      const after = store.summaryBetween(start, start + 48 * 3600_000);
      expect(after.rps).toBe(before.rps);
      expect(after.windowSec).toBe(before.windowSec);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  describe("non-backend time", () => {
    it("measures every request, at every percentile, with no control stream", () => {
      // The quantity this replaced was a difference against a 2%-of-load direct
      // stream, which needed 1,000 observations on the thin arm for a p99 and so
      // reported none on a real run. Read per request, 300 requests give a p99.
      const store = createMetricsStore(":memory:");
      try {
        store.ingestBatch({ batchId: "nb", results: many(300, { ttfbMs: 112, serverMs: 100 }) });
        const s = store.summary(300_000);
        expect(s.nonBackendMs.count).toBe(300);
        // every observation is exactly 12ms; the band is the residual
        // histogram's bucket width at that magnitude, not measurement spread
        for (const p of [s.nonBackendMs.p50, s.nonBackendMs.p90, s.nonBackendMs.p95, s.nonBackendMs.p99]) {
          expect(p).not.toBeNull();
          expect(p!).toBeGreaterThan(9);
          expect(p!).toBeLessThan(15);
        }
        expect(s.nonBackendMs.avg!).toBeCloseTo(12, 5);
      } finally { store.close(); }
    });

    it("reports a percentile off a handful of samples rather than withholding it", () => {
      // A per-percentile evidence bar used to gate this, because the thin arm of
      // the Δ genuinely could not support a p99. Here the sample IS the traffic,
      // and the count sits next to the number — so the operator can judge it
      // instead of being handed a blank where a measurement was taken.
      const store = createMetricsStore(":memory:");
      try {
        store.ingestBatch({ batchId: "few", results: many(25, { ttfbMs: 112, serverMs: 100 }) });
        const nb = store.summary(300_000).nonBackendMs;
        expect(nb.count).toBe(25);
        expect(nb.p99).not.toBeNull();
      } finally { store.close(); }
    });

    it("keeps a negative value instead of flooring it at zero", () => {
      // TTFB and the SUT's own clock are read at different layers, so a fast
      // local hop lands slightly below zero. Clamping those lifts every
      // percentile above them by exactly the amount clamped away.
      const store = createMetricsStore(":memory:");
      try {
        store.ingestBatch({ batchId: "signed", results: many(300, { ttfbMs: 96, serverMs: 100 }) });
        const nb = store.summary(300_000).nonBackendMs;
        expect(nb.avg!).toBeCloseTo(-4, 5);
        expect(nb.p50!).toBeLessThan(0);
      } finally { store.close(); }
    });

    it("is reported per endpoint and per class", () => {
      const store = createMetricsStore(":memory:");
      try {
        store.ingestBatch({ batchId: "split", results: many(200, { ttfbMs: 112, serverMs: 100 }) });
        const s = store.summary(300_000);
        expect(s.perEndpoint[0]!.nonBackendMs.count).toBeGreaterThan(0);
        expect(s.perEndpoint[0]!.nonBackendMs.p95).not.toBeNull();
        expect(s.perClass[0]!.nonBackendMs.count).toBeGreaterThan(0);
        expect(s.perClass[0]!.nonBackendMs.p95).not.toBeNull();
      } finally { store.close(); }
    });

    it("separates a bulk class from a small one, and pools both in the headline", () => {
      // A 400ms body copy is not what anyone means by "what does the gateway
      // add", which is why the per-class rows are what to compare between runs.
      // The headline pools every class anyway: withholding classes from it made
      // the tile and the per-class table describe different traffic, and an
      // operator cannot see a scenario mix they were never shown.
      const store = createMetricsStore(":memory:");
      try {
        store.ingestBatch({
          batchId: "per-class",
          results: [
            ...many(100, { ttfbMs: 112, serverMs: 100 }),
            ...many(100, { class: "big-response", ttfbMs: 500, serverMs: 100 })
          ]
        });
        const s = store.summary(300_000);
        const perClass = s.perClass;
        expect(perClass.find((c) => c.cls === "small-rest")!.nonBackendMs.avg!).toBeCloseTo(12, 5);
        expect(perClass.find((c) => c.cls === "big-response")!.nonBackendMs.avg!).toBeCloseTo(400, 5);
        expect(s.nonBackendMs.count).toBe(200);
        expect(s.nonBackendMs.avg!).toBeCloseTo(206, 5);
      } finally { store.close(); }
    });

    it("counts only requests that carried both clocks, and still counts them as traffic", () => {
      // A response the gateway manufactured has no backend time to subtract, and
      // a row written under an older measurement schema is a different quantity.
      // Both are absent from the count rather than contributing a wrong number —
      // and both are still part of what the run delivered.
      const store = createMetricsStore(":memory:");
      try {
        store.ingestBatch({
          batchId: "partial",
          results: [
            ...many(100, { ttfbMs: 112, serverMs: 100 }),
            ...many(50, { ttfbMs: 112, serverMs: null, reachedBackend: false, status: 401 }),
            ...many(50, { ttfbMs: 112, serverMs: 100, measurementVersion: 2 })
          ]
        });
        const s = store.summary(300_000);
        expect(s.total).toBe(200);
        expect(s.nonBackendMs.count).toBe(100);
      } finally { store.close(); }
    });
  });
});
