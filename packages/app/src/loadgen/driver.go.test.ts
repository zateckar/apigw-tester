import { describe, expect, it } from "bun:test";
import { buildApp } from "../app.js";
import { readConfig } from "../config.js";
import { workerBinaryPath } from "./goClient.js";
import type { RequestResult } from "@apigw/shared";

// This integration test exercises Driver against the Go worker end-to-end.
// Both cases are skipped when the worker binary is absent (dev machines
// without Go installed); the ts-control case guards regressions in shape.
const HAVE_GO_WORKER = workerBinaryPath() !== null;

process.env["APP_BASIC_AUTH"] = "test:pw-123";
const AUTH = `Basic ${Buffer.from("test:pw-123").toString("base64")}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
): Promise<RequestResult[]> {
  process.env["LOADGEN_BACKEND"] = backend;
  const built = buildApp({ ...readConfig(), dbPath: ":memory:", publicDir: "nope" });
  const server = built.listen(0);
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

    const recent = await authed(`/api/recent?limit=500`);
    expect(recent.status).toBe(200);
    const body = await recent.json() as { items: RequestResult[] };
    return (body.items ?? []).filter((r) => r.runId === runId);
  } finally {
    await built.shutdown();
    server.stop(true);
    delete process.env["LOADGEN_BACKEND"];
  }
}

describe.skipIf(!HAVE_GO_WORKER)("driver with LOADGEN_BACKEND=go", () => {
  it(
    "ingests batches whose results match the TS contract in shape and volume",
    async () => {
      const gwProfile = {
        mode: "constant" as const, rps: 200, maxConcurrency: 100,
        soapRatioPct: 10, invalidRatioPct: 2,
        scenarioWeights: { listPets: 50, getPet: 20, createPet: 10, updatePet: 5, deletePet: 5, placeOrder: 10 }
      };

      // control run: the in-process TS driver against the same shape
      const tsResults = await runOnce("ts", 3, 200, gwProfile);
      expect(tsResults.length).toBeGreaterThan(600 * 0.6);

      const results = await runOnce("go", 3, 200, gwProfile);

      // 3s at 200rps ≈ 600 issued; allow a wide but bounded band because the
      // concurrency ceiling and OS scheduling shape the tail
      expect(results.length).toBeGreaterThan(600 * 0.6);
      expect(results.length).toBeLessThan(600 * 1.2);

      const sample = results[0]!;
      for (const key of [
        "runId", "requestId", "ts", "protocol", "endpoint", "class", "method", "status",
        "latencyMs", "ttfbMs", "baselineMs", "overheadMs", "overheadReason", "bytesReq", "bytesResp",
        "reachedBackend", "measurementVersion", "error"
      ]) {
        expect(sample).toHaveProperty(key);
      }
      expect(sample.measurementVersion).toBe(2);
      expect(sample.requestId).toMatch(/^[0-9a-f]{32}$/);

      const ok = results.filter((r) => r.status >= 200 && r.status < 400).length;
      expect(ok / results.length).toBeGreaterThan(0.85);

      // invalidRatioPct=2 must actually flow through the Go scheduler
      const invalid = results.filter((r) => r.class === "invalid");
      expect(invalid.length).toBeGreaterThan(0);

      // shape equivalence with the TS control run: identical outcome mix
      // within a tolerance — both ran at the same rps against the same SUT
      const tsOk = tsResults.filter((r) => r.status >= 200 && r.status < 400).length / tsResults.length;
      const goOk = results.filter((r) => r.status >= 200 && r.status < 400).length / results.length;
      expect(Math.abs(tsOk - goOk)).toBeLessThan(0.05);
      expect(Math.abs(tsResults.length - results.length) / tsResults.length).toBeLessThan(0.1);
    },
    { timeout: 60_000 }
  );
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
