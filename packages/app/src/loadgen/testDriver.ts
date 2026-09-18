import { Driver } from "./driver.js";
import type { GoClientEvents, GoStatusMsg, GoWorkerClient } from "./goClient.js";

/**
 * A Driver that never spawns the Go worker.
 *
 * Most of the app's tests care about the control plane — run lifecycle, config
 * push, the API surface, the store — and not about generating traffic. A real
 * Driver costs a child process per test file, and in CI it would make every one
 * of those tests depend on a built binary.
 *
 * They used to get that by setting LOADGEN_BACKEND=ts, which selected a whole
 * second in-process load generator. That was a heavy price for a stub: two
 * implementations of scheduling, scenario building and outcome accounting had
 * to stay in step forever, and where they did not it was the production one
 * that went unnoticed — `effectiveMaxConcurrency` was reported from the unused
 * implementation on every real run. This file is what that was being used for.
 *
 * It stands in a running worker: start/stop/configure are accepted and
 * recorded, stop acks the way a real worker does, and `pushStatus` feeds the
 * status message a real worker would broadcast.
 */
export class TestDriver extends Driver {
  /** run ids the fake worker was asked to start, in order */
  readonly started: string[] = [];
  /** how many times it was asked to stop */
  stops = 0;
  /** how many times config was pushed to it */
  configures = 0;
  /** set to reject ensureStarted(), i.e. a worker that will not come up */
  spawnError: Error | null = null;

  /** the binary is "there" — this driver never looks at the filesystem */
  protected override workerBinary(): string | null {
    return "<test worker>";
  }

  protected override createClient(events: GoClientEvents): GoWorkerClient {
    const stub = {
      ensureStarted: async (): Promise<void> => {
        if (this.spawnError) throw this.spawnError;
      },
      configure: (): void => { this.configures++; },
      start: (runId: string): void => { this.started.push(runId); },
      stop: (): void => {
        this.stops++;
        const runId = this.started[this.started.length - 1] ?? "";
        // a real worker acks asynchronously after draining, and it is that ack
        // — not the stop call — that ends the run
        queueMicrotask(() => events.onStopped(runId));
      },
      shutdown: async (): Promise<void> => {}
    };
    return stub as unknown as GoWorkerClient;
  }

  /** Feed the status a real worker would broadcast, so counters and the
   *  concurrency ceiling can be asserted without generating traffic. */
  pushStatus(s: Partial<GoStatusMsg>): void {
    const full: GoStatusMsg = {
      runId: "", sent: 0, ok: 0, r4xx: 0, errors: 0, gwFaults: 0, rateLimited: 0,
      unauthorized: 0, invalidSent: 0, invalidLeaked: 0, invalidRejectedByGateway: 0,
      inFlight: 0, targetRps: 0, dropped: 0, resultsLost: 0,
      effectiveMaxConcurrency: 0, throttledSinceMs: 0,
      ...s
    };
    (this as unknown as { goLastStatus: GoStatusMsg }).goLastStatus = full;
  }
}
