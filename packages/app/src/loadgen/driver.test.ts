import { describe, expect, it, spyOn } from "bun:test";
import { LIMITS, MEASUREMENT_VERSION, type AggregateBatch } from "@apigw/shared";
import { Driver, MAX_REFERENCE_INFLIGHT, THROTTLE_TICKS_TO_WARN } from "./driver.js";

// The default backend flipped to "go" once the worker shipped; these tests
// exercise the in-process driver's internals directly and must not switch.
process.env["LOADGEN_BACKEND"] = "ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** requests behind a pre-rolled batch — the driver aggregates before ingest,
 *  so a batch no longer carries one object per request. */
const ingestedCount = (b: AggregateBatch): number => b.cells.reduce((n, c) => n + c.count, 0);
/** reach into the driver's internals to simulate in-flight state */
const priv = (d: Driver) => d as unknown as Record<string, any>;

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
      for (const r of batch.tail) seen.push(r.runId);
      return { ingested: ingestedCount(batch) };
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
    d.setIngest((batch) => ({ ingested: ingestedCount(batch) }));
    d.setGw({
      rest: { baseUrl: "http://rest-gw:9000", apiKey: "rest-key", apiKeyHeader: "X-Rest-Key", pathPrefix: "/r" },
      soap: { baseUrl: "http://soap-gw:9001", apiKey: "soap-key", apiKeyHeader: "X-Soap-Key", pathPrefix: "" }
    });
    d.setHealthCheck(() => null);
    const fetchSpy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async (input, init) => {
      hits.push({
        url: String(input),
        key: (init?.headers as Record<string, string> | undefined)?.["X-Rest-Key"]
          ?? (init?.headers as Record<string, string> | undefined)?.["X-Soap-Key"]
      });
      return new Response("{}", { status: 200 });
    });
    try {
      // invalidRatioPct must be 0, not the default 2: the invalid slice is
      // picked before the SOAP slice, so one fire() in ~70 would emit a REST
      // contract violation instead and fail this assertion at random
      d.setProfile({ soapRatioPct: 100, invalidRatioPct: 0 });
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

describe("the direct reference stream", () => {
  /** Mock every fetch with one canned response; returns the URLs requested. */
  const withFetch = (res: () => Promise<Response>): { urls: string[]; restore: () => void } => {
    const urls: string[] = [];
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch")
      .mockImplementation(async (input) => { urls.push(String(input)); return res(); });
    return { urls, restore: () => spy.mockRestore() };
  };

  it("records the residual as observed, including when it comes out negative", async () => {
    // A residual below zero is not an error to be swallowed: TTFB and the SUT's
    // self-reported time are read at different layers, so the low tail of the
    // reference distribution legitimately crosses zero. Clamping it — which the
    // retired per-request estimate did — lifts the reference and understates
    // the gateway by exactly the amount clamped away.
    const d = new Driver();
    d.setBaselineUrl("http://sut.test:8080");
    d.setProfile({ soapRatioPct: 0, invalidRatioPct: 0 });
    const f = withFetch(async () => new Response("{}", { status: 200, headers: { "x-server-ms": "5000" } }));
    try {
      d.start("run-ref");
      await priv(d).fireReference();
      const spool = priv(d).referenceSpool as { class: string; residualMs: number }[];
      expect(spool).toHaveLength(1);
      expect(spool[0]!.residualMs).toBeLessThan(0);
      expect(spool[0]!.residualMs).toBeGreaterThan(-5_100);
      expect(f.urls[0]).toStartWith("http://sut.test:8080/");
    } finally {
      f.restore();
      await d.shutdown();
    }
  });

  it("records nothing when the backend does not report its own time", async () => {
    // the same rule the gateway arm is held to: no backend clock, no residual.
    // Filtering one arm more leniently than the other is what biases a Δ.
    const d = new Driver();
    d.setBaselineUrl("http://sut.test:8080");
    const f = withFetch(async () => new Response("{}", { status: 200 }));
    try {
      d.start("run-ref-silent");
      await priv(d).fireReference();
      expect(priv(d).referenceSpool).toHaveLength(0);
    } finally {
      f.restore();
      await d.shutdown();
    }
  });

  it("paces at the configured share of the load and never queues behind itself", async () => {
    const d = new Driver();
    d.setBaselineUrl("http://sut.test:8080");
    let fired = 0;
    priv(d).fireReference = () => { fired++; return Promise.resolve(); };
    d.start("run-pace");
    const t0 = Date.now();
    // the first pump only establishes the clock — minting from a zero epoch
    // would release a run's worth of probes at once
    priv(d).pumpReference(t0, 1_000);
    expect(fired).toBe(0);
    // 2% of 1000 rps = 20 rps, so one second is 20 probes
    priv(d).pumpReference(t0 + 1_000, 1_000);
    expect(fired).toBe(20);

    // with the in-flight ceiling already reached, a tick issues nothing rather
    // than piling probes onto a SUT that is not keeping up — a backlogged
    // reference measures our own queue and would flatter the gateway
    fired = 0;
    priv(d).referenceInFlight = MAX_REFERENCE_INFLIGHT;
    priv(d).pumpReference(t0 + 2_000, 1_000);
    expect(fired).toBe(0);
    await d.shutdown();
  });

  it("holds the declared share at the top of the supported rate range", async () => {
    // regression: the ceiling was 50 rps, so above 2,500 rps of load the
    // control arm silently thinned relative to the gateway arm and became the
    // binding constraint on every percentile the Δ could report
    const d = new Driver();
    d.setBaselineUrl("http://sut.test:8080");
    let fired = 0;
    priv(d).fireReference = () => { fired++; return Promise.resolve(); };
    d.start("run-pace-high");
    const t0 = Date.now();
    priv(d).pumpReference(t0, 10_000);
    priv(d).pumpReference(t0 + 1_000, 10_000);
    expect(fired).toBe(200); // 2% of 10k, not a ceiling
    await d.shutdown();
  });

  it("rides the batch alongside the results it is to be compared against", async () => {
    const d = new Driver();
    d.setHealthCheck(() => null);
    const batches: AggregateBatch[] = [];
    d.setIngest((batch) => { batches.push(batch); return { ingested: ingestedCount(batch) }; });
    priv(d).recordReference({ ts: Date.now() - 100, class: "small-rest", residualMs: 0.4 });
    await priv(d).flush(true);
    const direct = batches[0]!.residuals.filter((r) => r.path === "direct");
    expect(direct).toHaveLength(1);
    expect(direct[0]!.sumMs).toBe(0.4);
    expect(direct[0]!.count).toBe(1);
    // and it flushes even with no results of its own to carry
    expect(batches[0]!.cells).toHaveLength(0);
    await d.shutdown();
  });

  it("keys reference residuals by health window, so a stall taints only its own", async () => {
    // the whole reason a residual cell is not minute-grained: the control plane
    // withholds contaminated windows, and at minute grain that choice would be
    // between discarding a whole minute and keeping a stall inside it
    const d = new Driver();
    d.setHealthCheck(() => null);
    const batches: AggregateBatch[] = [];
    d.setIngest((batch) => { batches.push(batch); return { ingested: ingestedCount(batch) }; });
    const base = Math.floor(Date.now() / 2_000) * 2_000;
    priv(d).recordReference({ ts: base - 4_000, class: "small-rest", residualMs: 0.4 });
    priv(d).recordReference({ ts: base - 2_000, class: "small-rest", residualMs: 0.5 });
    await priv(d).flush(true);
    const windows = batches[0]!.residuals.map((r) => r.windowTs).sort();
    expect(windows).toEqual([base - 4_000, base - 2_000]);
    await d.shutdown();
  });

  it("drops reference samples taken while the generator was unwell", async () => {
    // both arms get the same health filter. Keeping a contaminated reference
    // sample while withholding the contaminated gateway ones would subtract our
    // own stall from the gateway's cost.
    const d = new Driver();
    d.setHealthCheck(() => "local event-loop stall");
    const batches: AggregateBatch[] = [];
    d.setIngest((batch) => { batches.push(batch); return { ingested: ingestedCount(batch) }; });
    priv(d).recordReference({ ts: Date.now() - 100, class: "small-rest", residualMs: 0.4 });
    await priv(d).flush(true);
    expect(batches[0]!.residuals).toHaveLength(0);
    await d.shutdown();
  });
});

describe("Driver credential containment", () => {
  /** Fire one request at `gw` and report the headers that went on the wire. */
  const headersSentTo = async (gw: Record<string, unknown>, selfUrl?: string): Promise<Record<string, string>> => {
    const seen: Record<string, string>[] = [];
    const d = new Driver();
    d.setIngest((batch) => ({ ingested: ingestedCount(batch) }));
    if (selfUrl) d.setBaselineUrl(selfUrl);
    d.setGw(gw);
    d.setProfile({ soapRatioPct: 0, invalidRatioPct: 0 });
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async (_i, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("{}", { status: 200 });
    });
    try {
      d.start("run-creds");
      await priv(d).fire();
    } finally {
      spy.mockRestore();
      await d.shutdown();
    }
    return seen[0] ?? {};
  };

  it('"auto" withholds our Basic credential from a foreign origin', async () => {
    // the whole point: an external gateway is a third party. Sending it the
    // dashboard credential writes our admin password into their access log,
    // and a gateway doing its own auth may choke on a header it never expected.
    process.env["APP_BASIC_AUTH"] = "admin:secret";
    const h = await headersSentTo(
      { rest: { baseUrl: "http://gw.example.com:9000", forwardBasicAuth: "auto" } },
      "http://127.0.0.1:8080"
    );
    expect(h["authorization"]).toBeUndefined();
  });

  it('"auto" still authenticates to the bundled petstore on our own origin', async () => {
    // that target requires the header to answer at all, so out-of-the-box use
    // must keep working without the operator configuring anything
    process.env["APP_BASIC_AUTH"] = "admin:secret";
    const h = await headersSentTo(
      { rest: { baseUrl: "http://127.0.0.1:8080", forwardBasicAuth: "auto" } },
      "http://127.0.0.1:8080"
    );
    expect(h["authorization"]).toMatch(/^Basic /);
  });

  it('"always" and "never" override the origin check in both directions', async () => {
    process.env["APP_BASIC_AUTH"] = "admin:secret";
    const forced = await headersSentTo(
      { rest: { baseUrl: "http://gw.example.com:9000", forwardBasicAuth: "always" } },
      "http://127.0.0.1:8080"
    );
    expect(forced["authorization"]).toMatch(/^Basic /);

    const withheld = await headersSentTo(
      { rest: { baseUrl: "http://127.0.0.1:8080", forwardBasicAuth: "never" } },
      "http://127.0.0.1:8080"
    );
    expect(withheld["authorization"]).toBeUndefined();
  });

  it("tags every request for correlation with the gateway's own logs", async () => {
    const h = await headersSentTo({ rest: { baseUrl: "http://gw.example.com:9000" } });
    expect(h["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    // W3C trace context: version-traceid-spanid-flags, neither id all-zero
    expect(h["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const [, traceId, spanId] = (h["traceparent"] as string).split("-");
    expect(traceId).toBe(h["x-request-id"]);
    expect(spanId).not.toBe("0".repeat(16));
  });

  it("issues a distinct id per request", async () => {
    const d = new Driver();
    const ids = new Set<string>();
    d.setIngest((batch) => {
      for (const r of batch.tail) ids.add(r.requestId);
      return { ingested: ingestedCount(batch) };
    });
    d.setProfile({ soapRatioPct: 0, invalidRatioPct: 0 });
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    try {
      d.start("run-ids");
      for (let i = 0; i < 25; i++) await priv(d).fire();
      await priv(d).flush();
      expect(ids.size).toBe(25);
    } finally {
      spy.mockRestore();
      await d.shutdown();
    }
  });
});

describe("Driver outcome accounting", () => {
  /** Fire `n` requests against a canned response and return the run counters. */
  const runAgainst = async (
    res: () => Response,
    profile: Record<string, unknown> = { soapRatioPct: 0, invalidRatioPct: 0 },
    n = 4
  ) => {
    const d = new Driver();
    const results: { status: number; reachedBackend: boolean }[] = [];
    d.setIngest((batch) => {
      for (const r of batch.tail) results.push({ status: r.status, reachedBackend: r.reachedBackend });
      return { ingested: ingestedCount(batch) };
    });
    d.setProfile(profile as never);
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async () => res());
    try {
      d.start("run-outcome");
      for (let i = 0; i < n; i++) await priv(d).fire();
      await priv(d).flush();
      return { counters: d.status().counters, results };
    } finally {
      spy.mockRestore();
      await d.shutdown();
    }
  };

  it("does not count a 401 as a success", async () => {
    // regression: `status < 500` meant ok++, so a gateway rejecting every
    // request on a bad API key reported a flawless run with a 0% error rate
    const { counters } = await runAgainst(() => new Response("no", { status: 401 }));
    expect(counters.ok).toBe(0);
    expect(counters.clientErrors).toBe(4);
    expect(counters.unauthorized).toBe(4);
  });

  it("surfaces rate limiting on its own", async () => {
    // a run that trips the gateway's quota has meaningless latency numbers;
    // 429 must be visible rather than folded into a generic bucket
    const { counters } = await runAgainst(() => new Response("slow down", { status: 429 }));
    expect(counters.ok).toBe(0);
    expect(counters.rateLimited).toBe(4);
    expect(counters.clientErrors).toBe(4);
  });

  it("separates the gateway's own faults from backend errors", async () => {
    const upstreamDown = await runAgainst(() => new Response("bad gateway", { status: 502 }));
    expect(upstreamDown.counters.gatewayErrors).toBe(4);
    expect(upstreamDown.counters.errors).toBe(4);

    const appBroke = await runAgainst(() => new Response("boom", { status: 500 }));
    expect(appBroke.counters.gatewayErrors).toBe(0);
    expect(appBroke.counters.errors).toBe(4);
  });

  it("marks a response as backend-reached only when it carries X-Server-Ms", async () => {
    const proxied = await runAgainst(
      () => new Response("{}", { status: 200, headers: { "x-server-ms": "12" } })
    );
    expect(proxied.results.every((r) => r.reachedBackend)).toBe(true);

    const gatewayMade = await runAgainst(() => new Response("{}", { status: 200 }));
    expect(gatewayMade.results.every((r) => !r.reachedBackend)).toBe(true);
  });

  it("credits an invalid request's rejection to whoever actually made it", async () => {
    // the bundled SUT validates too, so "answered 4xx" alone proves nothing
    // about the gateway. X-Server-Ms is the tie-breaker.
    const invalidOnly = { soapRatioPct: 0, invalidRatioPct: 100 };

    const blockedByGw = await runAgainst(() => new Response("nope", { status: 400 }), invalidOnly);
    expect(blockedByGw.counters.invalidSent).toBe(4);
    expect(blockedByGw.counters.invalidRejectedByGateway).toBe(4);
    expect(blockedByGw.counters.invalidLeaked).toBe(0);

    // same 400 — but the backend's fingerprint proves the gateway passed it on
    const caughtByBackend = await runAgainst(
      () => new Response("nope", { status: 400, headers: { "x-server-ms": "3" } }),
      invalidOnly
    );
    expect(caughtByBackend.counters.invalidRejectedByGateway).toBe(0);
    expect(caughtByBackend.counters.invalidLeaked).toBe(4);
  });
});

describe("Driver load-shed accounting", () => {
  it("records the load the concurrency cap stopped us issuing", async () => {
    // coordinated omission: a throttled run quietly delivers less than the
    // target and the latency chart looks better for it. The shed has to reach
    // the store, or a window can report health it never actually tested.
    const d = new Driver();
    const batches: { dropped: number; targetSum: number; ticks: number }[] = [];
    d.setIngest((batch) => {
      for (const s of batch.shed ?? []) batches.push({ dropped: s.dropped, targetSum: s.targetSum, ticks: s.ticks });
      return { ingested: ingestedCount(batch) };
    });
    d.setProfile({ mode: "constant", rps: 500, maxConcurrency: 10 });
    d.start("run-shed");
    // pin in-flight at the ceiling so every due token is shed
    priv(d).effectiveMaxConcurrency = 10;
    priv(d).inFlight = 10;
    priv(d).tick();        // primes the bucket's clock; nothing is due yet
    await sleep(150);      // ~75 tokens accrue at 500 rps
    priv(d).tick();

    expect(d.status().counters.droppedRequests).toBeGreaterThan(0);
    // a final flush drains the still-open minute too
    await priv(d).flush(true);
    expect(batches.length).toBeGreaterThan(0);
    const total = batches.reduce((a, b) => a + b.dropped, 0);
    expect(total).toBe(d.status().counters.droppedRequests);
    // the target is recorded even on ticks that issued nothing — without the
    // denominator the shed count is a bare number nobody can size
    expect(batches.reduce((a, b) => a + b.ticks, 0)).toBeGreaterThan(0);
    expect(batches.reduce((a, b) => a + b.targetSum, 0)).toBeGreaterThan(0);
    priv(d).inFlight = 0;
    await d.shutdown();
  });

  it("keeps the accounting when a flush fails, rather than losing it", async () => {
    const d = new Driver();
    let fail = true;
    const seen: number[] = [];
    d.setIngest((batch) => {
      if (fail) throw new Error("store unavailable");
      for (const s of batch.shed ?? []) seen.push(s.dropped);
      return { ingested: ingestedCount(batch) };
    });
    d.setProfile({ mode: "constant", rps: 500, maxConcurrency: 10 });
    d.start("run-shed-retry");
    priv(d).effectiveMaxConcurrency = 10;
    priv(d).inFlight = 10;
    priv(d).tick();
    await sleep(150);
    priv(d).tick();
    const dropped = d.status().counters.droppedRequests;
    expect(dropped).toBeGreaterThan(0);

    await priv(d).flush(true);   // rejected — must be held, not discarded
    expect(seen).toEqual([]);
    fail = false;
    await priv(d).flush(true);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(dropped);
    priv(d).inFlight = 0;
    await d.shutdown();
  });

  it("holds the open minute back until the run ends", async () => {
    // a mid-run flush must not publish a bucket that is still filling, or the
    // same minute would be reported twice with different totals
    const d = new Driver();
    const flushed: number[] = [];
    d.setIngest((batch) => {
      for (const s of batch.shed ?? []) flushed.push(s.bucketTs);
      return { ingested: ingestedCount(batch) };
    });
    d.setProfile({ mode: "constant", rps: 500, maxConcurrency: 10 });
    d.start("run-open-bucket");
    priv(d).effectiveMaxConcurrency = 10;
    priv(d).inFlight = 10;
    priv(d).tick();

    await priv(d).flush();       // ordinary flush: open bucket stays behind
    expect(flushed).toEqual([]);
    await priv(d).flush(true);   // final flush: it goes
    expect(flushed.length).toBe(1);
    priv(d).inFlight = 0;
    await d.shutdown();
  });
});

describe("Driver bounded runs", () => {
  it("stops itself once durationMinutes has elapsed", async () => {
    const d = new Driver();
    const stopped: (string | null)[] = [];
    d.setIngest((batch) => ({ ingested: ingestedCount(batch) }));
    d.onAutoStop((runId) => stopped.push(runId));
    d.setProfile({ mode: "constant", rps: 0, durationMinutes: 10 });
    d.start("run-bounded");
    // rewind the clock past the limit rather than waiting ten minutes
    priv(d).startedAt = Date.now() - 11 * 60_000;
    priv(d).tick();

    expect(stopped).toEqual(["run-bounded"]);
    expect(priv(d).state).not.toBe("running");
    await d.shutdown();
  });

  it("runs indefinitely when no duration is set", async () => {
    const d = new Driver();
    const stopped: (string | null)[] = [];
    d.setIngest((batch) => ({ ingested: ingestedCount(batch) }));
    d.onAutoStop((runId) => stopped.push(runId));
    d.setProfile({ mode: "constant", rps: 0, durationMinutes: 0 });
    d.start("run-forever");
    priv(d).startedAt = Date.now() - 30 * 24 * 60 * 60_000;
    priv(d).tick();
    expect(stopped).toEqual([]);
    expect(priv(d).state).toBe("running");
    await d.shutdown();
  });

  it("stops a Go-backend run at durationMinutes even though tickTimer never arms", async () => {
    // regression: the Go path in start() returns before the tick interval is
    // installed, and the worker treats durationMinutes as inert metadata — a
    // bounded Go-driven run used to run forever
    const d = new Driver();
    const stopped: (string | null)[] = [];
    d.setIngest((batch) => ({ ingested: ingestedCount(batch) }));
    d.onAutoStop((runId) => stopped.push(runId));
    const go = {
      ensureStarted: async () => {},
      configure: () => {},
      start: () => {},
      stop: () => {},
      shutdown: async () => {}
    };
    priv(d).go = () => go;
    // one-hundredth of a minute is 600ms — long enough to prove the watchdog
    // fires, short enough to not stall the suite
    d.setProfile({ mode: "constant", rps: 0, durationMinutes: 0.01 });
    d.start("run-go-bounded");
    expect(priv(d).state).toBe("running");
    expect(priv(d).durationTimer).not.toBeNull();

    await new Promise((r) => setTimeout(r, 1200));
    expect(stopped).toEqual(["run-go-bounded"]);
    expect(priv(d).state).not.toBe("running");
    await d.shutdown();
  });
});

describe("Driver fire() response byte accounting", () => {
  const drive = async (makeRes: () => Response): Promise<number[]> => {
    const sizes: number[] = [];
    const d = new Driver();
    d.setIngest((batch) => {
      for (const r of batch.tail) sizes.push(r.bytesResp);
      return { ingested: ingestedCount(batch) };
    });
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async () => makeRes());
    try {
      d.start("run-bytes");
      await priv(d).fire();
      d.stop();
      await sleep(400);
      await priv(d).flush();
    } finally {
      spy.mockRestore();
      await d.shutdown();
    }
    return sizes;
  };

  it("trusts Content-Length instead of buffering the body", async () => {
    const body = "z".repeat(12345);
    const sizes = await drive(() => new Response(body, { status: 200 }));
    expect(sizes.length).toBe(1);
    // a string Response always carries content-length; the count must match
    // its declared value without having buffered the body
    expect(sizes[0]).toBe(12345);
  });

  it("counts streamed chunks when Content-Length is absent", async () => {
    const chunk = new TextEncoder().encode("xy".repeat(5000));
    const sizes = await drive(
      () => new Response(new ReadableStream({ start(c) { c.enqueue(chunk); c.close(); } }), { status: 200 })
    );
    expect(sizes.length).toBe(1);
    expect(sizes[0]).toBe(10_000);
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

describe("Driver concurrency ceiling", () => {
  it("honours the configured ceiling even when it cannot sustain the rate", async () => {
    // This used to auto-raise to rps × 5 = 2,500, which turned the operator's
    // safety limit into a floor. A ceiling only ever binds when the target is
    // slow — which is precisely when a small host needs it — so overriding it
    // removed the brake at the only moment it mattered. The shortfall is
    // reported as shed load rather than engineered away.
    const d = new Driver();
    d.setProfile({ mode: "constant", rps: 500, maxConcurrency: 25 });
    d.start("run-scale");
    expect(priv(d).effectiveMaxConcurrency).toBe(25);
    const s = d.status();
    expect(s.effectiveMaxConcurrency).toBe(25);
    expect(s.throttledSinceMs).toBeNull();
    await d.shutdown();
  });

  it("keeps an explicit ceiling when it already covers the rate", async () => {
    const d = new Driver();
    d.setProfile({ mode: "constant", rps: 10, maxConcurrency: 800 });
    d.start("run-big");
    expect(priv(d).effectiveMaxConcurrency).toBe(800);
    await d.shutdown();
  });

  it("never exceeds LIMITS.maxConcurrency", async () => {
    const d = new Driver();
    d.setProfile({ mode: "constant", rps: 10_000, maxConcurrency: LIMITS.maxConcurrency * 10 });
    d.start("run-huge");
    expect(priv(d).effectiveMaxConcurrency).toBe(LIMITS.maxConcurrency);
    await d.shutdown();
  });

  it("flags sustained saturation as throttled and counts the dropped load", async () => {
    const d = new Driver();
    // 2,500 is now the operator's choice rather than something the driver
    // arrived at on its own; the ceiling has to exceed the stub's per-tick
    // demand or the recovery step below can never find headroom
    d.setProfile({ mode: "constant", rps: 500, maxConcurrency: 2500 });
    d.start("run-throttle");
    const bucket = priv(d).bucket as { tick: (nowMs: number, p: unknown, s: number) => { due: number; targetRps: number } };
    const origTick = bucket.tick.bind(bucket);
    // simulate a fully saturated cap: every tick wants 50 but nothing completes
    priv(d).inFlight = 2500;
    bucket.tick = () => ({ due: 50, targetRps: 500 });
    const tick = priv(d).tick.bind(d) as () => void;
    // the threshold is a duration converted to ticks, so it tracks the
    // scheduler cadence rather than being a magic count
    for (let i = 0; i < THROTTLE_TICKS_TO_WARN - 1; i++) {
      tick();
      expect(d.status().throttledSinceMs).toBeNull();
    }
    tick();
    expect(d.status().throttledSinceMs).not.toBeNull();
    expect(priv(d).droppedTokens as number).toBe(50 * THROTTLE_TICKS_TO_WARN);
    // recovery: a tick with headroom clears the flag immediately
    priv(d).inFlight = 0;
    tick();
    expect(d.status().throttledSinceMs).toBeNull();
    bucket.tick = origTick;
    await d.shutdown();
  });
});



describe("timing qualification", () => {
  it("retains a request and its elapsed time when overlapping health is bad", async () => {
    // The row still counts toward throughput, status and latency — that is what
    // the run delivered. Only its residual is withheld, because a generator
    // stall delays when we see the response headers but not the SUT's own
    // clock, so the whole stall would land inside ttfb − serverMs.
    const d = new Driver();
    d.setHealthCheck(() => "local CPU throttling");
    const batches: any[] = [];
    d.setIngest(batch => { batches.push(batch); return { ingested: ingestedCount(batch) }; });
    priv(d).record({ runId: "r", ts: Date.now() - 100, latencyMs: 50, ttfbMs: 40, serverMs: 10, timingReason: null, measurementVersion: MEASUREMENT_VERSION });
    await priv(d).flush(true);
    // the request is in the roll-up in full
    expect(batches[0].cells[0].count).toBe(1);
    expect(batches[0].cells[0].latencySumMs).toBe(50);
    // and in the tail, with its clocks intact and the reason on it
    expect(batches[0].tail).toHaveLength(1);
    expect(batches[0].tail[0].ttfbMs).toBe(40);
    expect(batches[0].tail[0].serverMs).toBe(10);
    expect(batches[0].tail[0].timingReason).toBe("local CPU throttling");
    // only the residual is withheld
    expect(batches[0].residuals).toHaveLength(0);
    await d.shutdown();
  });

  it("stamps health per 2s sample window — a stall taints only its own window", async () => {
    // a healthy request must not be disqualified for sharing a flush with a
    // stalled one; and each distinct window is checked exactly once
    const d = new Driver();
    const now = Date.now();
    const w = (ts: number) => Math.floor(ts / 2_000) * 2_000;
    const stalled = w(now);            // window containing "now"
    const healthy = stalled - 2_000;   // previous window
    const checked: [number, number][] = [];
    d.setHealthCheck((from, to) => {
      checked.push([from, to]);
      return from === stalled ? "local event-loop stall" : null;
    });
    const batches: any[] = [];
    d.setIngest(batch => { batches.push(batch); return { ingested: ingestedCount(batch) }; });
    const base = { runId: "r", latencyMs: 50, ttfbMs: 40, serverMs: 10, timingReason: null, measurementVersion: MEASUREMENT_VERSION };
    priv(d).record({ ...base, ts: healthy + 100 });
    priv(d).record({ ...base, ts: healthy + 900 });
    priv(d).record({ ...base, ts: stalled + 100 });
    await priv(d).flush(true);
    const results = batches[0].tail;
    expect(results).toHaveLength(3);
    expect(results[0].timingReason).toBeNull();
    expect(results[1].timingReason).toBeNull();
    expect(results[2].timingReason).toBe("local event-loop stall");
    // the healthy window keeps its residuals; the stalled one loses its own
    expect(batches[0].residuals.map((r: any) => r.windowTs)).toEqual([healthy]);
    expect(batches[0].residuals[0].count).toBe(2);
    // one check per distinct window, closed windows asked about in full and
    // the still-open one only up to now — the sampler cannot cover the rest
    expect(checked).toHaveLength(2);
    expect(checked[0]).toEqual([healthy, healthy + 2_000]);
    expect(checked[1]![0]).toBe(stalled);
    expect(checked[1]![1]).toBeGreaterThanOrEqual(now);
    expect(checked[1]![1]).toBeLessThanOrEqual(stalled + 2_000);
    await d.shutdown();
  });

  it("counts measurements the spool threw away instead of losing them silently", async () => {
    // the spool drops its oldest decile on overflow. Those are requests the
    // gateway served — invisible loss here makes a truncated sample look like
    // a complete one, and it is the busiest moments that overflow.
    const d = new Driver();
    d.setHealthCheck(() => null);
    const batches: any[] = [];
    d.setIngest(batch => { batches.push(batch); return { ingested: ingestedCount(batch) }; });
    const now = Date.now();
    for (let i = 0; i < 50_001; i++) {
      priv(d).record({ runId: "r", ts: now, latencyMs: 1, overheadMs: 1, overheadReason: null });
    }
    expect(d.status().counters.resultsLost).toBe(5_000);

    await priv(d).flush(true);
    const shed = batches.flatMap((b: any) => b.shed ?? []);
    // the loss rides the shed accounting so the window it thinned can report it
    expect(shed.reduce((n: number, s: any) => n + (s.resultsLost ?? 0), 0)).toBe(5_000);
    await d.shutdown();
  });

  it("never asks about a window that has not elapsed — the open tail of a batch stays qualified", async () => {
    // the newest 2s window of every batch is still open; asking the sampler
    // about its future half is always "coverage unavailable", which would
    // exclude the tail of every flush and keep the verdict inconclusive
    const d = new Driver();
    const now = Date.now();
    const asked: [number, number][] = [];
    d.setHealthCheck((from, to) => {
      asked.push([from, to]);
      return to > Date.now() ? "health coverage unavailable" : null;
    });
    const batches: any[] = [];
    d.setIngest(batch => { batches.push(batch); return { ingested: ingestedCount(batch) }; });
    priv(d).record({ runId: "r", ts: now, latencyMs: 50, ttfbMs: 40, serverMs: 10, timingReason: null, measurementVersion: MEASUREMENT_VERSION });
    await priv(d).flush(true);
    expect(asked[0]![1]).toBeLessThanOrEqual(Date.now());
    expect(batches[0].tail[0].timingReason).toBeNull();
    expect(batches[0].residuals).toHaveLength(1);
    expect(batches[0].residuals[0].sumMs).toBe(30);
    await d.shutdown();
  });
});
