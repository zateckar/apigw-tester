import { describe, expect, it } from "vitest";
import { Driver } from "./driver.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** reach into the driver's internals to simulate in-flight state */
const priv = (d: Driver) => d as unknown as Record<string, never>;

describe("Driver.stop() drain", () => {
  it("waits for in-flight requests regardless of how long the run has been going", async () => {
    // regression: the deadline was measured from startedAt, so any run older
    // than 10s tore down immediately and results landed with runId = null
    const d = new Driver();
    d.start("run-old");
    priv(d).startedAt = Date.now() - 11_000; // a long-running run
    priv(d).inFlight = 3;

    d.stop();
    await sleep(600);

    expect(priv(d).inFlight).toBe(3);
    expect(priv(d).state).toBe("stopping");
    expect(priv(d).runId).toBe("run-old");

    // once the requests land, the run finishes
    priv(d).inFlight = 0;
    await sleep(400);
    expect(priv(d).state).toBe("idle");
    await d.shutdown();
  });

  it("gives up after the drain timeout rather than hanging forever", async () => {
    const d = new Driver();
    d.start("run-stuck");
    priv(d).inFlight = 1;
    d.stop();
    priv(d).stoppedAt = Date.now() - 11_000; // pretend we already waited it out
    await sleep(400);
    expect(priv(d).state).toBe("idle");
    await d.shutdown();
  });

  it("never records a result without a runId", async () => {
    const seen: (string | null | undefined)[] = [];
    const d = new Driver();
    d.setIngest((batch) => {
      for (const r of batch.results) seen.push(r.runId);
      return { ingested: batch.results.length };
    });
    d.start("run-x");
    // a request that completes after the run has been torn down still carries
    // the run identity it was issued under
    const fire = priv(d).fire.bind(d);
    priv(d).gw = { baseUrl: "http://127.0.0.1:1", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "" };
    const p = fire();
    d.stop();
    await sleep(600);
    await p;
    await priv(d).flush();
    expect(seen.length).toBeGreaterThan(0);
    for (const runId of seen) expect(typeof runId).toBe("string");
    await d.shutdown();
  });

  it("a second start() supersedes a pending drain", async () => {
    const d = new Driver();
    d.start("run-a");
    priv(d).inFlight = 5;
    d.stop();
    d.start("run-b");
    await sleep(500);
    expect(priv(d).state).toBe("running");
    expect(priv(d).runId).toBe("run-b");
    await d.shutdown();
  });

  it("stop() on an idle driver is a no-op", () => {
    const d = new Driver();
    expect(d.stop()).toEqual({ stopped: true, runId: null });
  });
});

describe("Driver config hardening", () => {
  it("clamps a hostile profile rather than accepting it", () => {
    const d = new Driver();
    d.setProfile({ maxConcurrency: 0, rps: 1e12, soapRatioPct: 900, invalidRatioPct: -5 } as never);
    const p = d.currentProfile;
    expect(p.maxConcurrency).toBeGreaterThanOrEqual(1);
    expect(p.rps).toBeLessThanOrEqual(10_000);
    expect(p.soapRatioPct).toBe(100);
    expect(p.invalidRatioPct).toBe(0);
  });

  it("rejects a header name that would let config inject request headers", () => {
    const d = new Driver();
    d.setGw({ apiKeyHeader: "X-Evil\r\nX-Injected: 1", baseUrl: "http://127.0.0.1:8080" });
    // CRLF stripped, and the remainder is not a legal header name → safe default
    expect(d.currentGw.apiKeyHeader).toBe("X-API-Key");
    // a legal custom header name is preserved
    d.setGw({ apiKeyHeader: "X-Gateway-Key" });
    expect(d.currentGw.apiKeyHeader).toBe("X-Gateway-Key");
  });

  it("falls back to the previous base URL when handed a non-URL", () => {
    const d = new Driver();
    d.setGw({ baseUrl: "http://127.0.0.1:8080" });
    d.setGw({ baseUrl: "not a url" });
    expect(d.currentGw.baseUrl).toBe("http://127.0.0.1:8080");
    d.setGw({ baseUrl: "file:///etc/passwd" });
    expect(d.currentGw.baseUrl).toBe("http://127.0.0.1:8080");
  });
});

describe("Driver.status()", () => {
  it("is side-effect free for mode=real", () => {
    // regression: status() called targetRpsAt(), which advanced the drift model,
    // so every dashboard poll perturbed the traffic being generated
    const d = new Driver();
    d.setProfile({ mode: "real", rps: 10 });
    d.start("run-real");
    const before = JSON.stringify(priv(d).bucket);
    for (let i = 0; i < 50; i++) d.status();
    expect(JSON.stringify(priv(d).bucket)).toBe(before);
    void d.shutdown();
  });
});
