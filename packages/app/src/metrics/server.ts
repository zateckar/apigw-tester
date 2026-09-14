import { HISTOGRAM_EDGES_MS, LIMITS } from "@apigw/shared";
import type {
  ClassStat,
  EndpointStat,
  GwTargets,
  IngestBatch,
  LoadProfile,
  MetricSummary,
  RequestResult,
  RunEvent,
  ScenarioClass,
  TimePoint,
  TimeSeries
} from "@apigw/shared";
import { openDb, ensureColumn, type DbHandle } from "./db.js";
import {
  Histogram,
  emptyHistogram,
  meanFromRollup,
  mergeHistograms,
  percentile,
  addToHistogram
} from "./rollup.js";

const MINUTE_BUCKETS = 60_000;
const HOUR_BUCKETS = 3_600_000;
const RAW_RETENTION_MS = 24 * HOUR_BUCKETS;
const MINUTE_RETENTION_MS = 7 * 24 * HOUR_BUCKETS;
const HOUR_RETENTION_MS = 90 * 24 * HOUR_BUCKETS;

/** the loadgen driver's flush cadence; batch size ÷ this is the ingest rate */
const FLUSH_MS = 5_000;
const FLUSH_SEC = FLUSH_MS / 1000;
/** rows per multi-row VALUES insert — 200 × 13 params stays far under
 *  SQLite's ~32766 bind-parameter ceiling */
const RAW_CHUNK_ROWS = 200;
/** ceiling on the sampling factor so the raw tail never thins out completely */
const MAX_SAMPLE_K = 100;

export interface MetricsStore {
  ingestBatch: (batch: IngestBatch) => { ingested: number; duplicate?: boolean };
  summary: (windowMs: number) => MetricSummary;
  timeseries: (bucketSec: 60 | 3600, from: number, to: number) => TimeSeries;
  recent: (limit: number) => RequestResult[];
  readGateway: () => unknown | null;
  writeGateway: (cfg: GwTargets) => void;
  readProfile: () => LoadProfile | null;
  writeProfile: (p: LoadProfile) => void;
  recordRunStart: (runId: string, profile: unknown) => void;
  recordRunStop: (runId: string) => void;
  listRuns: () => RunEvent[];
  /** Wipe all collected metric data (raw, both roll-ups, ingest markers, run
   *  history). The config rows — gateway, profile — survive. */
  resetAll: () => void;
  /** Delete stopped runs started more than `olderThanMs` ago; a running or
   *  crashed-but-unstopped run is never removed. Returns rows deleted. */
  pruneRuns: (olderThanMs: number) => number;
  close: () => void;
}

interface RollupRow {
  bucket_ts: number;
  protocol: string;
  endpoint: string;
  cls: string;
  count: number;
  errors: number;
  ok2xx: number;
  rejected4xx: number;
  latency_sum_ms: number;
  max_latency_ms: number;
  overhead_sum_ms: number;
  overhead_max_ms: number;
  bytes_req: number;
  bytes_resp: number;
  hist: string;
  overhead_hist: string;
}

interface Combined {
  protocol: string;
  endpoint: string;
  cls: string;
  count: number;
  errors: number;
  ok2xx: number;
  rejected4xx: number;
  latencySumMs: number;
  maxLatencyMs: number;
  overheadSumMs: number;
  overheadMaxMs: number;
  bytesReq: number;
  bytesResp: number;
  hist: Histogram;
  overheadHist: Histogram;
}

function newCombined(r: RollupRow): Combined {
  return {
    protocol: r.protocol, endpoint: r.endpoint, cls: r.cls,
    count: 0, errors: 0, ok2xx: 0, rejected4xx: 0,
    latencySumMs: 0, maxLatencyMs: 0,
    overheadSumMs: 0, overheadMaxMs: 0, bytesReq: 0, bytesResp: 0,
    hist: emptyHistogram(), overheadHist: emptyHistogram()
  };
}

function rowsToCombined(rows: RollupRow[], scope: "endpoint" | "class"): Map<string, Combined> {
  // endpoint scope deliberately folds the class away: the same path is hit by
  // more than one class (e.g. GET /api/pets as both small-rest and concurrency)
  // and two identically-labelled rows in the table read as a bug
  const keyOf = (r: RollupRow) =>
    scope === "endpoint" ? `${r.protocol}|${r.endpoint}` : r.cls;
  const map = new Map<string, Combined>();
  for (const r of rows) {
    const key = keyOf(r);
    let c = map.get(key);
    if (!c) {
      c = newCombined(r);
      map.set(key, c);
    }
    c.count += r.count;
    c.errors += r.errors;
    c.ok2xx += r.ok2xx ?? 0;
    c.rejected4xx += r.rejected4xx ?? 0;
    c.latencySumMs += r.latency_sum_ms;
    c.maxLatencyMs = Math.max(c.maxLatencyMs, r.max_latency_ms);
    c.overheadSumMs += r.overhead_sum_ms;
    c.overheadMaxMs = Math.max(c.overheadMaxMs, r.overhead_max_ms);
    c.bytesReq += r.bytes_req;
    c.bytesResp += r.bytes_resp;
    mergeHistograms(c.hist, parseHist(r.hist));
    mergeHistograms(c.overheadHist, parseHist(r.overhead_hist));
  }
  return map;
}

function parseHist(s: string): Histogram {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!Array.isArray(parsed)) return emptyHistogram();
    return parsed as Histogram;
  } catch {
    return emptyHistogram();
  }
}

// ---- requests_raw downsampling --------------------------------------------
// requests_raw is only ever read by the recent tail (GET /api/recent, capped
// at LIMITS.recentLimit rows) — every aggregate chart comes from the roll-ups,
// which stay exact. At high rps, one insert per request saturates the loop,
// so above ~500 rps the crud (small-rest/concurrency) tail is kept 1-in-k and
// everything "interesting" is kept whole. Below that, k = 1 and nothing is
// dropped.

function keepEveryK(batchLen: number): number {
  // rate is in requests/sec; k=1 until batchRate reaches ~500 rps, then
  // batchRate/100 rounded up, capped so the tail still has something to show
  const rate = batchLen / FLUSH_SEC;
  return Math.min(MAX_SAMPLE_K, Math.max(1, Math.ceil(rate / 100)));
}

/** crud classes are sampled; errors and the rarer classes always survive */
function alwaysKeep(r: RequestResult): boolean {
  if (r.error !== null || r.status === 0 || r.status >= 400) return true;
  return r.class !== "small-rest" && r.class !== "concurrency";
}

/**
 * Pick the rows that go into requests_raw for this batch. Index-based, so a
 * sampled run still has a spread of rows across the window, and deterministic
 * enough to reason about in tests.
 */
function selectRawRows(batchLen: number, results: RequestResult[]): RequestResult[] {
  if (batchLen <= LIMITS.recentLimit) return results;
  const k = keepEveryK(batchLen);
  if (k <= 1) return results;
  const kept: RequestResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as RequestResult;
    if (alwaysKeep(r) || i % k === 0) kept.push(r);
  }
  return kept;
}

const RAW_COLS = `(ts, run_id, protocol, endpoint, class, method, status, latency_ms, baseline_ms, overhead_ms, bytes_req, bytes_resp, error)`;
const RAW_NCOLS = 13;

/** build one multi-row INSERT for `rows` raw results */
function rawInsertSql(rows: number): string {
  const tuple = `(${Array(RAW_NCOLS).fill("?").join(", ")})`;
  return `INSERT INTO requests_raw ${RAW_COLS} VALUES ${Array(rows).fill(tuple).join(", ")}`;
}

function rawInsertParams(r: RequestResult): (string | number | null)[] {
  return [r.ts, r.runId, r.protocol, r.endpoint, r.class, r.method, r.status,
    r.latencyMs, r.baselineMs, r.overheadMs, r.bytesReq, r.bytesResp, r.error ?? null];
}

export function createMetricsStore(dbPath: string): MetricsStore {
  const db = openDb(dbPath);
  migrate(db);

  const upsertMinute = db.prepare(layer("rollup_minute"));
  const upsertHour = db.prepare(layer("rollup_hour"));
  function layer(table: string): string {
    return `
     INSERT INTO ${table} (bucket_ts, protocol, endpoint, cls, count, errors, ok2xx, rejected4xx, latency_sum_ms, max_latency_ms, overhead_sum_ms, overhead_max_ms, bytes_req, bytes_resp, hist, overhead_hist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_ts, protocol, endpoint, cls) DO UPDATE SET
       count = count + excluded.count,
       errors = errors + excluded.errors,
       ok2xx = ok2xx + excluded.ok2xx,
       rejected4xx = rejected4xx + excluded.rejected4xx,
       latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
       max_latency_ms = MAX(max_latency_ms, excluded.max_latency_ms),
       overhead_sum_ms = overhead_sum_ms + excluded.overhead_sum_ms,
       overhead_max_ms = MAX(overhead_max_ms, excluded.overhead_max_ms),
       bytes_req = bytes_req + excluded.bytes_req,
       bytes_resp = bytes_resp + excluded.bytes_resp,
       hist = (
         SELECT json_group_array(b.sum) FROM (
           WITH RECURSIVE seq(i) AS (
             SELECT 0
             UNION ALL SELECT i+1 FROM seq WHERE i < json_array_length(excluded.hist) - 1
           )
           SELECT COALESCE(json_extract(${table}.hist, '$[' || i || ']'), 0) +
                  COALESCE(json_extract(excluded.hist, '$[' || i || ']'), 0) AS sum
           FROM seq
         ) b
       ),
       overhead_hist = (
         SELECT json_group_array(b.sum) FROM (
           WITH RECURSIVE seq(i) AS (
             SELECT 0
             UNION ALL SELECT i+1 FROM seq WHERE i < json_array_length(excluded.overhead_hist) - 1
           )
           SELECT COALESCE(json_extract(${table}.overhead_hist, '$[' || i || ']'), 0) +
                  COALESCE(json_extract(excluded.overhead_hist, '$[' || i || ']'), 0) AS sum
           FROM seq
         ) b
       )`;
  }
  const insertRun = db.prepare(`INSERT INTO runs (run_id, started_at, profile) VALUES (?, ?, ?)`);
  const stopRun = db.prepare(`UPDATE runs SET stopped_at = ? WHERE run_id = ? AND stopped_at IS NULL`);
  const getConfig = db.prepare(`SELECT value FROM config WHERE key = ?`);
  const setConfig = db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  const seenBatch = db.prepare(`SELECT 1 AS one FROM ingest_seen WHERE batch_id = ?`);
  const markBatch = db.prepare(`INSERT OR IGNORE INTO ingest_seen (batch_id, received_at) VALUES (?, ?)`);
  const cleanupSeen = db.prepare(`DELETE FROM ingest_seen WHERE received_at < ?`);

  const readRows = (table: "rollup_minute" | "rollup_hour", fromBucket: number, toBucket: number): RollupRow[] =>
    db.prepare(
      `SELECT bucket_ts, protocol, endpoint, cls, count, errors, ok2xx, rejected4xx, latency_sum_ms, max_latency_ms,
              overhead_sum_ms, overhead_max_ms, bytes_req, bytes_resp, hist, overhead_hist
       FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).all(fromBucket, toBucket) as unknown as RollupRow[];

  const readRawRecent = (limit: number): RequestResult[] => {
    const n = Number(limit);
    // guard both NaN and negatives: SQLite reads LIMIT -1 as "no limit"
    const safe = Number.isFinite(n) ? Math.min(LIMITS.recentLimit, Math.max(1, Math.trunc(n))) : 100;
    return db.prepare(
      `SELECT ts, run_id AS runId, protocol, endpoint, class, method, status,
              latency_ms AS latencyMs, baseline_ms AS baselineMs, overhead_ms AS overheadMs,
              bytes_req AS bytesReq, bytes_resp AS bytesResp, error
       FROM requests_raw ORDER BY ts DESC LIMIT ?`
    ).all(safe) as unknown as RequestResult[];
  };

  /** Above this window length the hour roll-up is used instead of the minute
   *  one. Both layers receive every request during ingest, so the totals are
   *  identical either way — but a 7d window over minute buckets means ~10k
   *  buckets x endpoint combos of JSON histogram parsing on the event loop. */
  const MINUTE_LAYER_MAX_MS = 6 * HOUR_BUCKETS;

  /** Consider traffic live if a batch was ingested within this span — ~2x the
   *  loadgen flush interval plus the UI poll, so a run's end is recognised
   *  promptly without flickering between polls. */
  const LIVE_WINDOW_MS = 30_000;
  /** Wall-clock time of the most recent successfully ingested batch. */
  let lastIngestAt: number | null = null;

  function windowRows(windowMs: number): RollupRow[] {
    const now = Date.now();
    const from = now - windowMs;
    if (windowMs <= MINUTE_LAYER_MAX_MS) {
      return readRows("rollup_minute", Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS, Math.floor(now / MINUTE_BUCKETS) * MINUTE_BUCKETS);
    }
    return readRows("rollup_hour", Math.floor(from / HOUR_BUCKETS) * HOUR_BUCKETS, Math.floor(now / HOUR_BUCKETS) * HOUR_BUCKETS);
  }

  function ingestBatch(batch: IngestBatch): { ingested: number; duplicate?: boolean } {
    if (!batch || !Array.isArray(batch.results) || typeof batch.batchId !== "string" || batch.batchId === "") {
      throw new Error("batchId and results[] required");
    }
    if (seenBatch.get(batch.batchId)) return { ingested: 0, duplicate: true };

    interface Bucket {
      bucket_ts: number; protocol: string; endpoint: string; cls: string;
      count: number; errors: number; ok2xx: number; rejected4xx: number;
      latency_sum_ms: number; max_latency_ms: number;
      overhead_sum_ms: number; overhead_max_ms: number;
      bytes_req: number; bytes_resp: number;
      hist: Histogram; overhead_hist: Histogram;
    }
    const minute = new Map<string, Bucket>();
    const hour = new Map<string, Bucket>();
    const results = batch.results;

    // One transaction for the whole batch: raw rows, both roll-up layers and the
    // idempotency marker commit together or not at all. Marking the batch inside
    // the transaction means a rolled-back batch can be retried rather than being
    // silently swallowed as a duplicate.
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of results) {
        if (!r || typeof r.runId !== "string" || r.runId === "" || !Number.isFinite(r.ts)) {
          throw new Error("each result needs a runId and a numeric ts");
        }
        const mB = Math.floor(r.ts / MINUTE_BUCKETS) * MINUTE_BUCKETS;
        const hB = Math.floor(r.ts / HOUR_BUCKETS) * HOUR_BUCKETS;
        const isErr = r.status === 0 || r.status >= 500;
        const is2xx = r.status >= 200 && r.status < 300;
        const is4xx = r.status >= 400 && r.status < 500;

        for (const [bucketTs, table] of [[mB, minute], [hB, hour]] as const) {
          const key = `${bucketTs}|${r.protocol}|${r.endpoint}|${r.class}`;
          let b = table.get(key);
          if (!b) {
            b = {
              bucket_ts: bucketTs, protocol: r.protocol, endpoint: r.endpoint, cls: r.class,
              count: 0, errors: 0, ok2xx: 0, rejected4xx: 0,
              latency_sum_ms: 0, max_latency_ms: 0,
              overhead_sum_ms: 0, overhead_max_ms: 0,
              bytes_req: 0, bytes_resp: 0,
              hist: emptyHistogram(), overhead_hist: emptyHistogram()
            };
            table.set(key, b);
          }
          b.count++;
          b.errors += isErr ? 1 : 0;
          b.ok2xx += is2xx ? 1 : 0;
          b.rejected4xx += is4xx ? 1 : 0;
          b.latency_sum_ms += r.latencyMs;
          b.max_latency_ms = Math.max(b.max_latency_ms, r.latencyMs);
          b.overhead_sum_ms += r.overheadMs;
          b.overhead_max_ms = Math.max(b.overhead_max_ms, r.overheadMs);
          b.bytes_req += r.bytesReq;
          b.bytes_resp += r.bytesResp;
          addToHistogram(b.hist, r.latencyMs);
          addToHistogram(b.overhead_hist, r.overheadMs);
        }
      }
      // requests_raw is only ever read by the recent tail (GET /api/recent,
      // capped at LIMITS.recentLimit rows) — every aggregate chart comes from
      // the roll-ups above, which stay exact. At high rps one insert per
      // request saturates the loop, so the raw tail is downsampled (crud
      // classes 1-in-k, errors and rarer classes whole) and written as chunked
      // multi-row INSERTs instead of one statement per row.
      const rawKept = selectRawRows(results.length, results);
      for (let off = 0; off < rawKept.length; off += RAW_CHUNK_ROWS) {
        const slice = rawKept.slice(off, off + RAW_CHUNK_ROWS);
        const params = slice.flatMap(rawInsertParams);
        db.prepare(rawInsertSql(slice.length)).run(...params);
      }
      for (const b of minute.values()) {
        upsertMinute.run(b.bucket_ts, b.protocol, b.endpoint, b.cls, b.count, b.errors, b.ok2xx, b.rejected4xx, b.latency_sum_ms, b.max_latency_ms, b.overhead_sum_ms, b.overhead_max_ms, b.bytes_req, b.bytes_resp, JSON.stringify(b.hist), JSON.stringify(b.overhead_hist));
      }
      for (const b of hour.values()) {
        upsertHour.run(b.bucket_ts, b.protocol, b.endpoint, b.cls, b.count, b.errors, b.ok2xx, b.rejected4xx, b.latency_sum_ms, b.max_latency_ms, b.overhead_sum_ms, b.overhead_max_ms, b.bytes_req, b.bytes_resp, JSON.stringify(b.hist), JSON.stringify(b.overhead_hist));
      }
      markBatch.run(batch.batchId, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
      throw e;
    }
    lastIngestAt = Date.now();
    return { ingested: batch.results.length };
  }

  function summary(windowMs: number): MetricSummary {
    // Roll-ups are written synchronously during ingest, so they already include
    // the in-progress minute. There is deliberately no separate "live tail" pass
    // here — adding one double-counted every request in the current bucket.
    const rows = windowRows(windowMs);
    const byEndpointCls = rowsToCombined(rows, "endpoint");
    const byClass = rowsToCombined(rows, "class");

    let total = 0;
    let errors = 0;
    let bytesReq = 0;
    let bytesResp = 0;
    let latencySum = 0;
    let overheadSum = 0;
    const totalHist = emptyHistogram();
    const totalOverheadHist = emptyHistogram();
    const perEndpoint: EndpointStat[] = [];
    const perClass: ClassStat[] = [];
    const protoAcc = new Map<string, { total: number; errors: number }>();
    const windowSec = windowMs / 1000;
    const perSec = (n: number): number => (windowSec > 0 ? n / windowSec : 0);

    for (const c of byEndpointCls.values()) {
      total += c.count;
      errors += c.errors;
      bytesReq += c.bytesReq;
      bytesResp += c.bytesResp;
      latencySum += c.latencySumMs;
      overheadSum += c.overheadSumMs;
      mergeHistograms(totalHist, c.hist);
      mergeHistograms(totalOverheadHist, c.overheadHist);
      perEndpoint.push({
        protocol: c.protocol === "soap" ? "soap" : "rest",
        endpoint: c.endpoint,
        total: c.count,
        errors: c.errors,
        errorPct: c.count === 0 ? 0 : (100 * c.errors) / c.count,
        rps: perSec(c.count),
        p50: percentile(c.hist, 50),
        p95: percentile(c.hist, 95),
        avgLatencyMs: meanFromRollup(c.latencySumMs, c.count),
        avgRespBytes: c.count === 0 ? 0 : c.bytesResp / c.count
      });
      const acc = protoAcc.get(c.protocol) ?? { total: 0, errors: 0 };
      acc.total += c.count;
      acc.errors += c.errors;
      protoAcc.set(c.protocol, acc);
    }

    for (const [cls, c] of byClass.entries()) {
      if (c.count === 0) continue;
      perClass.push({
        cls: cls as ScenarioClass,
        total: c.count,
        errors: c.errors,
        errorPct: (100 * c.errors) / c.count,
        rps: perSec(c.count),
        latencyMs: {
          p50: percentile(c.hist, 50),
          p95: percentile(c.hist, 95),
          p99: percentile(c.hist, 99),
          avg: meanFromRollup(c.latencySumMs, c.count)
        },
        overheadMs: {
          p50: percentile(c.overheadHist, 50),
          p95: percentile(c.overheadHist, 95),
          p99: percentile(c.overheadHist, 99),
          avg: meanFromRollup(c.overheadSumMs, c.count)
        },
        avgBytesReq: c.bytesReq / c.count,
        avgBytesResp: c.bytesResp / c.count
      });
    }

    const invalid = byClass.get("invalid");
    return {
      windowSec,
      total,
      errors,
      errorPct: total === 0 ? 0 : (100 * errors) / total,
      rps: perSec(total),
      latencyMs: {
        p50: percentile(totalHist, 50),
        p90: percentile(totalHist, 90),
        p95: percentile(totalHist, 95),
        p99: percentile(totalHist, 99),
        avg: latencySum / Math.max(total, 1),
        max: rows.reduce((m, r) => Math.max(m, r.max_latency_ms), 0)
      },
      overheadMs: {
        p50: percentile(totalOverheadHist, 50),
        p90: percentile(totalOverheadHist, 90),
        p95: percentile(totalOverheadHist, 95),
        p99: percentile(totalOverheadHist, 99),
        avg: overheadSum / Math.max(total, 1)
      },
      bytes: { req: bytesReq, resp: bytesResp, respPerSec: perSec(bytesResp) },
      perProtocol: [...protoAcc.entries()].map(([protocol, a]) => ({
        protocol: protocol === "soap" ? "soap" as const : "rest" as const,
        total: a.total,
        errors: a.errors
      })),
      perEndpoint: perEndpoint.sort((a, b) => b.total - a.total),
      perClass: perClass.sort((a, b) => b.total - a.total),
      contract: {
        invalidSent: invalid?.count ?? 0,
        rejected4xx: invalid?.rejected4xx ?? 0,
        wronglyAccepted: invalid?.ok2xx ?? 0
      }
    };
  }

  function timeseries(bucketSec: 60 | 3600, from: number, to: number): TimeSeries {
    const sizeMs = bucketSec * 1000;
    const now = Date.now();
    // Unvalidated from/to used to let one request allocate tens of millions of
    // points and OOM the process, so both ends are normalised and the span is
    // capped before a single object is built.
    const safeTo = Number.isFinite(to) ? Math.min(to, now + sizeMs) : now;
    const retention = bucketSec === 60 ? MINUTE_RETENTION_MS : HOUR_RETENTION_MS;
    const earliest = safeTo - retention;
    let safeFrom = Number.isFinite(from) ? Math.max(from, earliest) : safeTo - 3_600_000;
    if (safeFrom > safeTo) safeFrom = safeTo;

    const fromB = Math.floor(safeFrom / sizeMs) * sizeMs;
    const toB = Math.floor(safeTo / sizeMs) * sizeMs;
    const requested = Math.floor((toB - fromB) / sizeMs) + 1;
    const truncated = requested > LIMITS.timeseriesPoints;
    const startB = truncated ? toB - (LIMITS.timeseriesPoints - 1) * sizeMs : fromB;

    const table = bucketSec === 60 ? "rollup_minute" : "rollup_hour";
    const rows = readRows(table, startB, toB);

    interface Acc {
      ts: number; total: number; errors: number; bytesResp: number;
      restTotal: number; soapTotal: number; restErrors: number; soapErrors: number;
      hist: Histogram; overheadHist: Histogram;
    }
    const points = new Map<number, Acc>();
    for (const r of rows) {
      let p = points.get(r.bucket_ts);
      if (!p) {
        p = {
          ts: r.bucket_ts, total: 0, errors: 0, bytesResp: 0,
          restTotal: 0, soapTotal: 0, restErrors: 0, soapErrors: 0,
          hist: emptyHistogram(), overheadHist: emptyHistogram()
        };
        points.set(r.bucket_ts, p);
      }
      p.total += r.count;
      p.errors += r.errors;
      p.bytesResp += r.bytes_resp;
      mergeHistograms(p.hist, parseHist(r.hist));
      mergeHistograms(p.overheadHist, parseHist(r.overhead_hist));
      if (r.protocol === "soap") {
        p.soapTotal += r.count;
        p.soapErrors += r.errors;
      } else {
        p.restTotal += r.count;
        p.restErrors += r.errors;
      }
    }
    // A bucket is still accumulating — "partial" — when it contains the
    // current time, or when it sits past the latest written data while a run is
    // still feeding the store. Partial marking only applies to windows that
    // reach now: trailing zeros of a historical window are real.
    const live = lastIngestAt !== null && now - lastIngestAt < LIVE_WINDOW_MS;
    // Math.max(...spread) copies the whole array onto the call stack and
    // throws RangeError on large ones; a loop costs the same and scales
    let lastDataTs: number | null = null;
    for (const r of rows) {
      if (lastDataTs === null || r.bucket_ts > lastDataTs) lastDataTs = r.bucket_ts;
    }
    const windowIsCurrent = safeTo > now - sizeMs;

    const out: TimePoint[] = [];
    for (let t = startB; t <= toB; t += sizeMs) {
      const p = points.get(t);
      if (!p) {
        const zero: TimePoint = { ts: t, total: 0, errors: 0, rps: 0, p50: 0, p90: 0, p99: 0, overheadP50: 0, overheadP95: 0, overheadP99: 0, bytesResp: 0, restTotal: 0, soapTotal: 0, restErrors: 0, soapErrors: 0 };
        if (windowIsCurrent && live && (t === toB || (lastDataTs !== null && t > lastDataTs))) {
          zero.partial = true;
        }
        out.push(zero);
        continue;
      }
      const point: TimePoint = {
        ts: p.ts, total: p.total, errors: p.errors,
        rps: p.total / bucketSec,
        p50: percentile(p.hist, 50),
        p90: percentile(p.hist, 90),
        p99: percentile(p.hist, 99),
        overheadP50: percentile(p.overheadHist, 50),
        overheadP95: percentile(p.overheadHist, 95),
        overheadP99: percentile(p.overheadHist, 99),
        bytesResp: p.bytesResp,
        restTotal: p.restTotal, soapTotal: p.soapTotal,
        restErrors: p.restErrors, soapErrors: p.soapErrors
      };
      if (windowIsCurrent && t === toB) {
        point.partial = true;
      }
      out.push(point);
    }
    return truncated ? { bucketSec, points: out, truncated } : { bucketSec, points: out };
  }

  const rawCleaner = setInterval(() => {
    try {
      const cutoff = Date.now() - RAW_RETENTION_MS;
      db.prepare(`DELETE FROM requests_raw WHERE ts < ?`).run(cutoff);
      const minuteCutoff = Math.floor((Date.now() - MINUTE_RETENTION_MS) / MINUTE_BUCKETS) * MINUTE_BUCKETS;
      db.prepare(`DELETE FROM rollup_minute WHERE bucket_ts < ?`).run(minuteCutoff);
      const hourCutoff = Math.floor((Date.now() - HOUR_RETENTION_MS) / HOUR_BUCKETS) * HOUR_BUCKETS;
      db.prepare(`DELETE FROM rollup_hour WHERE bucket_ts < ?`).run(hourCutoff);
      cleanupSeen.run(Date.now() - 6 * HOUR_BUCKETS);
      // WAL would otherwise grow without bound across a multi-week run
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      // a throw inside a timer callback would take the whole process down
      console.error("[metrics] retention sweep failed:", (e as Error).message);
    }
  }, 10 * 60_000);
  rawCleaner.unref();

  return {
    ingestBatch,
    summary,
    timeseries,
    recent: readRawRecent,
    readGateway: () => {
      const row = getConfig.get("gateway") as { value: string } | undefined;
      if (!row) return null;
      try { return JSON.parse(row.value) as unknown; } catch { return null; }
    },
    writeGateway: (cfg) => setConfig.run("gateway", JSON.stringify(cfg)),
    resetAll: () => {
      // config rows (gateway, profile) deliberately survive a reset
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM requests_raw");
        db.exec("DELETE FROM rollup_minute");
        db.exec("DELETE FROM rollup_hour");
        db.exec("DELETE FROM ingest_seen");
        db.exec("DELETE FROM runs");
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw e;
      }
      // give the freed pages back to the file system, as the sweeper does
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    pruneRuns: (olderThanMs) => {
      const cutoff = Date.now() - olderThanMs;
      return Number((db.prepare(`DELETE FROM runs WHERE started_at < ? AND stopped_at IS NOT NULL`).run(cutoff) as { changes: number | bigint }).changes);
    },
    readProfile: () => {
      const row = getConfig.get("profile") as { value: string } | undefined;
      if (!row) return null;
      try { return JSON.parse(row.value) as LoadProfile; } catch { return null; }
    },
    writeProfile: (p) => setConfig.run("profile", JSON.stringify(p)),
    recordRunStart: (runId, profile) => insertRun.run(runId, Date.now(), JSON.stringify(profile)),
    recordRunStop: (runId) => stopRun.run(Date.now(), runId),
    listRuns: () => {
      const rows = db.prepare(
        `SELECT id, run_id AS runId, started_at AS startedAt, stopped_at AS stoppedAt, profile
         FROM runs ORDER BY started_at DESC LIMIT 50`
      ).all() as unknown as (Omit<RunEvent, "profile"> & { profile: string })[];
      return rows.map((r) => {
        let profile: LoadProfile;
        try { profile = JSON.parse(r.profile) as LoadProfile; } catch { profile = {} as LoadProfile; }
        return { ...r, profile };
      });
    },
    close: () => {
      clearInterval(rawCleaner);
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* closing anyway */ }
      db.close();
    }
  };
}

/** Additive migrations for databases created by an older build. */
function migrate(db: DbHandle): void {
  for (const table of ["rollup_minute", "rollup_hour"]) {
    ensureColumn(db, table, "ok2xx", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "rejected4xx", "INTEGER NOT NULL DEFAULT 0");
  }
}

export const HISTOGRAM_EDGES = HISTOGRAM_EDGES_MS;
