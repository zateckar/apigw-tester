import { describe, expect, it, spyOn } from "bun:test";
import { LIMITS, type ScenarioClass } from "@apigw/shared";
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
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
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

describe("Driver credential containment", () => {
  /** Fire one request at `gw` and report the headers that went on the wire. */
  const headersSentTo = async (gw: Record<string, unknown>, selfUrl?: string): Promise<Record<string, string>> => {
    const seen: Record<string, string>[] = [];
    const d = new Driver();
    d.setIngest((batch) => ({ ingested: batch.results.length }));
    if (selfUrl) d.setBaselineUrl(selfUrl);
    d.setGw(gw);
    d.setProfile({ soapRatioPct: 0, invalidRatioPct: 0 });
    const spy = spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
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
      for (const r of batch.results) ids.add(r.requestId);
      return { ingested: batch.results.length };
    });
    d.setProfile({ soapRatioPct: 0, invalidRatioPct: 0 });
    const spy = spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
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
      for (const r of batch.results) results.push({ status: r.status, reachedBackend: r.reachedBackend });
      return { ingested: batch.results.length };
    });
    d.setProfile(profile as never);
    const spy = spyOn(globalThis, "fetch").mockImplementation(async () => res());
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
      return { ingested: batch.results.length };
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
      return { ingested: batch.results.length };
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
      return { ingested: batch.results.length };
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
    d.setIngest((batch) => ({ ingested: batch.results.length }));
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
    d.setIngest((batch) => ({ ingested: batch.results.length }));
    d.onAutoStop((runId) => stopped.push(runId));
    d.setProfile({ mode: "constant", rps: 0, durationMinutes: 0 });
    d.start("run-forever");
    priv(d).startedAt = Date.now() - 30 * 24 * 60 * 60_000;
    priv(d).tick();
    expect(stopped).toEqual([]);
    expect(priv(d).state).toBe("running");
    await d.shutdown();
  });
});

describe("Driver fire() response byte accounting", () => {
  const drive = async (makeRes: () => Response): Promise<number[]> => {
    const sizes: number[] = [];
    const d = new Driver();
    d.setIngest((batch) => {
      for (const r of batch.results) sizes.push(r.bytesResp);
      return { ingested: batch.results.length };
    });
    const spy = spyOn(globalThis, "fetch").mockImplementation(async () => makeRes());
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
  it("auto-raises maxConcurrency to hold 5s of the target rate", async () => {
    const d = new Driver();
    d.setProfile({ mode: "constant", rps: 500, maxConcurrency: 25 });
    d.start("run-scale");
    expect(priv(d).effectiveMaxConcurrency).toBe(2500);
    const s = d.status();
    expect(s.effectiveMaxConcurrency).toBe(2500);
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
    d.setProfile({ mode: "constant", rps: 10_000, maxConcurrency: 25 });
    d.start("run-huge");
    expect(priv(d).effectiveMaxConcurrency).toBe(LIMITS.maxConcurrency);
    await d.shutdown();
  });

  it("flags sustained saturation as throttled and counts the dropped load", async () => {
    const d = new Driver();
    d.setProfile({ mode: "constant", rps: 500, maxConcurrency: 25 });
    d.start("run-throttle");
    const bucket = priv(d).bucket as { tick: (nowMs: number, p: unknown, s: number) => { due: number; targetRps: number } };
    const origTick = bucket.tick.bind(bucket);
    // simulate a fully saturated cap: every tick wants 50 but nothing completes
    priv(d).inFlight = 2500;
    bucket.tick = () => ({ due: 50, targetRps: 500 });
    const tick = priv(d).tick.bind(d) as () => void;
    for (let i = 0; i < 9; i++) {
      tick();
      expect(d.status().throttledSinceMs).toBeNull();
    }
    tick(); // 10th capped tick ≈ 1s of throttling
    expect(d.status().throttledSinceMs).not.toBeNull();
    expect(priv(d).droppedTokens as number).toBe(500);
    // recovery: a tick with headroom clears the flag immediately
    priv(d).inFlight = 0;
    tick();
    expect(d.status().throttledSinceMs).toBeNull();
    bucket.tick = origTick;
    await d.shutdown();
  });
});

