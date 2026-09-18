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
  LoadProfile
} from "@apigw/shared";
import { edgeTableMismatch } from "@apigw/shared";
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
  /** the ceiling this run applies: the operator's number clamped by
   *  LIMITS.maxConcurrency. Only the worker knows it — the control plane used
   *  to report its own default here, so a configured 500 read as 25. */
  effectiveMaxConcurrency: number;
  /** epoch ms since the ceiling started continuously refusing load, 0 if not */
  throttledSinceMs: number;
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
  /** cleared if the worker's declared bucket tables do not match this build's */
  private bucketsOk = true;
  private starting: Promise<void> | null = null;

  constructor(private events: GoClientEvents) {}

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
      this.deliver(batch);
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
      this.deliver(batch);
    } catch { /* partial line: the worker would only send one mid-shutdown */ }
    this.socketBuf = "";
  }

  /**
   * Hand a batch on, unless the worker's bucket tables disagree with ours.
   *
   * Batches used to be filtered here: the worker's per-window health report was
   * turned into a verdict and any window it condemned had its measurements
   * dropped before the store ever saw them. That is gone. It silently deleted
   * evidence the operator could not ask for back — and on the very batches most
   * worth looking at, since a stalled window is where the interesting tail
   * lives. The generator's health is still reported; it belongs in the run's
   * validity verdict, where it is visible, not in a filter nobody can see.
   *
   * The bucket-table check stays, because that one is not a judgement call: a
   * worker whose histogram edges differ writes numbers that are wrong rather
   * than uncertain, and no downstream reader could tell.
   */
  private deliver(batch: AggregateBatch): void {
    if (!this.bucketsOk) return;
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

  /** Push the configure op; safe before start (the worker applies on next start).
   *
   *  `sutUrl` is where the SUT answers with no gateway in front of it. The
   *  worker no longer sends traffic there — it is passed so the worker knows
   *  which origin is us, which is what `forwardBasicAuth: "auto"` turns on. */
  configure(gw: GwTargets, profile: LoadProfile, sutUrl: string): void {
    const raw = expectedAuthHeader();
    let basicAuth = "";
    if (raw) {
      const v = raw.toString("utf-8");
      if (v.startsWith("Basic ")) basicAuth = v.slice(6);
    }
    const selfOrigin = originOf(sutUrl) ?? sutUrl;
    this.send({
      op: "configure",
      gw: { rest: gw.rest, soap: gw.soap },
      profile,
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
