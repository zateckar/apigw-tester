import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { buildApp, repointStrandedSelfTargets } from "./app.js";
import { readConfig } from "./config.js";
import { TestDriver } from "./loadgen/testDriver.js";
import { DEFAULT_GW_CONFIG, type GwTargets } from "@apigw/shared";

// These tests are about one failure: the rig pointed at a host that is up and
// answering, but is not the thing under test. Every generated request 404s
// while nothing in the UI looks broken.

process.env["APP_BASIC_AUTH"] = "test:pw-123";
const AUTH = `Basic ${Buffer.from("test:pw-123").toString("base64")}`;

const targets = (baseUrl: string, pathPrefix = ""): GwTargets => ({
  rest: { ...DEFAULT_GW_CONFIG, baseUrl, pathPrefix },
  soap: { ...DEFAULT_GW_CONFIG, baseUrl, pathPrefix }
});

describe("moving a saved target that the SUT has moved out from under", () => {
  const opts = {
    controlPlaneUrl: "http://127.0.0.1:8080",
    servesPetstore: false,
    defaults: targets("http://127.0.0.1:8081")
  };

  it("moves a target still pointing at the control plane's own port", () => {
    const moved = repointStrandedSelfTargets(targets("http://127.0.0.1:8080"), opts);
    expect(moved?.rest.baseUrl).toBe("http://127.0.0.1:8081");
    expect(moved?.soap.baseUrl).toBe("http://127.0.0.1:8081");
  });

  it("keeps everything about the target except where it points", () => {
    const saved = targets("http://127.0.0.1:8080");
    saved.rest = { ...saved.rest, apiKey: "k", apiKeyHeader: "X-Key", forwardBasicAuth: "always" };
    const moved = repointStrandedSelfTargets(saved, opts);
    expect(moved?.rest).toEqual({ ...saved.rest, baseUrl: "http://127.0.0.1:8081" });
  });

  it("leaves a real gateway alone", () => {
    expect(repointStrandedSelfTargets(targets("http://gw.example.test:8080"), opts)).toBeNull();
    expect(repointStrandedSelfTargets(targets("http://127.0.0.1:9000"), opts)).toBeNull();
  });

  it("leaves our own port alone when a prefix says a gateway fronts us there", () => {
    // 8080/gw is not the old self-reference, it is somebody routing through us;
    // retargeting it would move a live measurement off its subject
    expect(repointStrandedSelfTargets(targets("http://127.0.0.1:8080", "/gw"), opts)).toBeNull();
  });

  it("leaves our own port alone while we are the one serving the petstore", () => {
    const saved = targets("http://127.0.0.1:8080");
    expect(repointStrandedSelfTargets(saved, { ...opts, servesPetstore: true })).toBeNull();
  });

  it("reports no change rather than rewriting an already-correct target", () => {
    expect(repointStrandedSelfTargets(targets("http://127.0.0.1:8081"), opts)).toBeNull();
  });

  it("moves only the side that is stranded", () => {
    const saved = targets("http://gw.example.test");
    saved.rest = { ...saved.rest, baseUrl: "http://127.0.0.1:8080" };
    const moved = repointStrandedSelfTargets(saved, opts);
    expect(moved?.rest.baseUrl).toBe("http://127.0.0.1:8081");
    expect(moved?.soap.baseUrl).toBe("http://gw.example.test");
  });
});

describe("the gateway target the dashboard is handed", () => {
  // A SUT on its own port, distinct from the control plane's, is the whole
  // point: the fallback used to be a library constant naming the control
  // plane, so a fresh install displayed — and on save persisted — a target that
  // cannot serve a single request of the run.
  const sutUrl = "http://127.0.0.1:65123";
  let base: string;
  let built: ReturnType<typeof buildApp>;
  let server: ReturnType<ReturnType<typeof buildApp>["listen"]>;

  beforeAll(() => {
    const cfg = readConfig();
    built = buildApp({
      ...cfg,
      sutBackend: "ts",
      dbPath: ":memory:",
      publicDir: "nope",
      defaultGateway: targets(sutUrl)
    }, { driver: new TestDriver() });
    server = built.listen(0);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await built.shutdown();
    server.stop(true);
  }, 30_000);

  it("is where the SUT is, on a store that has never been written to", async () => {
    const r = await fetch(`${base}/api/config/gateway`, { headers: { authorization: AUTH } });
    const gw = (await r.json()) as GwTargets;
    expect(gw.rest.baseUrl).toBe(sutUrl);
    expect(gw.soap.baseUrl).toBe(sutUrl);
    expect(gw.rest.baseUrl).not.toBe(`http://127.0.0.1:${server.port}`);
  });
});

describe("the gateway test button", () => {
  // The bug this exists for: a host that answers /health but serves none of
  // the run's routes reported a confident green, so a target that 404'd every
  // single request looked configured correctly.
  let liveness: ReturnType<typeof Bun.serve>;
  let base: string;
  let built: ReturnType<typeof buildApp>;
  let server: ReturnType<ReturnType<typeof buildApp>["listen"]>;

  const probe = async (baseUrl: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; status?: number; url: string }> => {
    const r = await fetch(`${base}/api/config/gateway/test`, {
      method: "POST",
      headers: { authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ ...DEFAULT_GW_CONFIG, baseUrl, protocol: "rest", ...extra })
    });
    return (await r.json()) as { ok: boolean; status?: number; url: string };
  };

  beforeAll(() => {
    liveness = Bun.serve({
      port: 0,
      fetch: (req) => new URL(req.url).pathname === "/health"
        ? new Response("ok")
        : new Response("not found", { status: 404 })
    });
    built = buildApp({ ...readConfig(), sutBackend: "ts", dbPath: ":memory:", publicDir: "nope" }, { driver: new TestDriver() });
    server = built.listen(0);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    liveness.stop(true);
    await built.shutdown();
    server.stop(true);
  }, 30_000);

  it("fails a host that is alive but serves none of the run's routes", async () => {
    const r = await probe(`http://127.0.0.1:${liveness.port}`);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("probes a route the load actually generates", async () => {
    const r = await probe(`http://127.0.0.1:${liveness.port}`);
    expect(r.url).toContain("/api/pets");
    expect(r.url).not.toContain("/health");
  });

  it("passes a host that serves the petstore", async () => {
    // this app is running the in-process petstore, so it is its own valid
    // target — on an ephemeral port, which "auto" does not recognise as ours,
    // hence the explicit forward of the credential the petstore requires
    const r = await probe(base, { forwardBasicAuth: "always" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });
});
