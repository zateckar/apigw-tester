import {
  MEASUREMENT_VERSION,
  RAW_TAIL_PER_FLUSH,
  type AggCell,
  type AggregateBatch,
  type IngestBatch,
  type LoadShedSample,
  type Protocol,
  type RequestResult,
  type RunCell,
  type ScenarioClass
} from "@apigw/shared";
import {
  addToHistogram,
  addToResidualHistogram,
  addToStatusHistogram,
  emptyHistogram,
  emptyResidualHistogram,
  emptyStatusHistogram
} from "./rollup.js";

/**
 * Roll a batch of raw results up into the shape the store writes.
 *
 * This is the reference implementation of the aggregation the Go worker does
 * for itself. It exists in two places because the worker cannot import it, and
 * both are exercised against the same store by the two-backend integration
 * test — if they ever disagree about a bucket edge or a counter, that test
 * reads two different answers for the same traffic.
 */

const MINUTE_MS = 60_000;

/**
 * Time a request spent outside the backend: `ttfb − serverMs − connectMs`.
 *
 * Every request that carried both clocks contributes one observation. There is
 * no health gate on it: a gate was needed when this fed a *difference* between
 * two distributions, where a generator stall landed entirely on one side and
 * moved the answer. Here a stall shows up as a fat tail in the same histogram —
 * which is a truer thing to put in front of an operator than a withheld number,
 * and the run's validity verdict says whether the generator was well.
 *
 * Refused: a row from an older measurement version, because the field meant
 * something else then and mixing the two silently changes the metric. A request
 * with no backend clock contributes nothing rather than a substituted value,
 * which shows up as a smaller count.
 */
export function nonBackendMsOf(r: RequestResult): number | null {
  if ((r.measurementVersion ?? 1) < MEASUREMENT_VERSION) return null;
  if (r.ttfbMs == null || r.serverMs == null) return null;
  const v = r.ttfbMs - r.serverMs - (r.connectMs ?? 0);
  return Number.isFinite(v) ? v : null;
}

/** Rows worth keeping in the tail whatever the rate: anything that failed, and
 *  the classes rare enough that uniform sampling would erase them. */
function isNotable(r: RequestResult): boolean {
  if (r.error !== null || r.status === 0 || r.status >= 400) return true;
  return r.class !== "small-rest" && r.class !== "concurrency";
}

/** `take` items spread evenly across `items`, in order. Index-based rather than
 *  random so the same batch always yields the same tail. */
function spread<T>(items: T[], take: number): T[] {
  if (take <= 0) return [];
  if (take >= items.length) return items.slice();
  const out: T[] = [];
  for (let i = 0; i < take; i++) out.push(items[Math.floor((i * items.length) / take)] as T);
  return out;
}

/**
 * Pick the raw rows that survive into requests_raw.
 *
 * Bounded per flush rather than sampled 1-in-k: the tail feeds one capped table
 * in the UI, so the number of rows worth writing is a property of that table,
 * not of the request rate. Failures and the rarer classes are taken first —
 * they are what anyone opens the table to look at — and ordinary traffic fills
 * whatever is left, so a healthy run still shows a timeline.
 */
export function selectTail(results: RequestResult[], limit = RAW_TAIL_PER_FLUSH): RequestResult[] {
  if (results.length <= limit) return results.slice();
  const notable: RequestResult[] = [];
  const plain: RequestResult[] = [];
  for (const r of results) (isNotable(r) ? notable : plain).push(r);
  const kept = spread(notable, limit);
  return kept.concat(spread(plain, limit - kept.length)).sort((a, b) => a.ts - b.ts);
}

interface CellKeyed extends AggCell {
  key: string;
}

/** Accumulates results into cells. Reusable across flushes is deliberately not
 *  supported: a drained aggregator is empty, so nothing can be shipped twice. */
class Aggregator {
  private readonly cells = new Map<string, CellKeyed>();
  private readonly runs = new Map<string, RunCell>();

  add(r: RequestResult): void {
    if (!r || typeof r.runId !== "string" || r.runId === "" || !Number.isFinite(r.ts)) {
      throw new Error("each result needs a runId and a numeric ts");
    }
    const bucketTs = Math.floor(r.ts / MINUTE_MS) * MINUTE_MS;
    const key = `${bucketTs}|${r.protocol}|${r.endpoint}|${r.class}`;
    let c = this.cells.get(key);
    if (!c) {
      c = {
        key,
        bucketTs,
        firstTs: r.ts,
        lastTs: r.ts,
        protocol: r.protocol as Protocol,
        endpoint: r.endpoint,
        cls: r.class as ScenarioClass,
        count: 0, errors: 0, ok2xx: 0, rejected4xx: 0, rejected4xxGw: 0, reachedBackend: 0,
        latencySumMs: 0, maxLatencyMs: 0, bytesReq: 0, bytesResp: 0,
        connSetups: 0, connSetupSumMs: 0, connMeasured: 0,
        hist: emptyHistogram(), statusHist: emptyStatusHistogram(),
        nonBackendCount: 0, nonBackendSumMs: 0, nonBackendHist: emptyResidualHistogram()
      };
      this.cells.set(key, c);
    }

    const isErr = r.status === 0 || r.status >= 500;
    const is2xx = r.status >= 200 && r.status < 300;
    const is4xx = r.status >= 400 && r.status < 500;
    // `X-Server-Ms` on the response is the backend's fingerprint. Without it the
    // response was manufactured before the backend was reached — which is how
    // "the gateway rejected it" is told apart from "the backend rejected it"
    // for the deliberately-invalid slice.
    const reached = r.reachedBackend === true;

    c.firstTs = Math.min(c.firstTs, r.ts);
    c.lastTs = Math.max(c.lastTs, r.ts);
    c.count++;
    c.errors += isErr ? 1 : 0;
    c.ok2xx += is2xx ? 1 : 0;
    c.rejected4xx += is4xx ? 1 : 0;
    c.rejected4xxGw += is4xx && !reached ? 1 : 0;
    c.reachedBackend += reached ? 1 : 0;
    c.latencySumMs += r.latencyMs;
    c.maxLatencyMs = Math.max(c.maxLatencyMs, r.latencyMs);
    c.bytesReq += r.bytesReq;
    c.bytesResp += r.bytesResp;
    if (r.connectMs != null) {
      c.connMeasured++;
      if (r.connReused !== true) {
        c.connSetups++;
        c.connSetupSumMs += r.connectMs;
      }
    }
    addToHistogram(c.hist, r.latencyMs);
    addToStatusHistogram(c.statusHist, r.status);

    const runKey = `${bucketTs}|${r.runId}`;
    const run = this.runs.get(runKey);
    if (run) run.count++;
    else this.runs.set(runKey, { bucketTs, runId: r.runId, count: 1 });

    // Time spent outside the backend, per request, in the same cell as
    // everything else — so it is readable per endpoint and per class at any
    // percentile.
    const nonBackend = nonBackendMsOf(r);
    if (nonBackend !== null) {
      c.nonBackendCount++;
      c.nonBackendSumMs += nonBackend;
      addToResidualHistogram(c.nonBackendHist, nonBackend);
    }
  }

  drain(batchId: string, tail: RequestResult[], shed?: LoadShedSample[]): AggregateBatch {
    const cells = [...this.cells.values()].map(({ key: _key, ...cell }) => cell);
    this.cells.clear();
    const runs = [...this.runs.values()];
    this.runs.clear();
    return { batchId, cells, runs, tail, ...(shed && shed.length > 0 ? { shed } : {}) };
  }
}

/**
 * Roll a raw batch up in one pass.
 *
 * Used by the in-process driver at flush time and by the store to accept the
 * public `/api/ingest` shape, so there is exactly one code path that turns
 * requests into rows however they arrived.
 */
export function aggregateBatch(batch: IngestBatch): AggregateBatch {
  if (!batch || !Array.isArray(batch.results) || typeof batch.batchId !== "string" || batch.batchId === "") {
    throw new Error("batchId and results[] required");
  }
  const agg = new Aggregator();
  for (const r of batch.results) agg.add(r);
  return agg.drain(batch.batchId, selectTail(batch.results), batch.shed);
}
