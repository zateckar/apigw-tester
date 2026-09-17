import { randomBytes, randomUUID } from "node:crypto";
import type {
  AggregateBatch,
  BaselineSample,
  GwConfig,
  GwTargets,
  LoadProfile,
  LoadShedSample,
  RequestResult,
  RunCounters,
  RunState,
  RunStatus
} from "@apigw/shared";
import {
  DEFAULT_GW_TARGETS as defaultGwTargets,
  DEFAULT_LOAD_PROFILE as defaultProfile,
  EMPTY_RUN_COUNTERS,
  LIMITS,
  MEASUREMENT_VERSION,
  isGatewayFault,
  isSuccess,
  referenceRps,
  sanitizeGwTargets,
  sanitizeLoadProfile
} from "@apigw/shared";
import { TokenBucket, peakTargetRps } from "./scheduler.js";
import {
  buildSpec, bigRequestBytes, type ReqSpec, type SpecContext
} from "./scenarios.js";
import { GoWorkerClient, workerBinaryPath, type GoStatusMsg } from "./goClient.js";
import { filterHealthyResiduals, stampHealthWindows, windowHealth } from "./health.js";
import { aggregateBatch } from "../metrics/aggregate.js";
import { expectedAuthHeader } from "../auth.js";
import { SERVER_MS_HEADER } from "../petstore/server.js";
import { probeContext, type ProbeContext } from "./policy.js";

/** Parse the SUT's per-request server-time header; garbage/absent → null. */
function parseServerMs(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** How long to wait on a request of this shape. The bulk and slow-upstream
 *  classes are deliberately slow; a 15s budget would time them out by design. */
function requestBudgetMs(spec: ReqSpec): number {
  switch (spec.class) {
    case "slow-upstream":
    case "big-response":
    case "big-request":
      return 60_000;
    default:
      return 15_000;
  }
}

/**
 * Per-request correlation ids for the hot path.
 *
 * Every generated request carries `X-Request-Id` and a W3C `traceparent`, so a
 * slow row in the dashboard can be looked up in the gateway's own access log or
 * trace backend — without that, "the gateway added 800 ms to some requests" is
 * unactionable.
 *
 * randomUUID() per request costs real CPU at a few thousand rps, and that CPU is
 * charged to the very latency being measured. A run instead draws one random
 * prefix at start and appends a counter: unique within and across runs,
 * monotonic (so id order matches send order in a gateway log), and near-free.
 */
class RequestIds {
  /** 12 hex chars, first nibble forced non-zero so derived span ids are valid */
  private prefix = "100000000000";
  private seq = 0;

  reset(): void {
    const hex = randomBytes(6).toString("hex");
    this.prefix = (hex[0] === "0" ? "1" : (hex[0] as string)) + hex.slice(1);
    this.seq = 0;
  }

  /**
   * A 32-hex-char id usable verbatim as a W3C trace-id, plus the traceparent
   * header built from it. The span id mixes run entropy with the counter so it
   * is neither all-zero (which the spec forbids) nor repeated across runs.
   */
  next(): { requestId: string; traceparent: string } {
    const seqHex = (++this.seq).toString(16).padStart(20, "0");
    const traceId = this.prefix + seqHex;
    const spanId = this.prefix.slice(0, 4) + seqHex.slice(-12);
    return { requestId: traceId, traceparent: `00-${traceId}-${spanId}-01` };
  }
}

/** Origin of a URL, or null when it will not parse. Used to decide whether a
 *  target is this very process (and may therefore see our own credential). */
function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

// NOTE on HTTP agents: I benchmarked a tuned undici Agent({ connections: 512,
// pipelining: 10 }) against Node's built-in fetch dispatcher at 500 concurrent
// requests against the local petstore. The built-in was *cleaner* (144 fails vs
// 79 with the tuned Agent): the driver's fetch() is called from many tiny short-
// lived micro-tasks, and undici's per-origin socket pool + pipelining forces the
// same sockets to saturate while short-lived ones pile up. On Windows loopback
// the fallback is the better default. Keep Node's default dispatcher.

/**
 * Scheduler cadence, and with it the depth of the burst the target sees.
 *
 * A tick releases the whole interval's worth of requests at one instant, so the
 * gateway is offered `rps × TICK_MS/1000` arrivals simultaneously and then
 * nothing until the next tick. At the old 20ms that was 100 at once at 5k rps —
 * an impulse train, not an arrival process — and the queueing it caused at the
 * burst front was measured as the gateway's latency. Worse for the overhead Δ:
 * the reference stream runs at 2% of the load and so never bursts, so the
 * self-inflicted queueing landed on the gateway arm alone and was reported as
 * the gateway's cost, growing with the rate.
 *
 * 5ms here against 1ms in the Go worker, deliberately. This driver issues every
 * request on the event loop it is also measuring, so a 1ms interval would be
 * missed under load — and a missed tick hands its tokens to the next one, which
 * makes the bursts deeper rather than shallower. The Go worker ticks on its own
 * goroutine and has no such ceiling. That the two differ is a real fidelity
 * difference between the backends, and one more reason go is the default.
 */
const TICK_MS = 5;
/** must match FLUSH_MS in metrics/server.ts — the store's ingest-rate
 *  estimate and liveness window are derived from the same cadence */
const FLUSH_MS = 10_000;

/**
 * Drain the response body chunk-by-chunk, keeping only the total size. Never
 * buffer a big response just to know its length: a 4MB arrayBuffer per request
 * at high rps is pure GC churn, and it skews the very latency we are
 * measuring. Never `body.cancel()` either — an aborted body kills the
 * connection, forcing a new handshake per request on the shared loop.
 */
async function readOrDrain(res: Response, wantBody: boolean): Promise<{ bytes: number; buf: ArrayBuffer | null }> {
  if (wantBody) {
    const buf = await res.arrayBuffer();
    return { bytes: buf.byteLength, buf };
  }
  const cl = res.headers.get("content-length");
  // the SUT always sets Content-Length, and its value is cheaper than the
  // body itself; fall back to counting chunks for anyone who doesn't
  const declared = cl === null ? null : Number(cl);
  // Big declared bodies: arrayBuffer() outruns a manual chunk loop. The loop
  // pays one promise turn per chunk through Bun's stream machinery (the
  // onReadStreamIntoSinkChunk/pull frames dominating the CPU profile at high
  // big-response rps); arrayBuffer hands the whole drain to native code. The
  // 4MB alloc+drop it costs is cheaper than dozens of loop turns. Do this
  // before getReader(): a locked body rejects arrayBuffer().
  if (declared !== null && Number.isFinite(declared) && declared >= 256 * 1024) {
    const buf = await res.arrayBuffer();
    return { bytes: buf.byteLength, buf: null };
  }
  const reader = res.body?.getReader();
  if (!reader) return { bytes: declared ?? 0, buf: null };
  try {
    if (declared !== null && Number.isFinite(declared) && declared >= 0) {
      while (!(await reader.read()).done) { /* discard */ }
      return { bytes: declared, buf: null };
    }
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    return { bytes, buf: null };
  } finally {
    // a reader left open keeps the socket busy even after it is drained
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

const MAX_SPOOL = 50_000;
/**
 * Reference observations held before a flush.
 *
 * Generous next to the rate the stream actually runs at — tens of seconds of
 * buffer even at its ceiling — so this only fills when ingest is already
 * wedged, at which point the load's own spool is being shed too. Overflow drops
 * the oldest and is not counted: unlike a lost request measurement, a thinner
 * reference arm is not silent, it shows up directly as `directSamples` in the
 * reported Δ.
 */
const MAX_REFERENCE_SPOOL = 5_000;
/**
 * Concurrent reference probes. The reference arm must never queue behind
 * itself: a slow SUT would otherwise accumulate probes whose measured residual
 * is mostly our own backlog, and that inflated reference would be subtracted
 * from the gateway arm — flattering the gateway exactly when things are worst.
 * Hitting this ceiling thins the arm instead, which the Δ reports.
 *
 * Sized off the stream's own rate: the declared share needs 200 probes a second
 * at LIMITS.rps, so the old 64 would have bound on any SUT answering in much
 * over 300ms and thinned the control arm for a reason unrelated to the SUT.
 */
export const MAX_REFERENCE_INFLIGHT = 256;
/** how long stop() waits for in-flight requests before giving up on them */
const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 250;
/**
 * How long the Go path waits for the worker's "stopped" ack before ending the
 * run anyway.
 *
 * The worker's own stop is bounded — its request drain and its reference drain
 * each get DrainTimeout — so an ack that has not arrived by now is not late,
 * it is not coming: a wedged flush, a dead child, a lost line. Without this the
 * run sits at "stopping" until the process restarts, and the operator cannot
 * start the next one.
 */
const GO_STOP_ACK_TIMEOUT_MS = 30_000;
/** ids of pets we created, kept so deletePet has something real to remove */
const MAX_TRACKED_IDS = 2_000;
/** give up on a batch the store keeps refusing, rather than wedging the spool */
const MAX_INGEST_ATTEMPTS = 3;
/** per-minute scheduler buckets held before a flush; bounded like the spool */
const MAX_SHED_BUCKETS = 2_000;
/** raise the concurrency ceiling to hold 5s worth of peak load: Little's law
 *  (rate × latency) says that is how much in-flight the target rate needs at
 *  5s mean latency — generous, most targets answer far faster */
const LATENCY_ALLOWANCE_SEC = 5;
/** how long the concurrency cap must stay saturated before it is reported —
 *  a duration, not a tick count, so changing the scheduler cadence does not
 *  silently change how twitchy the warning is */
const THROTTLE_WARN_AFTER_MS = 200;
export const THROTTLE_TICKS_TO_WARN = Math.max(1, Math.round(THROTTLE_WARN_AFTER_MS / TICK_MS));
/** once throttled, re-warn at most this often */
const THROTTLE_WARN_MS = 10_000;

export type IngestFn = (batch: AggregateBatch) => { ingested: number } | Promise<{ ingested: number }>;

/** Which load-generation backend the driver uses. Default "go" — measured
 *  ~10× cheaper CPU and ~10× tighter event-loop latency than in-process TS
 *  (the JS loop no longer touches requests, so its own stalls no longer
 *  inflate what it measures). Set LOADGEN_BACKEND=ts to opt back into the
 *  in-process driver, useful on hosts where the worker binary isn't built. */
export type LoadgenBackend = "ts" | "go";

function readBackend(): LoadgenBackend {
  return process.env["LOADGEN_BACKEND"] === "ts" ? "ts" : "go";
}

/**
 * In-process load driver. One Driver per app: scheduler, scenario emitters,
 * the direct-to-SUT reference stream (the control arm of the overhead
 * measurement), and batched ingest.
 * Backend "go" delegates generation to the Go worker process (goClient.ts);
 * this class stays the control plane: config push, run lifecycle, status,
 * health-stamping of incoming batches, ingest.
 */
export class Driver {
  private gw: GwTargets = { rest: { ...defaultGwTargets.rest }, soap: { ...defaultGwTargets.soap } };
  private profile: LoadProfile = { ...defaultProfile };
  private state: RunState = "idle";
  private runId: string | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  private bucket = new TokenBucket();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** arm-only deadline for the Go path: tickTimer does not run there, so a one-
   *  shot watchdog is what enforces durationMinutes for Go-driven runs */
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  /** backstop for a "stopped" ack the Go worker never sends */
  private goStopTimer: ReturnType<typeof setTimeout> | null = null;

  private inFlight = 0;
  private activeRequests = new Set<AbortController>();
  private seedId = 120; // ids <= this are seeded by the petstore and never evicted
  private createdIds: number[] = [];
  private counters: RunCounters = { ...EMPTY_RUN_COUNTERS };
  private ids = new RequestIds();
  private spool: RequestResult[] = [];
  /** direct-to-SUT reference observations awaiting the next flush */
  private referenceSpool: BaselineSample[] = [];
  private referenceTokens = 0;
  private referenceLastMs: number | null = null;
  private referenceInFlight = 0;
  /** per-minute scheduler accounting awaiting the next flush */
  private shed = new Map<number, LoadShedSample>();
  /** called when durationMinutes elapses, so the run can be closed out */
  private onDurationReached: ((runId: string | null) => void) | null = null;
  private targetRps = 0;
  private effectiveMaxConcurrency = defaultProfile.maxConcurrency;
  private throttleTicks = 0;          // consecutive ticks capped by concurrency headroom
  private throttledSinceMs: number | null = null;
  private lastThrottleWarnMs = 0;
  private droppedTokens = 0;          // load the cap kept us from issuing, per run
  private errLogBudget = 30; // log first N request errors per run
  private healthCheck: (from: number, to: number) => string | null = () => "health unavailable";

  /** Resolved at construction; tests pin LOADGEN_BACKEND=ts explicitly.
   *  Flips to "ts" if the worker binary is missing or fails to start. */
  private backend: LoadgenBackend = readBackend();
  /** Control-plane client for the Go worker; created lazily on first use. */
  private goClient: GoWorkerClient | null = null;
  /** last status broadcast from the worker (arrives ~every 10s while running) */
  private goLastStatus: GoStatusMsg | null = null;

  setHealthCheck(check: (from: number, to: number) => string | null): void { this.healthCheck = check; }

  private flushing = false;
  private ingestAttempts = 0;

  // Per-target URL prefix ("base without trailing slashes" + "/prefix"), so
  // fire() does one concat instead of four regex replaces per request. Synced
  // whenever the gw config changes (and once at construction).
  private urlPrefix: { rest: string; soap: string } = {
    rest: this.urlPrefixFor(this.gw.rest),
    soap: this.urlPrefixFor(this.gw.soap)
  };
  /**
   * Whether each target may receive this rig's own `Authorization: Basic …`.
   * Resolved from GwConfig.forwardBasicAuth whenever the config changes — see
   * `sendsOurCredential`. Never send the dashboard credential to a third-party
   * gateway: it lands in their access log, and a gateway doing its own auth may
   * reject or rewrite a header it did not expect.
   */
  private forwardAuth: { rest: boolean; soap: boolean } = { rest: false, soap: false };
  /** cached "Basic …" header string for the creds in effect when this run
   *  started; re-reading + re-encoding env per request is a per-run constant
   *  and was charged to a few thousand requests */
  private authHeader: string | null = null;

  // Where the SUT answers with no gateway in front of it: the target of the
  // reference stream. Doubles as "which origin is us", for
  // forwardBasicAuth: "auto".
  private baselineUrl = "http://127.0.0.1:8080";

  private ingestFn: IngestFn | null = null;

  /** Redirect the reference stream (useful in tests and custom setups). Also
   *  defines "us" for forwardBasicAuth: "auto", so it must be re-resolved. */
  setBaselineUrl(url: string): void {
    this.baselineUrl = url.replace(/\/+$/, "");
    this.refreshUrlPrefixes();
    this.goClient?.configure(this.gw, this.profile, this.baselineUrl);
  }

  get currentGw(): GwTargets {
    return { rest: { ...this.gw.rest }, soap: { ...this.gw.soap } };
  }
  get currentProfile(): LoadProfile { return { ...this.profile }; }

  setGw(gw: unknown): void {
    this.gw = sanitizeGwTargets(gw, this.gw);
    this.refreshUrlPrefixes();
    this.goClient?.configure(this.gw, this.profile, this.baselineUrl);
  }

  setProfile(profile: Partial<LoadProfile>): void {
    this.profile = sanitizeLoadProfile({ ...this.profile, ...profile }, this.profile);
    this.goClient?.configure(this.gw, this.profile, this.baselineUrl);
  }

  /** Lazily create the Go worker control client and wire its events into the
   *  plain Driver surface: batches arrive already rolled up by the worker and
   *  health-qualified by the client (the same window grouping the ts flush path
   *  uses, over both arms of the overhead comparison), and land in ingestFn. */
  private go(): GoWorkerClient | null {
    if (this.backend !== "go") return null;
    if (workerBinaryPath() === null) {
      // the image bakes the binary but a source checkout may not have it built;
      // auto-fall back so LOADGEN_BACKEND=ts doesn't have to be remembered
      console.warn("[driver] packages/go/bin/gwtester-worker is missing — falling back to in-process ts driver (build it under packages/go to use the default go backend)");
      this.backend = "ts";
      return null;
    }
    if (!this.goClient) {
      const client = new GoWorkerClient({
        onStatus: (s) => { this.goLastStatus = s; },
        onBatch: async (batch) => {
          if (!this.ingestFn) return;
          try { await this.ingestFn(batch); } catch (e) {
            console.error("[driver] ingest failed:", (e as Error).message);
          }
        },
        onStopped: () => {
          // Accepting only "running" here was the bug behind a run that said
          // "stopping" forever: stop() moves us to "stopping" and *then* asks
          // the worker to stop, so its ack always arrived in the one state this
          // guard rejected. The ack was dropped and nothing else ever moved the
          // run to idle — only a restart, or starting another run, cleared it.
          if (this.state === "idle") return;
          if (this.goStopTimer) { clearTimeout(this.goStopTimer); this.goStopTimer = null; }
          this.state = "idle";
          this.runId = null;
          this.startedAt = null;
          this.stoppedAt = null;
        }
      });
      client.setHealthCheck((from, to) => this.healthCheck(from, to));
      void client.ensureStarted().catch((e) => {
        console.error("[driver] go worker failed to start — falling back to ts:", (e as Error).message);
        this.goClient = null;
        this.backend = "ts";
      });
      client.configure(this.gw, this.profile, this.baselineUrl);
      this.goClient = client;
    }
    return this.goClient;
  }

  /** Wire the ingest function (in-process, called from the metrics module). */
  setIngest(fn: IngestFn): void {
    this.ingestFn = fn;
  }

  /** Notified when a bounded run hits its durationMinutes and stops itself, so
   *  the caller can record the stop exactly as a manual one would. */
  onAutoStop(fn: (runId: string | null) => void): void {
    this.onDurationReached = fn;
  }

  private get ctx(): SpecContext {
    return { seedId: this.seedId, createdIds: this.createdIds };
  }

  // stays async although nothing is awaited here any more: every caller awaits
  // it, and the go path starts a child process whose readiness this will need
  // to wait on again
  async init(): Promise<void> {
    if (this.go()) {
      // the flush timer exists only for the ts backend: the worker streams its
      // own batches — reference observations included — and pushes them as
      // events instead
      return;
    }
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /**
   * Issue this tick's share of the direct-to-SUT reference stream.
   *
   * The control arm of the overhead measurement: the same scenario generator,
   * so the class mix matches the load's by construction, aimed straight at the
   * SUT. Matching mixes is what makes it legitimate to pool residuals across
   * classes and still read the difference as the gateway's cost.
   *
   * It is paced continuously alongside the load rather than run as a probe
   * cycle, for three reasons. Its connections stay warm, so it is not measuring
   * TCP setup the load path has long since amortised. It covers the same
   * minutes as the traffic it is compared against, so a comparison is never
   * made across different machine conditions. And it scales with the load, so
   * it neither perturbs a small run nor runs too thin to support a p99 on a
   * large one.
   */
  private pumpReference(nowMs: number, targetRps: number): void {
    const rps = referenceRps(targetRps);
    if (this.referenceLastMs === null) {
      this.referenceLastMs = nowMs;
      return;
    }
    const dtSec = Math.max(0, (nowMs - this.referenceLastMs) / 1000);
    this.referenceLastMs = nowMs;
    this.referenceTokens = Math.min(rps, this.referenceTokens + dtSec * rps);
    const whole = Math.floor(this.referenceTokens);
    this.referenceTokens -= whole;
    const due = Math.min(whole, Math.max(0, MAX_REFERENCE_INFLIGHT - this.referenceInFlight));
    for (let i = 0; i < due; i++) void this.fireReference();
  }

  /** One reference observation: same request shape as the load, gateway
   *  bypassed, residual recorded as measured. */
  private async fireReference(): Promise<void> {
    if (this.state !== "running") return;
    const spec = buildSpec(this.profile, this.ctx);
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), requestBudgetMs(spec));
    this.activeRequests.add(ac);
    this.referenceInFlight++;
    const started = Date.now();
    const t0 = performance.now();
    try {
      const headers: Record<string, string> = { ...spec.headers };
      // straight to the SUT, so this rig's own credential is the right one and
      // the gateway's API key is not
      const auth = expectedAuthHeader();
      if (auth) headers["authorization"] = auth.toString("utf-8");
      const res = await fetch(`${this.baselineUrl}${spec.path}`, {
        method: spec.method, headers, body: spec.body, signal: ac.signal
      });
      const ttfbMs = performance.now() - t0;
      const serverMs = parseServerMs(res.headers.get(SERVER_MS_HEADER));
      await readOrDrain(res, false);
      // no backend clock means no residual — the same rule the gateway arm is
      // held to, so neither side is filtered more leniently than the other
      if (serverMs === null) return;
      this.recordReference({ ts: started, class: spec.class, residualMs: ttfbMs - serverMs });
    } catch {
      // a reference probe that never answered contributes nothing; it is not
      // an error of the gateway's and must not be reported as one
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(ac);
      this.referenceInFlight--;
    }
  }

  private recordReference(s: BaselineSample): void {
    if (this.referenceSpool.length >= MAX_REFERENCE_SPOOL) {
      this.referenceSpool.splice(0, Math.ceil(MAX_REFERENCE_SPOOL / 10));
    }
    this.referenceSpool.push(s);
  }

  start(runId: string): { ok: true; runId: string } {
    const goClient = this.go();
    if (goClient) {
      if (this.state === "running") return { ok: true, runId: this.runId ?? runId };
      // a stop still waiting on its ack is superseded by this run
      if (this.goStopTimer) { clearTimeout(this.goStopTimer); this.goStopTimer = null; }
      void goClient.ensureStarted().then(() => {
        goClient.configure(this.gw, this.profile, this.baselineUrl);
        goClient.start(runId);
      });
      this.state = "running";
      this.runId = runId;
      this.startedAt = Date.now();
      this.stoppedAt = null;
      this.goLastStatus = null;
      // tickTimer doesn't run in the Go path — the Go worker owns pacing — but
      // durationMinutes still has to end the run; enforce it with a watchdog.
      if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null; }
      const limitMin = this.profile.durationMinutes ?? 0;
      if (limitMin > 0) {
        this.durationTimer = setTimeout(() => {
          this.durationTimer = null;
          if (this.state !== "running" || this.startedAt === null) return;
          console.log(`[driver] run ${this.runId} reached its ${limitMin} minute limit — stopping`);
          this.onDurationReached?.(this.runId);
          this.stop();
        }, limitMin * 60_000);
        this.durationTimer.unref?.();
      }
      console.log(`[driver] run ${runId} started, mode=${this.profile.mode}, target=${this.gw.rest.baseUrl} (go backend)`);
      return { ok: true, runId };
    }
    if (this.state === "running") return { ok: true, runId: this.runId ?? runId };
    // a stop() still draining is superseded by the new run
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }

    this.state = "running";
    this.runId = runId;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.bucket = new TokenBucket();
    this.counters = { ...EMPTY_RUN_COUNTERS };
    this.ids.reset();
    this.errLogBudget = 30;
    this.ingestAttempts = 0;
    this.throttleTicks = 0;
    this.throttledSinceMs = null;
    this.lastThrottleWarnMs = 0;
    this.droppedTokens = 0;
    this.shed.clear();
    this.referenceSpool.length = 0;
    this.referenceTokens = 0;
    this.referenceLastMs = null;
    this.refreshUrlPrefixes();
    // the creds are constant for the run; refresh them here instead of per request
    this.authHeader = expectedAuthHeader()?.toString("utf-8") ?? null;

    // Little's law: sustaining a rate needs rps × latency in flight, so a low
    // maxConcurrency silently caps throughput at maxConcurrency / latency —
    // the shipped default of 25 reaches only ~65 rps against a 385ms target.
    // Treat the profile value as a floor and size the real ceiling for the
    // peak rate, with 5s of latency as a generous allowance.
    const need = Math.ceil(peakTargetRps(this.profile) * LATENCY_ALLOWANCE_SEC);
    this.effectiveMaxConcurrency = Math.min(LIMITS.maxConcurrency, Math.max(this.profile.maxConcurrency, need));
    if (this.effectiveMaxConcurrency > this.profile.maxConcurrency) {
      console.log(
        `[driver] auto-raised maxConcurrency ${this.profile.maxConcurrency} -> ${this.effectiveMaxConcurrency}` +
        ` for rps target ${Math.round(peakTargetRps(this.profile))}`
      );
    }

    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();
    console.log(`[driver] run ${runId} started, mode=${this.profile.mode}, target=${this.gw.rest.baseUrl}`);
    // An operator who sets "always" against an external gateway is choosing to
    // hand it the dashboard credential. Say so once per run rather than doing
    // it silently.
    for (const side of ["rest", "soap"] as const) {
      if (this.forwardAuth[side] && originOf(this.gw[side].baseUrl) !== originOf(this.baselineUrl)) {
        console.warn(
          `[driver] forwarding this rig's Basic credential to the external ${side.toUpperCase()} target` +
          ` ${this.gw[side].baseUrl} (forwardBasicAuth="${this.gw[side].forwardBasicAuth}")`
        );
      }
    }
    return { ok: true, runId };
  }

  stop(): { stopped: true; runId: string | null } {
    const runId = this.runId;
    if (this.goClient && this.state !== "idle") {
      if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null; }
      this.goClient.stop();
      this.state = "stopping";
      this.stoppedAt = Date.now();
      // the "stopped" broadcast (and the worker's final batch) move us to idle;
      // this is the backstop for when it never comes
      if (this.goStopTimer) clearTimeout(this.goStopTimer);
      this.goStopTimer = setTimeout(() => {
        this.goStopTimer = null;
        if (this.state !== "stopping") return; // the ack landed, or a new run took over
        console.warn(
          `[driver] run ${runId}: no stop ack from the go worker after ` +
          `${GO_STOP_ACK_TIMEOUT_MS / 1000}s — ending the run anyway`
        );
        this.state = "idle";
        this.runId = null;
        this.startedAt = null;
        this.stoppedAt = null;
      }, GO_STOP_ACK_TIMEOUT_MS);
      this.goStopTimer.unref?.();
      return { stopped: true, runId };
    }
    if (this.state === "idle") return { stopped: true, runId: null };
    this.state = "stopping";
    this.stoppedAt = Date.now();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;

    const drain = () => {
      this.drainTimer = null;
      if (this.state !== "stopping") return; // a new run took over
      const waitedMs = Date.now() - (this.stoppedAt ?? Date.now());
      if (this.inFlight > 0 && waitedMs < DRAIN_TIMEOUT_MS) {
        this.drainTimer = setTimeout(drain, DRAIN_POLL_MS);
        this.drainTimer.unref?.();
        return;
      }
      if (this.inFlight > 0) {
        console.warn(`[driver] run ${runId} drain timed out with ${this.inFlight} request(s) still in flight`);
      }
      this.state = "idle";
      this.runId = null;
      this.startedAt = null;
      this.stoppedAt = null;
      const c = this.counters;
      console.log(
        `[driver] run ${runId} stopped, sent=${c.sent} ok=${c.ok} 4xx=${c.clientErrors}` +
        ` errors=${c.errors} gwFaults=${c.gatewayErrors} 429=${c.rateLimited} 401/403=${c.unauthorized}`
      );
      // hand whatever we collected to the store rather than dropping it —
      // including the partial minute's scheduler accounting
      void this.flush(true);
    };
    this.drainTimer = setTimeout(drain, DRAIN_POLL_MS);
    this.drainTimer.unref?.();
    return { stopped: true, runId };
  }

  private tick(): void {
    if (this.state !== "running" || this.startedAt === null) return;
    const now = Date.now();
    // An acceptance run is bounded: stop on time and let the caller collect a
    // report, rather than running until somebody remembers to press stop.
    const limitMin = this.profile.durationMinutes ?? 0;
    if (limitMin > 0 && now - this.startedAt >= limitMin * 60_000) {
      console.log(`[driver] run ${this.runId} reached its ${limitMin} minute limit — stopping`);
      this.onDurationReached?.(this.runId);
      this.stop();
      return;
    }
    const { due, targetRps, missed } = this.bucket.tick(now, this.profile, this.startedAt);
    this.targetRps = targetRps;
    this.noteSchedulerTick(now, targetRps);
    // the reference arm is paced off the same tick as the load, so the two
    // distributions always cover the same moments
    this.pumpReference(now, targetRps);
    const headroom = Math.max(0, this.effectiveMaxConcurrency - this.inFlight);
    const cap = Math.min(due, headroom);
    const dropped = due - cap + (missed ?? 0);
    if (dropped > 0) {
      this.counters.droppedRequests += dropped;
      this.noteShed(now, dropped);
      // the target rate asks for more than the ceiling can accept: sustained
      // saturation means real latency outgrew the allowance, so we throttle
      // — surface it rather than silently delivering less than the target
      this.droppedTokens += dropped;
      this.throttleTicks++;
      if (this.throttleTicks === THROTTLE_TICKS_TO_WARN) this.throttledSinceMs = Date.now();
      if (this.throttleTicks >= THROTTLE_TICKS_TO_WARN && Date.now() - this.lastThrottleWarnMs >= THROTTLE_WARN_MS) {
        this.lastThrottleWarnMs = Date.now();
        console.warn(
          `[driver] target ${targetRps.toFixed(1)} rps but concurrency cap ${this.effectiveMaxConcurrency} is throttling` +
          ` (inFlight=${this.inFlight}, latency too high?); dropped ${this.droppedTokens} request(s) worth of load so far`
        );
      }
    } else {
      this.throttleTicks = 0;
      this.throttledSinceMs = null;
    }
    for (let i = 0; i < cap; i++) {
      void this.fire();
    }
  }

  /**
   * Per-minute scheduler accounting, flushed with the next metrics batch.
   *
   * Recording the *target* every tick — not just the drops — is what lets a
   * window say "you asked for 500 rps and we delivered 340". Without the
   * denominator, shed load is a bare number nobody can size.
   */
  private noteSchedulerTick(nowMs: number, targetRps: number): void {
    const b = this.shedBucket(nowMs);
    b.targetSum += targetRps;
    b.ticks++;
  }

  private noteShed(nowMs: number, dropped: number): void {
    this.shedBucket(nowMs).dropped += dropped;
  }

  /** Measurements thrown away for requests the gateway really served. Counted
   *  into the minute they were lost in, so the window carrying the surviving
   *  requests is judged on how much of the sample went missing. */
  private noteResultsLost(lost: number): void {
    this.counters.resultsLost += lost;
    const b = this.shedBucket(Date.now());
    b.resultsLost = (b.resultsLost ?? 0) + lost;
  }

  private shedBucket(nowMs: number): LoadShedSample {
    const bucketTs = Math.floor(nowMs / 60_000) * 60_000;
    let b = this.shed.get(bucketTs);
    if (!b) {
      // bounded like the result spool: a store that keeps refusing batches must
      // not let this grow without limit either
      if (this.shed.size >= MAX_SHED_BUCKETS) {
        const oldest = this.shed.keys().next();
        if (!oldest.done) this.shed.delete(oldest.value);
      }
      this.shed.set(bucketTs, (b = { bucketTs, dropped: 0, resultsLost: 0, targetSum: 0, ticks: 0 }));
    }
    return b;
  }

  private trackCreatedId(id: number): void {
    this.createdIds.push(id);
    if (this.createdIds.length > MAX_TRACKED_IDS) this.createdIds.shift();
  }

  private async fire(): Promise<void> {
    // capture the run identity up front: the run may end while we await below,
    // and a result must never be attributed to a null run
    const runId = this.runId;
    if (runId === null || this.startedAt === null) return;

    const spec = buildSpec(this.profile, this.ctx);
    this.inFlight++;
    this.counters.sent++;
    if (spec.expectInvalid) this.counters.invalidSent++;

    // REST and SOAP may be fronted at different gateway URLs / API keys
    const soap = spec.protocol === "soap";
    const target = soap ? this.gw.soap : this.gw.rest;
    const url = (soap ? this.urlPrefix.soap : this.urlPrefix.rest) + spec.path;
    const { requestId, traceparent } = this.ids.next();
    const started = Date.now();
    const timerStarted = performance.now();
    const ac = new AbortController();
    this.activeRequests.add(ac);
    const timeout = setTimeout(() => ac.abort(), requestBudgetMs(spec));
    let status = 0;
    let bytesResp = 0;
    let ttfbMs: number | null = null;
    let error: string | null = null;
    /** SUT's own time for this request; null when the response never touched the
     *  SUT (gateway's own rejection) or a real gateway stripped the header. */
    let serverMs: number | null = null;

    try {
      const headers: Record<string, string> = { ...spec.headers };
      headers["x-request-id"] = requestId;
      headers["traceparent"] = traceparent;
      if (this.authHeader && (soap ? this.forwardAuth.soap : this.forwardAuth.rest)) {
        headers["authorization"] = this.authHeader;
      }
      if (target.apiKey) headers[target.apiKeyHeader || "X-API-Key"] = target.apiKey;
      const res = await fetch(url, {
        method: spec.method,
        headers,
        body: spec.body,
        signal: ac.signal
      });
      status = res.status;
      // fetch() resolves on response headers: this is the request's TTFB
      ttfbMs = performance.now() - timerStarted;
      serverMs = parseServerMs(res.headers.get(SERVER_MS_HEADER));
      // only the createPet flow needs the parsed body (to learn the new id);
      // everything else just wants the byte count, which the length header
      // already tells us
      const text = await readOrDrain(res, spec.captureId === true);
      bytesResp = text.bytes;

      if (spec.captureId && status >= 200 && status < 300 && text.buf !== null && text.buf.byteLength < 1_000_000) {
        try {
          const parsed = JSON.parse(Buffer.from(text.buf).toString("utf-8")) as { id?: unknown };
          if (typeof parsed.id === "number" && Number.isSafeInteger(parsed.id)) this.trackCreatedId(parsed.id);
        } catch { /* padded or proxied into something unparsable — ignore */ }
      }
      // `X-Server-Ms` is the backend's fingerprint: present means the request
      // got all the way through. For the invalid slice that is the whole
      // question — a 4xx without it is the GATEWAY rejecting the request, a 4xx
      // with it means the gateway let a contract violation past and only the
      // backend caught it.
      if (spec.expectInvalid) {
        if (serverMs !== null) this.counters.invalidLeaked++;
        else if (status >= 400 && status < 500) this.counters.invalidRejectedByGateway++;
      }

      // A 4xx is not a success. A gateway answering 401 on a bad key, or 429
      // once its quota trips, used to land in `ok` and report a flawless run.
      if (isSuccess(status)) this.counters.ok++;
      else if (status >= 500) this.counters.errors++;
      else this.counters.clientErrors++;
      if (isGatewayFault(status)) this.counters.gatewayErrors++;
      if (status === 429) this.counters.rateLimited++;
      if (status === 401 || status === 403) this.counters.unauthorized++;
    } catch (e) {
      const err = e as Error;
      // No response at all. Both branches are failures — a timeout used to
      // increment only `timeouts`, so a gateway that hung on every request
      // reported zero errors alongside zero successes.
      this.counters.errors++;
      this.counters.gatewayErrors++;
      if (err.name === "AbortError" || ac.signal.aborted) {
        error = "timeout/abort";
        this.counters.timeouts++;
      } else {
        error = err.message;
      }
      if (this.errLogBudget > 0) {
        this.errLogBudget--;
        console.error(`[driver] request failed: ${spec.method} ${url} -> ${error}`);
      }
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(ac);
      this.inFlight--;
    }

    const latencyMs = performance.now() - timerStarted;

    // TTFB and the SUT's own time are both recorded raw. The residual between
    // them — everything that was not the backend — is what the store compares
    // against the reference stream. Deliberately not reduced to a single
    // "overhead" number here: a per-request overhead would need a direct call
    // this request never made, and inventing one from a running median is what
    // the previous measurement did. Body transfer after headers stays out of
    // it, and in total latency, where it belongs.
    this.record({
      runId,
      requestId,
      ts: started,
      protocol: spec.protocol,
      endpoint: spec.endpoint,
      class: spec.class,
      method: spec.method,
      status,
      latencyMs,
      ttfbMs,
      serverMs,
      // Null, not 0: `fetch` exposes no connection-level hook, so this driver
      // genuinely cannot tell a pool hit from a fresh TLS handshake. Claiming
      // zero would let the residual subtract a setup cost it never measured.
      // Both arms are equally blind here, so the Δ stays internally consistent
      // — it just carries setup on both sides. The Go worker uses httptrace and
      // does separate them, which is one more reason it is the default.
      connectMs: null,
      timingReason: null,
      measurementVersion: MEASUREMENT_VERSION,
      bytesReq: spec.class === "big-request" ? bigRequestBytes(spec.body) : Buffer.byteLength(spec.body ?? ""),
      bytesResp,
      reachedBackend: serverMs !== null,
      error
    });
  }

  /** "http://host:port/prefix" per target, path added later in one concat. */
  private urlPrefixFor(target: GwConfig): string {
    const base = target.baseUrl.replace(/\/+$/, "");
    const prefix = target.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return prefix ? `${base}/${prefix}` : base;
  }

  /**
   * Whether this target gets our `Authorization: Basic …`.
   *
   * "auto" — the default — forwards only to our own origin, i.e. the bundled
   * petstore, which requires the header to answer at all. A real gateway is by
   * definition a different origin and gets nothing: that stops the dashboard
   * credential from being written into a third party's logs and stops a header
   * the gateway did not ask for from confusing its own auth.
   */
  private sendsOurCredential(target: GwConfig): boolean {
    switch (target.forwardBasicAuth) {
      case "always": return true;
      case "never": return false;
      default: return this.isSelf(target);
    }
  }

  private refreshUrlPrefixes(): void {
    this.urlPrefix = { rest: this.urlPrefixFor(this.gw.rest), soap: this.urlPrefixFor(this.gw.soap) };
    this.forwardAuth = {
      rest: this.sendsOurCredential(this.gw.rest),
      soap: this.sendsOurCredential(this.gw.soap)
    };
  }

  private record(r: RequestResult): void {
    if (this.spool.length >= MAX_SPOOL) {
      // drop the oldest decile in one splice rather than shifting per insert.
      // These are measurements of requests the gateway really served, so the
      // loss is counted: silently thinning the spool understates the tail
      // exactly when the rig is busiest.
      const lost = Math.ceil(MAX_SPOOL / 10);
      this.spool.splice(0, lost);
      this.noteResultsLost(lost);
    }
    this.spool.push(r);
  }

  /** `final` also drains the still-open minute — use it when stopping, where
   *  there is no later flush to carry it. */
  private async flush(final = false): Promise<void> {
    if (this.flushing) return;
    // scheduler accounting must flush even with no results: a fully throttled
    // tick issues nothing, and that is precisely the case worth recording
    const shed = this.takeShed(final);
    if (this.spool.length === 0 && shed.length === 0 && this.referenceSpool.length === 0) return;
    if (!this.ingestFn) {
      this.restoreShed(shed); // metrics module not wired yet
      return;
    }
    this.flushing = true;
    const chunk = this.spool.splice(0, this.spool.length);
    const baseline = this.referenceSpool.splice(0, this.referenceSpool.length);
    // One verdict source for the whole flush, so a row and its own residual can
    // never be judged differently at the window boundary.
    const health = windowHealth(this.healthCheck);
    if (chunk.length > 0) stampHealthWindows(chunk, health);
    // Roll up here rather than shipping every result: what crosses into the
    // store is then a few dozen cells plus a capped tail regardless of the rate,
    // instead of one object per request on the event loop whose stalls are the
    // very thing this rig withholds measurements over.
    const batch = aggregateBatch({ batchId: randomUUID(), results: chunk, shed, baseline });
    // both arms are filtered by the same health rule: keeping contaminated
    // reference samples while withholding contaminated gateway ones would
    // shift the reference up and understate the gateway by our own stalls
    batch.residuals = filterHealthyResiduals(batch.residuals, health);
    try {
      await this.ingestFn(batch);
      this.ingestAttempts = 0;
    } catch (e) {
      this.ingestAttempts++;
      if (this.ingestAttempts >= MAX_INGEST_ATTEMPTS) {
        // never let one poison batch wedge the pipeline forever; the shed rows
        // go with it rather than being replayed against a store that refuses them
        this.noteResultsLost(chunk.length);
        console.error(
          `[driver] dropping ${chunk.length} results after ${this.ingestAttempts} failed ingest attempts:`,
          (e as Error).message
        );
        this.ingestAttempts = 0;
      } else {
        // put them back at the front, newest data still wins if we overflow
        this.spool = chunk.concat(this.spool);
        if (this.spool.length > MAX_SPOOL) {
          const lost = this.spool.length - MAX_SPOOL;
          this.spool = this.spool.slice(lost);
          this.noteResultsLost(lost);
        }
        // the reference arm goes back too: retrying the gateway arm without it
        // would leave that minute's Δ comparing full traffic against a gap
        this.referenceSpool = baseline.concat(this.referenceSpool).slice(-MAX_REFERENCE_SPOOL);
        this.restoreShed(shed);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Drain completed shed buckets; the open one stays behind, still filling,
   *  unless this is the last flush of a run. */
  private takeShed(final: boolean): LoadShedSample[] {
    const openBucket = Math.floor(Date.now() / 60_000) * 60_000;
    const out: LoadShedSample[] = [];
    for (const [ts, s] of this.shed) {
      if (!final && ts >= openBucket) continue;
      out.push(s);
      this.shed.delete(ts);
    }
    return out;
  }

  /** Fold un-ingested buckets back in, so a failed flush loses no accounting. */
  private restoreShed(samples: LoadShedSample[]): void {
    for (const s of samples) {
      const b = this.shedBucket(s.bucketTs);
      b.dropped += s.dropped;
      b.resultsLost = (b.resultsLost ?? 0) + (s.resultsLost ?? 0);
      b.targetSum += s.targetSum;
      b.ticks += s.ticks;
    }
  }

  status(): RunStatus {
    // The Go worker owns the counters for its own runs, so they are read from
    // its last status message even once the run is idle: the worker emits a
    // final tally after draining, and falling back to this process's (empty)
    // counters the moment a run ended reported every finished Go run as zero
    // traffic.
    if (this.goClient && this.goLastStatus !== null) {
      const s = this.goLastStatus;
      return {
        state: this.state,
        runId: this.runId,
        startedAt: this.startedAt,
        uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
        profile: { ...this.profile },
        targetRps: this.state === "running" ? s?.targetRps ?? 0 : 0,
        effectiveMaxConcurrency: this.effectiveMaxConcurrency,
        throttledSinceMs: null,
        counters: {
          sent: s?.sent ?? 0,
          ok: s?.ok ?? 0,
          errors: s?.errors ?? 0,
          clientErrors: s?.r4xx ?? 0,
          gatewayErrors: s?.gwFaults ?? 0,
          rateLimited: s?.rateLimited ?? 0,
          unauthorized: s?.unauthorized ?? 0,
          timeouts: 0,
          droppedRequests: s?.dropped ?? 0,
          resultsLost: s?.resultsLost ?? 0,
          invalidSent: s?.invalidSent ?? 0,
          invalidRejectedByGateway: s?.invalidRejectedByGateway ?? 0,
          invalidLeaked: s?.invalidLeaked ?? 0
        },
        gateway: this.currentGw,
        targetIsSelf: { rest: this.isSelf(this.gw.rest), soap: this.isSelf(this.gw.soap) }
      };
    }
    return {
      state: this.state,
      runId: this.runId,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
      profile: { ...this.profile },
      // reported from the last scheduler tick: reading status must never
      // advance the mode=real drift model
      targetRps: this.state === "running" ? this.targetRps : 0,
      effectiveMaxConcurrency: this.effectiveMaxConcurrency,
      throttledSinceMs: this.state === "running" ? this.throttledSinceMs : null,
      counters: { ...this.counters },
      targetIsSelf: { rest: this.isSelf(this.gw.rest), soap: this.isSelf(this.gw.soap) }
    };
  }

  /**
   * Probe context for the gateway policy checks: same targets, same URL
   * building and the same credential rule the load driver itself applies, so a
   * policy result describes the path the traffic actually takes.
   */
  policyContext(): ProbeContext {
    return probeContext(
      this.currentGw,
      (t) => (this.sendsOurCredential(t) ? expectedAuthHeader()?.toString("utf-8") ?? null : null),
      this.isSelf(this.gw.rest)
    );
  }

  /** True when this target is our own origin — no gateway in the path. */
  private isSelf(target: GwConfig): boolean {
    const self = originOf(this.baselineUrl);
    const theirs = originOf(target.baseUrl);
    return self !== null && theirs !== null && self === theirs;
  }

  async shutdown(): Promise<void> {
    if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null; }
    if (this.goStopTimer) { clearTimeout(this.goStopTimer); this.goStopTimer = null; }
    if (this.goClient) {
      // stop the timers the ts path may have armed before the client came up
      if (this.tickTimer) clearInterval(this.tickTimer);
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.tickTimer = this.flushTimer = null;
      const client = this.goClient;
      this.goClient = null;
      this.state = "idle";
      this.runId = null;
      await client.shutdown();
      return;
    }
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.tickTimer = this.flushTimer = null;
    this.drainTimer = null;
    this.state = "idle";
    const deadline = performance.now() + 5000;
    while (this.activeRequests.size && performance.now() < deadline) await new Promise(r => setTimeout(r, 20));
    for (const ac of this.activeRequests) ac.abort();
    // Fetch abort continuations finish recording before the last flush.
    while (this.activeRequests.size) await new Promise(r => setTimeout(r, 20));
    while (this.flushing) await new Promise(r => setTimeout(r, 20));
    await this.flush(true);
  }
}
