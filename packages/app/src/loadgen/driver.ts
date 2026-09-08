import { randomUUID } from "node:crypto";
import type {
  GwConfig,
  IngestBatch,
  LoadProfile,
  RequestResult,
  RunState,
  RunStatus,
  ScenarioClass
} from "@apigw/shared";
import { DEFAULT_GW_CONFIG as defaultGw, DEFAULT_LOAD_PROFILE as defaultProfile } from "@apigw/shared";
import { TokenBucket, targetRpsAt } from "./scheduler.js";
import { buildSpec, buildBaselineProbe, type ReqSpec } from "./scenarios.js";
import { readBasicAuthCreds } from "../auth.js";

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
const MAX_SPOOL = 50_000;

export type IngestFn = (batch: IngestBatch) => { ingested: number } | Promise<{ ingested: number }>;

/**
 * In-process load driver. One Driver per app: scheduler, scenario emitters,
 * direct-to-SUT baseline probes (for GW-overhead math), and batched ingest.
 */
export class Driver {
  private gw: GwConfig = { ...defaultGw };
  private profile: LoadProfile = { ...defaultProfile };
  private state: RunState = "idle";
  private runId: string | null = null;
  private startedAt: number | null = null;

  private bucket = new TokenBucket();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private baselineTimer: ReturnType<typeof setInterval> | null = null;

  private inFlight = 0;
  private seedId = 120; // best-effort guess for the petstore's id space
  private counters = { sent: 0, ok: 0, errors: 0, timeouts: 0 };
  private spool: RequestResult[] = [];
  private targetRps = 0;
  private errLogBudget = 30; // log first N request errors per run

  // baseline endpoint: which :8080 to hit directly for class-level baselines (defaults to same-app)
  private baselineUrl = "http://127.0.0.1:8080";
  // per-class baselines from direct calls — used to compute GW overhead per request
  private baselines = new Map<ScenarioClass, number[]>();

  private ingestFn: IngestFn | null = null;

  /** Redirect baseline probing (useful in tests and custom setups). */
  setBaselineUrl(url: string): void { this.baselineUrl = url.replace(/\/+$/, ""); }

  get currentGw(): GwConfig { return { ...this.gw }; }
  get currentProfile(): LoadProfile { return { ...this.profile }; }

  setGw(gw: Partial<GwConfig>): void {
    this.gw = { ...this.gw, ...gw };
  }

  setProfile(profile: Partial<LoadProfile>): void {
    this.profile = { ...this.profile, ...profile };
  }

  /** Wire the ingest function (in-process, called from the metrics module). */
  setIngest(fn: IngestFn): void {
    this.ingestFn = fn;
  }

  async init(): Promise<void> {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
    this.baselineTimer = setInterval(() => void this.probeBaselines(), BASELINE_PROBE_MS);
    this.baselineTimer.unref?.();
  }

  /** Hit the SUT directly (no GW) to establish per-class baseline latencies. */
  private async probeBaselines(): Promise<void> {
    const specs = buildBaselineProbe(this.seedId);
    for (const spec of specs) {
      const lat = await this.timeDirect(spec);
      if (lat !== null) {
        let arr = this.baselines.get(spec.class);
        if (!arr) this.baselines.set(spec.class, (arr = []));
        arr.push(lat);
        if (arr.length > BASELINE_SAMPLES_PER_CLASS * 2) arr.shift();
      }
    }
  }

  private async timeDirect(spec: ReqSpec): Promise<number | null> {
    const url = `${this.baselineUrl}${spec.path}`;
    const t0 = Date.now();
    try {
      const headers: Record<string, string> = { ...spec.headers };
      const creds = readBasicAuthCreds();
      if (creds) headers["authorization"] = `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
      const res = await fetch(url, { method: spec.method, headers, body: spec.body });
      await res.arrayBuffer();
      return Date.now() - t0;
    } catch {
      return null;
    }
  }

  private baselineFor(cls: ScenarioClass): number {
    const arr = this.baselines.get(cls) ?? [];
    if (arr.length === 0) return 0; // until baseline measured, overhead is unknown → 0
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.5)] ?? sorted[0] ?? 0;
  }

  start(runId: string): { ok: true; runId: string } {
    if (this.state === "running") return { ok: true, runId: this.runId ?? runId };
    this.state = "running";
    this.runId = runId;
    this.startedAt = Date.now();
    this.bucket = new TokenBucket();
    this.counters = { sent: 0, ok: 0, errors: 0, timeouts: 0 };
    this.errLogBudget = 30;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    console.log(`[driver] run ${runId} started, mode=${this.profile.mode}, target=${this.gw.baseUrl}`);
    return { ok: true, runId };
  }

  stop(): { stopped: true; runId: string | null } {
    const runId = this.runId;
    this.state = "stopping";
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    const drain = () => {
      if (this.inFlight === 0 || Date.now() - (this.startedAt ?? 0) > 10_000) {
        this.state = "idle";
        this.runId = null;
        this.startedAt = null;
        this.spool.length = 0;
        console.log(`[driver] run ${runId} stopped, sent=${this.counters.sent} ok=${this.counters.ok} errors=${this.counters.errors}`);
      } else {
        setTimeout(drain, 500).unref();
      }
    };
    setTimeout(drain, 500).unref();
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

  private async fire(): Promise<void> {
    if (!this.runId || this.startedAt === null) return;
    const spec = buildSpec(this.profile, this.seedId);
    this.inFlight++;
    this.counters.sent++;

    const url = this.buildUrl(spec.path);
    const started = Date.now();
    const ac = new AbortController();
    const budgetMs =
      spec.class === "slow-upstream" || spec.class === "big-response" || spec.class === "big-request" ? 60_000 : 15_000;
    const timeout = setTimeout(() => ac.abort("timeout"), budgetMs);
    let status = 0;
    let bytesResp = 0;
    let error: string | null = null;

    try {
      const headers: Record<string, string> = { ...spec.headers };
      const creds = readBasicAuthCreds();
      if (creds) headers["authorization"] = `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
      if (this.gw.apiKey) headers[this.gw.apiKeyHeader || "X-API-Key"] = this.gw.apiKey;
      const res = await fetch(url, {
        method: spec.method,
        headers,
        body: spec.body,
        signal: ac.signal
      });
      status = res.status;
      const buf = await res.arrayBuffer();
      bytesResp = buf.byteLength;
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

    this.record({
      runId: this.runId,
      ts: started,
      protocol: spec.protocol,
      endpoint: spec.endpoint,
      class: spec.class,
      method: spec.method,
      status,
      latencyMs: Date.now() - started,
      baselineMs: this.baselineFor(spec.class),
      overheadMs: Math.max(0, Date.now() - started - this.baselineFor(spec.class)),
      bytesReq: Buffer.byteLength(spec.body ?? ""),
      bytesResp,
      error
    });
    void spec.expectBytes;
  }

  private buildUrl(path: string): string {
    const base = this.gw.baseUrl.replace(/\/+$/, "");
    const prefix = this.gw.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return `${base}${prefix ? "/" + prefix : ""}${path}`;
  }

  private record(r: RequestResult): void {
    if (this.spool.length >= MAX_SPOOL) this.spool.shift();
    this.spool.push(r);
  }

  private async flush(): Promise<void> {
    if (this.spool.length === 0) return;
    const chunk = this.spool.splice(0, this.spool.length);
    if (!this.ingestFn) return; // metrics module not wired yet; drop silently
    const batch: IngestBatch = { batchId: randomUUID(), results: chunk };
    try {
      await this.ingestFn(batch);
    } catch {
      if (this.spool.length + chunk.length > MAX_SPOOL) {
        const drop = this.spool.length + chunk.length - MAX_SPOOL;
        this.spool.splice(0, drop);
      }
      this.spool.push(...chunk);
      if (this.spool.length > MAX_SPOOL) this.spool = this.spool.slice(this.spool.length - MAX_SPOOL);
    }
  }

  status(): RunStatus {
    return {
      state: this.state,
      runId: this.runId,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
      profile: { ...this.profile },
      targetRps: this.state === "running" && this.startedAt
        ? targetRpsAt(this.profile, Date.now(), this.startedAt)
        : 0,
      counters: { ...this.counters }
    };
  }

  async shutdown(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
