import type {
  AggregateBatch,
  GwConfig,
  GwTargets,
  LoadProfile,
  RunStatus
} from "@apigw/shared";
import {
  DEFAULT_GW_TARGETS as defaultGwTargets,
  DEFAULT_LOAD_PROFILE as defaultProfile,
  sanitizeGwTargets,
  sanitizeLoadProfile
} from "@apigw/shared";
import { GoWorkerClient, workerBinaryPath, type GoClientEvents, type GoStatusMsg } from "./goClient.js";
import { expectedAuthHeader } from "../auth.js";
import { probeContext, type ProbeContext } from "./policy.js";

/**
 * Control plane for the load generator.
 *
 * This process no longer generates load. It owns configuration, the run
 * lifecycle, status and the policy probes; the Go worker (packages/go) owns
 * pacing, request construction, every clock and the roll-up, and streams
 * batches back over the results socket.
 *
 * There was a second, in-process generator here — a token-bucket scheduler, a
 * scenario emitter, a firing path and an aggregator, about 600 lines — selected
 * by LOADGEN_BACKEND=ts and silently fallen back to whenever the worker binary
 * was missing. It is gone. Two implementations of the same thing meant the
 * production one could be wrong without anyone noticing: `effectiveMaxConcurrency`
 * and `throttledSinceMs` were assigned only on the in-process path and reported
 * on both, so every worker-driven run showed the *default* concurrency ceiling
 * rather than the configured one, for as long as both existed. Both now come off
 * the worker's status message, which is the only place that knows them.
 *
 * What was kept from it: the scenario builders (packages/app/src/loadgen/
 * scenarios.ts), still the reference the Go port mirrors and still the fixture
 * generator for the petstore contract tests.
 */

/** Origin of a URL, or null when it will not parse. Used to decide whether a
 *  target is this very process (and may therefore see our own credential). */
function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * How long to wait for the worker's "stopped" ack before ending the run anyway.
 *
 * The worker's own stop is bounded — its request drain gets DrainTimeout — so an
 * ack that has not arrived by now is not late, it is not coming: a wedged flush,
 * a dead child, a lost line. Without this the run sits at "stopping" until the
 * process restarts, and the operator cannot start the next one.
 */
const GO_STOP_ACK_TIMEOUT_MS = 30_000;

export type IngestFn = (batch: AggregateBatch) => { ingested: number } | Promise<{ ingested: number }>;

export class Driver {
  private gw: GwTargets = { rest: { ...defaultGwTargets.rest }, soap: { ...defaultGwTargets.soap } };
  private profile: LoadProfile = { ...defaultProfile };
  private state: RunStatus["state"] = "idle";
  private runId: string | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  /** The Go worker owns pacing, so durationMinutes needs a watchdog here. */
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  /** backstop for a "stopped" ack the Go worker never sends */
  private goStopTimer: ReturnType<typeof setTimeout> | null = null;
  /** called when durationMinutes elapses, so the run can be closed out */
  private onDurationReached: ((runId: string | null) => void) | null = null;

  /** Why the load generator cannot run, or null. There is no second generator
   *  to fall back to, so this is refused rather than worked around. */
  private generatorError: string | null = null;
  /** Control-plane client for the Go worker; created lazily on first use. */
  private goClient: GoWorkerClient | null = null;
  /** last status broadcast from the worker (arrives ~every 10s while running) */
  private goLastStatus: GoStatusMsg | null = null;

  // Where the SUT answers with no gateway in front of it. No traffic is sent
  // here; it is what "which origin is us" means, for forwardBasicAuth: "auto".
  private sutUrl = "http://127.0.0.1:8080";

  private ingestFn: IngestFn | null = null;

  /** Tell the driver where the SUT is. Defines "us" for
   *  forwardBasicAuth: "auto", which the worker resolves per side. */
  setSutUrl(url: string): void {
    this.sutUrl = url.replace(/\/+$/, "");
    this.goClient?.configure(this.gw, this.profile, this.sutUrl);
  }

  get currentGw(): GwTargets {
    return { rest: { ...this.gw.rest }, soap: { ...this.gw.soap } };
  }
  get currentProfile(): LoadProfile { return { ...this.profile }; }

  setGw(gw: unknown): void {
    this.gw = sanitizeGwTargets(gw, this.gw);
    this.goClient?.configure(this.gw, this.profile, this.sutUrl);
  }

  setProfile(profile: Partial<LoadProfile>): void {
    this.profile = sanitizeLoadProfile({ ...this.profile, ...profile }, this.profile);
    this.goClient?.configure(this.gw, this.profile, this.sutUrl);
  }

  /** Where the worker binary is, or null. A method rather than a direct call so
   *  a test can stand in a missing binary without touching the filesystem —
   *  refusing the run when it is absent is behaviour worth covering. */
  protected workerBinary(): string | null {
    return workerBinaryPath();
  }

  /** Construct the worker client. The two seams on this class — this and
   *  workerBinary() — are what let a test drive the whole control plane without
   *  a child process; see TestDriver. */
  protected createClient(events: GoClientEvents): GoWorkerClient {
    return new GoWorkerClient(events);
  }

  /**
   * Lazily create the Go worker control client and wire its events into the
   * Driver surface: batches arrive already rolled up by the worker and land in
   * ingestFn.
   *
   * Returns null when the worker cannot be had, having recorded why. The caller
   * refuses the run: there is nothing else to hand the load to, and a rig that
   * changes instrument without saying so produces numbers that look identical
   * and mean something else.
   */
  private go(): GoWorkerClient | null {
    if (this.workerBinary() === null) {
      // cleared on the next attempt: an operator who builds the binary and
      // presses start again should not have to restart the process
      this.generatorError =
        "the load generator binary is missing (packages/go/bin/gwtester-worker) — " +
        "build it with `go build -o bin/gwtester-worker ./cmd/gwtester-worker` in packages/go";
      return null;
    }
    if (!this.goClient) {
      const client = this.createClient({
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
      void client.ensureStarted().catch((e) => this.generatorFailed(e as Error));
      client.configure(this.gw, this.profile, this.sutUrl);
      this.goClient = client;
    }
    return this.goClient;
  }

  /**
   * The worker could not be spawned, or died on the way up.
   *
   * Spawning is async, so this can land after start() has already answered the
   * API. End the run here: a dashboard showing "running" against a generator
   * that does not exist is the one outcome worse than refusing up front.
   */
  private generatorFailed(e: Error): void {
    this.generatorError = `the load generator failed to start: ${e.message}`;
    console.error(`[driver] ${this.generatorError}`);
    this.goClient = null;
    if (this.goStopTimer) { clearTimeout(this.goStopTimer); this.goStopTimer = null; }
    if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null; }
    if (this.state !== "idle") {
      this.state = "idle";
      this.runId = null;
      this.startedAt = null;
      this.stoppedAt = null;
    }
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

  /** Bring the worker up ahead of the first run, so a missing binary is on the
   *  log at boot rather than at the moment somebody presses start. */
  async init(): Promise<void> {
    if (this.go() === null) console.error(`[driver] ${this.generatorError}`);
  }

  start(runId: string): { ok: true; runId: string } | { ok: false; error: string } {
    this.generatorError = null;   // a rebuilt binary must be picked up here
    const goClient = this.go();
    if (goClient === null) return { ok: false, error: this.generatorError ?? "the load generator is unavailable" };
    if (this.state === "running") return { ok: true, runId: this.runId ?? runId };
    // a stop still waiting on its ack is superseded by this run
    if (this.goStopTimer) { clearTimeout(this.goStopTimer); this.goStopTimer = null; }
    void goClient.ensureStarted().then(() => {
      goClient.configure(this.gw, this.profile, this.sutUrl);
      goClient.start(runId);
    }).catch((e) => this.generatorFailed(e as Error));
    this.state = "running";
    this.runId = runId;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.goLastStatus = null;

    // The worker owns pacing, but durationMinutes still has to end the run:
    // enforce it here with a watchdog. A bounded run used to run forever.
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

    // An operator who sets "always" against an external gateway is choosing to
    // hand it the dashboard credential. Say so once per run rather than doing
    // it silently.
    for (const side of ["rest", "soap"] as const) {
      if (this.sendsOurCredential(this.gw[side]) && originOf(this.gw[side].baseUrl) !== originOf(this.sutUrl)) {
        console.warn(
          `[driver] forwarding this rig's Basic credential to the external ${side.toUpperCase()} target` +
          ` ${this.gw[side].baseUrl} (forwardBasicAuth="${this.gw[side].forwardBasicAuth}")`
        );
      }
    }
    console.log(`[driver] run ${runId} started, mode=${this.profile.mode}, target=${this.gw.rest.baseUrl}`);
    return { ok: true, runId };
  }

  stop(): { stopped: true; runId: string | null } {
    const runId = this.runId;
    if (this.state === "idle" || !this.goClient) return { stopped: true, runId: this.state === "idle" ? null : runId };
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

  /**
   * Whether this target gets our `Authorization: Basic …`.
   *
   * "auto" — the default — forwards only to our own origin, i.e. the bundled
   * petstore, which requires the header to answer at all. A real gateway is by
   * definition a different origin and gets nothing: that stops the dashboard
   * credential from being written into a third party's logs and stops a header
   * the gateway did not ask for from confusing its own auth.
   *
   * The worker applies the same rule to the load it issues (config.SendsBasicAuth
   * in packages/go); this copy decides it for the policy probes, which fire from
   * this process. The two must agree or a probe describes a path the traffic
   * does not take.
   */
  private sendsOurCredential(target: GwConfig): boolean {
    switch (target.forwardBasicAuth) {
      case "always": return true;
      case "never": return false;
      default: return this.isSelf(target);
    }
  }

  status(): RunStatus {
    // The worker owns every counter, so they are read from its last status
    // message even once the run is idle: it emits a final tally after draining,
    // and falling back to an empty local set the moment a run ended reported
    // every finished run as zero traffic.
    const s = this.goLastStatus;
    return {
      state: this.state,
      runId: this.runId,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
      profile: { ...this.profile },
      targetRps: this.state === "running" ? s?.targetRps ?? 0 : 0,
      // the ceiling the worker actually applied, not the one we would have
      // computed: only it knows what the clamp did to the configured number
      effectiveMaxConcurrency: s?.effectiveMaxConcurrency || this.profile.maxConcurrency,
      throttledSinceMs: this.state === "running" && s?.throttledSinceMs ? s.throttledSinceMs : null,
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
      targetIsSelf: { rest: this.isSelf(this.gw.rest), soap: this.isSelf(this.gw.soap) },
      generatorError: this.generatorError
    };
  }

  /**
   * Probe context for the gateway policy checks: same targets, same URL
   * building and the same credential rule the worker applies to the load, so a
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
    const self = originOf(this.sutUrl);
    const theirs = originOf(target.baseUrl);
    return self !== null && theirs !== null && self === theirs;
  }

  async shutdown(): Promise<void> {
    if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null; }
    if (this.goStopTimer) { clearTimeout(this.goStopTimer); this.goStopTimer = null; }
    this.state = "idle";
    this.runId = null;
    if (!this.goClient) return;
    const client = this.goClient;
    this.goClient = null;
    await client.shutdown();
  }
}
