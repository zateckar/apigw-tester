import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Supervisor for the Go petstore process — the system under test.
 *
 * The SUT used to be a route table inside this process. That made the control
 * plane's event loop a term in every measurement it recorded: at 5k rps its max
 * loop delay ran past the 10ms validity limit often enough to disqualify most
 * health windows, and the rig spent its time reporting that it could not vouch
 * for its own numbers.
 *
 * Splitting it out is what makes "the backend was busy" and "the recorder was
 * busy" different sentences. Everything here exists to keep that separation
 * honest: a separate binary, its own port, its own scheduler, and a parent that
 * only talks to it over a port number read from one line of stdout.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/go — the compiled side of the rig — relative to packages/app/src/sut. */
const GO_DIR = resolve(HERE, "../../../go");

/** How long to wait for the child's ready line before giving up on it. */
const READY_TIMEOUT_MS = 10_000;

/** Backoff before re-spawning a SUT that exited on its own. */
const RESTART_DELAY_MS = 500;

/** Absolute path of the built SUT binary for the current platform, or null. */
export function sutBinaryPath(): string | null {
  const name = process.platform === "win32" ? "gwtester-sut.exe" : "gwtester-sut";
  const p = join(GO_DIR, "bin", name);
  return existsSync(p) ? p : null;
}

interface ReadyMsg {
  op?: string;
  port?: number;
  pid?: number;
}

export class GoSutProcess {
  private child: ChildProcessByStdio<null, Readable, null> | null = null;
  private stdoutBuf = "";
  /** the port the child actually bound, which is what callers must use */
  private boundPort = 0;
  /** the port we asked for; 0 means "any free port", which is not restartable */
  private requestedPort = 0;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get port(): number {
    return this.boundPort;
  }

  /**
   * Spawn the SUT and resolve once it reports the port it bound.
   *
   * Resolving on the child's own ready line rather than on spawn() is what makes
   * the caller's first request safe: a race here would be recorded as gateway
   * connection failures on the first seconds of every run.
   */
  async start(port: number): Promise<number> {
    if (this.child) return this.boundPort;
    this.requestedPort = port;
    this.stopping = false;
    return await this.spawnOnce(port);
  }

  private async spawnOnce(port: number): Promise<number> {
    const bin = sutBinaryPath();
    if (bin === null) throw new Error(`gwtester-sut binary not found under ${join(GO_DIR, "bin")}`);

    const child = spawn(bin, [], {
      env: { ...process.env, SUT_PORT: String(port) },
      stdio: ["ignore", "pipe", "inherit"]
    });
    this.child = child;
    this.stdoutBuf = "";

    const ready = new Promise<number>((res, rej) => {
      const timer = setTimeout(() => {
        rej(new Error(`gwtester-sut did not report ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();

      const onData = (chunk: Buffer | string): void => {
        this.stdoutBuf += chunk.toString("utf-8");
        for (;;) {
          const nl = this.stdoutBuf.indexOf("\n");
          if (nl < 0) return;
          const line = this.stdoutBuf.slice(0, nl).trim();
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          if (line === "") continue;
          let msg: ReadyMsg;
          try {
            msg = JSON.parse(line) as ReadyMsg;
          } catch {
            // the child logs to stderr, so anything unparseable on stdout is a
            // protocol violation worth seeing rather than swallowing
            console.warn(`[sut] unparseable line on stdout: ${line.slice(0, 200)}`);
            continue;
          }
          if (msg.op === "ready" && typeof msg.port === "number") {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            res(msg.port);
            return;
          }
        }
      };
      child.stdout.on("data", onData);
      child.once("error", (e) => { clearTimeout(timer); rej(e); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        rej(new Error(`gwtester-sut exited during startup (code=${code})`));
      });
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      console.error(`[sut] petstore exited unexpectedly (code=${code} signal=${signal})`);
      this.scheduleRestart();
    });

    this.boundPort = await ready;
    return this.boundPort;
  }

  /**
   * Bring the SUT back after an unexpected exit.
   *
   * Only when the port was pinned: everything downstream — the configured
   * gateway target, the reference stream's base URL, a real gateway's own
   * upstream config — is holding a URL with that port in it, and coming back on
   * a different one would leave a rig that looks alive and measures nothing. An
   * ephemeral port is used only by tests, which own the lifecycle themselves.
   */
  private scheduleRestart(): void {
    if (this.requestedPort === 0 || this.restartTimer !== null) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.child) return;
      void this.spawnOnce(this.requestedPort)
        .then(() => console.warn("[sut] petstore restarted"))
        .catch((e: Error) => {
          console.error(`[sut] restart failed: ${e.message}`);
          this.scheduleRestart();
        });
    }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((res) => {
      const done = setTimeout(() => { child.kill("SIGKILL"); res(); }, 6_000);
      done.unref?.();
      child.once("exit", () => { clearTimeout(done); res(); });
      child.kill("SIGTERM");
    });
  }
}
