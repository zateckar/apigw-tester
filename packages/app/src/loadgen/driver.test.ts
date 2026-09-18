import { describe, expect, it } from "bun:test";
import { LIMITS } from "@apigw/shared";
import { Driver } from "./driver.js";
import { TestDriver } from "./testDriver.js";

/**
 * The control plane, with no worker process.
 *
 * This file used to be ~800 lines exercising a second, in-process load
 * generator — scheduling, firing, outcome accounting, spooling. That generator
 * is gone; the Go worker is the only one, and its behaviour is asserted against
 * real traffic in driver.go.test.ts. What is left here is what this class
 * actually does now: refuse a run it cannot generate, hold the run lifecycle,
 * report what the worker tells it, and decide which targets see this rig's own
 * credential.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** reach into the driver's internals to simulate state */
const priv = (d: Driver) => d as unknown as Record<string, any>;

describe("no fallback generator", () => {
  it("refuses the run when the worker binary is missing, and says how to build it", () => {
    const d = new Driver();
    priv(d).workerBinary = () => null;

    const out = d.start("run-nobinary");
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain("gwtester-worker");
    expect((out as { error: string }).error).toContain("go build");
    // and nothing is generated: no run, no state change, no traffic
    expect(d.status().state).toBe("idle");
    expect(d.status().runId).toBeNull();
    expect(d.status().generatorError).toContain("missing");
  });

  it("retries the binary on the next start instead of latching the failure", async () => {
    // an operator who reads the message, builds the worker and presses start
    // again must not have to restart the process to be believed
    const d = new TestDriver();
    priv(d).workerBinary = () => null;
    expect(d.start("run-1").ok).toBe(false);

    priv(d).workerBinary = () => "<test worker>";
    expect(d.start("run-2").ok).toBe(true);
    expect(d.status().generatorError).toBeNull();
    await sleep(10);
    expect(d.started).toEqual(["run-2"]);
    await d.shutdown();
  });

  it("ends the run when the worker fails to start after start() already said yes", async () => {
    // spawning is async, so the failure can land after the API has answered.
    // Leaving the dashboard on "running" against a generator that does not
    // exist is the one outcome worse than refusing up front.
    const d = new TestDriver();
    d.spawnError = new Error("exec format error");

    const out = d.start("run-doomed");
    expect(out.ok).toBe(true);          // nothing has failed yet
    await sleep(20);                    // the spawn rejection lands
    expect(d.status().state).toBe("idle");
    expect(d.status().runId).toBeNull();
    expect(d.status().generatorError).toContain("exec format error");
    await d.shutdown();
  });
});

describe("run lifecycle", () => {
  it("starts, and hands the run id to the worker", async () => {
    const d = new TestDriver();
    expect(d.start("run-a").ok).toBe(true);
    await sleep(10);
    expect(d.started).toEqual(["run-a"]);
    expect(d.status().state).toBe("running");
    expect(d.status().runId).toBe("run-a");
    await d.shutdown();
  });

  it("is idempotent: a second start reports the run already going", async () => {
    const d = new TestDriver();
    d.start("run-first");
    await sleep(10);
    const again = d.start("run-second");
    expect(again).toEqual({ ok: true, runId: "run-first" });
    expect(d.started).toEqual(["run-first"]);
    await d.shutdown();
  });

  it("reaches idle only on the worker's ack, not on the stop call", async () => {
    // Accepting the ack only while "running" was the bug behind a run that said
    // "stopping" forever: stop() moves to "stopping" and *then* asks the worker,
    // so the ack always arrived in the one state the guard rejected.
    const d = new TestDriver();
    d.start("run-stop");
    await sleep(10);
    d.stop();
    expect(d.status().state).toBe("stopping");   // ack has not landed yet
    await sleep(10);
    expect(d.status().state).toBe("idle");
    expect(d.status().runId).toBeNull();
    expect(d.stops).toBe(1);
    await d.shutdown();
  });

  it("stop() on an idle driver is a no-op", () => {
    const d = new TestDriver();
    expect(d.stop()).toEqual({ stopped: true, runId: null });
    expect(d.stops).toBe(0);
  });

  it("stops a bounded run itself — the worker treats durationMinutes as metadata", async () => {
    // regression: the worker owns pacing and never ends the run, so nothing
    // enforced durationMinutes and a bounded run ran forever
    const d = new TestDriver();
    const autoStopped: (string | null)[] = [];
    d.onAutoStop((runId) => autoStopped.push(runId));
    // one-hundredth of a minute is 600ms — long enough to prove the watchdog
    // fires, short enough to not stall the suite
    d.setProfile({ mode: "constant", rps: 0, durationMinutes: 0.01 });
    d.start("run-bounded");
    expect(d.status().state).toBe("running");

    await sleep(1_200);
    expect(autoStopped).toEqual(["run-bounded"]);
    expect(d.status().state).not.toBe("running");
    await d.shutdown();
  });

  it("does not arm a watchdog for an unbounded run", async () => {
    const d = new TestDriver();
    const autoStopped: (string | null)[] = [];
    d.onAutoStop((runId) => autoStopped.push(runId));
    d.setProfile({ mode: "constant", rps: 0, durationMinutes: 0 });
    d.start("run-forever");
    await sleep(700);
    expect(autoStopped).toEqual([]);
    expect(d.status().state).toBe("running");
    await d.shutdown();
  });
});

describe("status reflects the worker, not our own guesses", () => {
  it("reports the ceiling the worker applied, not the one we would have computed", async () => {
    // The bug this closes: effectiveMaxConcurrency was assigned only on the
    // retired in-process path and reported on both, so every worker-driven run
    // showed the default 25 no matter what the operator configured. Only the
    // worker knows what the clamp did to the number.
    const d = new TestDriver();
    d.setProfile({ rps: 1_000, maxConcurrency: 500 });
    d.start("run-conc");
    await sleep(10);
    d.pushStatus({ effectiveMaxConcurrency: 500, targetRps: 1_000, sent: 4_000 });

    const s = d.status();
    expect(s.effectiveMaxConcurrency).toBe(500);
    expect(s.targetRps).toBe(1_000);
    expect(s.counters.sent).toBe(4_000);
    await d.shutdown();
  });

  it("falls back to the configured ceiling before the first status arrives", async () => {
    // "we have not heard yet" must not read as a ceiling of zero
    const d = new TestDriver();
    d.setProfile({ maxConcurrency: 300 });
    d.start("run-early");
    expect(d.status().effectiveMaxConcurrency).toBe(300);
    await d.shutdown();
  });

  it("surfaces sustained throttling, which only the worker can see", async () => {
    const d = new TestDriver();
    d.start("run-throttled");
    await sleep(10);
    const since = Date.now() - 5_000;
    d.pushStatus({ throttledSinceMs: since });
    expect(d.status().throttledSinceMs).toBe(since);

    // and clears when the ceiling stops binding
    d.pushStatus({ throttledSinceMs: 0 });
    expect(d.status().throttledSinceMs).toBeNull();
    await d.shutdown();
  });

  it("keeps the worker's final tally after the run ends", async () => {
    // the worker emits a closing status after draining; reverting to empty
    // local counters the moment a run ended reported every finished run as
    // zero traffic
    const d = new TestDriver();
    d.start("run-final");
    await sleep(10);
    d.pushStatus({ sent: 1_234, ok: 1_200, errors: 34 });
    d.stop();
    await sleep(10);

    expect(d.status().state).toBe("idle");
    expect(d.status().counters.sent).toBe(1_234);
    expect(d.status().counters.ok).toBe(1_200);
    await d.shutdown();
  });

  it("reports no target rate when no run is going", async () => {
    const d = new TestDriver();
    d.pushStatus({ targetRps: 500 });
    expect(d.status().targetRps).toBe(0);
    await d.shutdown();
  });
});

describe("Driver config hardening", () => {
  it("clamps a hostile profile instead of trusting it", () => {
    const d = new Driver();
    d.setProfile({ rps: 10 ** 9, maxConcurrency: -5, soapRatioPct: 900 } as never);
    const p = d.currentProfile;
    expect(p.rps).toBeLessThanOrEqual(LIMITS.rps);
    expect(p.maxConcurrency).toBeGreaterThan(0);
    expect(p.soapRatioPct).toBeLessThanOrEqual(100);
  });

  it("keeps the previous value for a field it cannot read", () => {
    const d = new Driver();
    d.setProfile({ rps: 50 });
    d.setProfile({ rps: "fast" } as never);
    expect(d.currentProfile.rps).toBe(50);
  });

  it("upgrades a legacy flat gateway config onto both protocols", () => {
    const d = new Driver();
    d.setGw({ baseUrl: "http://gw.example.com", apiKey: "k", apiKeyHeader: "X-Key", pathPrefix: "/v1" });
    expect(d.currentGw.rest.baseUrl).toBe("http://gw.example.com");
    expect(d.currentGw.soap.baseUrl).toBe("http://gw.example.com");
    expect(d.currentGw.soap.apiKey).toBe("k");
  });

  it("pushes every config change to the worker", async () => {
    // a run started after a config change must use it; the worker is told on
    // every setter as well as at start, because configure is cheap and a
    // missed push means the run measures the wrong target
    const d = new TestDriver();
    d.start("run-cfg");
    await sleep(10);
    const before = d.configures;
    d.setGw({ rest: { baseUrl: "http://new-gw:9000" } });
    d.setProfile({ rps: 42 });
    d.setSutUrl("http://127.0.0.1:9999");
    expect(d.configures).toBe(before + 3);
    await d.shutdown();
  });
});

describe("credential containment", () => {
  /**
   * These used to be asserted by firing a request through the in-process driver
   * and reading the headers off the wire. The worker fires the load now and
   * applies its own copy of the rule (config.SendsBasicAuth in packages/go), so
   * what is left on this side is the decision itself — which still has a
   * consumer here: the policy probes fire from this process and must take the
   * same view, or a probe describes a path the traffic does not take.
   */
  const credentialFor = (gw: Record<string, unknown>, selfUrl = "http://127.0.0.1:8080"): string | undefined => {
    process.env["APP_BASIC_AUTH"] = "admin:secret";
    const d = new Driver();
    d.setSutUrl(selfUrl);
    d.setGw(gw);
    return d.policyContext().baseHeaders("rest")["authorization"];
  };

  it('"auto" withholds our Basic credential from a foreign origin', () => {
    // the whole point: an external gateway is a third party. Sending it the
    // dashboard credential writes our admin password into their access log,
    // and a gateway doing its own auth may choke on a header it never expected.
    expect(credentialFor({ rest: { baseUrl: "http://gw.example.com:9000", forwardBasicAuth: "auto" } })).toBeUndefined();
  });

  it('"auto" still authenticates to the bundled petstore on our own origin', () => {
    // that target requires the header to answer at all, so out-of-the-box use
    // must keep working without the operator configuring anything
    expect(credentialFor({ rest: { baseUrl: "http://127.0.0.1:8080", forwardBasicAuth: "auto" } }))
      .toMatch(/^Basic /);
  });

  it('"always" and "never" override the origin check in both directions', () => {
    expect(credentialFor({ rest: { baseUrl: "http://gw.example.com:9000", forwardBasicAuth: "always" } }))
      .toMatch(/^Basic /);
    expect(credentialFor({ rest: { baseUrl: "http://127.0.0.1:8080", forwardBasicAuth: "never" } }))
      .toBeUndefined();
  });

  it("knows when the target is this very process, so the dashboard can say so", () => {
    // everything gateway-shaped is vacuous with no gateway in the path, and
    // reporting "0% blocked" in red for that configuration is a false alarm
    const d = new Driver();
    d.setSutUrl("http://127.0.0.1:8080");
    d.setGw({ rest: { baseUrl: "http://127.0.0.1:8080" }, soap: { baseUrl: "http://gw.example.com:9000" } });
    expect(d.status().targetIsSelf).toEqual({ rest: true, soap: false });
  });
});
