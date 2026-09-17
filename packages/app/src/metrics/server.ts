import {
  DEFAULT_POLICY_CONFIG,
  DEFAULT_SLO,
  GATEWAY_FAULT_BUCKETS,
  HISTOGRAM_EDGES_MS,
  LIMITS,
  RAW_TAIL_PER_FLUSH,
  STATUS_BUCKETS,
  VALIDITY_LIMITS,
  minSamplesForPercentile,
  sanitizePolicyConfig,
  sanitizeSlo
} from "@apigw/shared";
import type {
  AggCell,
  AggregateBatch,
  ClassStat,
  ConnSetupStats,
  NonBackendStats,
  ContractStats,
  EndpointStat,
  GwTargets,
  IngestBatch,
  LoadProfile,
  MetricSummary,
  OverheadDelta,
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
import { aggregateBatch } from "./aggregate.js";
import { openDb, ensureColumn, type DbHandle } from "./db.js";
import {
  Histogram,
  ResidualHistogram,
  StatusHistogram,
  emptyHistogram,
  emptyResidualHistogram,
  emptyStatusHistogram,
  meanFromRollup,
  mergeHistograms,
  percentile,
  residualPercentile
} from "./rollup.js";

const MINUTE_BUCKETS = 60_000;
const HOUR_BUCKETS = 3_600_000;
const RAW_RETENTION_MS = 24 * HOUR_BUCKETS;
const MINUTE_RETENTION_MS = 7 * 24 * HOUR_BUCKETS;
const HOUR_RETENTION_MS = 90 * 24 * HOUR_BUCKETS;

/** dashboard summary cache granularity — not a batch cadence; a driver may
 *  flush as often as it likes. */
const FLUSH_MS = 10_000;
/** rows per multi-row VALUES insert — 200 × 17 params stays far under
 *  SQLite's ~32766 bind-parameter ceiling */
const RAW_CHUNK_ROWS = 200;

export interface MetricsStore {
  /** The public `/api/ingest` shape: one object per request, rolled up here. */
  ingestBatch: (batch: IngestBatch) => { ingested: number; duplicate?: boolean };
  /** The generators' shape: already rolled up, with a bounded raw tail. This is
   *  the write path; ingestBatch composes onto it. */
  ingestAggregate: (batch: AggregateBatch) => { ingested: number; duplicate?: boolean };
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
  first_ts: number | null;
  last_ts: number | null;
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
  bytes_req: number;
  bytes_resp: number;
  conn_setups: number;
  conn_setup_sum_ms: number;
  conn_measured: number;
  hist: string;
  status_hist: string;
  nb_count: number;
  nb_sum_ms: number;
  nb_hist: string;
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
  bytesReq: number;
  bytesResp: number;
  connSetups: number;
  connSetupSumMs: number;
  connMeasured: number;
  hist: Histogram;
  statusHist: StatusHistogram;
  nbCount: number;
  nbSumMs: number;
  nbHist: ResidualHistogram;
}

function newCombined(r: RollupRow): Combined {
  return {
    protocol: r.protocol, endpoint: r.endpoint, cls: r.cls,
    count: 0, errors: 0, ok2xx: 0, rejected4xx: 0, rejected4xxGw: 0, reachedBackend: 0,
    latencySumMs: 0, maxLatencyMs: 0, bytesReq: 0, bytesResp: 0,
    connSetups: 0, connSetupSumMs: 0, connMeasured: 0,
    hist: emptyHistogram(), statusHist: emptyStatusHistogram(),
    nbCount: 0, nbSumMs: 0, nbHist: emptyResidualHistogram()
  };
}

/** The reported shape of non-backend time over a set of rolled-up rows. */
function nonBackendStats(rows: Iterable<Combined>): NonBackendStats {
  const hist = emptyResidualHistogram();
  let count = 0;
  let sumMs = 0;
  for (const c of rows) {
    mergeHistograms(hist, c.nbHist);
    count += c.nbCount;
    sumMs += c.nbSumMs;
  }
  // No gate beyond "did anything measure it". Every request carrying both
  // clocks contributes one observation, so a percentile here is drawn from the
  // traffic itself rather than from a 2% control stream — which is the whole
  // reason this replaced the two-arm Δ as the headline.
  if (count === 0) {
    return { p50: null, p90: null, p95: null, p99: null, avg: null, count: 0 };
  }
  return {
    p50: residualPercentile(hist, 50),
    p90: residualPercentile(hist, 90),
    p95: residualPercentile(hist, 95),
    p99: residualPercentile(hist, 99),
    avg: sumMs / count,
    count
  };
}

/** Roll the connection-reuse counters of a set of combined rows into the
 *  reported shape. Shares of `measured`, never of `count`: a generator that
 *  cannot see connection events contributes rows with measured = 0, and
 *  dividing by the request count there would report perfect reuse. */
function connSetupStats(rows: Iterable<Combined>): ConnSetupStats {
  let setups = 0;
  let measured = 0;
  let sumMs = 0;
  for (const c of rows) {
    setups += c.connSetups;
    measured += c.connMeasured;
    sumMs += c.connSetupSumMs;
  }
  return {
    setups,
    measured,
    pct: measured === 0 ? null : (100 * setups) / measured,
    avgMs: setups === 0 ? null : sumMs / setups
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

// ---- residual distributions and the gateway Δ ------------------------------

/** Which side of the comparison a residual distribution belongs to. */
type ResidualPath = "gw" | "direct";

/** One arm: the residuals of one path, over one class, over one window. */
interface ResidualArm {
  hist: ResidualHistogram;
  count: number;
  sumMs: number;
}

function emptyArm(): ResidualArm {
  return { hist: emptyResidualHistogram(), count: 0, sumMs: 0 };
}

interface ResidualPair { gw: ResidualArm; direct: ResidualArm }

function emptyPair(): ResidualPair {
  return { gw: emptyArm(), direct: emptyArm() };
}

function mergeArm(into: ResidualArm, from: ResidualArm): void {
  mergeHistograms(into.hist, from.hist);
  into.count += from.count;
  into.sumMs += from.sumMs;
}

function mergePair(into: ResidualPair, from: ResidualPair): void {
  mergeArm(into.gw, from.gw);
  mergeArm(into.direct, from.direct);
}

/**
 * The headline number: how much worse the gateway path's residual distribution
 * is than the direct path's, read at matching percentiles.
 *
 * Every percentile is gated on the *thinner* of the two arms, because a
 * difference is only as sound as its weaker side — and the direct arm is
 * deliberately a small fraction of the load, so it is nearly always the one
 * that runs out first. A gated percentile comes back null with a reason rather
 * than as a confident number drawn from three samples.
 */
function overheadDelta(pair: ResidualPair): OverheadDelta {
  const { gw, direct } = pair;
  const support = Math.min(gw.count, direct.count);
  const thin: number[] = [];
  const at = (p: number): number | null => {
    if (support < minSamplesForPercentile(p)) {
      thin.push(p);
      return null;
    }
    const a = residualPercentile(gw.hist, p);
    const b = residualPercentile(direct.hist, p);
    return a === null || b === null ? null : a - b;
  };
  // fixed order so `thin` reads low-to-high in the message below
  const p50 = at(50);
  const p90 = at(90);
  const p95 = at(95);
  const p99 = at(99);

  let unavailable: string | null = null;
  if (gw.count === 0 && direct.count === 0) {
    unavailable = "no residuals recorded in this window";
  } else if (direct.count === 0) {
    unavailable =
      "no direct reference traffic in this window — there is nothing to compare the gateway path against";
  } else if (gw.count === 0) {
    unavailable =
      "no request through the gateway carried backend timing (X-Server-Ms), so none of them has a residual; " +
      "a gateway that strips the header, or that answered everything itself, cannot be measured this way";
  } else if (thin.length > 0) {
    // One requirement per percentile. They differ by an order of magnitude —
    // p90 wants 100, p99 wants 1,000 — and collapsing them onto the largest
    // told a window 31 samples short of p90 that it was 931 short, which sends
    // anyone trying to fix it after the wrong number by a factor of ten.
    const needs = thin.map((p) => `p${p} needs ${minSamplesForPercentile(p).toLocaleString()}`).join(", ");
    unavailable =
      `${needs} residuals on each side; this window has ` +
      `${gw.count.toLocaleString()} through the gateway and ${direct.count.toLocaleString()} direct` +
      // naming the thinner arm matters: the reference stream is a fixed small
      // share of the load, so it is almost always the binding constraint, and
      // "run it longer or faster" is the only thing that moves it
      (direct.count <= gw.count ? " (the direct reference stream is the thinner arm)" : "");
  }

  return {
    p50, p90, p95, p99,
    // the mean is far more sample-efficient than a tail percentile, but one
    // observation still does not make a mean — hold it to the p50 bar
    avg: support >= minSamplesForPercentile(50) ? gw.sumMs / gw.count - direct.sumMs / direct.count : null,
    gwSamples: gw.count,
    directSamples: direct.count,
    unavailable
  };
}

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
    c.bytesReq += r.bytes_req;
    c.bytesResp += r.bytes_resp;
    c.connSetups += r.conn_setups ?? 0;
    c.connSetupSumMs += r.conn_setup_sum_ms ?? 0;
    c.connMeasured += r.conn_measured ?? 0;
    mergeHistograms(c.hist, parseHist(r.hist));
    mergeHistograms(c.statusHist, parseHist(r.status_hist));
    c.nbCount += r.nb_count ?? 0;
    c.nbSumMs += r.nb_sum_ms ?? 0;
    mergeHistograms(c.nbHist, parseResidualHist(r.nb_hist));
  }
  return map;
}

/** Residual histograms are a different width from latency ones; a row written
 *  before the column existed parses to an all-zero array of the right size. */
function parseResidualHist(s: string | null | undefined): ResidualHistogram {
  if (typeof s !== "string") return emptyResidualHistogram();
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!Array.isArray(parsed)) return emptyResidualHistogram();
    return parsed as ResidualHistogram;
  } catch {
    return emptyResidualHistogram();
  }
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

const RAW_COLS = `(ts, run_id, request_id, protocol, endpoint, class, method, status, latency_ms, ttfb_ms, server_ms, connect_ms, conn_reused, timing_reason, measurement_version, bytes_req, bytes_resp, reached_backend, error)`;
const RAW_NCOLS = 19;

/** build one multi-row INSERT for `rows` raw results */
function rawInsertSql(rows: number): string {
  const tuple = `(${Array(RAW_NCOLS).fill("?").join(", ")})`;
  return `INSERT INTO requests_raw ${RAW_COLS} VALUES ${Array(rows).fill(tuple).join(", ")}`;
}

function rawInsertParams(r: RequestResult): (string | number | null)[] {
  return [r.ts, r.runId, r.requestId ?? "", r.protocol, r.endpoint, r.class, r.method, r.status,
    r.latencyMs, r.ttfbMs ?? null, r.serverMs ?? null,
    r.connectMs ?? null, r.connectMs == null ? null : (r.connReused === true ? 1 : 0),
    r.timingReason ?? null, r.measurementVersion ?? 1, r.bytesReq, r.bytesResp,
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
    return `SELECT hist, status_hist, nb_hist FROM ${table}
     WHERE bucket_ts = ? AND protocol = ? AND endpoint = ? AND cls = ?`;
  }

  function layer(table: string): string {
    return `
     INSERT INTO ${table} (first_ts, last_ts, bucket_ts, protocol, endpoint, cls, count, errors, ok2xx, rejected4xx, rejected4xx_gw, reached_backend, latency_sum_ms, max_latency_ms, bytes_req, bytes_resp, conn_setups, conn_setup_sum_ms, conn_measured, hist, status_hist, nb_count, nb_sum_ms, nb_hist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_ts, protocol, endpoint, cls) DO UPDATE SET
       first_ts = MIN(COALESCE(first_ts, bucket_ts), excluded.first_ts),
       last_ts = MAX(COALESCE(last_ts, bucket_ts + ${table === "rollup_minute" ? MINUTE_BUCKETS : HOUR_BUCKETS} - 1000), excluded.last_ts),
       count = count + excluded.count,
       errors = errors + excluded.errors,
       ok2xx = ok2xx + excluded.ok2xx,
       rejected4xx = rejected4xx + excluded.rejected4xx,
       rejected4xx_gw = rejected4xx_gw + excluded.rejected4xx_gw,
       reached_backend = reached_backend + excluded.reached_backend,
       latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
       max_latency_ms = MAX(max_latency_ms, excluded.max_latency_ms),
       bytes_req = bytes_req + excluded.bytes_req,
       bytes_resp = bytes_resp + excluded.bytes_resp,
       conn_setups = conn_setups + excluded.conn_setups,
       conn_setup_sum_ms = conn_setup_sum_ms + excluded.conn_setup_sum_ms,
       conn_measured = conn_measured + excluded.conn_measured,
       hist = excluded.hist,
       status_hist = excluded.status_hist,
       nb_count = nb_count + excluded.nb_count,
       nb_sum_ms = nb_sum_ms + excluded.nb_sum_ms,
       nb_hist = excluded.nb_hist`;
  }
  const selectMinute = db.prepare(selectRow("rollup_minute"));
  const selectHour = db.prepare(selectRow("rollup_hour"));
  const upsertMinute = db.prepare(layer("rollup_minute"));
  const upsertHour = db.prepare(layer("rollup_hour"));

  // Residual layers. Far fewer rows than rollup_* — one per (bucket, class,
  // path), so at most 14 a minute — which is why these get a plain
  // select-merge-upsert with no cross-flush cache: the read they would save is
  // already cheap enough not to show up.
  const selectResidual = (table: string): string =>
    `SELECT count, sum_ms, hist FROM ${table} WHERE bucket_ts = ? AND cls = ? AND path = ?`;
  const upsertResidual = (table: string): string => `
     INSERT INTO ${table} (bucket_ts, cls, path, count, sum_ms, hist) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_ts, cls, path) DO UPDATE SET
       count = excluded.count,
       sum_ms = excluded.sum_ms,
       hist = excluded.hist`;
  const selectResidualMinute = db.prepare(selectResidual("residual_minute"));
  const selectResidualHour = db.prepare(selectResidual("residual_hour"));
  const upsertResidualMinute = db.prepare(upsertResidual("residual_minute"));
  const upsertResidualHour = db.prepare(upsertResidual("residual_hour"));
  const upsertRunMinute = db.prepare(
    `INSERT INTO run_minute (bucket_ts, run_id, count) VALUES (?, ?, ?)
     ON CONFLICT(bucket_ts, run_id) DO UPDATE SET count = count + excluded.count`
  );
  const upsertShed = db.prepare(
    `INSERT INTO load_shed (bucket_ts, dropped, results_lost, gen_faults, target_sum, ticks) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_ts) DO UPDATE SET
       dropped = dropped + excluded.dropped,
       results_lost = results_lost + excluded.results_lost,
       gen_faults = gen_faults + excluded.gen_faults,
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
      `SELECT first_ts, last_ts, bucket_ts, protocol, endpoint, cls, count, errors, ok2xx, rejected4xx, rejected4xx_gw,
              reached_backend, latency_sum_ms, max_latency_ms, bytes_req, bytes_resp,
              conn_setups, conn_setup_sum_ms, conn_measured, hist, status_hist,
              nb_count, nb_sum_ms, nb_hist
       FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).all(fromBucket, toBucket) as unknown as RollupRow[];

  interface ResidualRow { bucket_ts: number; cls: string; path: string; count: number; sum_ms: number; hist: string }

  const readResidualRows = (table: "residual_minute" | "residual_hour", fromBucket: number, toBucket: number): ResidualRow[] =>
    db.prepare(
      `SELECT bucket_ts, cls, path, count, sum_ms, hist FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).all(fromBucket, toBucket) as unknown as ResidualRow[];

  /** Fold residual rows into one pair of arms per class. */
  function armsByClass(rows: ResidualRow[]): Map<string, ResidualPair> {
    const out = new Map<string, ResidualPair>();
    for (const r of rows) {
      let pair = out.get(r.cls);
      if (!pair) out.set(r.cls, (pair = emptyPair()));
      const arm = r.path === "direct" ? pair.direct : pair.gw;
      arm.count += Number(r.count) || 0;
      arm.sumMs += Number(r.sum_ms) || 0;
      mergeHistograms(arm.hist, parseHist(r.hist));
    }
    return out;
  }

  const readRawRecent = (limit: number): RequestResult[] => {
    const n = Number(limit);
    // guard both NaN and negatives: SQLite reads LIMIT -1 as "no limit"
    const safe = Number.isFinite(n) ? Math.min(LIMITS.recentLimit, Math.max(1, Math.trunc(n))) : 100;
    const rows = db.prepare(
      `SELECT ts, run_id AS runId, request_id AS requestId, protocol, endpoint, class, method, status,
              latency_ms AS latencyMs, ttfb_ms AS ttfbMs, server_ms AS serverMs, timing_reason AS timingReason, measurement_version AS measurementVersion,
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
  // Persisted rollup state carried across flushes so the open minute/hour
  // rows are not re-SELECTed and re-parsed every 10s. Cleared by any write
  // path that can change rollup tables behind ingestBatch's back.
  const minuteRollupCache = new Map<string, { reasons: Record<string, number>; hist: Histogram; qualifiedHist: Histogram; statusHist: Histogram; nbHist: ResidualHistogram }>();
  const hourRollupCache = new Map<string, { reasons: Record<string, number>; hist: Histogram; qualifiedHist: Histogram; statusHist: Histogram; nbHist: ResidualHistogram }>();
  const clearRollupCaches = () => { minuteRollupCache.clear(); hourRollupCache.clear(); };

  function windowRows(from: number, to: number): RollupRow[] {
    const spanMs = to - from;
    if (spanMs <= MINUTE_LAYER_MAX_MS) {
      return readRows("rollup_minute", Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS, Math.floor(to / MINUTE_BUCKETS) * MINUTE_BUCKETS);
    }
    return readRows("rollup_hour", Math.floor(from / HOUR_BUCKETS) * HOUR_BUCKETS, Math.floor(to / HOUR_BUCKETS) * HOUR_BUCKETS);
  }

  /** Residual arms over the same span, from whichever layer windowRows used —
   *  so the Δ always covers exactly the buckets the rest of the summary does. */
  function windowResidualRows(from: number, to: number): ResidualRow[] {
    if (to - from <= MINUTE_LAYER_MAX_MS) {
      return readResidualRows("residual_minute", Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS, Math.floor(to / MINUTE_BUCKETS) * MINUTE_BUCKETS);
    }
    return readResidualRows("residual_hour", Math.floor(from / HOUR_BUCKETS) * HOUR_BUCKETS, Math.floor(to / HOUR_BUCKETS) * HOUR_BUCKETS);
  }

  /**
   * Whether this window's numbers can be believed.
   *
   * Both inputs are minute-granular regardless of which roll-up layer the
   * metrics came from — one row per minute is cheap even across a week, and a
   * validity signal averaged into hour buckets would hide exactly the short
   * saturation spikes it exists to catch.
   */
  /** Counts and coverage use the same complete rollup buckets. Raw retention
   * and sampling cannot change rates. Legacy rows use their whole bucket. */
  function coveredSec(from: number, to: number, rows: RollupRow[]): number {
    if (!rows.length) return Math.max(1, (to - from) / 1000);
    const width = to - from <= MINUTE_LAYER_MAX_MS ? MINUTE_BUCKETS : HOUR_BUCKETS;
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) {
      lo = Math.min(lo, r.first_ts ?? r.bucket_ts);
      hi = Math.max(hi, r.last_ts ?? r.bucket_ts + width - 1000);
    }
    return Math.max(1, (hi - lo) / 1000 + 1);
  }

  function validityFor(from: number, to: number, total: number, windowSec: number): WindowValidity {
    const fromB = Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    const toB = Math.floor(to / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    const shed = db.prepare(
      `SELECT COALESCE(SUM(dropped),0) AS dropped, COALESCE(SUM(results_lost),0) AS resultsLost,
              COALESCE(SUM(gen_faults),0) AS genFaults,
              COALESCE(SUM(target_sum),0) AS targetSum, COALESCE(SUM(ticks),0) AS ticks
       FROM load_shed WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).get(fromB, toB) as {
      dropped: number; resultsLost: number; genFaults: number; targetSum: number; ticks: number;
    };
    const health = db.prepare(
      `SELECT COALESCE(MAX(cpu_max),-1) AS cpuMax, COALESCE(MAX(loop_p99_max),-1) AS loopMax,
              COALESCE(SUM(samples),0) AS samples
       FROM host_health WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).get(fromB, toB) as { cpuMax: number; loopMax: number; samples: number };

    const dropped = Number(shed.dropped) || 0;
    const resultsLost = Number(shed.resultsLost) || 0;
    const genFaults = Number(shed.genFaults) || 0;
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
    if (resultsLost > 0) {
      // not a sampling knob: the raw tail is deliberately downsampled, but
      // these rows never reached any aggregate. The loss happens when results
      // arrive fastest, so what is missing is disproportionately the slow tail
      // — the surviving percentiles flatter the gateway.
      const lostPct = (100 * resultsLost) / Math.max(1, issued + resultsLost);
      reasons.push(
        `${resultsLost.toLocaleString()} measurements (${lostPct.toFixed(1)}%) were lost after the gateway served them — ` +
        `the percentiles below describe the requests that survived, and loss is biased toward the busiest moments`
      );
    }
    const genFaultPct = issued === 0 ? 0 : (100 * genFaults) / issued;
    if (genFaultPct > VALIDITY_LIMITS.genFaultPct) {
      // These never reached the gateway, so they are absent from its error rate
      // by design — which is exactly why the window has to say so out loud.
      // Silently excluding them would leave a run reporting a healthy gateway
      // over a fraction of the traffic it was supposed to be judged on.
      reasons.push(
        `${genFaults.toLocaleString()} requests (${genFaultPct.toFixed(1)}%) never reached the target — ` +
        "the connection was refused or timed out before the gateway saw them, so this is the generator " +
        "or the network between, not the gateway; the rates and percentiles below cover only the requests that got through"
      );
    }
    if (cpuMax !== null && cpuMax > VALIDITY_LIMITS.cpuProcessPct) {
      reasons.push(`generator CPU utilization or throttling indicator peaked at ${cpuMax.toFixed(0)}% (limit ${VALIDITY_LIMITS.cpuProcessPct}%) — measured latency includes our own queueing`);
    }
    if (loopMax !== null && loopMax > VALIDITY_LIMITS.eventLoopP99Ms) {
      reasons.push(`event-loop delay reached ${loopMax.toFixed(0)} ms (limit ${VALIDITY_LIMITS.eventLoopP99Ms} ms) — every latency in this window is inflated by that much`);
    }

    return {
      ok: reasons.length === 0,
      reasons,
      droppedRequests: dropped,
      shedPct,
      resultsLost,
      genFaults,
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
   * minutes this run touched". run_minute carries the id, and holds an exact
   * count per (minute, run) — it used to be counted off the raw table, which
   * stopped being sound once that table became a bounded tail rather than every
   * request. It is kept as long as the minute roll-ups are, so this stays
   * answerable for as long as there is a window to report on.
   */
  function windowScope(runId: string, from: number, to: number): WindowScope {
    const fromB = Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    const toB = Math.floor(to / MINUTE_BUCKETS) * MINUTE_BUCKETS + MINUTE_BUCKETS - 1;
    const row = db.prepare(
      `SELECT COALESCE(SUM(count), 0) AS total,
              COALESCE(SUM(CASE WHEN run_id <> ? THEN count ELSE 0 END), 0) AS foreign_rows
         FROM run_minute WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).get(runId, fromB, toB) as { total: number; foreign_rows: number };
    const total = Number(row.total) || 0;
    const foreignRequests = Number(row.foreign_rows) || 0;
    return {
      foreignRequests,
      totalRequests: total,
      foreignPct: total === 0 ? 0 : (100 * foreignRequests) / total
    };
  }

  /**
   * Accept the public raw shape by rolling it up first.
   *
   * There is one write path, and it takes cells. `/api/ingest` still posts
   * per-request rows because that is the documented contract for an external
   * poster, and a poster doing a few hundred requests a second pays nothing to
   * have them folded here.
   */
  function ingestBatch(batch: IngestBatch): { ingested: number; duplicate?: boolean } {
    return ingestAggregate(aggregateBatch(batch));
  }

  function ingestAggregate(agg: AggregateBatch): { ingested: number; duplicate?: boolean } {
    if (!agg || typeof agg.batchId !== "string" || agg.batchId === "" || !Array.isArray(agg.cells)) {
      throw new Error("batchId and cells[] required");
    }
    if (seenBatch.get(agg.batchId)) return { ingested: 0, duplicate: true };

    interface Bucket {
      first_ts: number; last_ts: number;
      bucket_ts: number; protocol: string; endpoint: string; cls: string;
      count: number; errors: number; ok2xx: number; rejected4xx: number;
      rejected4xx_gw: number; reached_backend: number;
      latency_sum_ms: number; max_latency_ms: number;
      bytes_req: number; bytes_resp: number;
      conn_setups: number; conn_setup_sum_ms: number; conn_measured: number;
      hist: Histogram; status_hist: StatusHistogram;
      nb_count: number; nb_sum_ms: number; nb_hist: ResidualHistogram;
    }
    const minute = new Map<string, Bucket>();
    const hour = new Map<string, Bucket>();

    /**
     * Fold one cell into one layer.
     *
     * Merging rather than assigning matters for the hour layer: a batch
     * spanning a minute boundary carries two cells for the same
     * (protocol, endpoint, class) that share an hour.
     */
    const foldCell = (table: Map<string, Bucket>, bucketTs: number, c: AggCell): void => {
      const key = `${bucketTs}|${c.protocol}|${c.endpoint}|${c.cls}`;
      let b = table.get(key);
      if (!b) {
        // Each batch MUST build fresh histogram objects here. The rollup caches
        // below keep references to these arrays between flushes as "what is in
        // the DB"; sharing a bucket object across batches would be silently
        // double-merged by the cache logic.
        b = {
          first_ts: c.firstTs, last_ts: c.lastTs,
          bucket_ts: bucketTs, protocol: c.protocol, endpoint: c.endpoint, cls: c.cls,
          count: 0, errors: 0, ok2xx: 0, rejected4xx: 0,
          rejected4xx_gw: 0, reached_backend: 0,
          latency_sum_ms: 0, max_latency_ms: 0,
          bytes_req: 0, bytes_resp: 0,
          conn_setups: 0, conn_setup_sum_ms: 0, conn_measured: 0,
          hist: emptyHistogram(), status_hist: emptyStatusHistogram(),
          nb_count: 0, nb_sum_ms: 0, nb_hist: emptyResidualHistogram()
        };
        table.set(key, b);
      }
      b.first_ts = Math.min(b.first_ts, c.firstTs);
      b.last_ts = Math.max(b.last_ts, c.lastTs);
      b.count += c.count;
      b.errors += c.errors;
      b.ok2xx += c.ok2xx;
      b.rejected4xx += c.rejected4xx;
      b.rejected4xx_gw += c.rejected4xxGw;
      b.reached_backend += c.reachedBackend;
      b.latency_sum_ms += c.latencySumMs;
      b.max_latency_ms = Math.max(b.max_latency_ms, c.maxLatencyMs);
      b.bytes_req += c.bytesReq;
      b.bytes_resp += c.bytesResp;
      b.conn_setups += c.connSetups ?? 0;
      b.conn_setup_sum_ms += c.connSetupSumMs ?? 0;
      b.conn_measured += c.connMeasured ?? 0;
      mergeHistograms(b.hist, c.hist);
      mergeHistograms(b.status_hist, c.statusHist);
      // absent on a producer that predates the metric; merge what is there
      b.nb_count += c.nonBackendCount ?? 0;
      b.nb_sum_ms += c.nonBackendSumMs ?? 0;
      if (Array.isArray(c.nonBackendHist)) mergeHistograms(b.nb_hist, c.nonBackendHist);
    };

    /** Residual arms this batch touches, keyed bucket|class|path per layer. */
    interface ResidualBucket {
      bucket_ts: number; cls: string; path: ResidualPath;
      count: number; sum_ms: number; hist: ResidualHistogram;
    }
    const residualMinute = new Map<string, ResidualBucket>();
    const residualHour = new Map<string, ResidualBucket>();

    let ingested = 0;
    for (const c of agg.cells) {
      if (!c || !Number.isFinite(c.bucketTs) || !Array.isArray(c.hist) || !Array.isArray(c.statusHist)) {
        throw new Error("each cell needs a numeric bucketTs and both histograms");
      }
      foldCell(minute, Math.floor(c.bucketTs / MINUTE_BUCKETS) * MINUTE_BUCKETS, c);
      foldCell(hour, Math.floor(c.bucketTs / HOUR_BUCKETS) * HOUR_BUCKETS, c);
      ingested += c.count;
    }
    // Residual cells arrive keyed by health window — finer than a minute, so the
    // control plane could drop only the contaminated ones — and are re-keyed to
    // the storage layers here, where that distinction has already been used up.
    for (const rc of agg.residuals ?? []) {
      if (!rc || !Number.isFinite(rc.windowTs) || !Array.isArray(rc.hist)) continue;
      if (rc.path !== "gw" && rc.path !== "direct") continue;
      for (const [width, table] of [[MINUTE_BUCKETS, residualMinute], [HOUR_BUCKETS, residualHour]] as const) {
        const bucketTs = Math.floor(rc.windowTs / width) * width;
        const key = `${bucketTs}|${rc.cls}|${rc.path}`;
        let b = table.get(key);
        if (!b) {
          b = { bucket_ts: bucketTs, cls: rc.cls, path: rc.path, count: 0, sum_ms: 0, hist: emptyResidualHistogram() };
          table.set(key, b);
        }
        b.count += rc.count;
        b.sum_ms += rc.sumMs;
        mergeHistograms(b.hist, rc.hist);
      }
    }

    // One transaction for the whole batch: raw rows, both roll-up layers and the
    // idempotency marker commit together or not at all. Marking the batch inside
    // the transaction means a rolled-back batch can be retried rather than being
    // silently swallowed as a duplicate.
    db.exec("BEGIN IMMEDIATE");
    try {
      // requests_raw is only ever read by the recent tail (GET /api/recent,
      // capped at LIMITS.recentLimit rows) — every aggregate chart comes from
      // the cells above, which stay exact. The producer already bounded this to
      // RAW_TAIL_PER_FLUSH; the cap is re-applied here because a compromised or
      // buggy producer must not be able to turn the raw table into the load.
      const tail = (agg.tail ?? []).slice(0, RAW_TAIL_PER_FLUSH);
      for (let off = 0; off < tail.length; off += RAW_CHUNK_ROWS) {
        const slice = tail.slice(off, off + RAW_CHUNK_ROWS);
        const params = slice.flatMap(rawInsertParams);
        db.prepare(rawInsertSql(slice.length)).run(...params);
      }
      // Exact per-run counts, so "how much of this window is somebody else's
      // traffic" stays answerable now that the raw table holds only a sample.
      for (const r of agg.runs ?? []) {
        if (!r || typeof r.runId !== "string" || r.runId === "" || !Number.isFinite(r.bucketTs)) continue;
        upsertRunMinute.run(
          Math.floor(r.bucketTs / MINUTE_BUCKETS) * MINUTE_BUCKETS,
          r.runId,
          Math.max(0, Math.round(r.count) || 0)
        );
      }
      type StoredHists = { hist: string; status_hist: string; nb_hist: string };
      type Bind = string | number | bigint | null | Uint8Array | boolean;
      // Merge the stored histograms into the in-memory buckets first, then
      // write the full merged arrays back; scalar columns stay SQL-side deltas.
      const upsertParams = (b: Bucket): Bind[] => [
        b.first_ts, b.last_ts, b.bucket_ts, b.protocol, b.endpoint, b.cls, b.count, b.errors, b.ok2xx, b.rejected4xx,
        b.rejected4xx_gw, b.reached_backend, b.latency_sum_ms, b.max_latency_ms, b.bytes_req, b.bytes_resp,
        b.conn_setups, b.conn_setup_sum_ms, b.conn_measured,
        JSON.stringify(b.hist), JSON.stringify(b.status_hist),
        b.nb_count, b.nb_sum_ms, JSON.stringify(b.nb_hist)
      ];
      // Every flush touches the same open minute/hour rows — previously a
      // SELECT + JSON.parse × 3 histograms + merge + JSON.stringify × 3, per
      // key, per flush. rollupCache holds the *stored* histogram state between
      // flushes: each key is SELECTed and parsed at most once (on first sight
      // or after the row was written by another process/reset), thereafter the
      // cache entry is simply the post-merge arrays from the previous flush
      // (kept by reference; the per-batch Bucket objects are discarded after
      // the upsert, so the reference stays valid and exact).
      const storeKey = (b: Bucket) => `${b.bucket_ts}|${b.protocol}|${b.endpoint}|${b.cls}`;
      interface StoredState { hist: Histogram; statusHist: Histogram; nbHist: ResidualHistogram }
      const mergeIntoAndUpsert = (
        buckets: Map<string, Bucket>,
        select: typeof selectMinute,
        upsert: typeof upsertMinute,
        cache: Map<string, StoredState>,
        bucketWidthMs: number
      ): void => {
        // prune only entries for buckets that closed before this batch started:
        // pruning by *batch membership* would evict a still-open key whenever
        // a batch happens to carry no results for it, forcing a pointless
        // re-read on the next flush
        const oldestOpen = Math.floor(Date.now() / bucketWidthMs) * bucketWidthMs;
        for (const [k] of cache) {
          const ts = Number(k.split("|", 1)[0]);
          if (Number.isFinite(ts) && ts < oldestOpen) cache.delete(k);
        }
        for (const b of buckets.values()) {
          const key = storeKey(b);
          const cached = cache.get(key);
          if (cached !== undefined) {
            mergeHistograms(b.hist, cached.hist);
            mergeHistograms(b.status_hist, cached.statusHist);
            mergeHistograms(b.nb_hist, cached.nbHist);
          } else {
            const row = select.get(b.bucket_ts, b.protocol, b.endpoint, b.cls) as StoredHists | undefined;
            if (row) {
              mergeHistograms(b.hist, parseHist(row.hist));
              mergeHistograms(b.status_hist, parseHist(row.status_hist));
              mergeHistograms(b.nb_hist, parseResidualHist(row.nb_hist));
            }
          }
          // the upsert writes exactly b's (merged) state, so b becomes the
          // cached stored state for the next flush — scalar columns are
          // SQL-side deltas and never need the cache
          cache.set(key, { hist: b.hist, statusHist: b.status_hist, nbHist: b.nb_hist });
          upsert.run(...upsertParams(b));
        }
      };
      mergeIntoAndUpsert(minute, selectMinute, upsertMinute, minuteRollupCache, MINUTE_BUCKETS);
      mergeIntoAndUpsert(hour, selectHour, upsertHour, hourRollupCache, HOUR_BUCKETS);

      // Residual rows carry no SQL-side deltas: count and sum travel with the
      // histogram so all three always describe the same set of observations,
      // which means each touched row is read, merged and written whole.
      const flushResiduals = (
        buckets: Map<string, ResidualBucket>,
        select: typeof selectResidualMinute,
        upsert: typeof upsertResidualMinute
      ): void => {
        for (const b of buckets.values()) {
          const row = select.get(b.bucket_ts, b.cls, b.path) as
            { count: number; sum_ms: number; hist: string } | undefined;
          if (row) {
            b.count += Number(row.count) || 0;
            b.sum_ms += Number(row.sum_ms) || 0;
            mergeHistograms(b.hist, parseHist(row.hist));
          }
          upsert.run(b.bucket_ts, b.cls, b.path, b.count, b.sum_ms, JSON.stringify(b.hist));
        }
      };
      flushResiduals(residualMinute, selectResidualMinute, upsertResidualMinute);
      flushResiduals(residualHour, selectResidualHour, upsertResidualHour);
      // shed rows ride the same transaction as the requests they explain, so a
      // window can never show the load we issued without the load we did not
      for (const s of agg.shed ?? []) {
        if (!Number.isFinite(s?.bucketTs)) continue;
        upsertShed.run(
          Math.floor(s.bucketTs / MINUTE_BUCKETS) * MINUTE_BUCKETS,
          Math.max(0, Math.round(s.dropped) || 0),
          Math.max(0, Math.round(s.resultsLost ?? 0) || 0),
          Math.max(0, Math.round(s.genFaults ?? 0) || 0),
          Number.isFinite(s.targetSum) ? s.targetSum : 0,
          Math.max(0, Math.round(s.ticks) || 0)
        );
      }
      markBatch.run(agg.batchId, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
      // the merged state the caches captured was never persisted
      clearRollupCaches();
      throw e;
    }
    lastIngestAt = Date.now();
    summaryCacheKey = "";
    summaryCacheVal = null;
    return { ingested };
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
    const byEndpointCls = rowsToCombined(rows, "endpoint");
    const byClass = rowsToCombined(rows, "class");
    const residualByClass = armsByClass(windowResidualRows(from, to));

    let total = 0;
    let errors = 0;
    let bytesReq = 0;
    let bytesResp = 0;
    let latencySum = 0;
    const totalHist = emptyHistogram();
    const totalStatusHist = emptyStatusHistogram();
    const perEndpoint: EndpointStat[] = [];
    const perClass: ClassStat[] = [];
    const protoAcc = new Map<string, { total: number; errors: number }>();
    // rps divides by the span the window actually carried traffic, not the
    // nominal window: a 90-second-old run on the 15m tab is not a 4-rps run.
    const windowSec = coveredSec(from, to, rows);
    const perSec = (n: number): number => (windowSec > 0 ? n / windowSec : 0);

    for (const c of byEndpointCls.values()) {
      total += c.count;
      errors += c.errors;
      bytesReq += c.bytesReq;
      bytesResp += c.bytesResp;
      latencySum += c.latencySumMs;
      mergeHistograms(totalHist, c.hist);
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
        avgRespBytes: c.count === 0 ? 0 : c.bytesResp / c.count,
        nonBackendMs: nonBackendStats([c])
      });
      const acc = protoAcc.get(c.protocol) ?? { total: 0, errors: 0 };
      acc.total += c.count;
      acc.errors += c.errors;
      protoAcc.set(c.protocol, acc);
    }

    // Every request that did not return 2xx/3xx, minus the invalid slice's
    // rejections — those are the point of that slice, not a failure.
    let unexpectedFailures = 0;
    // The headline Δ pools the latency-sensitive classes. Pooling percentiles
    // across classes is only legitimate because both arms are drawn from the
    // same scenario mix — the reference stream is built by the same spec
    // generator as the load — so the pooled distributions differ by the
    // gateway and not by what they are made of.
    const headline = emptyPair();
    for (const cls of OVERHEAD_CLASSES) {
      const pair = residualByClass.get(cls);
      if (pair) mergePair(headline, pair);
    }
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
        nonBackendMs: nonBackendStats([c]),
        overheadMs: overheadDelta(residualByClass.get(cls) ?? emptyPair()),
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
      nonBackendMs: nonBackendStats(byEndpointCls.values()),
      overheadMs: overheadDelta(headline),
      connSetup: connSetupStats(byEndpointCls.values()),
      bytes: { req: bytesReq, resp: bytesResp, respPerSec: perSec(bytesResp) },
      status,
      validity: validityFor(from, to, total, windowSec),
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

    // Per-bucket Δ arms, pooled over the same classes as the headline KPI so
    // the chart and the tile describe the same measurement.
    const residualByBucket = new Map<number, ResidualPair>();
    for (const r of readResidualRows(bucketSec === 60 ? "residual_minute" : "residual_hour", startB, toB)) {
      if (!OVERHEAD_CLASSES.has(r.cls)) continue;
      let pair = residualByBucket.get(r.bucket_ts);
      if (!pair) residualByBucket.set(r.bucket_ts, (pair = emptyPair()));
      const arm = r.path === "direct" ? pair.direct : pair.gw;
      arm.count += Number(r.count) || 0;
      arm.sumMs += Number(r.sum_ms) || 0;
      mergeHistograms(arm.hist, parseHist(r.hist));
    }

    interface Acc {
      ts: number; total: number; errors: number; clientErrors: number; gatewayErrors: number;
      bytesResp: number;
      restTotal: number; soapTotal: number; restErrors: number; soapErrors: number;
      hist: Histogram;
    }
    const points = new Map<number, Acc>();
    for (const r of rows) {
      let p = points.get(r.bucket_ts);
      if (!p) {
        p = {
          ts: r.bucket_ts, total: 0, errors: 0, clientErrors: 0, gatewayErrors: 0, bytesResp: 0,
          restTotal: 0, soapTotal: 0, restErrors: 0, soapErrors: 0,
          hist: emptyHistogram()
        };
        points.set(r.bucket_ts, p);
      }
      p.total += r.count;
      p.errors += r.errors;
      p.clientErrors += r.rejected4xx ?? 0;
      p.gatewayErrors += statusCount(parseHist(r.status_hist), GATEWAY_FAULT_BUCKETS);
      p.bytesResp += r.bytes_resp;
      mergeHistograms(p.hist, parseHist(r.hist));
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
        const zero: TimePoint = { ts: t, total: 0, errors: 0, clientErrors: 0, gatewayErrors: 0, rps: 0, p50: 0, p90: 0, p99: 0, overheadP50: null, overheadP95: null, overheadP99: null, bytesResp: 0, restTotal: 0, soapTotal: 0, restErrors: 0, soapErrors: 0 };
        if (windowIsCurrent && live && (t === toB || (lastDataTs !== null && t > lastDataTs))) {
          zero.partial = true;
        }
        out.push(zero);
        continue;
      }
      const delta = overheadDelta(residualByBucket.get(t) ?? emptyPair());
      const point: TimePoint = {
        ts: p.ts, total: p.total, errors: p.errors,
        clientErrors: p.clientErrors, gatewayErrors: p.gatewayErrors,
        rps: p.total / bucketSec,
        p50: percentile(p.hist, 50),
        p90: percentile(p.hist, 90),
        p99: percentile(p.hist, 99),
        overheadP50: delta.p50,
        overheadP95: delta.p95,
        overheadP99: delta.p99,
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
      let deleted = 0;
      deleted += Number(db.prepare(`DELETE FROM requests_raw WHERE ts < ?`).run(cutoff).changes) || 0;
      const minuteCutoff = Math.floor((Date.now() - MINUTE_RETENTION_MS) / MINUTE_BUCKETS) * MINUTE_BUCKETS;
      deleted += Number(db.prepare(`DELETE FROM rollup_minute WHERE bucket_ts < ?`).run(minuteCutoff).changes) || 0;
      const hourCutoff = Math.floor((Date.now() - HOUR_RETENTION_MS) / HOUR_BUCKETS) * HOUR_BUCKETS;
      deleted += Number(db.prepare(`DELETE FROM rollup_hour WHERE bucket_ts < ?`).run(hourCutoff).changes) || 0;
      // residual layers age out with the layer they are read alongside, so a
      // window can never keep its latency roll-up and lose its Δ
      deleted += Number(db.prepare(`DELETE FROM residual_minute WHERE bucket_ts < ?`).run(minuteCutoff).changes) || 0;
      deleted += Number(db.prepare(`DELETE FROM residual_hour WHERE bucket_ts < ?`).run(hourCutoff).changes) || 0;
      // validity inputs are minute-granular and only ever read alongside the
      // minute layer, so they age out on the same schedule as it
      deleted += Number(db.prepare(`DELETE FROM load_shed WHERE bucket_ts < ?`).run(minuteCutoff).changes) || 0;
      deleted += Number(db.prepare(`DELETE FROM host_health WHERE bucket_ts < ?`).run(minuteCutoff).changes) || 0;
      // run attribution ages out with the minute layer, not with the raw tail:
      // a report window that still has roll-ups must still be able to say how
      // much of them was its own run
      deleted += Number(db.prepare(`DELETE FROM run_minute WHERE bucket_ts < ?`).run(minuteCutoff).changes) || 0;
      cleanupSeen.run(Date.now() - 6 * HOUR_BUCKETS);
      // WAL would otherwise grow without bound across a multi-week run — but a
      // TRUNCATE checkpoint on an untouched retention window is pure blocking
      // I/O, so only pay it when this sweep actually removed rows
      if (deleted > 0) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
    ingestAggregate,
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
      const cpu = Math.max(s.cpuCorePct ?? s.cpuProcessPct ?? 0, s.cpuCapacityPct ?? 0, (s.cpuThrottledMs ?? 0) > 0 ? 100 : 0);
      const loop = s.eventLoopMaxMs ?? s.eventLoopP99ms ?? 0;
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
        db.exec("DELETE FROM residual_minute");
        db.exec("DELETE FROM residual_hour");
        db.exec("DELETE FROM run_minute");
        db.exec("DELETE FROM load_shed");
        db.exec("DELETE FROM host_health");
        db.exec("DELETE FROM policy_results");
        db.exec("DELETE FROM ingest_seen");
        db.exec("DELETE FROM runs");
        clearRollupCaches();
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
  // The measurement-2 overhead columns (overhead_sum_ms, overhead_max_ms,
  // overhead_hist, qualified_overhead_*, exclusion_reasons, requests_raw's
  // baseline_ms / overhead_ms / overhead_reason) are no longer written or read.
  // They are left in place rather than dropped: every one has a default, so
  // they cost nothing, and a rewrite of these tables to remove them would be a
  // long lock on a database whose only other option is to be deleted. Their
  // contents are a different metric and are deliberately not carried forward.
  for (const table of ["rollup_minute", "rollup_hour"]) {
    ensureColumn(db, table, "first_ts", "REAL");
    ensureColumn(db, table, "last_ts", "REAL");
    ensureColumn(db, table, "ok2xx", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "rejected4xx", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "rejected4xx_gw", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "reached_backend", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "status_hist", "TEXT NOT NULL DEFAULT '[]'");
    // 0 is the right default here, unlike server_ms below: these are counts,
    // and a window written before connection events were observed genuinely
    // measured none. conn_measured being 0 is what tells the two apart from
    // "measured, and every connection was reused".
    ensureColumn(db, table, "conn_setups", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "conn_setup_sum_ms", "REAL NOT NULL DEFAULT 0");
    ensureColumn(db, table, "conn_measured", "INTEGER NOT NULL DEFAULT 0");
    // Counts again, so 0 is honest: a window written before this metric
    // existed measured no non-backend time, and nb_count = 0 is exactly how
    // the reader is told there is nothing to draw a percentile from. The
    // empty histogram merges positionally as all-zero.
    ensureColumn(db, table, "nb_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, table, "nb_sum_ms", "REAL NOT NULL DEFAULT 0");
    ensureColumn(db, table, "nb_hist", "TEXT NOT NULL DEFAULT '[]'");
  }
  ensureColumn(db, "load_shed", "results_lost", "INTEGER NOT NULL DEFAULT 0");
  // 0 reads as "none recorded", which for a pre-migration bucket is the honest
  // answer: those windows counted their dial failures as gateway errors, and
  // nothing here can retroactively take that back — but they will not now be
  // invalidated for a fault count nobody ever wrote.
  ensureColumn(db, "load_shed", "gen_faults", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "requests_raw", "request_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "requests_raw", "reached_backend", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "requests_raw", "ttfb_ms", "REAL");
  ensureColumn(db, "requests_raw", "overhead_reason", "TEXT DEFAULT 'legacy measurement'");
  ensureColumn(db, "requests_raw", "measurement_version", "INTEGER NOT NULL DEFAULT 1");
  // Null, not 0: a row written before measurement 3 has no recorded backend
  // time, and reading "0 ms of backend" off it would hand every one of those
  // requests its whole TTFB as a residual.
  ensureColumn(db, "requests_raw", "server_ms", "REAL");
  ensureColumn(db, "requests_raw", "timing_reason", "TEXT");
  // Nullable for the same reason: null is "connection setup was not observable
  // on this row", which is not the same claim as "it cost nothing".
  ensureColumn(db, "requests_raw", "connect_ms", "REAL");
  ensureColumn(db, "requests_raw", "conn_reused", "INTEGER");
}

export const HISTOGRAM_EDGES = HISTOGRAM_EDGES_MS;
