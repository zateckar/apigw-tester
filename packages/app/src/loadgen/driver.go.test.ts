import { describe, expect, it } from "bun:test";
import { buildApp } from "../app.js";
import { readConfig } from "../config.js";
import { workerBinaryPath } from "./goClient.js";
import { MEASUREMENT_VERSION, type MetricSummary, type RequestResult, type RunCounters } from "@apigw/shared";

// This integration test exercises Driver against the Go worker end-to-end.
// Both cases are skipped when the worker binary is absent (dev machines
// without Go installed); the ts-control case guards regressions in shape.
const HAVE_GO_WORKER = workerBinaryPath() !== null;

process.env["APP_BASIC_AUTH"] = "test:pw-123";
const AUTH = `Basic ${Buffer.from("test:pw-123").toString("base64")}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a port, then hand it straight back. */
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  return port;
}

interface RunOutcome {
  /** the recent tail: a deliberately downsampled SAMPLE above ~500 rows, so
   *  only per-result shape may be asserted on it, never volume */
  results: RequestResult[];
  /** the generator's own exact tallies, read just before stop */
  counters: RunCounters;
  /** the store's view of the run, where the overhead Δ is computed */
  summary: MetricSummary;
}

/**
 * Start the full app on an ephemeral port with the given loadgen backend,
 * run a bounded constant-rate load against the bundled petstore (the gateway
 * target defaults to self), then pull the ingested rows back out.
 */
async function runOnce(
  backend: "ts" | "go",
  seconds: number,
  rps: number,
  profile: Record<string, unknown>
): Promise<RunOutcome> {
  process.env["LOADGEN_BACKEND"] = backend;
  // selfUrl — and with it the direct-to-SUT baseline probe — is where the
  // reference arm of the overhead comparison is sent, and both drivers
  // calibrate once at init. Point it anywhere nothing is listening and every
  // probe fails silently: directSamples stays 0 and no Δ is ever computed.
  //
  // It now defaults to the split-out SUT's own port, so pinning PORT is no
  // longer enough — this run keeps the petstore in-process, so selfUrl has to
  // be walked back to the app's ephemeral port to match.
  const port = freePort();
  process.env["PORT"] = String(port);
  const built = buildApp({
    ...readConfig(),
    // in-process petstore: this test is about the two load generators, and
    // spawning a second process would add a variable it is not measuring
    sutBackend: "ts",
    selfUrl: `http://127.0.0.1:${port}`,
    dbPath: ":memory:",
    publicDir: "nope"
  });
  // Pin local health to "fine".
  //
  // This one process is the load generator, the gateway's stand-in, the SUT and
  // the store, so at a few hundred rps its own event loop stalls past the
  // validity limit and the rig correctly disqualifies most of its windows —
  // there is no residual left to compare. That gate is real and has its own
  // coverage; what this test is for is proving both generators emit both arms
  // of the comparison and that the store turns them into a Δ, which a
  // machine-dependent health verdict would make flaky rather than rigorous.
  built.driver.setHealthCheck(() => null);
  const server = built.listen(port);
  await built.ready; // config loaded; production ingest wired
  const base = `http://127.0.0.1:${server.port}`;

  // Batches land in SQLite through the store's ingest; we pull rows back out
  // via /api/recent (the same read path the dashboard uses), which keeps this
  // black-box for both backends.

  const authed = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: AUTH,
        "Content-Type": "application/json"
      } as Record<string, string>
    });

  try {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`${base}/health`);
        if (r.status === 200) break;
      } catch { /* not ready yet */ }
      await sleep(100);
    }

    // /api/run/start pulls from the store, not the request body — persist
    // profile and gateway first. The gateway defaults to port 8080; both
    // sides must point at this ephemeral instance.
    const putGw = await authed("/api/config/gateway", {
      method: "PUT",
      body: JSON.stringify({
        rest: { baseUrl: base, apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "", forwardBasicAuth: "always" },
        soap: { baseUrl: base, apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "", forwardBasicAuth: "always" }
      })
    });
    expect(putGw.status).toBe(200);
    const putProfile = await authed("/api/config/profile", {
      method: "PUT",
      body: JSON.stringify(profile)
    });
    expect(putProfile.status).toBe(200);

    const start = await authed("/api/run/start", { method: "POST", body: "{}" });
    expect(start.status).toBe(200);
    const { runId } = await start.json() as { runId: string };

    await sleep(seconds * 1000);

    const stop = await authed("/api/run/stop", { method: "POST" });
    expect(stop.status).toBe(200);
    // final batches land after stop: the TS driver flushes synchronously in
    // stop(), the Go worker drains its in-flight set then flushes — plus one
    // results-socket round trip
    await sleep(2500);

    // Volume comes from the generator's own counters, not from the recent
    // tail: that tail is sampled above ~500 rows, so counting it as issued
    // load reads a sampling change as a throughput regression. Read after the
    // drain, when nothing is in flight — mid-run, the two backends differ in
    // when a request joins `sent` versus `ok`, which is not a difference worth
    // asserting on.
    const statusRes = await authed("/api/run/status");
    expect(statusRes.status).toBe(200);
    const { counters } = await statusRes.json() as { counters: RunCounters };

    const recent = await authed(`/api/recent?limit=500`);
    expect(recent.status).toBe(200);
    const body = await recent.json() as { items: RequestResult[] };

    const summaryRes = await authed(`/api/summary?window=15m`);
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json() as MetricSummary;

    return { results: (body.items ?? []).filter((r) => r.runId === runId), counters, summary };
  } finally {
    await built.shutdown();
    server.stop(true);
    delete process.env["LOADGEN_BACKEND"];
    delete process.env["PORT"];
  }
}

describe.skipIf(!HAVE_GO_WORKER)("driver with LOADGEN_BACKEND=go", () => {
  it(
    "ingests batches whose results match the TS contract in shape and volume",
    async () => {
      // Fourteen seconds, not three. The reference stream runs at 2% of the
      // load — 4 observations a second here — and the headline Δ pools only the
      // latency-sensitive classes, which is roughly half of them. A p50 needs
      // 20 on the thinner side, so a shorter run would report the Δ as
      // unavailable and this test would assert nothing about the measurement.
      // Raising the rate instead of the duration is the wrong trade: the TS
      // control shares a process with the SUT, and pushing it to saturation
      // would disqualify the very windows being measured.
      const SECONDS = 14;
      const RPS = 200;
      const expected = SECONDS * RPS;

      const gwProfile = {
        mode: "constant" as const, rps: RPS, maxConcurrency: 100,
        soapRatioPct: 10, invalidRatioPct: 2,
        scenarioWeights: { listPets: 50, getPet: 20, createPet: 10, updatePet: 5, deletePet: 5, placeOrder: 10 }
      };

      // control run: the in-process TS driver against the same shape
      const ts = await runOnce("ts", SECONDS, RPS, gwProfile);
      expect(ts.counters.sent).toBeGreaterThan(expected * 0.6);

      const go = await runOnce("go", SECONDS, RPS, gwProfile);
      const results = go.results;

      // allow a wide but bounded band because the concurrency ceiling and OS
      // scheduling shape the tail
      expect(go.counters.sent).toBeGreaterThan(expected * 0.6);
      expect(go.counters.sent).toBeLessThan(expected * 1.2);
      // nothing may be measured and then quietly discarded
      expect(go.counters.resultsLost).toBe(0);
      expect(ts.counters.resultsLost).toBe(0);

      const sample = results[0]!;
      for (const key of [
        "runId", "requestId", "ts", "protocol", "endpoint", "class", "method", "status",
        "latencyMs", "ttfbMs", "serverMs", "bytesReq", "bytesResp",
        "reachedBackend", "measurementVersion", "error"
      ]) {
        expect(sample).toHaveProperty(key);
      }
      expect(sample.measurementVersion).toBe(MEASUREMENT_VERSION);
      expect(sample.requestId).toMatch(/^[0-9a-f]{32}$/);

      expect(go.counters.ok / go.counters.sent).toBeGreaterThan(0.85);

      // Whenever the response carried the backend's own clock, both must be
      // present: their difference is the residual the store differences against
      // the reference stream, and a missing serverMs on a backend-reached
      // response would charge the request's whole TTFB to the gateway.
      for (const r of results) {
        if (!r.reachedBackend) continue;
        expect(r.serverMs).not.toBeNull();
        expect(r.ttfbMs).not.toBeNull();
      }

      // Both backends must run a direct reference stream and produce a Δ from
      // it. The Go worker previously shipped no overhead measurement at all,
      // so this is the end-to-end assertion that it does now — and that both
      // generators reach the same conclusion about measurability.
      for (const outcome of [go, ts]) {
        const d = outcome.summary.overheadMs;
        expect(d.directSamples).toBeGreaterThan(0);
        expect(d.gwSamples).toBeGreaterThan(0);
        // p50 needs 20 observations on the thinner side. The reference stream
        // runs at 2% of the load, so this is what the run length is sized for.
        expect(d.p50).not.toBeNull();
      }
      // the target here IS the SUT, so the two paths are the same path and the
      // difference must be small — a large Δ would mean the measurement is
      // reading something other than the gateway
      expect(Math.abs(go.summary.overheadMs.p50!)).toBeLessThan(50);

      // invalidRatioPct=2 must actually flow through the Go scheduler
      const invalid = results.filter((r) => r.class === "invalid");
      expect(invalid.length).toBeGreaterThan(0);

      // equivalence with the TS control run: same outcome mix and same
      // delivered volume within a tolerance — both ran at the same rps
      // against the same SUT
      const tsOk = ts.counters.ok / ts.counters.sent;
      const goOk = go.counters.ok / go.counters.sent;
      expect(Math.abs(tsOk - goOk)).toBeLessThan(0.05);
      expect(Math.abs(ts.counters.sent - go.counters.sent) / ts.counters.sent).toBeLessThan(0.1);
    },
    { timeout: 120_000 }
  );

  it("returns to idle after a stop", async () => {
    // The run used to wedge here permanently. stop() moves the driver to
    // "stopping" and then asks the worker to stop; the worker's ack was only
    // accepted while the state was still "running", so the one state the ack
    // could ever arrive in was the one that dropped it. The dashboard showed
    // "stopping" until the process was restarted, and no further run could be
    // started. Asserting on the state after the stop is what catches that —
    // asserting the stop call returns 200 does not, because it always did.
    process.env["LOADGEN_BACKEND"] = "go";
    const built = buildApp({ ...readConfig(), sutBackend: "ts", dbPath: ":memory:", publicDir: "nope" });
    built.driver.setHealthCheck(() => null);
    const server = built.listen(0);
    await built.ready;
    const base = `http://127.0.0.1:${server.port}`;
    const authed = (p: string, init?: RequestInit) =>
      fetch(`${base}${p}`, { ...init, headers: { authorization: AUTH, "Content-Type": "application/json" } });

    try {
      await authed("/api/config/gateway", { method: "PUT", body: JSON.stringify({
        rest: { baseUrl: base, apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "", forwardBasicAuth: "always" },
        soap: { baseUrl: base, apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "", forwardBasicAuth: "always" }
      }) });
      await authed("/api/config/profile", { method: "PUT", body: JSON.stringify({
        mode: "constant", rps: 50, maxConcurrency: 50, soapRatioPct: 10, invalidRatioPct: 2,
        scenarioWeights: { listPets: 50, getPet: 20, createPet: 10, updatePet: 5, deletePet: 5, placeOrder: 10 }
      }) });

      await authed("/api/run/start", { method: "POST", body: "{}" });
      await sleep(3000);
      expect((await (await authed("/api/run/status")).json()).state).toBe("running");

      const stoppedAt = Date.now();
      await authed("/api/run/stop", { method: "POST" });
      // Deliberately generous. A healthy stop lands in a few seconds, but this
      // suite runs servers in parallel and the bound must not become a flake
      // detector — the bug this guards against never reaches idle at all, so
      // any finite bound catches it.
      let state = "";
      for (let i = 0; i < 300; i++) {
        state = (await (await authed("/api/run/status")).json()).state;
        if (state === "idle") break;
        await sleep(200);
      }
      const tookMs = Date.now() - stoppedAt;
      if (state !== "idle") console.error(`[test] still "${state}" after ${tookMs}ms`);
      expect(state).toBe("idle");

      // and the rig is usable again: a wedged run refused the next start
      const restart = await authed("/api/run/start", { method: "POST", body: "{}" });
      expect(restart.status).toBe(200);
      await authed("/api/run/stop", { method: "POST" });
    } finally {
      await built.shutdown();
      server.stop(true);
      delete process.env["LOADGEN_BACKEND"];
    }
  }, { timeout: 180_000 });
});

describe("workerBinaryPath", () => {
  it("resolves per platform when present", () => {
    const p = workerBinaryPath();
    if (HAVE_GO_WORKER) {
      expect(p).toMatch(/gwtester-worker(\.exe)?$/);
    } else {
      expect(p).toBeNull();
    }
  });
});
