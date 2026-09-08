import { HISTOGRAM_EDGES_MS } from "@apigw/shared";
import type {
  ClassStat,
  EndpointStat,
  GwConfig,
  IngestBatch,
  LoadProfile,
  MetricSummary,
  RequestResult,
  RunEvent,
  ScenarioClass,
  TimePoint,
  TimeSeries
} from "@apigw/shared";
import { openDb } from "./db.js";
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

export interface MetricsStore {
  ingestBatch: (batch: IngestBatch) => { ingested: number; duplicate?: boolean };
  summary: (windowMs: number) => MetricSummary;
  timeseries: (bucketSec: 60 | 3600, from: number, to: number) => TimeSeries;
  recent: (limit: number) => RequestResult[];
  readGateway: () => GwConfig | null;
  writeGateway: (cfg: GwConfig) => void;
  readProfile: () => LoadProfile | null;
  writeProfile: (p: LoadProfile) => void;
  recordRunStart: (runId: string, profile: unknown) => void;
  recordRunStop: (runId: string) => void;
  listRuns: () => RunEvent[];
  close: () => void;
}

interface RollupRow {
  bucket_ts: number;
  protocol: string;
  endpoint: string;
  cls: string;
  count: number;
  errors: number;
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
  latencySumMs: number;
  maxLatencyMs: number;
  overheadSumMs: number;
  overheadMaxMs: number;
  bytesReq: number;
  bytesResp: number;
  hist: Histogram;
  overheadHist: Histogram;
}

function rowsToCombined(rows: RollupRow[], scope: "endpoint" | "class" | "all"): Map<string, Combined> {
  const keyOf = (r: RollupRow) =>
    scope === "endpoint" ? `${r.protocol}|${r.endpoint}|${r.cls}` :
    scope === "class" ? `|${r.cls}` :
    "all";
  const map = new Map<string, Combined>();
  for (const r of rows) {
    const key = keyOf(r);
    let c = map.get(key);
    if (!c) {
      c = {
        protocol: r.protocol, endpoint: r.endpoint, cls: r.cls,
        count: 0, errors: 0, latencySumMs: 0, maxLatencyMs: 0,
        overheadSumMs: 0, overheadMaxMs: 0, bytesReq: 0, bytesResp: 0,
        hist: emptyHistogram(), overheadHist: emptyHistogram()
      };
      map.set(key, c);
    }
    c.count += r.count;
    c.errors += r.errors;
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
  try { return JSON.parse(s) as Histogram; } catch { return emptyHistogram(); }
}

export function createMetricsStore(dbPath: string): MetricsStore {
  const db = openDb(dbPath);

  const insertRaw = db.prepare(
    `INSERT INTO requests_raw (ts, run_id, protocol, endpoint, class, method, status, latency_ms, baseline_ms, overhead_ms, bytes_req, bytes_resp, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertMinute = db.prepare(layer("rollup_minute"));
  const upsertHour = db.prepare(layer("rollup_hour"));
  function layer(table: string): string {
    return `
     INSERT INTO ${table} (bucket_ts, protocol, endpoint, cls, count, errors, latency_sum_ms, max_latency_ms, overhead_sum_ms, overhead_max_ms, bytes_req, bytes_resp, hist, overhead_hist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bucket_ts, protocol, endpoint, cls) DO UPDATE SET
       count = count + excluded.count,
       errors = errors + excluded.errors,
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
      `SELECT bucket_ts, protocol, endpoint, cls, count, errors, latency_sum_ms, max_latency_ms,
              overhead_sum_ms, overhead_max_ms, bytes_req, bytes_resp, hist, overhead_hist
       FROM ${table} WHERE bucket_ts >= ? AND bucket_ts <= ?`
    ).all(fromBucket, toBucket) as unknown as RollupRow[];

  const readRawRecent = (limit: number): RequestResult[] =>
    db.prepare(
      `SELECT ts, run_id AS runId, protocol, endpoint, class, method, status,
              latency_ms AS latencyMs, baseline_ms AS baselineMs, overhead_ms AS overheadMs,
              bytes_req AS bytesReq, bytes_resp AS bytesResp, error
       FROM requests_raw ORDER BY ts DESC LIMIT ?`
    ).all(limit) as unknown as RequestResult[];

  function windowRows(windowMs: number): RollupRow[] {
    const now = Date.now();
    const from = now - windowMs;
    if (windowMs <= MINUTE_RETENTION_MS) {
      return readRows("rollup_minute", Math.floor(from / MINUTE_BUCKETS) * MINUTE_BUCKETS, Math.floor(now / MINUTE_BUCKETS) * MINUTE_BUCKETS);
    }
    return readRows("rollup_hour", Math.floor(from / HOUR_BUCKETS) * HOUR_BUCKETS, Math.floor(now / HOUR_BUCKETS) * HOUR_BUCKETS);
  }

  function ingestBatch(batch: IngestBatch): { ingested: number; duplicate?: boolean } {
    if (!Array.isArray(batch.results) || typeof batch.batchId !== "string") {
      throw new Error("batchId and results[] required");
    }
    if (seenBatch.get(batch.batchId)) return { ingested: 0, duplicate: true };
    markBatch.run(batch.batchId, Date.now());

    interface Bucket {
      bucket_ts: number; protocol: string; endpoint: string; cls: string;
      count: number; errors: number; latency_sum_ms: number; max_latency_ms: number;
      overhead_sum_ms: number; overhead_max_ms: number;
      bytes_req: number; bytes_resp: number;
      hist: Histogram; overhead_hist: Histogram;
    }
    const minute = new Map<string, Bucket>();
    const hour = new Map<string, Bucket>();

    for (const r of batch.results) {
      const mB = Math.floor(r.ts / MINUTE_BUCKETS) * MINUTE_BUCKETS;
      const hB = Math.floor(r.ts / HOUR_BUCKETS) * HOUR_BUCKETS;
      const isErr = r.status === 0 || r.status >= 500;
      insertRaw.run(r.ts, r.runId, r.protocol, r.endpoint, r.class, r.method, r.status, r.latencyMs, r.baselineMs, r.overheadMs, r.bytesReq, r.bytesResp, r.error ?? null);

      for (const [bucketTs, table] of [[mB, minute], [hB, hour]] as const) {
        const key = `${bucketTs}|${r.protocol}|${r.endpoint}|${r.class}`;
        let b = table.get(key);
        if (!b) {
          b = {
            bucket_ts: bucketTs, protocol: r.protocol, endpoint: r.endpoint, cls: r.class,
            count: 0, errors: 0, latency_sum_ms: 0, max_latency_ms: 0,
            overhead_sum_ms: 0, overhead_max_ms: 0,
            bytes_req: 0, bytes_resp: 0,
            hist: emptyHistogram(), overhead_hist: emptyHistogram()
          };
          table.set(key, b);
        }
        b.count++;
        b.errors += isErr ? 1 : 0;
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
    for (const b of minute.values()) {
      upsertMinute.run(b.bucket_ts, b.protocol, b.endpoint, b.cls, b.count, b.errors, b.latency_sum_ms, b.max_latency_ms, b.overhead_sum_ms, b.overhead_max_ms, b.bytes_req, b.bytes_resp, JSON.stringify(b.hist), JSON.stringify(b.overhead_hist));
    }
    for (const b of hour.values()) {
      upsertHour.run(b.bucket_ts, b.protocol, b.endpoint, b.cls, b.count, b.errors, b.latency_sum_ms, b.max_latency_ms, b.overhead_sum_ms, b.overhead_max_ms, b.bytes_req, b.bytes_resp, JSON.stringify(b.hist), JSON.stringify(b.overhead_hist));
    }
    return { ingested: batch.results.length };
  }

  function summary(windowMs: number): MetricSummary {
    const rows = windowRows(windowMs);
    const byEndpointCls = rowsToCombined(rows, "endpoint");
    const byClass = rowsToCombined(rows, "class");

    const rollEdge = Math.floor(Date.now() / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    const tailRows = db.prepare(
      `SELECT ts, protocol, endpoint, class, latency_ms, overhead_ms, bytes_req, bytes_resp, status
       FROM requests_raw WHERE ts >= ?`
    ).all(rollEdge) as unknown as {
      ts: number; protocol: string; endpoint: string; class: ScenarioClass;
      latency_ms: number; overhead_ms: number; bytes_req: number; bytes_resp: number; status: number;
    }[];

    const isErrStatus = (s: number) => s === 0 || s >= 500;
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
        protocol: c.protocol as "rest" | "soap",
        endpoint: c.endpoint,
        total: c.count,
        errors: c.errors,
        errorPct: c.count === 0 ? 0 : (100 * c.errors) / c.count,
        rps: windowMs === 0 ? 0 : c.count / (windowMs / 1000),
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
        errorPct: c.count === 0 ? 0 : (100 * c.errors) / c.count,
        rps: windowMs === 0 ? 0 : c.count / (windowMs / 1000),
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
        avgBytesReq: c.count === 0 ? 0 : c.bytesReq / c.count,
        avgBytesResp: c.count === 0 ? 0 : c.bytesResp / c.count
      });
    }

    // live tail (last minute, not yet rolled up)
    for (const t of tailRows) {
      if (t.ts < rollEdge) continue;
      total++;
      bytesReq += t.bytes_req;
      bytesResp += t.bytes_resp;
      latencySum += t.latency_ms;
      overheadSum += t.overhead_ms;
      const err = isErrStatus(t.status);
      if (err) errors++;
      addToHistogram(totalHist, t.latency_ms);
      addToHistogram(totalOverheadHist, t.overhead_ms);
      const proto = t.protocol === "soap" ? "soap" : "rest";
      const acc = protoAcc.get(proto) ?? { total: 0, errors: 0 };
      acc.total++;
      if (err) acc.errors++;
      protoAcc.set(proto, acc);
      // merge into the per-class rollup for the most recent row
      const existing = byClass.get(`|${t.class}`);
      if (existing) {
        existing.count++;
        existing.errors += err ? 1 : 0;
        existing.latencySumMs += t.latency_ms;
        existing.overheadSumMs += t.overhead_ms;
        existing.bytesReq += t.bytes_req;
        existing.bytesResp += t.bytes_resp;
        addToHistogram(existing.hist, t.latency_ms);
        addToHistogram(existing.overheadHist, t.overhead_ms);
      }
    }
    // rebuild per-class from refolded map
    perClass.length = 0;
    for (const [cls, c] of byClass.entries()) {
      if (c.count === 0) continue;
      perClass.push({
        cls: cls.replace(/^\|/, "") as ScenarioClass,
        total: c.count,
        errors: c.errors,
        errorPct: (100 * c.errors) / c.count,
        rps: c.count / (windowMs / 1000),
        latencyMs: {
          p50: percentile(c.hist, 50),
          p95: percentile(c.hist, 95),
          p99: percentile(c.hist, 99),
          avg: c.latencySumMs / c.count
        },
        overheadMs: {
          p50: percentile(c.overheadHist, 50),
          p95: percentile(c.overheadHist, 95),
          p99: percentile(c.overheadHist, 99),
          avg: c.overheadSumMs / c.count
        },
        avgBytesReq: c.bytesReq / c.count,
        avgBytesResp: c.bytesResp / c.count
      });
    }

    const windowSec = windowMs / 1000;
    return {
      windowSec,
      total,
      errors,
      errorPct: total === 0 ? 0 : (100 * errors) / total,
      rps: total / windowSec,
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
      bytes: { req: bytesReq, resp: bytesResp, respPerSec: bytesResp / windowSec },
      perProtocol: [...protoAcc.entries()].map(([protocol, a]) => ({
        protocol: protocol as "rest" | "soap",
        total: a.total,
        errors: a.errors
      })),
      perEndpoint: perEndpoint.sort((a, b) => b.total - a.total),
      perClass: perClass.sort((a, b) => b.total - a.total)
    };
  }

  function timeseries(bucketSec: 60 | 3600, from: number, to: number): TimeSeries {
    const table = bucketSec === 60 ? "rollup_minute" : "rollup_hour";
    const sizeMs = bucketSec * 1000;
    const fromB = Math.floor(from / sizeMs) * sizeMs;
    const toB = Math.floor(to / sizeMs) * sizeMs;
    const rows = readRows(table, fromB, toB);

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
    const out: TimePoint[] = [];
    for (let t = fromB; t <= toB; t += sizeMs) {
      const p = points.get(t);
      if (!p) {
        out.push({ ts: t, total: 0, errors: 0, rps: 0, p50: 0, p90: 0, p99: 0, overheadP50: 0, overheadP95: 0, overheadP99: 0, bytesResp: 0, restTotal: 0, soapTotal: 0, restErrors: 0, soapErrors: 0 });
        continue;
      }
      out.push({
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
      });
    }
    return { bucketSec, points: out };
  }

  const rawCleaner = setInterval(() => {
    const cutoff = Date.now() - RAW_RETENTION_MS;
    db.prepare(`DELETE FROM requests_raw WHERE ts < ?`).run(cutoff);
    const minuteCutoff = Math.floor((Date.now() - MINUTE_RETENTION_MS) / MINUTE_BUCKETS) * MINUTE_BUCKETS;
    db.prepare(`DELETE FROM rollup_minute WHERE bucket_ts < ?`).run(minuteCutoff);
    const hourCutoff = Math.floor((Date.now() - HOUR_RETENTION_MS) / HOUR_BUCKETS) * HOUR_BUCKETS;
    db.prepare(`DELETE FROM rollup_hour WHERE bucket_ts < ?`).run(hourCutoff);
    cleanupSeen.run(Date.now() - 6 * HOUR_BUCKETS);
  }, 10 * 60_000);
  rawCleaner.unref();

  return {
    ingestBatch,
    summary,
    timeseries,
    recent: readRawRecent,
    readGateway: () => {
      const row = getConfig.get("gateway") as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as GwConfig) : null;
    },
    writeGateway: (cfg) => setConfig.run("gateway", JSON.stringify(cfg)),
    readProfile: () => {
      const row = getConfig.get("profile") as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as LoadProfile) : null;
    },
    writeProfile: (p) => setConfig.run("profile", JSON.stringify(p)),
    recordRunStart: (runId, profile) => insertRun.run(runId, Date.now(), JSON.stringify(profile)),
    recordRunStop: (runId) => stopRun.run(Date.now(), runId),
    listRuns: () => {
      const rows = db.prepare(
        `SELECT id, run_id AS runId, started_at AS startedAt, stopped_at AS stoppedAt, profile
         FROM runs ORDER BY started_at DESC LIMIT 50`
      ).all() as unknown as (Omit<RunEvent, "profile"> & { profile: string })[];
      return rows.map((r) => ({ ...r, profile: JSON.parse(r.profile) as LoadProfile }));
    },
    close: () => db.close()
  };
}

export const HISTOGRAM_EDGES = HISTOGRAM_EDGES_MS;
