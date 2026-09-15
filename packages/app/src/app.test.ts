import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import { POLICY_LIMITS, type RequestResult, type SystemMetrics } from "@apigw/shared";

// Auth: tests run with a fixed known credential
process.env["APP_BASIC_AUTH"] = "test:pw-123";
const AUTH = `Basic ${Buffer.from("test:pw-123").toString("base64")}`;

let base: string;
let server: ReturnType<ReturnType<typeof buildApp>["listen"]>;

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
  const built = buildApp({ ...readConfig(), dbPath: ":memory:", publicDir: "nope" });
  server = built.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
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

  it("GET /api/system is behind auth and reports current + history", async () => {
    expect((await fetch(`${base}/api/system`)).status).toBe(401);

    const r = await authed("/api/system");
    expect(r.status).toBe(200);
    const m = (await r.json()) as SystemMetrics;
    expect(m.current.memTotalBytes).toBeGreaterThan(0);
    expect(m.current.memUsedBytes).toBeGreaterThan(0);
    expect(m.current.procRssBytes).toBeGreaterThan(0);
    // CPU is a capacity share or null before the second tick — never garbage
    if (m.current.cpuProcessPct !== null) {
      expect(m.current.cpuProcessPct).toBeGreaterThanOrEqual(0);
      expect(m.current.cpuProcessPct).toBeLessThanOrEqual(100);
    }
    expect(Array.isArray(m.history)).toBe(true);
    for (const s of m.history) expect(s.ts).toBeGreaterThan(0);
  });

  it("health identifies the build without leaking anything else", async () => {
    const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(typeof body["version"]).toBe("string");
    expect(body["version"]).not.toBe("unknown");
    expect(typeof body["uptimeSec"]).toBe("number");
    // nothing an anonymous caller could use to learn about the target or the run
    expect(Object.keys(body).sort()).toEqual(["status", "uptimeSec", "version"]);
  });

  it("sends security headers on every response, authed or not", async () => {
    for (const res of [await fetch(`${base}/health`), await fetch(`${base}/api/summary`), await authed("/api/summary")]) {
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("x-powered-by")).toBeNull();
      // no HSTS over a plain-HTTP hop — it would pin a client that has no https origin
      expect(res.headers.get("strict-transport-security")).toBeNull();
    }
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
    const cfg = {
      rest: { baseUrl: "http://example.test", apiKey: "k", apiKeyHeader: "X-Key", pathPrefix: "/gw", forwardBasicAuth: "never" },
      soap: { baseUrl: "http://soap.example.test", apiKey: "s", apiKeyHeader: "X-Soap-Key", pathPrefix: "", forwardBasicAuth: "always" }
    };
    await authed("/api/config/gateway", { method: "PUT", body: JSON.stringify(cfg) });
    expect(await (await authed("/api/config/gateway")).json()).toEqual(cfg);
  });

  it("never probes a foreign gateway with our own Basic credential", async () => {
    // the probe box takes an arbitrary operator-supplied URL; under "auto" it
    // must not become a way to post the dashboard credential to a third party
    const probe = async (forwardBasicAuth: string) => {
      const r = await authed("/api/config/gateway/test", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: "http://127.0.0.1:1", apiKey: "", apiKeyHeader: "X-API-Key",
          pathPrefix: "", forwardBasicAuth
        })
      });
      return (await r.json()) as { sentBasicAuth: boolean };
    };
    expect((await probe("auto")).sentBasicAuth).toBe(false);
    expect((await probe("never")).sentBasicAuth).toBe(false);
    // explicit opt-in still works, for a gateway that expects to pass it through
    expect((await probe("always")).sentBasicAuth).toBe(true);
  });

  it("rejects anonymous callers before parsing their body", async () => {
    // a body-parser-first ordering would answer 400 (bad JSON) and burn the
    // parse; the auth gate must answer 401 without ever looking at the body
    const r = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not json"
    });
    expect(r.status).toBe(401);
  });

  it("clamps a hostile load profile instead of persisting it", async () => {
    const r = await authed("/api/config/profile", {
      method: "PUT",
      body: JSON.stringify({
        mode: "constant", rps: 1e12, maxConcurrency: 0,
        soapRatioPct: 999, invalidRatioPct: -4,
        scenarioWeights: { listPets: -1, getPet: 0, createPet: 0, updatePet: 0, deletePet: 0, placeOrder: 0 }
      })
    });
    expect(r.status).toBe(200);
    const saved = (await (await authed("/api/config/profile")).json()) as {
      rps: number; maxConcurrency: number; soapRatioPct: number; invalidRatioPct: number;
    };
    expect(saved.maxConcurrency).toBeGreaterThanOrEqual(1);
    expect(saved.rps).toBeLessThanOrEqual(10_000);
    expect(saved.soapRatioPct).toBe(100);
    expect(saved.invalidRatioPct).toBe(0);
  });

  it("rejects a non-object profile body", async () => {
    const r = await authed("/api/config/profile", { method: "PUT", body: JSON.stringify([1, 2, 3]) });
    expect(r.status).toBe(400);
  });

  it("rejects a gateway config that is not an absolute http(s) URL", async () => {
    const good = { baseUrl: "http://example.test", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "" };
    for (const baseUrl of ["", "not a url", "file:///etc/passwd", "ftp://x/y"]) {
      for (const side of ["rest", "soap"] as const) {
        const r = await authed("/api/config/gateway", {
          method: "PUT",
          body: JSON.stringify({ rest: { ...good }, soap: { ...good }, [side]: { ...good, baseUrl } })
        });
        expect(r.status, `${side} ${baseUrl}`).toBe(400);
        const body = (await r.json()) as { error: string };
        expect(body.error.startsWith(`${side}.`), body.error).toBe(true);
      }
    }
  });

  it("validates query parameters instead of letting them reach SQL", async () => {
    expect((await authed("/api/summary?window=99y")).status).toBe(400);
    expect((await authed("/api/recent?limit=-1")).status).toBe(400);
    expect((await authed("/api/recent?limit=abc")).status).toBe(400);
    expect((await authed("/api/recent?limit=99999")).status).toBe(400);
    expect((await authed("/api/timeseries?bucket=7")).status).toBe(400);
    expect((await authed("/api/timeseries?from=abc&to=1")).status).toBe(400);
  });

  it("clamps an enormous timeseries span rather than allocating it", async () => {
    const r = await authed(`/api/timeseries?bucket=60&from=0&to=${Date.now()}`);
    expect(r.status).toBe(200);
    const ts = (await r.json()) as { points: unknown[]; truncated?: boolean };
    expect(ts.points.length).toBeLessThanOrEqual(10_000);
    expect(ts.truncated).toBe(true);
  });

  it("petstore rejects requests that violate the published contract", async () => {
    const cases: [string, RequestInit, number][] = [
      ["/api/pets?status=teleported", {}, 400],
      ["/api/pets?size=9999", {}, 400],
      ["/api/pets?size=abc", {}, 400],
      ["/api/pets/not-a-number", {}, 400],
      ["/api/pets", { method: "POST", body: JSON.stringify({ status: "available" }) }, 400],
      ["/api/pets", { method: "POST", body: JSON.stringify({ name: 12345 }) }, 400],
      ["/api/pets", { method: "POST", body: JSON.stringify({ name: "x", status: "liquidated" }) }, 400],
      ["/api/store/order", { method: "POST", body: JSON.stringify({ petId: "1" }) }, 400],
      ["/api/slow/999999", {}, 400],
      ["/api/big/99999999999", {}, 400]
    ];
    for (const [path, init, want] of cases) {
      const r = await authed(path, init);
      expect(r.status, `${path}`).toBe(want);
    }
  });

  it("a poisoned pet name cannot break the SOAP endpoint", async () => {
    // the store used to accept any JSON type for name, and esc() then threw,
    // returning an HTML 500 for every SOAP call touching that pet
    const bad = await authed("/api/pets/3", { method: "PUT", body: JSON.stringify({ name: 12345 }) });
    expect(bad.status).toBe(400);

    const injected = await authed("/api/pets", {
      method: "POST",
      body: JSON.stringify({ name: "Evil</name><injected>&" })
    });
    expect(injected.status).toBe(201);
    const id = ((await injected.json()) as { id: number }).id;

    const soap = await fetch(`${base}/soap/petservice`, {
      method: "POST",
      headers: { "Content-Type": "text/xml", SOAPAction: '"getPetById"', authorization: AUTH },
      body: `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getPetByIdRequest><petId>${id}</petId></getPetByIdRequest></soap:Body></soap:Envelope>`
    });
    expect(soap.status).toBe(200);
    const xml = await soap.text();
    expect(xml).toContain("&lt;/name&gt;");   // escaped, not injected
    expect(xml).not.toContain("<injected>");
  });

  it("stamps every SUT response with its own server time (X-Server-Ms)", async () => {
    // the driver pairs this per request to subtract backend latency from GW
    // overhead — cover all three emission paths: variability, raw stress, SOAP
    for (const path of ["/api/pets/1", "/api/slow/30", "/api/big/1024", "/api/echo"]) {
      const init: RequestInit = path === "/api/echo" ? { method: "POST", body: JSON.stringify({ x: 1 }) } : {};
      const r = await authed(path, init);
      const v = Number(r.headers.get("x-server-ms"));
      expect(Number.isFinite(v), path).toBe(true);
      expect(v, path).toBeGreaterThanOrEqual(0);
    }
    const slow = await authed("/api/slow/120");
    expect(Number(slow.headers.get("x-server-ms"))).toBeGreaterThanOrEqual(100);

    const soap = await authed("/soap/petservice", {
      method: "POST",
      headers: { "Content-Type": "text/xml", SOAPAction: '"getPetById"' },
      body: `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getPetByIdRequest><petId>1</petId></getPetByIdRequest></soap:Body></soap:Envelope>`
    });
    expect(Number.isFinite(Number(soap.headers.get("x-server-ms")))).toBe(true);
  });

  it("honours X-Test-Delay-Ms and caps X-Test-Size-B", async () => {
    // the *bound* on the delay is unit-tested in petstore/contract.test.ts — waiting
    // out the real 30 s clamp here would dominate the suite. This only proves the
    // header is wired through at all.
    const started = Date.now();
    const r = await authed("/api/pets/1", { headers: { "X-Test-Delay-Ms": "250" } });
    expect(r.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);

    const padded = await authed("/api/pets/1", { headers: { "X-Test-Size-B": "1099511627776" } });
    expect(padded.status).toBe(200);
    const body = await padded.text();
    expect(body.length).toBeLessThanOrEqual(11 * 1024 * 1024);
  }, 20_000);

  it("rejects an unvalidated admin latency profile", async () => {
    const r = await authed("/admin/latency-profile", {
      method: "PATCH",
      body: JSON.stringify({ "get-pet": { kind: "normal", meanMs: "abc", stddevMs: 5 } })
    });
    expect(r.status).toBe(400);
    const proto = await authed("/admin/latency-profile", {
      method: "PATCH",
      body: JSON.stringify({ __proto__: { kind: "fixed", ms: 1 } })
    });
    expect([200, 400]).toContain(proto.status);
  });

  it("rejects Object.prototype keys as a summary window", async () => {
    // a plain-object lookup table resolves `constructor` to a function, which is
    // not undefined — the guard has to reject it, not hand NaN to the store
    for (const win of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const r = await authed(`/api/summary?window=${encodeURIComponent(win)}`);
      expect(r.status, win).toBe(400);
    }
    // a repeated parameter arrives as an array, not a string
    expect((await authed("/api/summary?window=5m&window=1h")).status).toBe(400);
  });

  it("normalises the ?server= override before reflecting it into the definitions", async () => {
    const hostile = [
      'http://x" fake="y',        // would break out of the XML attribute
      "javascript:alert(1)",      // not an http(s) origin
      "http://gw.example.com/a<b>c",
      "not a url"
    ];
    for (const server of hostile) {
      const wsdl = await (await authed(`/api/definitions/petservice.wsdl?server=${encodeURIComponent(server)}`)).text();
      // check the whole document, not just the captured attribute: an injected
      // attribute lands *outside* the capture group and would otherwise pass
      expect(wsdl, server).not.toContain("fake=");
      const location = /<soap:address location="([^"]*)"/.exec(wsdl)?.[1];
      expect(location, server).toBeTruthy();
      expect(location, server).not.toContain("<");
      expect(location, server).not.toContain("javascript:");
      // whatever survived is still a usable absolute URL
      expect(() => new URL((location as string).replace(/&amp;/g, "&")), server).not.toThrow();

      const doc = (await (await authed(`/api/definitions/openapi.json?server=${encodeURIComponent(server)}`)).json()) as {
        servers: { url: string }[];
      };
      expect(doc.servers[0]?.url, server).toMatch(/^https?:\/\//);
    }
  });

  it("honours a well-formed ?server= override and escapes it for XML", async () => {
    const wsdl = await (await authed("/api/definitions/petservice.wsdl?server=https%3A%2F%2Fgw.example.com%2Fv1%2F")).text();
    expect(wsdl).toContain('location="https://gw.example.com/v1/soap/petservice"');

    const doc = (await (await authed("/api/definitions/openapi.json?server=https%3A%2F%2Fgw.example.com%2Fv1%2F")).json()) as {
      servers: { url: string }[];
    };
    expect(doc.servers[0]?.url).toBe("https://gw.example.com/v1");

    // `&` is legal in a URL path but must not appear raw in an XML attribute,
    // and `$&` must not be expanded by the replace()
    const amp = await (await authed("/api/definitions/petservice.wsdl?server=https%3A%2F%2Fgw.example.com%2Fp%24%26q")).text();
    expect(amp).toContain('location="https://gw.example.com/p$&amp;q/soap/petservice"');
    expect(amp).not.toContain("__SERVICE_LOCATION__");
  });

  it("probes a gateway server-side, since the dashboard CSP forbids cross-origin fetch", async () => {
    const probe = async (cfg: Record<string, unknown>) =>
      authed("/api/config/gateway/test", { method: "POST", body: JSON.stringify(cfg) });

    // reachable: point it at ourselves, whose /health is public; protocol selects
    // which persisted side the probe falls back to and is otherwise inert here
    const ok = (await (await probe({ protocol: "soap", baseUrl: base, apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "" })).json()) as {
      ok: boolean; status: number; url: string; latencyMs: number;
    };
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(200);
    expect(ok.url).toBe(`${base}/health`);
    expect(typeof ok.latencyMs).toBe("number");

    // the probe walks the same base+prefix path the driver will use
    const prefixed = (await (await probe({ baseUrl: base, apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "/v1" })).json()) as {
      url: string;
    };
    expect(prefixed.url).toBe(`${base}/v1/health`);

    // unreachable reports a reason instead of throwing
    const dead = (await (await probe({ baseUrl: "http://127.0.0.1:1", apiKey: "", apiKeyHeader: "X-API-Key", pathPrefix: "" })).json()) as {
      ok: boolean; error: string;
    };
    expect(dead.ok).toBe(false);
    expect(typeof dead.error).toBe("string");

    // and an unusable config is a 400, not a probe
    expect((await probe({ baseUrl: "ftp://x/y" })).status).toBe(400);
  }, 20_000);

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

  it("resets metrics and runs but keeps config", async () => {
    // the earlier tests have ingested data by now; make sure the primitives agree
    const before = await (await authed("/api/summary?window=24h")).json();
    expect(before.total).toBeGreaterThan(0);

    const r = await authed("/api/metrics/reset", { method: "POST" });
    expect(r.status).toBe(200);

    const after = await (await authed("/api/summary?window=24h")).json();
    expect(after.total).toBe(0);
    expect(await (await authed("/api/runs")).json()).toEqual([]);
    const recent = await (await authed("/api/recent?limit=5")).json();
    expect(recent.items).toEqual([]);
    // gateway/profile rows are settings, not metrics — they survive
    const gw = await (await authed("/api/config/gateway")).json();
    expect(gw.rest.baseUrl).toBeTruthy();
  });

  it("refuses to reset metrics while a run is live", async () => {
    await authed("/api/run/start", { method: "POST", body: "{}" });
    const r = await authed("/api/metrics/reset", { method: "POST" });
    expect(r.status).toBe(409);
    await authed("/api/run/stop", { method: "POST" });
    expect((await authed("/api/metrics/reset", { method: "POST" })).status).toBe(200);
  });

  it("refuses an on-demand policy pass while probing is disabled", async () => {
    // otherwise the caller gets a 202 and waits for results that will never come
    await authed("/api/policy", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    const off = await authed("/api/policy/run", { method: "POST" });
    expect(off.status).toBe(409);
    expect((await off.json()).error).toMatch(/disabled/);

    const saved = await authed("/api/policy", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, intervalSec: 1, required: ["rate-limit", "not-a-policy"] })
    });
    const cfg = (await saved.json()).config;
    // the interval is clamped and the unknown id dropped, rather than stored raw
    expect(cfg.intervalSec).toBe(POLICY_LIMITS.minIntervalSec);
    expect(cfg.required).toEqual(["rate-limit"]);
    await authed("/api/policy", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  });

  it("round-trips SLO thresholds and keeps 'not asserted' distinct from zero", async () => {
    const r = await authed("/api/config/slo", {
      method: "PUT",
      body: JSON.stringify({ maxOverheadP95Ms: null, maxUnexpectedFailurePct: 0, maxLeakedToBackend: 5 })
    });
    const slo = (await r.json()).slo;
    expect(slo.maxOverheadP95Ms).toBeNull();
    expect(slo.maxUnexpectedFailurePct).toBe(0);
    expect(slo.maxLeakedToBackend).toBe(5);
    expect((await (await authed("/api/config/slo")).json()).maxLeakedToBackend).toBe(5);
    expect((await authed("/api/config/slo", { method: "PUT", body: "[]" })).status).toBe(400);
  });

  it("reports on a finished run and 404s an unknown one", async () => {
    const started = (await (await authed("/api/run/start", { method: "POST", body: "{}" })).json()) as { runId: string };
    await authed("/api/run/stop", { method: "POST" });

    const report = await (await authed(`/api/runs/${started.runId}/report`)).json();
    expect(report.runId).toBe(started.runId);
    expect(["pass", "fail", "inconclusive"]).toContain(report.verdict.state);
    expect(report.gateway.rest.apiKey === "" || report.gateway.rest.apiKey === "[redacted]").toBe(true);

    const md = await authed(`/api/runs/${started.runId}/report.md`);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(md.headers.get("content-disposition")).toContain(`${started.runId}-report.md`);
    expect(await md.text()).toContain("# Gateway test report");

    expect((await authed("/api/runs/nope/report")).status).toBe(404);
    expect((await authed("/api/runs/nope/report.md")).status).toBe(404);
  });

  it("prunes old runs and rejects nonsense day counts", async () => {
    await authed("/api/run/start", { method: "POST", body: "{}" });
    await authed("/api/run/stop", { method: "POST" });
    const runs = (await (await authed("/api/runs")).json()) as unknown[];
    expect(runs.length).toBeGreaterThan(0);

    for (const bad of [{ olderThanDays: "x" }, { olderThanDays: 0 }, { olderThanDays: -3 }, {}]) {
      expect((await authed("/api/runs/prune", { method: "POST", body: JSON.stringify(bad) })).status).toBe(400);
    }
    // everything we recorded just now is younger than the horizon
    const kept = (await (await authed("/api/runs/prune", {
      method: "POST", body: JSON.stringify({ olderThanDays: 30 })
    })).json()) as { deleted: number };
    expect(kept.deleted).toBe(0);
    expect(((await (await authed("/api/runs")).json()) as unknown[]).length).toBe(runs.length);
  });
});
