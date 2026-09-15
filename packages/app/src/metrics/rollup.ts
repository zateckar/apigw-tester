import { HISTOGRAM_EDGES_MS, STATUS_BUCKETS, statusBucketIndex } from "@apigw/shared";

/** Fixed log-scale histogram over latency in milliseconds. */

export type Histogram = number[];

export function emptyHistogram(): Histogram {
  return new Array(HISTOGRAM_EDGES_MS.length + 1).fill(0);
}

/**
 * Counts per STATUS_BUCKETS slot. Same fixed-length-array shape as the latency
 * histogram on purpose: the merge helpers and the SQL upsert both work
 * positionally, so this needs no machinery of its own.
 */
export type StatusHistogram = number[];

export function emptyStatusHistogram(): StatusHistogram {
  return new Array(STATUS_BUCKETS.length).fill(0);
}

export function addToStatusHistogram(h: StatusHistogram, status: number, count = 1): void {
  const i = statusBucketIndex(status);
  if (i < 0) return;
  h[i] = ((h[i] as number) ?? 0) + count;
}

export function bucketIndex(latencyMs: number): number {
  const edges = HISTOGRAM_EDGES_MS;
  // binary search: ~35 edges × 2 calls/request made the linear scan show up
  let lo = 0;
  let hi = edges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (latencyMs <= (edges[mid] as number)) hi = mid - 1;
    else lo = mid + 1;
  }
  return lo; // first edge >= latencyMs, or edges.length (overflow bucket)
}

export function addToHistogram(h: Histogram, latencyMs: number, count = 1): void {
  const i = bucketIndex(latencyMs);
  h[i] = ((h[i] as number) ?? 0) + count;
}

export function mergeHistograms(target: Histogram, source: Histogram): void {
  for (let i = 0; i < target.length; i++) {
    target[i] = ((target[i] as number) ?? 0) + ((source[i] as number) ?? 0);
  }
}

export function totalInHistogram(h: Histogram): number {
  return h.reduce((a, b) => a + (b ?? 0), 0);
}

/** Notional upper edge of the overflow bucket. Anything slower than the top
 *  edge is reported as roughly this, rather than interpolating out to
 *  Number.MAX_SAFE_INTEGER and rendering an absurd p99. */
const OVERFLOW_EDGE_MS = (HISTOGRAM_EDGES_MS[HISTOGRAM_EDGES_MS.length - 1] as number) * 2;

/** Percentile estimate from bucket counts. Interpolates linearly inside the bucket. */
export function percentile(h: Histogram, p: number): number {
  const total = totalInHistogram(h);
  if (total === 0) return 0;
  const edges = HISTOGRAM_EDGES_MS;
  const targetRank = (p / 100) * total;
  let cumulative = 0;
  let lower = 0;
  for (let i = 0; i < h.length; i++) {
    const count = h[i] ?? 0;
    const upper = edges[i] ?? OVERFLOW_EDGE_MS;
    if (count === 0) {
      lower = upper;
      continue;
    }
    cumulative += count;
    if (cumulative >= targetRank) {
      const rankInBucket = count === 1 ? 1 : (targetRank - (cumulative - count)) / count;
      return lower + rankInBucket * (upper - lower);
    }
    lower = upper;
  }
  return edges[edges.length - 1] ?? OVERFLOW_EDGE_MS;
}

export function meanFromRollup(latencySumMs: number, count: number): number {
  return count === 0 ? 0 : latencySumMs / count;
}

export interface AggBucket {
  key: string;
  protocol: string;
  endpoint: string;
  count: number;
  errors: number;
  latencySumMs: number;
  maxLatencyMs: number;
  bytesReq: number;
  bytesResp: number;
  hist: Histogram;
  lastTs: number;
}

export function newBucket(protocol: string, endpoint: string): AggBucket {
  return {
    key: `${protocol}|${endpoint}`,
    protocol,
    endpoint,
    count: 0,
    errors: 0,
    latencySumMs: 0,
    maxLatencyMs: 0,
    bytesReq: 0,
    bytesResp: 0,
    hist: emptyHistogram(),
    lastTs: 0
  };
}
