import { describe, expect, it, vi } from "vitest";
import type { ScenarioClass } from "@apigw/shared";
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
    const unreachable = { baseUrl: "http://127.0.0.1:1", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "" };
    priv(d).gw = { rest: { ...unreachable }, soap: { ...unreachable } };
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
    d.setGw({ rest: { apiKeyHeader: "X-Evil\r\nX-Injected: 1", baseUrl: "http://127.0.0.1:8080" } });
    // CRLF stripped, and the remainder is not a legal header name → safe default
    expect(d.currentGw.rest.apiKeyHeader).toBe("X-API-Key");
    // a legal custom header name is preserved
    d.setGw({ rest: { apiKeyHeader: "X-Gateway-Key" } });
    expect(d.currentGw.rest.apiKeyHeader).toBe("X-Gateway-Key");
  });

  it("falls back to the previous base URL when handed a non-URL", () => {
    const d = new Driver();
    d.setGw({ rest: { baseUrl: "http://127.0.0.1:8080" } });
    d.setGw({ rest: { baseUrl: "not a url" } });
    expect(d.currentGw.rest.baseUrl).toBe("http://127.0.0.1:8080");
    d.setGw({ rest: { baseUrl: "file:///etc/passwd" } });
    expect(d.currentGw.rest.baseUrl).toBe("http://127.0.0.1:8080");
  });

  it("upgrades a legacy flat config onto both protocols", () => {
    const d = new Driver();
    d.setGw({ baseUrl: "http://gw.example.com", apiKey: "k", apiKeyHeader: "X-Key", pathPrefix: "/v1" });
    expect(d.currentGw.rest.baseUrl).toBe("http://gw.example.com");
    expect(d.currentGw.soap.baseUrl).toBe("http://gw.example.com");
    expect(d.currentGw.soap.apiKey).toBe("k");
  });

  it("routes REST and SOAP traffic to their own targets with their own keys", async () => {
    const hits: { url: string; key: string | undefined }[] = [];
    const d = new Driver();
    d.setIngest((batch) => ({ ingested: batch.results.length }));
    d.setGw({
      rest: { baseUrl: "http://rest-gw:9000", apiKey: "rest-key", apiKeyHeader: "X-Rest-Key", pathPrefix: "/r" },
      soap: { baseUrl: "http://soap-gw:9001", apiKey: "soap-key", apiKeyHeader: "X-Soap-Key", pathPrefix: "" }
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      hits.push({
        url: String(input),
        key: (init?.headers as Record<string, string> | undefined)?.["X-Rest-Key"]
          ?? (init?.headers as Record<string, string> | undefined)?.["X-Soap-Key"]
      });
      return new Response("{}", { status: 200 });
    });
    try {
      d.setProfile({ soapRatioPct: 100 });
      d.start("run-split");
      await priv(d).fire();
      d.stop();
      await sleep(300);
      expect(hits.some((h) => h.url.startsWith("http://soap-gw:9001/") && h.key === "soap-key")).toBe(true);

      hits.length = 0;
      d.setProfile({ soapRatioPct: 0, invalidRatioPct: 0 });
      d.start("run-split-rest");
      await priv(d).fire();
      d.stop();
      await sleep(300);
      expect(hits.every((h) => h.url.startsWith("http://rest-gw:9000/r/") && h.key === "rest-key")).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
      await d.shutdown();
    }
  });
});

describe("GW-overhead pairing (X-Server-Ms)", () => {
  // overheadFor is the split the whole feature hinges on, tested directly: the
  // spool/drain path around it is timing-sensitive under a mocked fetch (mock
  // responses never close the ServerResponse, so stop()'s drain waits out its
  // full timeout) and adds nothing to the math being proven
  const overheadFor = (d: Driver, cls: ScenarioClass, latencyMs: number, serverMs: number | null) =>
    (priv(d).overheadFor as (c: ScenarioClass, l: number, s: number | null) => { baselineMs: number; overheadMs: number })
      .call(d, cls, latencyMs, serverMs);

  it("subtracts this request's own server time, not a class median", async () => {
    const d = new Driver();
    // pretend transport probing measured ~10ms for this class
    priv(d).baselines = new Map([["small-rest", [8, 10, 12]]]);
    // 210ms through the GW, of which the SUT says 200 was its own work
    const { baselineMs, overheadMs } = overheadFor(d, "small-rest", 210, 200);
    expect(baselineMs).toBe(200 + 10); // backend + transport
    expect(overheadMs).toBe(0);        // 210 − 200 − 10 → slop only, never backend time
    await d.shutdown();
  });

  it("a random slow-upstream sleep is not billed to the gateway", async () => {
    // regression vs the old class-median math: /api/slow/:ms sleeps a random
    // 500–2500ms per request; the median could never match and the difference
    // showed up as hundreds of ms of phantom "GW overhead"
    const d = new Driver();
    priv(d).baselines = new Map([["slow-upstream", [5]]]);
    const { baselineMs, overheadMs } = overheadFor(d, "slow-upstream", 1950, 1900);
    expect(baselineMs).toBe(1905);
    expect(overheadMs).toBe(45);
    await d.shutdown();
  });

  it("falls back to the class baseline when the response never carried the header", async () => {
    // e.g. a real gateway stripped it, or answered from its own auth layer
    const d = new Driver();
    priv(d).baselines = new Map([["small-rest", [40, 50, 60]]]);
    const { baselineMs, overheadMs } = overheadFor(d, "small-rest", 120, null);
    expect(baselineMs).toBe(50);
    expect(overheadMs).toBe(70);
    await d.shutdown();
  });

  it("probes record transport-only baselines when the SUT emits the header", async () => {
    const d = new Driver();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await sleep(105);
      return new Response("{}", { status: 200, headers: { "x-server-ms": "100" } });
    });
    try {
      const spec: Parameters<Driver["setBaselineUrl"]> | never = undefined as never;
      void spec;
      const t = await priv(d).timeDirect({
        path: "/api/pets", method: "GET", headers: {}, protocol: "rest",
        class: "small-rest", endpoint: "GET /api/pets", body: "",
        captureId: false, expectInvalid: false
      });
      expect(t).not.toBeNull();
      expect(t as number).toBeLessThan(60); // 105 wall − 100 server, ±timer slop
      expect(t as number).toBeGreaterThanOrEqual(0);
    } finally {
      fetchSpy.mockRestore();
      await d.shutdown();
    }
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

