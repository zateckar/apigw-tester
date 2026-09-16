import { createMetricsClient, type AsyncMetricsStore } from "./metrics/client.js";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type MetricsStore, HISTOGRAM_EDGES } from "./metrics/server.js";
import { createSystemSampler, type SystemSampler } from "./metrics/system.js";
import { createPetstoreRoutes, SERVER_MS_HEADER, type Handler, type RouteCtx } from "./petstore/server.js";
import { buildOpenApiDocument, toYaml } from "./petstore/openapi.js";
import { WSDL } from "./petstore/soap.js";
import { Driver, type Driver as DriverType } from "./loadgen/driver.js";
import { readConfig, type AppConfig } from "./config.js";
import { requireAuth, readBasicAuthCreds } from "./auth.js";
import {
  LIMITS,
  sanitizeGwConfig,
  sanitizeGwTargets,
  sanitizeLoadProfile,
  sanitizePolicyConfig,
  sanitizeSlo,
  validateGwConfig,
  validateGwTargets
} from "@apigw/shared";
import { DEFAULT_GW_TARGETS, DEFAULT_LOAD_PROFILE } from "@apigw/shared";
import type { GwConfig, RunReport } from "@apigw/shared";
import { runPolicyProbes } from "./loadgen/policy.js";
import { buildRunReport, renderRunReportMarkdown } from "./report.js";

export interface BuiltApp {
  /** Bun-native request handler — pass to Bun.serve or call directly in tests. */
  fetch: (req: Request) => Promise<Response>;
  /** Ephemeral test server: Bun.serve on the given port (0 = random). */
  listen: (port: number) => ReturnType<typeof Bun.serve>;
  store: AsyncMetricsStore;
  driver: DriverType;
  sampler: SystemSampler;
  shutdown: () => Promise<void>;
}

/**
 * Version of the running build, for /health.
 */
const VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const STARTED_AT = Date.now();

/** How long POST /api/config/gateway/test waits before calling a gateway unreachable. */
const GATEWAY_PROBE_TIMEOUT_MS = 5_000;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

const SUMMARY_WINDOWS: Record<string, number> = Object.assign(Object.create(null) as object, {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000
}) as Record<string, number>;

function xmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeServerUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export function forwardsBasicAuth(target: GwConfig, selfUrl: string): boolean {
  if (target.forwardBasicAuth === "always") return true;
  if (target.forwardBasicAuth === "never") return false;
  const self = originOf(selfUrl);
  const theirs = originOf(target.baseUrl);
  return self !== null && theirs !== null && self === theirs;
}

/** Baseline response headers + request id; HSTS only once TLS terminates in
 *  front of us — mirrored from the Express middleware, including the exact
 *  header set the CI smoke suite greps for. Never set x-powered-by.
 *  The five constant headers are pre-baked once; per-request work is the HSTS
 *  check and the server-ms stamp. Original parse of req.url for the proto is
 *  gone: the caller already has the URL and passes the protocol down. */
const STATIC_SECURITY_HEADERS: readonly [string, string][] = [
  ["Content-Security-Policy", CSP],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Cross-Origin-Opener-Policy", "same-origin"]
];

function applySecurityHeaders(proto: string, headers: Headers): void {
  for (const [k, v] of STATIC_SECURITY_HEADERS) headers.set(k, v);
  if (proto === "https") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

interface ParsedRoute {
  method: string;
  segments: string[];
  def: { handler: Handler; body?: "json" | "text" | "arrayBuffer" };
}

function compileRoutes(table: Record<string, Handler | { handler: Handler; body?: "json" | "text" | "arrayBuffer" }>): ParsedRoute[] {
  const out: ParsedRoute[] = [];
  for (const [key, val] of Object.entries(table)) {
    const i = key.indexOf(" ");
    const method = key.slice(0, i);
    const path = key.slice(i + 1);
    const def = typeof val === "function" ? { handler: val } : val;
    out.push({ method, segments: path.split("/").filter(Boolean), def });
  }
  return out;
}

function match(route: ParsedRoute, method: string, segs: string[]): Record<string, string> | null {
  if (route.method !== method || route.segments.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const rs = route.segments[i] as string;
    const seg = segs[i] as string;
    if (rs.startsWith(":")) params[rs.slice(1)] = decodeURIComponent(seg);
    else if (rs !== seg) return null;
  }
  return params;
}

const json = (status: number, body: unknown, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

export function buildApp(cfg: AppConfig): BuiltApp {
  // ---------------- SUT: petstore ----------------
  const petstore = createPetstoreRoutes();

  // ---------------- metrics store (in-process) ----------------
  const store = createMetricsClient(cfg.dbPath);

  // host/process sampler for /api/system — memory-only, no DB writes
  const sampler = createSystemSampler();

  // ---------------- load driver (in-process) ----------------
  const driver = new Driver();
  sampler.start();
  driver.setHealthCheck((from, to) => {
    if (sampler.latest().ts < to) sampler.sampleNow();
    return sampler.qualityBetween(from, to);
  });
  driver.setIngest(async (batch) => {
    sampler.noteBatch(batch);
    return await store.ingestBatch(batch);
  });
  driver.setBaselineUrl(cfg.selfUrl);
  driver.onAutoStop((runId) => { if (runId) void store.recordRunStop(runId).catch(e => console.error("[metrics] run stop failed", e)); });

  const healthTimer = setInterval(async () => {
    try { await store.recordHealth(sampler.latest()); } catch (e) {
      console.error("[metrics] health sample failed:", (e as Error).message);
    }
  }, 2000);
  healthTimer.unref?.();

  // ---------------- gateway policy probes ----------------
  let policyTimer: ReturnType<typeof setInterval> | null = null;
  let policyRunning = false;

  const runPolicies = async (): Promise<void> => {
    if (policyRunning) return;
    policyRunning = true;
    try {
      const pcfg = await store.readPolicyConfig();
      if (!pcfg.enabled) return;
      const results = await runPolicyProbes(driver.policyContext(), pcfg);
      await store.writePolicyResults(results);
    } catch (e) {
      console.error("[policy] probe pass failed:", (e as Error).message);
    } finally {
      policyRunning = false;
    }
  };

  const schedulePolicies = async (): Promise<void> => {
    if (policyTimer) clearInterval(policyTimer);
    const pcfg = await store.readPolicyConfig();
    if (!pcfg.enabled) { policyTimer = null; return; }
    policyTimer = setInterval(() => void runPolicies(), pcfg.intervalSec * 1000);
    policyTimer.unref?.();
  };
  const ready = (async () => {
    await schedulePolicies();
    const savedGw = await store.readGateway();
    const savedProfile = await store.readProfile();
    driver.setGw(sanitizeGwTargets(savedGw ?? cfg.defaultGateway, cfg.defaultGateway));
    driver.setProfile(sanitizeLoadProfile(savedProfile ?? cfg.defaultProfile, cfg.defaultProfile));
    if (!savedGw) await store.writeGateway(cfg.defaultGateway);
    if (!savedProfile) await store.writeProfile(cfg.defaultProfile);
    void driver.init().catch(e => console.error("driver init failed", e));
  })();
  void ready.catch(e => console.error("[metrics] initialization failed", e));

  // ---------------- API contract definitions ----------------
  const specServerUrl = async (query: URLSearchParams, protocol: "rest" | "soap"): Promise<string> => {
    const fallback = normalizeServerUrl(cfg.defaultGateway[protocol].baseUrl) ?? `http://127.0.0.1:${cfg.port}`;
    const override = query.get("server");
    if (typeof override === "string" && override.trim() !== "") {
      return normalizeServerUrl(override) ?? fallback;
    }
    const gw = sanitizeGwTargets(await store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway)[protocol];
    const prefix = gw.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return normalizeServerUrl(`${gw.baseUrl.replace(/\/+$/, "")}${prefix ? "/" + prefix : ""}`) ?? fallback;
  };

  let startingRun = false;

  // ---------------- route table ----------------
  const appRoutes: Record<string, Handler | { handler: Handler; body?: "json" | "text" | "arrayBuffer" }> = {
    "GET /health": async () => json(200, { status: "ok", version: VERSION, uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000) }),

    "GET /api/definitions": async (ctx) =>
      json(200, {
        openapiJson: "/api/definitions/openapi.json",
        openapiYaml: "/api/definitions/openapi.yaml",
        wsdl: "/api/definitions/petservice.wsdl",
        serverUrl: await specServerUrl(ctx.query, "rest"),
        serverUrlSoap: await specServerUrl(ctx.query, "soap"),
        note: "Import these into the gateway under test to enable request/response validation. Override the advertised server with ?server=https://your-gw/base"
      }),

    "GET /api/definitions/openapi.json": async (ctx) =>
      new Response(JSON.stringify(buildOpenApiDocument({ serverUrl: await specServerUrl(ctx.query, "rest") }), null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="apigw-tester-openapi.json"'
        }
      }),

    "GET /api/definitions/openapi.yaml": async (ctx) =>
      new Response(toYaml(buildOpenApiDocument({ serverUrl: await specServerUrl(ctx.query, "rest") })), {
        headers: {
          "Content-Type": "application/yaml",
          "Content-Disposition": 'attachment; filename="apigw-tester-openapi.yaml"'
        }
      }),

    "GET /api/definitions/petservice.wsdl": async (ctx) => {
      const location = `${await specServerUrl(ctx.query, "soap")}/soap/petservice`;
      return new Response(WSDL.replace("__SERVICE_LOCATION__", () => xmlAttr(location)), {
        headers: { "Content-Type": "text/xml", "Content-Disposition": 'attachment; filename="petservice.wsdl"' }
      });
    },

    "GET /api/health": async () => json(200, { status: "ok" }),

    "POST /api/ingest": { handler: async (ctx) => {
      try {
        return json(200, await store.ingestBatch(ctx.jsonBody as Parameters<MetricsStore["ingestBatch"]>[0]));
      } catch (e) {
        return json(400, { error: (e as Error).message });
      }
    }, body: "json" },

    "GET /api/summary": async (ctx) => {
      const wins = ctx.query.getAll("window");
      const win = wins.length <= 1 ? (wins[0] ?? "5m") : "";
      const windowMs = SUMMARY_WINDOWS[win];
      if (typeof windowMs !== "number") {
        return json(400, { error: `window must be one of ${Object.keys(SUMMARY_WINDOWS).join("|")}` });
      }
      return json(200, await store.summary(windowMs));
    },

    "GET /api/timeseries": async (ctx) => {
      const bucketRaw = Number(ctx.query.get("bucket") ?? 60);
      if (bucketRaw !== 60 && bucketRaw !== 3600) {
        return json(400, { error: "bucket must be 60 or 3600" });
      }
      const now = Date.now();
      const to = ctx.query.get("to") === null ? now : Number(ctx.query.get("to"));
      const from = ctx.query.get("from") === null ? to - 3_600_000 : Number(ctx.query.get("from"));
      if (!Number.isFinite(to) || !Number.isFinite(from)) {
        return json(400, { error: "from and to must be epoch milliseconds" });
      }
      if (from > to) return json(400, { error: "from must not be after to" });
      return json(200, await store.timeseries(bucketRaw, from, to));
    },

    "GET /api/recent": async (ctx) => {
      const raw = ctx.query.get("limit");
      const n = raw === null ? 100 : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > LIMITS.recentLimit) {
        return json(400, { error: `limit must be an integer between 1 and ${LIMITS.recentLimit}` });
      }
      return json(200, { items: await store.recent(n), histogramEdges: HISTOGRAM_EDGES });
    },

    "GET /api/config/gateway": async () => json(200, sanitizeGwTargets(await store.readGateway() ?? DEFAULT_GW_TARGETS)),
    "PUT /api/config/gateway": { handler: async (ctx) => {
      const problem = validateGwTargets(ctx.jsonBody);
      if (problem) return json(400, { error: problem });
      const clean = sanitizeGwTargets(ctx.jsonBody, sanitizeGwTargets(await store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway));
      await store.writeGateway(clean);
      driver.setGw(clean);
      return json(200, { saved: true, gateway: clean });
    }, body: "json" },

    "POST /api/config/gateway/test": { handler: async (ctx) => {
      const body = (ctx.jsonBody ?? {}) as Record<string, unknown>;
      const protocol = body.protocol === "soap" ? "soap" : "rest";
      const problem = validateGwConfig(body);
      if (problem) return json(400, { ok: false, error: problem });
      const persisted = sanitizeGwTargets(await store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway);
      const probe = sanitizeGwConfig(body, persisted[protocol]);
      const prefix = probe.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
      // a SOAP endpoint answers POSTs, not GET /health — probe it with a real
      // getPetById call so a healthy route is not reported as down
      const isSoap = protocol === "soap";
      const url = `${probe.baseUrl.replace(/\/+$/, "")}${prefix ? "/" + prefix : ""}${isSoap ? "/soap/petservice" : "/health"}`;

      const headers: Record<string, string> = {};
      if (isSoap) {
        headers["Content-Type"] = "text/xml; charset=utf-8";
        headers["SOAPAction"] = '"getPetById"';
      }
      if (forwardsBasicAuth(probe, cfg.selfUrl)) {
        const creds = readBasicAuthCreds();
        if (creds) headers["authorization"] = `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
      }
      if (probe.apiKey) headers[probe.apiKeyHeader || "X-API-Key"] = probe.apiKey;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), GATEWAY_PROBE_TIMEOUT_MS);
      const started = Date.now();
      const sentBasicAuth = headers["authorization"] !== undefined;
      const soapProbeBody = '<?xml version="1.0" encoding="utf-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://petstore.apigw.test/soap">' +
        '<soap:Body><tns:getPetByIdRequest><petId>1</petId></tns:getPetByIdRequest></soap:Body></soap:Envelope>';
      try {
        const upstream = await fetch(url, isSoap
          ? { method: "POST", headers, body: soapProbeBody, signal: ac.signal }
          : { method: "GET", headers, signal: ac.signal });
        await upstream.arrayBuffer();
        // SOAP faults are 400 but still prove the service is reachable and
        // speaking SOAP — only a routing-level miss (404) is a failure
        const ok = isSoap ? upstream.status !== 404 : upstream.ok;
        return json(200, { ok, status: upstream.status, url, sentBasicAuth, latencyMs: Date.now() - started });
      } catch (e) {
        const reason = ac.signal.aborted
          ? `no response within ${GATEWAY_PROBE_TIMEOUT_MS / 1000}s`
          : ((e as Error).cause as Error | undefined)?.message ?? (e as Error).message;
        return json(200, { ok: false, url, sentBasicAuth, error: reason, latencyMs: Date.now() - started });
      } finally {
        clearTimeout(timer);
      }
    }, body: "json" },

    "GET /api/config/profile": async () => json(200, await store.readProfile() ?? DEFAULT_LOAD_PROFILE),
    "PUT /api/config/profile": { handler: async (ctx) => {
      if (typeof ctx.jsonBody !== "object" || ctx.jsonBody === null || Array.isArray(ctx.jsonBody)) {
        return json(400, { error: "body must be a JSON object" });
      }
      const clean = sanitizeLoadProfile(ctx.jsonBody, await store.readProfile() ?? cfg.defaultProfile);
      await store.writeProfile(clean);
      driver.setProfile(clean);
      return json(200, { saved: true, profile: clean });
    }, body: "json" },

    "POST /api/run/start": async () => {
      const current = driver.status();
      if (current.state === "running") {
        return json(200, { ok: true, runId: current.runId, alreadyRunning: true });
      }
      if (startingRun) return json(409, { error: "run startup is already in progress" });
      startingRun = true;
      try {
      const profile = sanitizeLoadProfile(await store.readProfile() ?? cfg.defaultProfile, cfg.defaultProfile);
      const gateway = sanitizeGwTargets(await store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway);
      const runId = `run-${Date.now()}`;
      await store.recordRunStart(runId, profile);
      driver.setGw(gateway);
      driver.setProfile(profile);
      const out = driver.start(runId);
      void runPolicies();
      return json(200, out);
      } finally { startingRun = false; }
    },

    "POST /api/run/stop": async () => {
      if (startingRun) return json(409, { error: "run startup is in progress" });
      const out = driver.stop();
      if (out.runId) await store.recordRunStop(out.runId);
      return json(200, out);
    },

    "GET /api/run/status": async () => json(200, { ...driver.status(), gateway: driver.currentGw }),

    "GET /api/system": async () => json(200, { current: sampler.latest(), history: sampler.history(120) }),

    "GET /api/runs": async () => json(200, await store.listRuns()),

    "GET /api/runs/:runId/report": async (ctx) => {
      const report = await reportFor(String(ctx.params["runId"]));
      if (!report) return json(404, { error: "no such run" });
      return json(200, report);
    },

    "GET /api/runs/:runId/report.md": async (ctx) => {
      const runId = String(ctx.params["runId"]);
      const report = await reportFor(runId);
      if (!report) return json(404, { error: "no such run" });
      const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
      return new Response(renderRunReportMarkdown(report), {
        headers: { "Content-Type": "text/markdown", "Content-Disposition": `attachment; filename="${safe}-report.md"` }
      });
    },

    "GET /api/policy": async () => json(200, { config: await store.readPolicyConfig(), results: await store.readPolicyResults() }),
    "PUT /api/policy": { handler: async (ctx) => {
      const clean = sanitizePolicyConfig(ctx.jsonBody, await store.readPolicyConfig());
      await store.writePolicyConfig(clean);
      await schedulePolicies();
      return json(200, { saved: true, config: clean });
    }, body: "json" },

    "POST /api/policy/run": async () => {
      if (!(await store.readPolicyConfig()).enabled) {
        return json(409, { error: "policy probing is disabled — enable it first" });
      }
      if (policyRunning) return json(409, { error: "a policy pass is already running" });
      void runPolicies().then(() => undefined);
      return json(202, { started: true });
    },

    "GET /api/config/slo": async () => json(200, await store.readSlo()),
    "PUT /api/config/slo": { handler: async (ctx) => {
      if (typeof ctx.jsonBody !== "object" || ctx.jsonBody === null || Array.isArray(ctx.jsonBody)) {
        return json(400, { error: "body must be a JSON object" });
      }
      const clean = sanitizeSlo(ctx.jsonBody, await store.readSlo());
      await store.writeSlo(clean);
      return json(200, { saved: true, slo: clean });
    }, body: "json" },

    "POST /api/metrics/reset": async () => {
      if (startingRun || driver.status().state !== "idle") {
        return json(409, { error: "stop the run before resetting metrics" });
      }
      await store.resetAll();
      return json(200, { ok: true });
    },

    "POST /api/runs/prune": { handler: async (ctx) => {
      const days = Number((ctx.jsonBody as Record<string, unknown> | undefined)?.olderThanDays);
      if (!Number.isFinite(days) || days < 1 || days > 3650) {
        return json(400, { error: "olderThanDays must be a number between 1 and 3650" });
      }
      return json(200, { deleted: await store.pruneRuns(days * DAY_MS) });
    }, body: "json" }
  };

  const DAY_MS = 86_400_000;

  const reportFor = async (runId: string): Promise<RunReport | null> => {
    const run = await store.findRun(runId);
    if (!run) return null;
    const to = run.stoppedAt ?? Date.now();
    const summary = await store.summaryBetween(run.startedAt, to);
    return buildRunReport({
      run,
      summary,
      scope: await store.windowScope(runId, run.startedAt, to),
      gateway: sanitizeGwTargets(await store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway),
      policies: await store.readPolicyResults(),
      policyConfig: await store.readPolicyConfig(),
      slo: await store.readSlo()
    });
  };

  // ---------------- static dashboard ----------------
  const publicDir = resolve(cfg.publicDir);
  const uiFiles = new Map<string, Uint8Array>();
  let indexHtml: Uint8Array | null = null;
  if (existsSync(publicDir)) {
    try {
      for (const entry of new Bun.Glob("**/*").scanSync({ cwd: publicDir, onlyFiles: true })) {
        const data = new Uint8Array(readFileSync(join(publicDir, entry)));
        uiFiles.set("/" + entry.replace(/\\/g, "/"), data);
      }
      indexHtml = uiFiles.get("/index.html") ?? null;
    } catch { /* fall through to the 503 root */ }
  }

  // ---------------- dispatcher ----------------
  const petCompiled = compileRoutes(petstore.routes);
  const appCompiled = compileRoutes(appRoutes);
  const all = [...appCompiled, ...petCompiled];

  /** Routes the SUT stamps X-Server-Ms on — the petstore paths plus the three
   *  synthetic stress endpoints. Mirrors the old serverMsStamp middleware's
   *  coverage exactly (petstore router + /api/slow /api/big /api/echo). */
  const stampsServerMs = (pathname: string): boolean =>
    pathname.startsWith("/api/pets") || pathname.startsWith("/api/store") ||
    pathname.startsWith("/soap/") || pathname.startsWith("/admin/") ||
    pathname === "/api/slow" || pathname.startsWith("/api/slow/") ||
    pathname === "/api/big" || pathname.startsWith("/api/big/") ||
    pathname === "/api/echo";

  const fetchHandler = async (req: Request): Promise<Response> => {
    await ready;
    let enteredAt = performance.now();
    const url = new URL(req.url);
    const pathname = url.pathname;
    const segs = pathname.split("/").filter(Boolean);
    const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");

    const finish = (res: Response): Response => {
      const headers = new Headers(res.headers);
      if (stampsServerMs(pathname)) headers.set(SERVER_MS_HEADER, String(Math.max(0, performance.now() - enteredAt)));
      applySecurityHeaders(proto, headers);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };

    try {
      // public healthcheck — no auth
      if (req.method === "GET" && pathname === "/health") {
        return finish(json(200, { status: "ok", version: VERSION, uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000) }));
      }

      // auth gate before any body parsing
      const denied = requireAuth(req);
      if (denied) return finish(denied);

      for (const route of all) {
        const params = match(route, req.method, segs);
        if (!params) continue;
        const ctx: RouteCtx = { req, enteredAt, params, query: url.searchParams };
        if (route.def.body === "json") ctx.jsonBody = await req.json().catch(() => undefined);
        else if (route.def.body === "text") ctx.textBody = await req.text();
        else if (route.def.body === "arrayBuffer") ctx.echoBytes = (await req.arrayBuffer()).byteLength;
        // server time starts once the body is fully in: bodies (a 12MB echo
        // upload, a fat SOAP envelope) arriving slowly are transport, not SUT
        // processing — Express's old order (body parsers before the petstore
        // router) excluded them too, and counting them would understate
        // gateway overhead exactly on the classes that measure it
        if (route.def.body) ctx.enteredAt = enteredAt = performance.now();
        return finish(await route.def.handler(ctx));
      }

      // static UI + SPA fallback
      if (req.method === "GET") {
        const file = uiFiles.get(pathname);
        if (file) {
          return finish(new Response(file, { headers: { "Cache-Control": "max-age=3600", "Content-Type": mimeFor(pathname) } }));
        }
        if (indexHtml && !/^\/(api|soap|admin|health)\b/.test(pathname) && (req.headers.get("accept") ?? "").includes("text/html")) {
          return finish(new Response(indexHtml, { headers: { "Content-Type": "text/html" } }));
        }
      }

      if (pathname === "/") {
        return finish(new Response("dashboard not built — run the UI build first (packages/ui → dist).", { status: 503 }));
      }
      return finish(json(404, { error: "not found" }));
    } catch (err) {
      console.error("[apigw-tester] request failed:", err);
      // a body Bun refused to parse is the caller's fault, not ours
      if (err instanceof SyntaxError) {
        return finish(json(400, { error: "request body could not be parsed" }));
      }
      return finish(json(500, { error: "internal error" }));
    }
  };

  return {
    fetch: fetchHandler,
    listen: (port: number) => Bun.serve({ port, fetch: fetchHandler, idleTimeout: 35 }),
    store,
    driver,
    sampler,
    async shutdown() {
      await ready;
      clearInterval(healthTimer);
      if (policyTimer) clearInterval(policyTimer);
      await driver.shutdown();
      sampler.stop();
      await store.close();
    }
  };
}

function mimeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

export interface RunningServer {
  server: ReturnType<typeof Bun.serve>;
  store: AsyncMetricsStore;
  driver: DriverType;
  sampler: SystemSampler;
  shutdown: () => Promise<void>;
}

export function startServer(): RunningServer {
  if (!readBasicAuthCreds()) {
    console.error("[apigw-tester] FATAL: APP_BASIC_AUTH not set. Example: APP_BASIC_AUTH=admin:s3cret");
    process.exit(1);
  }
  const cfg = readConfig();
  const { fetch, store, driver, sampler, shutdown } = buildApp(cfg);
  // idleTimeout must clear LIMITS.delayMs (30s) or the chaos-timeout probe and
  // /api/slow sever early; maxRequestBodySize's 128MiB default already covers
  // the 12MB echo limit
  const server = Bun.serve({
    port: cfg.port,
    fetch,
    idleTimeout: 35,
    error(err) {
      console.error("[apigw-tester] request failed:", err);
      return json(500, { error: "internal error" });
    }
  });
  console.log(`[apigw-tester] http://localhost:${cfg.port}  (dashboard, petstore, load driver + metrics) — auth enabled`);
  console.log(`[apigw-tester] API definitions: /api/definitions/openapi.json · /api/definitions/petservice.wsdl`);
  return { server, store, driver, sampler, shutdown };
}
