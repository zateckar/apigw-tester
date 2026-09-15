import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GwTargets,
  IngestBatch,
  LoadProfile,
  RequestResult,
  ScenarioClass
} from "@apigw/shared";
import { expectedAuthHeader } from "../auth.js";

/**
 * Control-plane client for the Go loadgen worker.
 *
 * The Bun side owns the process: it spawns the worker, answers its lifecycle
 * (configure/start/stop) over line-delimited JSON on the child's stdio, and
 * accepts NDJSON result batches on a loopback TCP listener whose address the
 * worker reads from RESULTS_ADDR.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/worker, relative to packages/app/src/loadgen. */
const WORKER_DIR = resolve(HERE, "../../../worker");

/** Absolute path of the built worker binary for the current platform, or null. */
export function workerBinaryPath(): string | null {
  const name = process.platform === "win32" ? "gwtester-worker.exe" : "gwtester-worker";
  const p = join(WORKER_DIR, "bin", name);
  return existsSync(p) ? p : null;
}

export interface GoStatusMsg {
  runId: string;
  sent: number;
  ok: number;
  r4xx: number;
  errors: number;
  gwFaults: number;
  rateLimited: number;
  unauthorized: number;
  invalidSent: number;
  invalidLeaked: number;
  invalidRejectedByGateway: number;
  inFlight: number;
  targetRps: number;
  dropped: number;
}

export interface GoBaselineMsg {
  at: Record<string, number>;
  byClass: Record<string, number[]>;
}

interface OutMsg {
  op: "ready" | "status" | "baseline" | "stopped";
  [k: string]: unknown;
}

export interface GoClientEvents {
  onBatch: (batch: IngestBatch) => void | Promise<unknown>;
  onStatus: (s: GoStatusMsg) => void;
  onBaseline: (b: GoBaselineMsg) => void;
  onStopped: (runId: string) => void;
}

const HEALTH_SAMPLE_MS = 2_000;

/**
 * GoWorkerClient spawns and owns one worker child process plus the results
 * listener. All channels are line-delimited; the results listener accepts a
 * single connection (the worker redials on failure and drops nothing).
 */
export class GoWorkerClient {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private port = 0;
  private stdoutBuf = "";
  private socketBuf = "";
  private healthCheck: (from: number, to: number) => string | null = () => "health unavailable";
  private starting: Promise<void> | null = null;

  constructor(private events: GoClientEvents) {}

  setHealthCheck(check: (from: number, to: number) => string | null): void {
    this.healthCheck = check;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Spawn the worker and open the results listener. Idempotent. */
  async ensureStarted(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.spawn();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async spawn(): Promise<void> {
    const bin = workerBinaryPath();
    if (bin === null) throw new Error(`gwtester-worker binary not found under ${join(WORKER_DIR, "bin")}`);

    this.server = createServer((sock) => {
      sock.setNoDelay(true);
      this.socket = sock;
      sock.on("data", (chunk: Buffer) => this.onSocketData(chunk));
      sock.on("close", () => { if (this.socket === sock) this.socket = null; });
      sock.on("error", () => { /* worker redials; surfacing here is noise */ });
    });
    await new Promise<void>((res, rej) => {
      this.server!.once("error", rej);
      this.server!.listen(0, "127.0.0.1", () => res());
    });
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") throw new Error("listener has no port");
    this.port = addr.port;

    const child = spawn(bin, [], {
      env: { ...process.env, RESULTS_ADDR: `127.0.0.1:${this.port}` },
      stdio: ["pipe", "pipe", "inherit"]
    });
    this.child = child;
    child.on("exit", (code, signal) => {
      console.warn(`[driver:go] worker exited (code=${code} signal=${signal})`);
      this.child = null;
    });
    child.stdout.on("data", (chunk: Buffer | string) => this.onStdoutData(chunk));
  }

  private onStdoutData(chunk: Buffer | string): void {
    this.stdoutBuf += chunk.toString("utf-8");
    for (;;) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl < 0) return;
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim() === "") continue;
      let msg: OutMsg;
      try {
        msg = JSON.parse(line) as OutMsg;
      } catch {
        continue;
      }
      switch (msg.op) {
        case "status":
          this.events.onStatus(msg as unknown as GoStatusMsg);
          break;
        case "baseline":
          this.events.onBaseline({ at: msg.at as Record<string, number>, byClass: msg.byClass as Record<string, number[]> });
          break;
        case "stopped":
          this.events.onStopped(msg.runId as string);
          break;
        case "ready":
          break;
      }
    }
  }

  private onSocketData(chunk: Buffer): void {
    this.socketBuf += chunk.toString("utf-8");
    for (;;) {
      const nl = this.socketBuf.indexOf("\n");
      if (nl < 0) return;
      const line = this.socketBuf.slice(0, nl);
      this.socketBuf = this.socketBuf.slice(nl + 1);
      if (line.trim() === "") continue;
      let batch: IngestBatch;
      try {
        batch = JSON.parse(line) as IngestBatch;
      } catch (e) {
        console.error("[driver:go] dropping malformed batch:", (e as Error).message);
        continue;
      }
      this.stampAndDeliver(batch);
    }
  }

  /**
   * Health-stamp a batch exactly as the TS flush loop did: group results by
   * the sampler's 2s window, one healthCheck per distinct window, results
   * with an exclusion reason of their own (worker sets only "request
   * failed") keep it.
   */
  stampBatch(results: RequestResult[]): void {
    const byWindow = new Map<number, string | null>();
    for (const r of results) {
      if (r.overheadReason !== null && r.overheadReason !== undefined) continue;
      const w = Math.floor(r.ts / HEALTH_SAMPLE_MS);
      let reason = byWindow.get(w);
      if (reason === undefined) {
        reason = this.healthCheck(w * HEALTH_SAMPLE_MS, (w + 1) * HEALTH_SAMPLE_MS);
        byWindow.set(w, reason);
      }
      if (reason !== null) r.overheadReason = reason;
    }
  }

  /** Flush any partial line (on shutdown) and deliver complete batches. */
  flushSocketTail(): void {
    if (this.socketBuf.trim() === "") {
      this.socketBuf = "";
      return;
    }
    try {
      const batch = JSON.parse(this.socketBuf) as IngestBatch;
      this.stampAndDeliver(batch);
    } catch { /* partial line: the worker would only send one mid-shutdown */ }
    this.socketBuf = "";
  }

  private stampAndDeliver(batch: IngestBatch): void {
    if (Array.isArray(batch.results)) this.stampBatch(batch.results);
    try {
      void this.events.onBatch(batch);
    } catch (e) {
      console.error("[driver:go] ingest failed:", (e as Error).message);
    }
  }

  /** Send one control message to the worker. No-op when not running. */
  private send(obj: Record<string, unknown>): void {
    const c = this.child;
    if (!c || c.killed) return;
    c.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Push the configure op; safe before start (the worker applies on next start). */
  configure(gw: GwTargets, profile: LoadProfile, baselineUrl: string): void {
    const raw = expectedAuthHeader();
    let basicAuth = "";
    if (raw) {
      const v = raw.toString("utf-8");
      if (v.startsWith("Basic ")) basicAuth = v.slice(6);
    }
    const selfOrigin = originOf(baselineUrl) ?? baselineUrl;
    this.send({
      op: "configure",
      gw: { rest: gw.rest, soap: gw.soap },
      profile,
      baselineUrl,
      selfOrigin,
      basicAuth
    });
  }

  start(runId: string): void {
    this.send({ op: "start", runId });
  }

  stop(): void {
    this.send({ op: "stop" });
  }

  /** Stop the child and close the listener. Waits for the child to exit. */
  async shutdown(): Promise<void> {
    const child = this.child;
    if (child) {
      this.stop();
      try {
        child.stdin.end();
      } catch { /* already gone */ }
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* gone */ }
          res();
        }, 6_000);
        t.unref?.();
        child.once("exit", () => { clearTimeout(t); res(); });
      });
      this.child = null;
    }
    this.flushSocketTail();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((res) => srv.close(() => res()));
    }
  }
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

/** Re-export for the driver: classes keyed map from a baseline op. */
export function classesOf(b: GoBaselineMsg): ScenarioClass[] {
  return Object.keys(b.byClass) as ScenarioClass[];
}
