import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AggregateBatch,
  EdgeTables,
  GwTargets,
  LoadProfile,
  WorkerHealthCell
} from "@apigw/shared";
import { edgeTableMismatch, HEALTH_WINDOW_MS } from "@apigw/shared";

/** How many health windows to keep in case a cell and its residuals are split
 *  across batches. Thirty windows is a minute — far longer than any observed
 *  skew, and still only a few hundred bytes. */
const HEALTH_MEMORY_WINDOWS = 30;
import { expectedAuthHeader } from "../auth.js";
import { filterHealthyResiduals, stampHealthWindows, windowHealth, workerWindowHealth } from "./health.js";

/**
 * Control-plane client for the Go loadgen worker.
 *
 * The Bun side owns the process: it spawns the worker, answers its lifecycle
 * (configure/start/stop) over line-delimited JSON on the child's stdio, and
 * accepts NDJSON result batches on a loopback TCP listener whose address the
 * worker reads from RESULTS_ADDR.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/go, relative to packages/app/src/loadgen. */
const GO_DIR = resolve(HERE, "../../../go");

/** Absolute path of the built worker binary for the current platform, or null. */
export function workerBinaryPath(): string | null {
  const name = process.platform === "win32" ? "gwtester-worker.exe" : "gwtester-worker";
  const p = join(GO_DIR, "bin", name);
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
  /** load never issued (concurrency ceiling) */
  dropped: number;
  /** measurements discarded after the request was served */
  resultsLost: number;
}

interface OutMsg {
  op: "ready" | "status" | "stopped";
  [k: string]: unknown;
}

export interface GoClientEvents {
  onBatch: (batch: AggregateBatch) => void | Promise<unknown>;
  onStatus: (s: GoStatusMsg) => void;
  onStopped: (runId: string) => void;
}

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
  /** cleared if the worker's declared bucket tables do not match this build's */
  private bucketsOk = true;
  /** recent per-window health reports from the worker; see rememberHealth */
  private health = new Map<number, WorkerHealthCell>();
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
    if (bin === null) throw new Error(`gwtester-worker binary not found under ${join(GO_DIR, "bin")}`);

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
        case "stopped":
          this.events.onStopped(msg.runId as string);
          break;
        case "ready":
          this.checkBucketTables(msg["buckets"]);
          break;
      }
    }
  }

  /**
   * Refuse a worker whose histogram bucket tables differ from ours.
   *
   * The worker rolls its own results up, which means it has its own copy of the
   * latency, residual and status edge tables. Those arrays ARE the on-disk
   * layout and merge positionally, so a drift between the two implementations
   * does not fail — it quietly mixes two different histograms into one column
   * and answers every percentile wrong for as long as the database lives. That
   * is worth one comparison at handshake.
   */
  private checkBucketTables(declared: unknown): void {
    const mismatch = edgeTableMismatch(declared as Partial<EdgeTables> | undefined);
    if (mismatch === null) return;
    console.error(
      `[driver:go] worker bucket tables disagree with this build (${mismatch}); ` +
      "refusing its results — rebuild the worker from this commit"
    );
    this.bucketsOk = false;
  }

  private onSocketData(chunk: Buffer): void {
    this.socketBuf += chunk.toString("utf-8");
    for (;;) {
      const nl = this.socketBuf.indexOf("\n");
      if (nl < 0) return;
      const line = this.socketBuf.slice(0, nl);
      this.socketBuf = this.socketBuf.slice(nl + 1);
      if (line.trim() === "") continue;
      let batch: AggregateBatch;
      try {
        batch = JSON.parse(line) as AggregateBatch;
      } catch (e) {
        console.error("[driver:go] dropping malformed batch:", (e as Error).message);
        continue;
      }
      this.stampAndDeliver(batch);
    }
  }

  /** Flush any partial line (on shutdown) and deliver complete batches. */
  flushSocketTail(): void {
    if (this.socketBuf.trim() === "") {
      this.socketBuf = "";
      return;
    }
    try {
      const batch = JSON.parse(this.socketBuf) as AggregateBatch;
      this.stampAndDeliver(batch);
    } catch { /* partial line: the worker would only send one mid-shutdown */ }
    this.socketBuf = "";
  }

  /**
   * Qualify the batch's residuals, then hand it on.
   *
   * The verdict comes from whichever process held the clock. The worker reports
   * its own scheduling health per window and ships those cells alongside the
   * residuals they qualify, so that is what is used; the control plane's event
   * loop times nothing here and its delay is not evidence about these numbers.
   * A worker too old to report health omits the key entirely, and the old
   * control-plane gate applies — refusing to guess, in the same spirit as the
   * bucket-table check above.
   *
   * Both arms of the comparison go through one filter. Withholding contaminated
   * residuals from the gateway arm while keeping them in the direct arm would
   * shift the reference distribution and understate the gateway by exactly the
   * generator's own stalls. The raw tail is stamped rather than dropped: those
   * rows still describe requests the gateway really served, and only their
   * residual is in doubt.
   */
  private stampAndDeliver(batch: AggregateBatch): void {
    if (!this.bucketsOk) return;
    const health = Array.isArray(batch.health)
      ? workerWindowHealth(this.rememberHealth(batch.health))
      : windowHealth(this.healthCheck);
    if (Array.isArray(batch.tail)) stampHealthWindows(batch.tail, health);
    if (Array.isArray(batch.residuals)) {
      batch.residuals = filterHealthyResiduals(batch.residuals, health);
    }
    try {
      void this.events.onBatch(batch);
    } catch (e) {
      console.error("[driver:go] ingest failed:", (e as Error).message);
    }
  }

  /**
   * Fold the batch's health cells into a short-lived window and return the set
   * a verdict may be drawn from.
   *
   * The worker releases a window's residual cells and its health cell on the
   * same rule, so they normally arrive together. This exists for the case where
   * they do not: the two drains read the clock at slightly different instants,
   * and a socket write can be split across batches. Holding a minute of cells
   * costs a few hundred bytes and removes a class of silent residual loss where
   * the evidence arrived one batch after the thing it qualifies.
   */
  private rememberHealth(cells: WorkerHealthCell[]): WorkerHealthCell[] {
    for (const c of cells) {
      if (typeof c?.windowTs === "number") this.health.set(c.windowTs, c);
    }
    if (this.health.size > HEALTH_MEMORY_WINDOWS) {
      const cutoff = Math.max(...this.health.keys()) - HEALTH_MEMORY_WINDOWS * HEALTH_WINDOW_MS;
      for (const w of this.health.keys()) if (w < cutoff) this.health.delete(w);
    }
    return [...this.health.values()];
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
