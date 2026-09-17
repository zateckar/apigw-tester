import {
  HEALTH_WINDOW_MS,
  VALIDITY_LIMITS,
  type RequestResult,
  type ResidualCell,
  type WorkerHealthCell
} from "@apigw/shared";

/** Verdict on one health window: null when the generator was well across it,
 *  otherwise why it was not. */
export type WindowVerdict = (ts: number) => string | null;

/**
 * Memoized local-health verdict per {@link HEALTH_WINDOW_MS} window.
 *
 * Checking per observation was an O(batch × history) scan on the event loop
 * (50k results × 600 samples) — a stall inflating the very latencies being
 * checked — and meaningless besides: two requests 100ms apart share one health
 * sample. One check per distinct window is O(windows).
 *
 * Build one per flush and pass it to everything that needs a verdict: two
 * separately-built closures capture different `now`s and can disagree about the
 * window at the right edge, which would mark a result and its own residual
 * inconsistently.
 *
 * The right edge is clamped to now because the window a batch ends in has not
 * closed yet: asking the sampler about an interval reaching into the future is
 * always answered "coverage unavailable", which would disqualify the tail of
 * every batch forever.
 */
export function windowHealth(healthCheck: (from: number, to: number) => string | null): WindowVerdict {
  const now = Date.now();
  const byWindow = new Map<number, string | null>();
  return (ts: number): string | null => {
    const w = Math.floor(ts / HEALTH_WINDOW_MS);
    let reason = byWindow.get(w);
    if (reason === undefined) {
      const from = w * HEALTH_WINDOW_MS;
      // an observation timestamped ahead of this clock leaves from > now: keep
      // the window non-empty and let the sampler report it as uncovered
      const to = Math.max(from + 1, Math.min(from + HEALTH_WINDOW_MS, now));
      reason = healthCheck(from, to);
      byWindow.set(w, reason);
    }
    return reason;
  };
}

/**
 * Verdict built from the generator's own report on itself.
 *
 * Used whenever the generator ships health cells — that is, whenever something
 * other than this event loop held the clock. The control plane's loop delay is
 * then simply not evidence: it receives pre-rolled batches once a second and
 * times nothing. Judging the worker's measurements by this process's scheduling
 * was how a rig with an idle control plane came to discard windows at a rate
 * that tracked the host's timer granularity rather than anything about the run.
 *
 * Coverage is checked the same way the control-plane sampler checks it, and for
 * the same reason: a window nobody observed must not read as a healthy one.
 * Windows are released by the worker only once closed, so a cell that arrives
 * at all describes a complete window.
 */
/**
 * Verdict for a window whose evidence has not arrived *yet*, as opposed to one
 * whose evidence is missing.
 *
 * The worker releases a window's health cell only once the window has closed,
 * but the raw tail ships on the next flush regardless — so the newest rows in
 * every batch belong to a window no cell can exist for yet. Treating that as
 * "unavailable" stamped roughly 60% of the visible request rows with a
 * generator fault that had not happened: on a batch flushed before any window
 * closed, 190 of 200 rows.
 *
 * Callers must decide what pending means for them. A residual is withheld —
 * an unqualified measurement is not usable and a later batch cannot rescue it.
 * A tail row is left unmarked, because "we have not heard yet" is not a defect
 * to report against a request the gateway really served.
 */
export const HEALTH_PENDING = "generator health pending";

export function workerWindowHealth(cells: Iterable<WorkerHealthCell>): WindowVerdict {
  const byWindow = new Map<number, WorkerHealthCell>();
  let newest = -Infinity;
  for (const c of cells) {
    if (typeof c?.windowTs !== "number") continue;
    const w = Math.floor(c.windowTs / HEALTH_WINDOW_MS);
    if (w > newest) newest = w;
    const prev = byWindow.get(w);
    // a window can be reported once; if it ever is not, keep the worse report
    if (prev === undefined || c.schedP99Ms > prev.schedP99Ms) byWindow.set(w, c);
  }
  return (ts: number): string | null => {
    const w = Math.floor(ts / HEALTH_WINDOW_MS);
    const cell = byWindow.get(w);
    // Past the newest window anyone has reported on, silence is the protocol
    // working: that window has not closed. Before it, silence means the
    // evidence is genuinely missing and whatever it would have qualified
    // cannot be trusted.
    if (cell === undefined) return w > newest ? HEALTH_PENDING : "generator health unavailable";
    if (cell.samples <= 0) return "generator health unavailable";
    if (cell.schedP99Ms > VALIDITY_LIMITS.workerSchedP99Ms) return "generator scheduling delay";
    if (cell.cpuPct > VALIDITY_LIMITS.workerCpuPct) return "generator CPU saturation";
    return null;
  };
}

/**
 * Mark results whose timing was taken while this generator was unwell.
 *
 * This matters far more to the residual than to latency. A stalled event loop
 * delays when we *observe* the response headers but not the SUT's own
 * `X-Server-Ms`, so the entire stall lands inside `ttfb − serverMs` and reads
 * as gateway overhead that never happened. The row still counts toward
 * throughput, status and latency — those are what the run delivered — but its
 * residual is withheld.
 *
 * A pending window is left unmarked: see {@link HEALTH_PENDING}. The row is
 * already on its way to the dashboard and no later batch can revise it, so the
 * choice is between an annotation that may be wrong and none at all — and
 * "the generator was unwell" is not a claim to make on a guess.
 */
export function stampHealthWindows(results: RequestResult[], health: WindowVerdict): void {
  for (const r of results) {
    if (r.timingReason !== null && r.timingReason !== undefined) continue;
    const reason = health(r.ts);
    if (reason !== null && reason !== HEALTH_PENDING) r.timingReason = reason;
  }
}

/**
 * Drop residual cells taken during an unhealthy window.
 *
 * Residual cells are keyed by health window precisely so this is possible:
 * dropping one here withholds exactly the observations a per-request check
 * would have, no more and no less.
 *
 * Both arms go through this one filter. Withholding contaminated residuals from
 * the gateway arm while keeping them in the direct arm would shift the reference
 * distribution up and understate the gateway by exactly the generator's own
 * stalls; that the two arms share a code path here is the guarantee they cannot
 * drift apart.
 */
export function filterHealthyResiduals(cells: ResidualCell[], health: WindowVerdict): ResidualCell[] {
  if (cells.length === 0) return cells;
  return cells.filter((c) => health(c.windowTs) === null);
}
