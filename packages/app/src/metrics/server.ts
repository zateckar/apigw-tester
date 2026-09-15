import {
  DEFAULT_POLICY_CONFIG,
  DEFAULT_SLO,
  GATEWAY_FAULT_BUCKETS,
  HISTOGRAM_EDGES_MS,
  LIMITS,
  STATUS_BUCKETS,
  VALIDITY_LIMITS,
  sanitizePolicyConfig,
  sanitizeSlo
} from "@apigw/shared";
import type {
  ClassStat,
  ContractStats,
  EndpointStat,
  GwTargets,
  IngestBatch,
  LoadProfile,
  MetricSummary,
  PolicyConfig,
  PolicyResult,
  RequestResult,
  RunEvent,
  ScenarioClass,
  SloThresholds,
  StatusBreakdown,
  StatusBucket,
  SystemSample,
  TimePoint,
  TimeSeries,
  WindowScope,
  WindowValidity
} from "@apigw/shared";
import { openDb, ensureColumn, type DbHandle } from "./db.js";
import {
  Histogram,
  StatusHistogram,
  addToStatusHistogram,
  emptyHistogram,
  emptyStatusHistogram,
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

/** the loadgen driver's flush cadence; batch size ÷ this is the ingest rate.
 *  Must match FLUSH_MS in loadgen/driver.ts. */
const FLUSH_MS = 10_000;
const FLUSH_SEC = FLUSH_MS / 1000;
/** rows per multi-row VALUES insert — 200 × 13 params stays far under
 *  SQLite's ~32766 bind-parameter ceiling */
const RAW_CHUNK_ROWS = 200;
/** ceiling on the sampling factor so the raw tail never thins out completely */
const MAX_SAMPLE_K = 100;

export interface MetricsStore {
  ingestBatch: (batch: IngestBatch) => { ingested: number; duplicate?: boolean };
  summary: (windowMs: number) => MetricSummary;
  /** Same shape as summary(), over an explicit span — the basis of a per-run
   *  report. Buckets are minute-granular, so a span is resolved to the buckets
   *  it touches rather than to the millisecond. */
  summaryBetween: (from: number, to: number) => MetricSummary;
  /** How much of a report window's traffic belongs to some other run. */
  windowScope: (runId: string, from: number, to: number) => WindowScope;
  /** Fold one host sample into the current minute's health row. */
  recordHealth: (sample: SystemSample) => void;
  readPolicyResults: () => PolicyResult[];
  writePolicyResults: (results: PolicyResult[]) => void;
  readPolicyConfig: () => PolicyConfig;
  writePolicyConfig: (cfg: PolicyConfig) => void;
  readSlo: () => SloThresholds;
  writeSlo: (slo: SloThresholds) => void;
  findRun: (runId: string) => RunEvent | null;
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
  rejected4xx_gw: number;
  reached_backend: number;
  latency_sum_ms: number;
  max_latency_ms: number;
  overhead_sum_ms: number;
  overhead_max_ms: number;
  bytes_req: number;
  bytes_resp: number;
  hist: string;
  overhead_hist: string;
  status_hist: string;
}

interface Combined {
  protocol: string;
  endpoint: string;
  cls: string;
  count: number;
  errors: number;
  ok2xx: number;
  rejected4xx: number;
  rejected4xxGw: number;
  reachedBackend: number;
  latencySumMs: number;
  maxLatencyMs: number;
  overheadSumMs: number;
  overheadMaxMs: number;
  bytesReq: number;
  bytesResp: number;
  hist: Histogram;
  overheadHist: Histogram;
  statusHist: StatusHistogram;
}

function newCombined(r: RollupRow): Combined {
  return {
    protocol: r.protocol, endpoint: r.endpoint, cls: r.cls,
    count: 0, errors: 0, ok2xx: 0, rejected4xx: 0, rejected4xxGw: 0, reachedBackend: 0,
    latencySumMs: 0, maxLatencyMs: 0,
    overheadSumMs: 0, overheadMaxMs: 0, bytesReq: 0, bytesResp: 0,
    hist: emptyHistogram(), overheadHist: emptyHistogram(), statusHist: emptyStatusHistogram()
  };
}

/** Count across a status histogram for the named buckets. */
function statusCount(h: StatusHistogram, buckets: readonly StatusBucket[]): number {
  let n = 0;
  for (const b of buckets) {
    const i = STATUS_BUCKETS.indexOf(b);
    if (i >= 0) n += h[i] ?? 0;
  }
  return n;
}

const OVERHEAD_CLASSES: ReadonlySet<string> = new Set(["small-rest", "concurrency", "soap"]);

const CLIENT_ERROR_BUCKETS: readonly StatusBucket[] =
  STATUS_BUCKETS.filter((b) => b === "4xx" || /^4\d\d$/.test(b));
const SERVER_ERROR_BUCKETS: readonly StatusBucket[] =
  STATUS_BUCKETS.filter((b) => b === "5xx" || /^5\d\d$/.test(b));
const OK_BUCKETS: readonly StatusBucket[] = ["2xx", "3xx"];

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
    c.rejected4xxGw += r.rejected4xx_gw ?? 0;
    c.reachedBackend += r.reached_backend ?? 0;
    c.latencySumMs += r.latency_sum_ms;
    c.maxLatencyMs = Math.max(c.maxLatencyMs, r.max_latency_ms);
    c.overheadSumMs += r.overhead_sum_ms;
    c.overheadMaxMs = Math.max(c.overheadMaxMs, r.overhead_max_ms);
    c.bytesReq += r.bytes_req;
    c.bytesResp += r.bytes_resp;
    mergeHistograms(c.hist, parseHist(r.hist));
    mergeHistograms(c.overheadHist, parseHist(r.overhead_hist));
    mergeHistograms(c.statusHist, parseHist(r.status_hist));
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

const RAW_COLS = `(ts, run_id, request_id, protocol, endpoint, class, method, status, latency_ms, baseline_ms, overhead_ms, bytes_req, bytes_resp, reached_backend, error)`;
const RAW_NCOLS = 15;

/** build one multi-row INSERT for `rows` raw results */
function rawInsertSql(rows: number): string {
  const tuple = `(${Array(RAW_NCOLS).fill("?").join(", ")})`;
  return `INSERT INTO requests_raw ${RAW_COLS} VALUES ${Array(rows).fill(tuple).join(", ")}`;
}

function rawInsertParams(r: RequestResult): (string | number | null)[] {
  return [r.ts, r.runId, r.requestId ?? "", r.protocol, r.endpoint, r.class, r.method, r.status,
    r.latencyMs, r.baselineMs, r.overheadMs, r.bytesReq, r.bytesResp,
    r.reachedBackend === true ? 1 : 0, r.error ?? null];
}

export function createMetricsStore(dbPath: string): MetricsStore {
  const db = openDb(dbPath);
  migrate(db);

  // Histogram columns are merged in JS (positional, fixed-length) rather than
  // by SQL: a recursive-CTE json merge per column per row was the single
  // largest CPU sink of the ingest path. The flow is: SELECT the existing row
  // for each (bucket_ts, protocol, endpoint, cls) key inside the same
  // transaction, mergeHistograms() the stored arrays into the in-memory
  // bucket, then write the full merged arrays back with a plain upsert whose
  // scalar columns stay cheap SQL arithmetic. Rows written by an older build
  // (hist='[]') merge positionally as all-zero.
  function selectRow(table: string): string {
    return `SELECT hist, overhead_hist, status_hist FROM ${table}
     WHERE bucket_ts = ? AND protocol = ? AND endpoint = ? AND cls = ?`;
  }

  function layer(table: string): string {
    return `
     INSERT INTO ${table} (bucket_ts, protocol, endpoint, cls, count, errors, ok2xx, rejected4xx, rejected4xx_gw, reached_backend, latency_sum_ms, max_latency_ms, overhead_sum_ms, overhead_max_ms, bytes_req, bytes_resp, hist, overhead_hist, status_hist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_ts, protocol, endpoint, cls) DO UPDATE SET
       count = count + excluded.count,
       errors = errors + excluded.errors,
       ok2xx = ok2xx + excluded.ok2xx,
       rejected4xx = rejected4xx + excluded.rejected4xx,
       rejected4xx_gw = rejected4xx_gw + excluded.rejected4xx_gw,
       reached_backend = reached_backend + excluded.reached_backend,
       latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
       max_latency_ms = MAX(max_latency_ms, excluded.max_latency_ms),
       overhead_sum_ms = overhead_sum_ms + excluded.overhead_sum_ms,
       overhead_max_ms = MAX(overhead_max_ms, excluded.overhead_max_ms),
       bytes_req = bytes_req + excluded.bytes_req,
       bytes_resp = bytes_resp + excluded.bytes_resp,
       hist = excluded.hist,
       overhead_hist = excluded.overhead_hist,
       status_hist = excluded.status_hist`;
  }
  const selectMinute = db.prepare(selectRow("rollup_minute"));
  const selectHour = db.prepare(selectRow("rollup_hour"));
  const upsertMinute = db.prepare(layer("rollup_minute"));
  const upsertHour = db.prepare(layer("rollup_hour"));
  const upsertShed = db.prepare(
    `INSERT INTO load_shed (bucket_ts, dropped, target_sum, ticks) VALUES (?, ?, ?, ?)
     ON CONFLICT(bucket_ts) DO UPDATE SET
       dropped = dropped + excluded.dropped,
       target_sum = target_sum + excluded.target_sum,
       ticks = ticks + excluded.ticks`
  );
  const upsertHealth = db.prepare(
    `INSERT INTO host_health (bucket_ts, samples, cpu_sum, cpu_max, loop_p99_sum, loop_p99_max)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(bucket_ts) DO UPDATE SET
       samples = samples + 1,
       cpu_sum = cpu_sum + excluded.cpu_sum,
       cpu_max = MAX(cpu_max, excluded.cpu_max),
       loop_p99_sum = loop_p99_sum + excluded.loop_p99_sum,
       loop_p99_max = MAX(loop_p99_max, excluded.loop_p99_max)`
  );
  const upsertPolicy = db.prepare(
    `INSERT INTO policy_results (id, checked_at, payload) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at, payload = excluded.payload`
  );
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
      `SELECT bucket_ts, protocol, endpoint, cls, count, errors, ok2xx, rejected4xx, rejected4xx_gw,
              reached_backend, latency_sum_ms, max_latency_ms,
              overhead_sum_ms, overhead_max_ms, bytes_req, bytes_resp, hist, overhead_hist, status_hist
       FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).all(fromBucket, toBucket) as unknown as RollupRow[];

  const readRawRecent = (limit: number): RequestResult[] => {
    const n = Number(limit);
    // guard both NaN and negatives: SQLite reads LIMIT -1 as "no limit"
    const safe = Number.isFinite(n) ? Math.min(LIMITS.recentLimit, Math.max(1, Math.trunc(n))) : 100;
    const rows = db.prepare(
      `SELECT ts, run_id AS runId, request_id AS requestId, protocol, endpoint, class, method, status,
              latency_ms AS latencyMs, baseline_ms AS baselineMs, overhead_ms AS overheadMs,
              bytes_req AS bytesReq, bytes_resp AS bytesResp, reached_backend AS reachedBackend, error
       FROM requests_raw ORDER BY ts DESC LIMIT ?`
    ).all(safe) as unknown as (Omit<RequestResult, "reachedBackend"> & { reachedBackend: number })[];
    // SQLite has no boolean type; hand the UI a real one rather than 0/1
    return rows.map((r) => ({ ...r, reachedBackend: r.reachedBackend === 1 }));
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

  function windowRows(from: number, to: number): RollupRow[] {
    const spanMs = to - from;
    if (spanMs <= MINUTE_LAYER_MAX_MS) {
      return readRows("rollup_minute", Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS, Math.floor(to / MINUTE_BUCKETS) * MINUTE_BUCKETS);
    }
    return readRows("rollup_hour", Math.floor(from / HOUR_BUCKETS) * HOUR_BUCKETS, Math.floor(to / HOUR_BUCKETS) * HOUR_BUCKETS);
  }

  /**
   * Whether this window's numbers can be believed.
   *
   * Both inputs are minute-granular regardless of which roll-up layer the
   * metrics came from — one row per minute is cheap even across a week, and a
   * validity signal averaged into hour buckets would hide exactly the short
   * saturation spikes it exists to catch.
   */
  function validityFor(from: number, to: number, total: number): WindowValidity {
    const fromB = Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    const toB = Math.floor(to / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    const shed = db.prepare(
      `SELECT COALESCE(SUM(dropped),0) AS dropped, COALESCE(SUM(target_sum),0) AS targetSum,
              COALESCE(SUM(ticks),0) AS ticks
       FROM load_shed WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).get(fromB, toB) as { dropped: number; targetSum: number; ticks: number };
    const health = db.prepare(
      `SELECT COALESCE(MAX(cpu_max),-1) AS cpuMax, COALESCE(MAX(loop_p99_max),-1) AS loopMax,
              COALESCE(SUM(samples),0) AS samples
       FROM host_health WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).get(fromB, toB) as { cpuMax: number; loopMax: number; samples: number };

    const windowSec = Math.max(1, (to - from) / 1000);
    const dropped = Number(shed.dropped) || 0;
    const issued = total;
    const intended = issued + dropped;
    const shedPct = intended === 0 ? 0 : (100 * dropped) / intended;
    const targetRps = Number(shed.ticks) > 0 ? Number(shed.targetSum) / Number(shed.ticks) : null;
    const cpuMax = Number(health.samples) > 0 && health.cpuMax >= 0 ? health.cpuMax : null;
    const loopMax = Number(health.samples) > 0 && health.loopMax >= 0 ? health.loopMax : null;

    const reasons: string[] = [];
    if (shedPct > VALIDITY_LIMITS.shedPct) {
      reasons.push(
        `${shedPct.toFixed(1)}% of the intended load was never issued (${dropped.toLocaleString()} requests) — ` +
        `the concurrency ceiling throttled the generator, so the target was never actually offered to the gateway`
      );
    }
    if (cpuMax !== null && cpuMax > VALIDITY_LIMITS.cpuProcessPct) {
      reasons.push(`generator CPU peaked at ${cpuMax.toFixed(0)}% of the machine (limit ${VALIDITY_LIMITS.cpuProcessPct}%) — measured latency includes our own queueing`);
    }
    if (loopMax !== null && loopMax > VALIDITY_LIMITS.eventLoopP99Ms) {
      reasons.push(`event-loop p99 stalled at ${loopMax.toFixed(0)} ms (limit ${VALIDITY_LIMITS.eventLoopP99Ms} ms) — every latency in this window is inflated by that much`);
    }

    return {
      ok: reasons.length === 0,
      reasons,
      droppedRequests: dropped,
      shedPct,
      targetRps,
      achievedRps: issued / windowSec,
      cpuProcessPctMax: cpuMax,
      eventLoopP99MsMax: loopMax
    };
  }

  /**
   * How much of a report window is somebody else's traffic.
   *
   * Roll-ups carry no run id, so a per-run summary is really "everything in the
   * minutes this run touched". The raw table does carry one, and it is kept for
   * 24h — long enough to answer this for any run you would actually report on.
   * Older than that, the honest answer is "unknown", not "zero".
   */
  function windowScope(runId: string, from: number, to: number): WindowScope {
    const fromB = Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    const toB = Math.floor(to / MINUTE_BUCKETS) * MINUTE_BUCKETS + MINUTE_BUCKETS - 1;
    const row = db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN run_id <> ? THEN 1 ELSE 0 END), 0) AS foreign_rows
         FROM requests_raw WHERE ts >= ? AND ts <= ?`
    ).get(runId, fromB, toB) as { total: number; foreign_rows: number };
    const total = Number(row.total) || 0;
    const foreignRequests = Number(row.foreign_rows) || 0;
    return {
      foreignRequests,
      totalRequests: total,
      foreignPct: total === 0 ? 0 : (100 * foreignRequests) / total
    };
  }

  function ingestBatch(batch: IngestBatch): { ingested: number; duplicate?: boolean } {
    if (!batch || !Array.isArray(batch.results) || typeof batch.batchId !== "string" || batch.batchId === "") {
      throw new Error("batchId and results[] required");
    }
    if (seenBatch.get(batch.batchId)) return { ingested: 0, duplicate: true };

    interface Bucket {
      bucket_ts: number; protocol: string; endpoint: string; cls: string;
      count: number; errors: number; ok2xx: number; rejected4xx: number;
      rejected4xx_gw: number; reached_backend: number;
      latency_sum_ms: number; max_latency_ms: number;
      overhead_sum_ms: number; overhead_max_ms: number;
      bytes_req: number; bytes_resp: number;
      hist: Histogram; overhead_hist: Histogram; status_hist: StatusHistogram;
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
        // `X-Server-Ms` on the response is the backend's fingerprint. Without
        // it the response was manufactured before the backend was reached —
        // which is how "the gateway rejected it" is told apart from "the
        // backend rejected it" for the deliberately-invalid slice.
        const reached = r.reachedBackend === true;

        for (const [bucketTs, table] of [[mB, minute], [hB, hour]] as const) {
          const key = `${bucketTs}|${r.protocol}|${r.endpoint}|${r.class}`;
          let b = table.get(key);
          if (!b) {
            b = {
              bucket_ts: bucketTs, protocol: r.protocol, endpoint: r.endpoint, cls: r.class,
              count: 0, errors: 0, ok2xx: 0, rejected4xx: 0,
              rejected4xx_gw: 0, reached_backend: 0,
              latency_sum_ms: 0, max_latency_ms: 0,
              overhead_sum_ms: 0, overhead_max_ms: 0,
              bytes_req: 0, bytes_resp: 0,
              hist: emptyHistogram(), overhead_hist: emptyHistogram(),
              status_hist: emptyStatusHistogram()
            };
            table.set(key, b);
          }
          b.count++;
          b.errors += isErr ? 1 : 0;
          b.ok2xx += is2xx ? 1 : 0;
          b.rejected4xx += is4xx ? 1 : 0;
          b.rejected4xx_gw += is4xx && !reached ? 1 : 0;
          b.reached_backend += reached ? 1 : 0;
          b.latency_sum_ms += r.latencyMs;
          b.max_latency_ms = Math.max(b.max_latency_ms, r.latencyMs);
          b.overhead_sum_ms += r.overheadMs;
          b.overhead_max_ms = Math.max(b.overhead_max_ms, r.overheadMs);
          b.bytes_req += r.bytesReq;
          b.bytes_resp += r.bytesResp;
          addToHistogram(b.hist, r.latencyMs);
          // overhead percentiles are only quoted for the latency-sensitive
          // classes; for the noise classes the histogram stays all-zero (the
          // sums above still feed the avg) and the UI renders it fine
          if (OVERHEAD_CLASSES.has(r.class)) addToHistogram(b.overhead_hist, r.overheadMs);
          addToStatusHistogram(b.status_hist, r.status);
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
      type StoredHists = { hist: string; overhead_hist: string; status_hist: string };
      type Bind = string | number | bigint | null | Uint8Array | boolean;
      // Merge the stored histograms into the in-memory buckets first, then
      // write the full merged arrays back; scalar columns stay SQL-side deltas.
      const upsertParams = (b: Bucket): Bind[] => [
        b.bucket_ts, b.protocol, b.endpoint, b.cls, b.count, b.errors, b.ok2xx, b.rejected4xx,
        b.rejected4xx_gw, b.reached_backend, b.latency_sum_ms, b.max_latency_ms,
        b.overhead_sum_ms, b.overhead_max_ms, b.bytes_req, b.bytes_resp,
        JSON.stringify(b.hist), JSON.stringify(b.overhead_hist), JSON.stringify(b.status_hist)
      ];
      const mergeIntoAndUpsert = (
        buckets: Map<string, Bucket>,
        select: typeof selectMinute,
        upsert: typeof upsertMinute
      ): void => {
        for (const b of buckets.values()) {
          const existing = select.get(b.bucket_ts, b.protocol, b.endpoint, b.cls) as StoredHists | undefined;
          if (existing) {
            mergeHistograms(b.hist, parseHist(existing.hist));
            mergeHistograms(b.overhead_hist, parseHist(existing.overhead_hist));
            mergeHistograms(b.status_hist, parseHist(existing.status_hist));
          }
          upsert.run(...upsertParams(b));
        }
      };
      mergeIntoAndUpsert(minute, selectMinute, upsertMinute);
      mergeIntoAndUpsert(hour, selectHour, upsertHour);
      // shed rows ride the same transaction as the requests they explain, so a
      // window can never show the load we issued without the load we did not
      for (const s of batch.shed ?? []) {
        if (!Number.isFinite(s?.bucketTs)) continue;
        upsertShed.run(
          Math.floor(s.bucketTs / MINUTE_BUCKETS) * MINUTE_BUCKETS,
          Math.max(0, Math.round(s.dropped) || 0),
          Number.isFinite(s.targetSum) ? s.targetSum : 0,
          Math.max(0, Math.round(s.ticks) || 0)
        );
      }
      markBatch.run(batch.batchId, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
      throw e;
    }
    lastIngestAt = Date.now();
    summaryCacheKey = "";
    summaryCacheVal = null;
    return { ingested: batch.results.length };
  }

  // The dashboard polls every ~2s but roll-ups only change on a flush, so the
  // whole window merge is memoized per (windowMs, flush index). The cache key
  // advances on every ingest, invalidating automatically.
  let summaryCacheKey = "";
  let summaryCacheVal: MetricSummary | null = null;

  function summary(windowMs: number): MetricSummary {
    const now = Date.now();
    const key = `${windowMs}|${Math.floor(now / FLUSH_MS)}`;
    if (summaryCacheVal !== null && key === summaryCacheKey) return summaryCacheVal;
    const val = summaryBetween(now - windowMs, now);
    summaryCacheKey = key;
    summaryCacheVal = val;
    return val;
  }

  function summaryBetween(from: number, to: number): MetricSummary {
    // Roll-ups are written synchronously during ingest, so they already include
    // the in-progress minute. There is deliberately no separate "live tail" pass
    // here — adding one double-counted every request in the current bucket.
    const rows = windowRows(from, to);
    const windowMs = Math.max(0, to - from);
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
    const totalStatusHist = emptyStatusHistogram();
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
      mergeHistograms(totalStatusHist, c.statusHist);
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

    // Every request that did not return 2xx/3xx, minus the invalid slice's
    // rejections — those are the point of that slice, not a failure.
    let unexpectedFailures = 0;
    for (const [cls, c] of byClass.entries()) {
      if (c.count === 0) continue;
      const notOk = c.count - statusCount(c.statusHist, OK_BUCKETS);
      // an `invalid` request answered 4xx is a pass, not a failure; an invalid
      // request that 502s or 2xxs still counts against the gateway
      unexpectedFailures += cls === "invalid" ? Math.max(0, notOk - c.rejected4xx) : notOk;
      perClass.push({
        cls: cls as ScenarioClass,
        total: c.count,
        errors: c.errors,
        errorPct: (100 * c.errors) / c.count,
        clientErrors: statusCount(c.statusHist, CLIENT_ERROR_BUCKETS),
        gatewayErrors: statusCount(c.statusHist, GATEWAY_FAULT_BUCKETS),
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
    const status: StatusBreakdown = {
      buckets: STATUS_BUCKETS
        .map((bucket, i) => ({ bucket: bucket as StatusBucket, count: totalStatusHist[i] ?? 0 }))
        .filter((b) => b.count > 0)
        .sort((a, b) => b.count - a.count),
      ok: statusCount(totalStatusHist, OK_BUCKETS),
      clientErrors: statusCount(totalStatusHist, CLIENT_ERROR_BUCKETS),
      serverErrors: statusCount(totalStatusHist, SERVER_ERROR_BUCKETS),
      gatewayErrors: statusCount(totalStatusHist, GATEWAY_FAULT_BUCKETS),
      rateLimited: statusCount(totalStatusHist, ["429"]),
      unauthorized: statusCount(totalStatusHist, ["401", "403"]),
      networkErrors: statusCount(totalStatusHist, ["net"])
    };
    const contract: ContractStats = {
      invalidSent: invalid?.count ?? 0,
      rejectedByGateway: invalid?.rejected4xxGw ?? 0,
      rejectedByBackend: Math.max(0, (invalid?.rejected4xx ?? 0) - (invalid?.rejected4xxGw ?? 0)),
      leakedToBackend: invalid?.reachedBackend ?? 0,
      wronglyAccepted: invalid?.ok2xx ?? 0,
      rejected4xx: invalid?.rejected4xx ?? 0
    };
    return {
      windowSec,
      total,
      errors,
      errorPct: total === 0 ? 0 : (100 * errors) / total,
      unexpectedFailures,
      unexpectedFailurePct: total === 0 ? 0 : (100 * unexpectedFailures) / total,
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
      status,
      validity: validityFor(from, to, total),
      perProtocol: [...protoAcc.entries()].map(([protocol, a]) => ({
        protocol: protocol === "soap" ? "soap" as const : "rest" as const,
        total: a.total,
        errors: a.errors
      })),
      perEndpoint: perEndpoint.sort((a, b) => b.total - a.total),
      perClass: perClass.sort((a, b) => b.total - a.total),
      contract
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
      ts: number; total: number; errors: number; clientErrors: number; gatewayErrors: number;
      bytesResp: number;
      restTotal: number; soapTotal: number; restErrors: number; soapErrors: number;
      hist: Histogram; overheadHist: Histogram;
    }
    const points = new Map<number, Acc>();
    for (const r of rows) {
      let p = points.get(r.bucket_ts);
      if (!p) {
        p = {
          ts: r.bucket_ts, total: 0, errors: 0, clientErrors: 0, gatewayErrors: 0, bytesResp: 0,
          restTotal: 0, soapTotal: 0, restErrors: 0, soapErrors: 0,
          hist: emptyHistogram(), overheadHist: emptyHistogram()
        };
        points.set(r.bucket_ts, p);
      }
      p.total += r.count;
      p.errors += r.errors;
      p.clientErrors += r.rejected4xx ?? 0;
      p.gatewayErrors += statusCount(parseHist(r.status_hist), GATEWAY_FAULT_BUCKETS);
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
        const zero: TimePoint = { ts: t, total: 0, errors: 0, clientErrors: 0, gatewayErrors: 0, rps: 0, p50: 0, p90: 0, p99: 0, overheadP50: 0, overheadP95: 0, overheadP99: 0, bytesResp: 0, restTotal: 0, soapTotal: 0, restErrors: 0, soapErrors: 0 };
        if (windowIsCurrent && live && (t === toB || (lastDataTs !== null && t > lastDataTs))) {
          zero.partial = true;
        }
        out.push(zero);
        continue;
      }
      const point: TimePoint = {
        ts: p.ts, total: p.total, errors: p.errors,
        clientErrors: p.clientErrors, gatewayErrors: p.gatewayErrors,
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
      // validity inputs are minute-granular and only ever read alongside the
      // minute layer, so they age out on the same schedule as it
      db.prepare(`DELETE FROM load_shed WHERE bucket_ts < ?`).run(minuteCutoff);
      db.prepare(`DELETE FROM host_health WHERE bucket_ts < ?`).run(minuteCutoff);
      cleanupSeen.run(Date.now() - 6 * HOUR_BUCKETS);
      // WAL would otherwise grow without bound across a multi-week run
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      // a throw inside a timer callback would take the whole process down
      console.error("[metrics] retention sweep failed:", (e as Error).message);
    }
  }, 10 * 60_000);
  rawCleaner.unref();

  const readJsonConfig = <T,>(key: string, coerce: (raw: unknown) => T): T => {
    const row = getConfig.get(key) as { value: string } | undefined;
    if (!row) return coerce(undefined);
    try { return coerce(JSON.parse(row.value)); } catch { return coerce(undefined); }
  };

  return {
    ingestBatch,
    summary,
    summaryBetween,
    windowScope,
    timeseries,
    recent: readRawRecent,
    recordHealth: (s) => {
      // a null CPU means the sampler had no previous sample to delta against;
      // folding 0 in would make a starting process look idle rather than unknown
      if (s.cpuProcessPct === null && s.eventLoopP99ms === null) return;
      const bucket = Math.floor(s.ts / MINUTE_BUCKETS) * MINUTE_BUCKETS;
      const cpu = s.cpuProcessPct ?? 0;
      const loop = s.eventLoopP99ms ?? 0;
      upsertHealth.run(bucket, cpu, cpu, loop, loop);
    },
    readPolicyResults: () => {
      const rows = db.prepare(`SELECT payload FROM policy_results ORDER BY id`).all() as unknown as { payload: string }[];
      const out: PolicyResult[] = [];
      for (const r of rows) {
        try { out.push(JSON.parse(r.payload) as PolicyResult); } catch { /* a row we can't read is a row we skip */ }
      }
      return out;
    },
    writePolicyResults: (results) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const r of results) upsertPolicy.run(r.id, r.checkedAt, JSON.stringify(r));
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw e;
      }
    },
    readPolicyConfig: () => readJsonConfig("policy", (raw) => sanitizePolicyConfig(raw, DEFAULT_POLICY_CONFIG)),
    writePolicyConfig: (cfg) => setConfig.run("policy", JSON.stringify(cfg)),
    readSlo: () => readJsonConfig("slo", (raw) => sanitizeSlo(raw, DEFAULT_SLO)),
    writeSlo: (slo) => setConfig.run("slo", JSON.stringify(slo)),
    findRun: (runId) => {
      const row = db.prepare(
        `SELECT id, run_id AS runId, started_at AS startedAt, stopped_at AS stoppedAt, profile
         FROM runs WHERE run_id = ? ORDER BY started_at DESC LIMIT 1`
      ).get(runId) as unknown as (Omit<RunEvent, "profile"> & { profile: string }) | undefined;
      if (!row) return null;
      let profile: LoadProfile;
      try { profile = JSON.parse(row.profile) as LoadProfile; } catch { profile = {} as LoadProfile; }
      return { ...row, profile };
    },
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
        db.exec("DELETE FROM load_shed");
        db.exec("DELETE FROM host_health");
        db.exec("DELETE FROM policy_results");
        db.exec("DELETE FROM ingest_seen");
        db.exec("DELETE FROM runs");
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw e;
      }
      // give the freed pages back to the file system, as the sweeper does
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      summaryCacheKey = "";
      summaryCacheVal = null;
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
      // finalize prepared statements too — without it on Windows the file
      // stays locked past close() and temp-dir cleanup in tests fails EBUSY
      db.close(true);
    }
  };
}

/**
 * Additive migrations for databases created by an older build.
 *
 * Every column defaults to a value that reads as "we did not record this", so a
 * pre-migration bucket reports zero gateway rejections rather than inventing
 * them: `status_hist` of `'[]'` merges positionally as all-zero, and
 * `reached_backend`/`rejected4xx_gw` of 0 leave the contract block showing the
 * conservative answer for old data instead of a flattering one.
 */
function migrate(db: DbHandle): void {
  for (const table of ["rollup_minute", "rollup_hour"]) {
    ensureColumn(db, table, "ok2xx", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "rejected4xx", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "rejected4xx_gw", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "reached_backend", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "status_hist", "TEXT NOT NULL DEFAULT '[]'");
  }
  ensureColumn(db, "requests_raw", "request_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "requests_raw", "reached_backend", "INTEGER NOT NULL DEFAULT 0");
}

export const HISTOGRAM_EDGES = HISTOGRAM_EDGES_MS;
