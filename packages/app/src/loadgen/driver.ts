import { randomUUID } from "node:crypto";
import type {
  GwConfig,
  GwTargets,
  IngestBatch,
  LoadProfile,
  RequestResult,
  RunState,
  RunStatus,
  ScenarioClass
} from "@apigw/shared";
import {
  DEFAULT_GW_TARGETS as defaultGwTargets,
  DEFAULT_LOAD_PROFILE as defaultProfile,
  sanitizeGwTargets,
  sanitizeLoadProfile
} from "@apigw/shared";
import { TokenBucket } from "./scheduler.js";
import { buildSpec, buildBaselineProbe, type ReqSpec, type SpecContext } from "./scenarios.js";
import { readBasicAuthCreds } from "../auth.js";
import { SERVER_MS_HEADER } from "../petstore/server.js";

/** Parse the SUT's per-request server-time header; garbage/absent → null. */
function parseServerMs(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// NOTE on HTTP agents: I benchmarked a tuned undici Agent({ connections: 512,
// pipelining: 10 }) against Node's built-in fetch dispatcher at 500 concurrent
// requests against the local petstore. The built-in was *cleaner* (144 fails vs
// 79 with the tuned Agent): the driver's fetch() is called from many tiny short-
// lived micro-tasks, and undici's per-origin socket pool + pipelining forces the
// same sockets to saturate while short-lived ones pile up. On Windows loopback
// the fallback is the better default. Keep Node's default dispatcher.

const TICK_MS = 100;
const FLUSH_MS = 5000;
const BASELINE_PROBE_MS = 60_000;
const BASELINE_SAMPLES_PER_CLASS = 8;
const BASELINE_PROBE_TIMEOUT_MS = 15_000;
const MAX_SPOOL = 50_000;
/** how long stop() waits for in-flight requests before giving up on them */
const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 250;
/** ids of pets we created, kept so deletePet has something real to remove */
const MAX_TRACKED_IDS = 2_000;
/** give up on a batch the store keeps refusing, rather than wedging the spool */
const MAX_INGEST_ATTEMPTS = 3;

export type IngestFn = (batch: IngestBatch) => { ingested: number } | Promise<{ ingested: number }>;

/**
 * In-process load driver. One Driver per app: scheduler, scenario emitters,
 * direct-to-SUT baseline probes (for GW-overhead math), and batched ingest.
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
  private baselineTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private inFlight = 0;
  private seedId = 120; // ids <= this are seeded by the petstore and never evicted
  private createdIds: number[] = [];
  private counters = { sent: 0, ok: 0, errors: 0, timeouts: 0, invalidSent: 0, invalidRejected: 0 };
  private spool: RequestResult[] = [];
  private targetRps = 0;
  private errLogBudget = 30; // log first N request errors per run
  private probing = false;   // re-entrancy guard for baseline probes
  private flushing = false;
  private ingestAttempts = 0;

  // baseline endpoint: which host to hit directly for class-level baselines
  private baselineUrl = "http://127.0.0.1:8080";
  // per-class baselines from direct calls — used to compute GW overhead per request
  private baselines = new Map<ScenarioClass, number[]>();

  private ingestFn: IngestFn | null = null;

  /** Redirect baseline probing (useful in tests and custom setups). */
  setBaselineUrl(url: string): void { this.baselineUrl = url.replace(/\/+$/, ""); }

  get currentGw(): GwTargets {
    return { rest: { ...this.gw.rest }, soap: { ...this.gw.soap } };
  }
  get currentProfile(): LoadProfile { return { ...this.profile }; }

  setGw(gw: unknown): void {
    this.gw = sanitizeGwTargets(gw, this.gw);
  }

  setProfile(profile: Partial<LoadProfile>): void {
    this.profile = sanitizeLoadProfile({ ...this.profile, ...profile }, this.profile);
  }

  /** Wire the ingest function (in-process, called from the metrics module). */
  setIngest(fn: IngestFn): void {
    this.ingestFn = fn;
  }

  private get ctx(): SpecContext {
    return { seedId: this.seedId, createdIds: this.createdIds };
  }

  async init(): Promise<void> {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
    this.baselineTimer = setInterval(() => void this.probeBaselines(), BASELINE_PROBE_MS);
    this.baselineTimer.unref?.();
    // establish baselines immediately so the first minute of a run reports
    // real overhead instead of "overhead == latency"
    await this.probeBaselines();
  }

  /** Hit the SUT directly (no GW) to establish per-class baseline latencies. */
  private async probeBaselines(): Promise<void> {
    if (this.probing) return; // a previous probe is still outstanding
    this.probing = true;
    try {
      for (const spec of buildBaselineProbe(this.ctx)) {
        const lat = await this.timeDirect(spec);
        if (lat !== null) {
          let arr = this.baselines.get(spec.class);
          if (!arr) this.baselines.set(spec.class, (arr = []));
          arr.push(lat);
          if (arr.length > BASELINE_SAMPLES_PER_CLASS) arr.shift();
        }
      }
    } finally {
      this.probing = false;
    }
  }

  private async timeDirect(spec: ReqSpec): Promise<number | null> {
    const url = `${this.baselineUrl}${spec.path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), BASELINE_PROBE_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const headers: Record<string, string> = { ...spec.headers };
      const creds = readBasicAuthCreds();
      if (creds) headers["authorization"] = `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
      const res = await fetch(url, { method: spec.method, headers, body: spec.body, signal: ac.signal });
      await res.arrayBuffer();
      const rtt = Date.now() - t0;
      // subtract the SUT's own time and batch the remainder (transport + client
      // stack) across all classes: per-request serverMs covers the class random
      // variation at run time, so a per-class total-latency baseline would just
      // re-import the noise we removed
      const serverMs = parseServerMs(res.headers.get(SERVER_MS_HEADER));
      return serverMs === null ? rtt : Math.max(0, rtt - serverMs);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the SUT cannot tell us: direct-path transport for this class. */
  private baselineFor(cls: ScenarioClass): number {
    const arr = this.baselines.get(cls) ?? [];
    if (arr.length === 0) return 0; // until baseline measured, overhead is unknown → 0
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.5)] ?? sorted[0] ?? 0;
  }

  /**
   * Split a through-gateway latency into backend time and gateway time for the
   * *same* request. With X-Server-Ms present this is exact: the backend's own
   * variability (per-request sleeps, chaos, padding) lands in baselineMs and
   * never in overheadMs. Without it (gateway-generated rejection, or a real SUT
   * with no header) we fall back to the class baseline as the backend estimate.
   */
  private overheadFor(cls: ScenarioClass, latencyMs: number, serverMs: number | null): { baselineMs: number; overheadMs: number } {
    const backendMs = Math.max(0, serverMs ?? this.baselineFor(cls));
    const baselineMs = serverMs === null ? backendMs : backendMs + this.baselineFor(cls);
    return { baselineMs, overheadMs: Math.max(0, latencyMs - baselineMs) };
  }

  start(runId: string): { ok: true; runId: string } {
    if (this.state === "running") return { ok: true, runId: this.runId ?? runId };
    // a stop() still draining is superseded by the new run
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }

    this.state = "running";
    this.runId = runId;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.bucket = new TokenBucket();
    this.counters = { sent: 0, ok: 0, errors: 0, timeouts: 0, invalidSent: 0, invalidRejected: 0 };
    this.errLogBudget = 30;
    this.ingestAttempts = 0;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();
    console.log(`[driver] run ${runId} started, mode=${this.profile.mode}, target=${this.gw.rest.baseUrl}`);
    return { ok: true, runId };
  }

  stop(): { stopped: true; runId: string | null } {
    const runId = this.runId;
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
      console.log(`[driver] run ${runId} stopped, sent=${this.counters.sent} ok=${this.counters.ok} errors=${this.counters.errors}`);
      // hand whatever we collected to the store rather than dropping it
      void this.flush();
    };
    this.drainTimer = setTimeout(drain, DRAIN_POLL_MS);
    this.drainTimer.unref?.();
    return { stopped: true, runId };
  }

  private tick(): void {
    if (this.state !== "running" || this.startedAt === null) return;
    const { due, targetRps } = this.bucket.tick(Date.now(), this.profile, this.startedAt);
    this.targetRps = targetRps;
    const cap = Math.min(due, Math.max(0, this.profile.maxConcurrency - this.inFlight));
    for (let i = 0; i < cap; i++) {
      void this.fire();
    }
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
    const target = spec.protocol === "soap" ? this.gw.soap : this.gw.rest;
    const url = this.buildUrl(target, spec.path);
    const started = Date.now();
    const ac = new AbortController();
    const budgetMs =
      spec.class === "slow-upstream" || spec.class === "big-response" || spec.class === "big-request" ? 60_000 : 15_000;
    const timeout = setTimeout(() => ac.abort(), budgetMs);
    let status = 0;
    let bytesResp = 0;
    let error: string | null = null;
    /** SUT's own time for this request; null when the response never touched the
     *  SUT (gateway's own rejection) or a real gateway stripped the header. */
    let serverMs: number | null = null;

    try {
      const headers: Record<string, string> = { ...spec.headers };
      const creds = readBasicAuthCreds();
      if (creds) headers["authorization"] = `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
      if (target.apiKey) headers[target.apiKeyHeader || "X-API-Key"] = target.apiKey;
      const res = await fetch(url, {
        method: spec.method,
        headers,
        body: spec.body,
        signal: ac.signal
      });
      status = res.status;
      serverMs = parseServerMs(res.headers.get(SERVER_MS_HEADER));
      const buf = await res.arrayBuffer();
      bytesResp = buf.byteLength;

      if (spec.captureId && status >= 200 && status < 300 && buf.byteLength < 1_000_000) {
        try {
          const parsed = JSON.parse(Buffer.from(buf).toString("utf-8")) as { id?: unknown };
          if (typeof parsed.id === "number" && Number.isSafeInteger(parsed.id)) this.trackCreatedId(parsed.id);
        } catch { /* padded or proxied into something unparsable — ignore */ }
      }
      if (spec.expectInvalid && status >= 400 && status < 500) this.counters.invalidRejected++;

      if (status < 500) this.counters.ok++;
      else this.counters.errors++;
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError" || ac.signal.aborted) {
        error = "timeout/abort";
        this.counters.timeouts++;
      } else {
        error = err.message;
        this.counters.errors++;
      }
      if (this.errLogBudget > 0) {
        this.errLogBudget--;
        console.error(`[driver] request failed: ${spec.method} ${url} -> ${error}`);
      }
    } finally {
      clearTimeout(timeout);
      this.inFlight--;
    }

    const finished = Date.now();
    const latencyMs = finished - started;
    const { baselineMs, overheadMs } = this.overheadFor(spec.class, latencyMs, serverMs);

    this.record({
      runId,
      ts: started,
      protocol: spec.protocol,
      endpoint: spec.endpoint,
      class: spec.class,
      method: spec.method,
      status,
      latencyMs,
      baselineMs,
      overheadMs,
      bytesReq: Buffer.byteLength(spec.body ?? ""),
      bytesResp,
      error
    });
  }

  private buildUrl(target: GwConfig, path: string): string {
    const base = target.baseUrl.replace(/\/+$/, "");
    const prefix = target.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return `${base}${prefix ? "/" + prefix : ""}${path}`;
  }

  private record(r: RequestResult): void {
    if (this.spool.length >= MAX_SPOOL) {
      // drop the oldest decile in one splice rather than shifting per insert
      this.spool.splice(0, Math.ceil(MAX_SPOOL / 10));
    }
    this.spool.push(r);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.spool.length === 0) return;
    if (!this.ingestFn) return; // metrics module not wired yet
    this.flushing = true;
    const chunk = this.spool.splice(0, this.spool.length);
    const batch: IngestBatch = { batchId: randomUUID(), results: chunk };
    try {
      await this.ingestFn(batch);
      this.ingestAttempts = 0;
    } catch (e) {
      this.ingestAttempts++;
      if (this.ingestAttempts >= MAX_INGEST_ATTEMPTS) {
        // never let one poison batch wedge the pipeline forever
        console.error(
          `[driver] dropping ${chunk.length} results after ${this.ingestAttempts} failed ingest attempts:`,
          (e as Error).message
        );
        this.ingestAttempts = 0;
      } else {
        // put them back at the front, newest data still wins if we overflow
        this.spool = chunk.concat(this.spool);
        if (this.spool.length > MAX_SPOOL) this.spool = this.spool.slice(this.spool.length - MAX_SPOOL);
      }
    } finally {
      this.flushing = false;
    }
  }

  status(): RunStatus {
    return {
      state: this.state,
      runId: this.runId,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
      profile: { ...this.profile },
      // reported from the last scheduler tick: reading status must never
      // advance the mode=real drift model
      targetRps: this.state === "running" ? this.targetRps : 0,
      counters: { ...this.counters }
    };
  }

  async shutdown(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.baselineTimer) clearInterval(this.baselineTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.tickTimer = this.flushTimer = this.baselineTimer = null;
    this.drainTimer = null;
    this.state = "idle";
    await this.flush();
  }
}
