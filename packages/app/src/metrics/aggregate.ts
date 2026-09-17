import {
  HEALTH_WINDOW_MS,
  MEASUREMENT_VERSION,
  RAW_TAIL_PER_FLUSH,
  type AggCell,
  type AggregateBatch,
  type BaselineSample,
  type IngestBatch,
  type LoadShedSample,
  type Protocol,
  type RequestResult,
  type ResidualArmPath,
  type ResidualCell,
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

/** Whether a row's residual is admissible into the gateway arm, and what it is.
 *
 * A row measured by an older build carries a different definition of the same
 * field and is not comparable; one stamped with a timing reason was taken while
 * this generator was unwell; and one missing either clock has no residual at
 * all. None of these are substituted for — they simply reduce the arm's sample
 * count, which the Δ reports.
 *
 * Connection acquisition comes off the residual. Unlike the calibration
 * constant the retired measurement subtracted, this is a value observed on this
 * very request, so no other distribution's variance enters the number — and
 * both arms subtract their own, which they must, since the reference stream
 * runs a near-idle pool and pays setup on a schedule of its own.
 */
export function residualOf(r: RequestResult): number | null {
  if (r.timingReason != null) return null;
  return nonBackendMsOf(r);
}

/**
 * Time a request spent outside the backend: `ttfb − serverMs − connectMs`.
 *
 * The same quantity {@link residualOf} feeds to the gateway arm, without the
 * health gate. That gate exists to protect a *difference* between two
 * distributions, where a generator stall lands entirely on one side; here every
 * request carries its own observation and a stall shows up as a fat tail in the
 * same histogram, which is a truer thing to look at than a withheld number.
 *
 * Still refused: a row from an older measurement version, because the field
 * meant something else then and mixing the two silently changes the metric.
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
  private readonly residuals = new Map<string, ResidualCell>();
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
    // percentile. A request the gateway answered itself carries no backend
    // clock and contributes nothing, which shows up as a smaller
    // nonBackendCount rather than as a substituted number.
    const nonBackend = nonBackendMsOf(r);
    if (nonBackend !== null) {
      c.nonBackendCount++;
      c.nonBackendSumMs += nonBackend;
      addToResidualHistogram(c.nonBackendHist, nonBackend);
    }

    // The gateway arm of the two-arm Δ.
    const residual = residualOf(r);
    if (residual !== null) this.addResidual(r.ts, r.class as ScenarioClass, "gw", residual);
  }

  /** The direct arm: reference traffic that bypassed the gateway. Deliberately
   *  outside the cells, and therefore outside every rate, status and contract
   *  number — it is the control, not the experiment. */
  addDirect(s: BaselineSample): void {
    if (!s || !Number.isFinite(s.ts) || !Number.isFinite(s.residualMs) || typeof s.class !== "string") return;
    this.addResidual(s.ts, s.class, "direct", s.residualMs);
  }

  private addResidual(ts: number, cls: ScenarioClass, path: ResidualArmPath, ms: number): void {
    const windowTs = Math.floor(ts / HEALTH_WINDOW_MS) * HEALTH_WINDOW_MS;
    const key = `${windowTs}|${cls}|${path}`;
    let b = this.residuals.get(key);
    if (!b) {
      b = { windowTs, cls, path, count: 0, sumMs: 0, hist: emptyResidualHistogram() };
      this.residuals.set(key, b);
    }
    b.count++;
    b.sumMs += ms;
    addToResidualHistogram(b.hist, ms);
  }

  drain(batchId: string, tail: RequestResult[], shed?: LoadShedSample[]): AggregateBatch {
    const cells = [...this.cells.values()].map(({ key: _key, ...cell }) => cell);
    this.cells.clear();
    const residuals = [...this.residuals.values()];
    this.residuals.clear();
    const runs = [...this.runs.values()];
    this.runs.clear();
    return { batchId, cells, residuals, runs, tail, ...(shed && shed.length > 0 ? { shed } : {}) };
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
  for (const s of batch.baseline ?? []) agg.addDirect(s);
  return agg.drain(batch.batchId, selectTail(batch.results), batch.shed);
}
