import { describe, expect, it } from "bun:test";
import { buildApp } from "../app.js";
import { readConfig } from "../config.js";
import { workerBinaryPath } from "./goClient.js";
import {
  MEASUREMENT_VERSION,
  type MetricSummary,
  type RequestResult,
  type RunCounters,
  type RunStatus
} from "@apigw/shared";

// This is the only test that generates real load. Everything else stubs the
// worker out (see TestDriver), so this is where the contract between the two
// processes — result shape, counters, roll-ups, the status surface — is checked
// against traffic that actually happened. Skipped when the binary is absent.
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
  /** the whole status surface the dashboard reads, as the run wound down */
  status: RunStatus;
  /** the store's view of the run, where the histograms are read back */
  summary: MetricSummary;
}

/**
 * Start the full app on an ephemeral port, run a bounded constant-rate load
 * against the bundled petstore (the gateway target defaults to self), then pull
 * the ingested rows back out.
 */
async function runOnce(seconds: number, profile: Record<string, unknown>): Promise<RunOutcome> {
  // selfUrl is what "us" means for forwardBasicAuth: "auto". It defaults to the
  // split-out SUT's own port, so pinning PORT is not enough — this run keeps the
  // petstore in-process, so selfUrl has to be walked back to the app's ephemeral
  // port or the load is issued without the credential the petstore requires.
  const port = freePort();
  process.env["PORT"] = String(port);
  const built = buildApp({
    ...readConfig(),
    // in-process petstore: this test is about the load generator, and spawning
    // a third process would add a variable it is not measuring
    sutBackend: "ts",
    selfUrl: `http://127.0.0.1:${port}`,
    dbPath: ":memory:",
    publicDir: "nope"
  });
  const server = built.listen(port);
  await built.ready; // config loaded; production ingest wired
  const base = `http://127.0.0.1:${server.port}`;

  // Batches land in SQLite through the store's ingest; we pull rows back out
  // via /api/recent (the same read path the dashboard uses), which keeps this
  // black-box: nothing below reaches into the Driver.

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
    // final batches land after stop: the worker drains its in-flight set, then
    // flushes — plus one results-socket round trip
    await sleep(2500);

    // Volume comes from the generator's own counters, not from the recent
    // tail: that tail is sampled above ~500 rows, so counting it as issued
    // load reads a sampling change as a throughput regression. Read after the
    // drain, when nothing is in flight — mid-run a request sits in `sent` but
    // not yet in `ok`, so the ratio below would be asserting on timing.
    const statusRes = await authed("/api/run/status");
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json() as RunStatus;

    const recent = await authed(`/api/recent?limit=500`);
    expect(recent.status).toBe(200);
    const body = await recent.json() as { items: RequestResult[] };

    const summaryRes = await authed(`/api/summary?window=15m`);
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json() as MetricSummary;

    return {
      results: (body.items ?? []).filter((r) => r.runId === runId),
      counters: status.counters,
      status,
      summary
    };
  } finally {
    await built.shutdown();
    server.stop(true);
    delete process.env["PORT"];
  }
}

describe.skipIf(!HAVE_GO_WORKER)("the Go load generator, end to end", () => {
  it(
    "ingests batches whose results carry the full measurement contract",
    async () => {
      // There was a second run here, driving the same shape through an
      // in-process TS generator, and two assertions comparing the two. That
      // generator is gone, and the comparison was largely redundant anyway: the
      // absolute bands below (delivered volume, ok ratio) say the same thing
      // without needing a second implementation to say it against. The run is
      // long enough to put every scenario class and the invalid slice through
      // the scheduler several times over.
      const SECONDS = 14;
      const RPS = 200;
      const expected = SECONDS * RPS;

      const gwProfile = {
        mode: "constant" as const, rps: RPS, maxConcurrency: 100,
        soapRatioPct: 10, invalidRatioPct: 2,
        scenarioWeights: { listPets: 50, getPet: 20, createPet: 10, updatePet: 5, deletePet: 5, placeOrder: 10 }
      };

      const go = await runOnce(SECONDS, gwProfile);
      const results = go.results;

      // allow a wide but bounded band because the concurrency ceiling and OS
      // scheduling shape the tail
      expect(go.counters.sent).toBeGreaterThan(expected * 0.6);
      expect(go.counters.sent).toBeLessThan(expected * 1.2);
      // nothing may be measured and then quietly discarded
      expect(go.counters.resultsLost).toBe(0);

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
      // present: their difference is the request's non-backend time, and a
      // missing serverMs on a backend-reached response would charge the
      // request's whole TTFB to the gateway.
      for (const r of results) {
        if (!r.reachedBackend) continue;
        expect(r.serverMs).not.toBeNull();
        expect(r.ttfbMs).not.toBeNull();
      }

      // Non-backend time is measured on the load itself, with no second stream
      // to difference against. The count is the assertion that matters: it is
      // per-request, so it tracks the traffic rather than a 2% slice of it, and
      // a percentile therefore exists at any rate.
      const nb = go.summary.nonBackendMs;
      expect(nb.count).toBeGreaterThan(go.counters.ok * 0.8);
      expect(nb.p50).not.toBeNull();
      expect(nb.p99).not.toBeNull();
      // the target here IS the SUT, so there is no gateway in the path and the
      // number must be small — a large one would mean the measurement is
      // reading something other than time spent outside the backend handler
      expect(Math.abs(nb.p50!)).toBeLessThan(50);

      // invalidRatioPct=2 must actually flow through the Go scheduler
      const invalid = results.filter((r) => r.class === "invalid");
      expect(invalid.length).toBeGreaterThan(0);

      // the ceiling the worker applied reaches the status surface. This was
      // reported from the retired in-process path, so every real run showed the
      // default rather than the configured 100.
      expect(go.status.effectiveMaxConcurrency).toBe(100);
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
    const built = buildApp({ ...readConfig(), sutBackend: "ts", dbPath: ":memory:", publicDir: "nope" });
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
