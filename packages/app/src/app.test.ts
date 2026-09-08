import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { type AddressInfo } from "node:net";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import type { RequestResult } from "@apigw/shared";

// Auth: tests run with a fixed known credential
process.env["APP_BASIC_AUTH"] = "test:pw-123";
const AUTH = `Basic ${Buffer.from("test:pw-123").toString("base64")}`;

let base: string;
let server: ReturnType<ReturnType<typeof buildApp>["app"]["listen"]>;

async function authed(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: AUTH,
      "Content-Type": "application/json"
    } as Record<string, string>
  });
}

function makeResult(i: number, ts: number, protocol: "rest" | "soap" = "rest", cls = "small-rest"): RequestResult {
  const latencyMs = 50 + (i % 100);
  return {
    runId: "test-run",
    ts,
    protocol,
    endpoint: protocol === "soap" ? "SOAP getPetById" : "GET /api/pets",
    class: cls as RequestResult["class"],
    method: "GET",
    status: i % 10 === 9 ? 500 : 200,
    latencyMs,
    baselineMs: 40,
    overheadMs: Math.max(0, latencyMs - 40),
    bytesReq: 100,
    bytesResp: 500 + i,
    error: i % 10 === 9 ? "chaos" : null
  };
}

beforeAll(async () => {
  const { app } = buildApp({ ...readConfig(), dbPath: ":memory:", publicDir: "nope" });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("apigw-tester app (auth protected)", () => {
  it("anon requests get 401 with Basic realm", async () => {
    const r = await fetch(`${base}/api/summary`);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Basic");
  });

  it("health endpoint is public (for load balancers)", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
  });

  it("petstore REST responds when authorized", async () => {
    const r = await authed("/api/pets?size=2");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.items.length).toBe(2);
  });

  it("petstore SOAP getPetById responds when authorized", async () => {
    const r = await fetch(`${base}/soap/petservice`, {
      method: "POST",
      headers: { "Content-Type": "text/xml", SOAPAction: '"getPetById"', authorization: AUTH },
      body: '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getPetByIdRequest><petId>1</petId></getPetByIdRequest></soap:Body></soap:Envelope>'
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("getPetByIdResponse");
  });

  it("SOAP without auth → 401", async () => {
    const r = await fetch(`${base}/soap/petservice`, {
      method: "POST",
      headers: { "Content-Type": "text/xml", SOAPAction: '"getPetById"' },
      body: '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getPetByIdRequest><petId>1</petId></getPetByIdRequest></soap:Body></soap:Envelope>'
    });
    expect(r.status).toBe(401);
  });

  it("wrong credentials → 401", async () => {
    const r = await fetch(`${base}/api/pets`, {
      headers: { authorization: `Basic ${Buffer.from("test:wrong").toString("base64")}` }
    });
    expect(r.status).toBe(401);
  });

  it("ingests, summarizes and rejects duplicates", async () => {
    const now = Date.now();
    const results = Array.from({ length: 40 }, (_, i) =>
      makeResult(i, now - i * 100, i % 4 === 0 ? "soap" : "rest", i % 4 === 0 ? "soap" : "small-rest")
    );
    const batch = { batchId: "batch-1", results };
    const r = await authed("/api/ingest", {
      method: "POST",
      body: JSON.stringify(batch)
    });
    expect((await r.json()).ingested).toBe(40);

    const dup = await authed("/api/ingest", { method: "POST", body: JSON.stringify(batch) });
    expect((await dup.json()).duplicate).toBe(true);

    const s = await (await authed("/api/summary?window=1h")).json();
    expect(s.total).toBeGreaterThanOrEqual(40);
    expect(s.latencyMs.p50).toBeGreaterThan(0);
    expect(s.overheadMs.p50).toBeGreaterThanOrEqual(0);
    expect(s.perEndpoint.length).toBeGreaterThan(0);
    expect(s.perClass.length).toBeGreaterThan(0);
    expect(s.perProtocol.find((p: { protocol: string }) => p.protocol === "soap")).toBeTruthy();
  });

  it("timeseries and recent are populated", async () => {
    const to = Date.now();
    const ts = await (await authed(`/api/timeseries?bucket=60&from=${to - 3600_000}&to=${to}`)).json();
    expect(ts.points.length).toBeGreaterThan(0);

    const recent = await (await authed("/api/recent?limit=5")).json();
    expect(recent.items.length).toBeGreaterThan(0);
    expect(recent.histogramEdges.length).toBeGreaterThan(30);
  });

  it("gateway config round-trip", async () => {
    const cfg = { baseUrl: "http://example.test", apiKey: "k", apiKeyHeader: "X-Key", pathPrefix: "/gw" };
    await authed("/api/config/gateway", { method: "PUT", body: JSON.stringify(cfg) });
    expect(await (await authed("/api/config/gateway")).json()).toEqual(cfg);
  });

  it("run start/stop transitions", async () => {
    const s = await (await authed("/api/run/status")).json();
    expect(s.state).toBe("idle");
    const started = await (await authed("/api/run/start", { method: "POST", body: "{}" })).json();
    expect(started.runId).toMatch(/^run-/);
    const running = await (await authed("/api/run/status")).json();
    expect(running.state).toBe("running");
    const stopped = await (await authed("/api/run/stop", { method: "POST" })).json();
    expect(stopped.stopped).toBe(true);
  });
});
