import express, { type Express, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HISTOGRAM_EDGES } from "./metrics/server.js";
import { createMetricsStore, type MetricsStore } from "./metrics/server.js";
import { createApp as createPetstoreApp } from "./petstore/server.js";
import { buildOpenApiDocument, toYaml } from "./petstore/openapi.js";
import { WSDL } from "./petstore/soap.js";
import { Driver, type Driver as DriverType } from "./loadgen/driver.js";
import { readConfig, type AppConfig } from "./config.js";
import { requireAuth, readBasicAuthCreds } from "./auth.js";
import { LIMITS, sanitizeGwConfig, sanitizeGwTargets, sanitizeLoadProfile, validateGwConfig, validateGwTargets } from "@apigw/shared";
import { DEFAULT_GW_TARGETS, DEFAULT_LOAD_PROFILE } from "@apigw/shared";

export interface BuiltApp {
  app: Express;
  store: MetricsStore;
  driver: DriverType;
}

/**
 * Version of the running build, for /health. Resolves to packages/app/package.json
 * from src/ (dev, tests) and to /app/package.json from dist/ (container) alike.
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

/**
 * Baseline response headers. The dashboard is same-origin and loads no third-party
 * script, so it can run under a tight policy; `style-src 'unsafe-inline'` is the one
 * concession, because Recharts sizes its SVG with inline style attributes.
 */
function securityHeaders(): express.RequestHandler {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
  return (req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // Only meaningful once TLS is terminated in front of us; asserting it on a
    // plain-HTTP hop would pin clients that never had a working https origin.
    if (req.secure) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

/**
 * Windows the summary endpoint accepts, in ms.
 *
 * A null-prototype object, so a query string of `constructor`/`toString` cannot
 * resolve to an inherited Object.prototype member and slip past the lookup guard.
 */
const SUMMARY_WINDOWS: Record<string, number> = Object.assign(Object.create(null) as object, {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000
}) as Record<string, number>;

/**
 * Normalise a server URL that will be reflected into a document we hand out.
 *
 * Returns null unless it is an absolute http(s) URL. The result is re-serialised
 * by the WHATWG URL parser, so a value that would break the XML attribute or the
 * YAML scalar it lands in (quotes, angle brackets, newlines) is either rejected
 * or percent-encoded before it gets there.
 */
/** XML attribute-value escape. `&` is legal in a URL but not raw in XML. */
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

export function buildApp(cfg: AppConfig): BuiltApp {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(securityHeaders());

  // Public healthcheck (load balancers). Everything else is behind Basic auth.
  // Deliberately says nothing an anonymous caller could use: version and uptime
  // only, no config, no counters.
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", version: VERSION, uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000) })
  );

  // Auth gate FIRST: an anonymous caller must not be able to make us parse a
  // multi-megabyte body before we reject it. Nothing about the check needs the body.
  app.use(requireAuth());

  app.use(express.text({ type: ["text/xml", "application/soap+xml"], limit: "1mb" }));
  app.use(express.json({ limit: "5mb" }));

  // ---------------- SUT: petstore ----------------
  const petstore = createPetstoreApp();
  app.use(petstore.app);

  // ---------------- metrics store (in-process) ----------------
  const store = createMetricsStore(cfg.dbPath);

  // ---------------- load driver (in-process) ----------------
  const driver = new Driver();
  driver.setIngest(store.ingestBatch); // driver flushes straight into the store
  driver.setBaselineUrl(cfg.selfUrl);  // probe the SUT directly (bypasses GW)

  // seed from persisted config so a restart keeps your settings
  const savedGw = store.readGateway();
  const savedProfile = store.readProfile();
  if (savedGw) driver.setGw(sanitizeGwTargets(savedGw, cfg.defaultGateway));
  else store.writeGateway(cfg.defaultGateway);
  if (savedProfile) driver.setProfile(sanitizeLoadProfile(savedProfile, cfg.defaultProfile));
  else store.writeProfile(cfg.defaultProfile);

  void driver.init().catch((e) => console.error("driver init failed", e));

  // ---------------- API contract definitions ----------------
  // Downloadable so they can be imported straight into the gateway under test.
  // This value is reflected verbatim into the WSDL and the OpenAPI document, so
  // every path into it — the `?server=` override and the persisted gateway config
  // alike — goes through normalizeServerUrl first. An unusable override falls back
  // to the configured gateway rather than being echoed back.
  const specServerUrl = (req: Request, protocol: "rest" | "soap"): string => {
    const fallback = normalizeServerUrl(cfg.defaultGateway[protocol].baseUrl) ?? `http://127.0.0.1:${cfg.port}`;
    const override = req.query["server"];
    if (typeof override === "string" && override.trim() !== "") {
      return normalizeServerUrl(override) ?? fallback;
    }
    // each protocol advertises its own target: the OpenAPI document points where
    // REST traffic goes, the WSDL where SOAP traffic goes
    const gw = sanitizeGwTargets(store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway)[protocol];
    const prefix = gw.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return normalizeServerUrl(`${gw.baseUrl.replace(/\/+$/, "")}${prefix ? "/" + prefix : ""}`) ?? fallback;
  };

  app.get("/api/definitions", (req, res) => {
    res.json({
      openapiJson: "/api/definitions/openapi.json",
      openapiYaml: "/api/definitions/openapi.yaml",
      wsdl: "/api/definitions/petservice.wsdl",
      serverUrl: specServerUrl(req, "rest"),
      serverUrlSoap: specServerUrl(req, "soap"),
      note: "Import these into the gateway under test to enable request/response validation. Override the advertised server with ?server=https://your-gw/base"
    });
  });

  app.get("/api/definitions/openapi.json", (req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="apigw-tester-openapi.json"');
    res.type("application/json").send(JSON.stringify(buildOpenApiDocument({ serverUrl: specServerUrl(req, "rest") }), null, 2));
  });

  app.get("/api/definitions/openapi.yaml", (req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="apigw-tester-openapi.yaml"');
    res.type("application/yaml").send(toYaml(buildOpenApiDocument({ serverUrl: specServerUrl(req, "rest") })));
  });

  app.get("/api/definitions/petservice.wsdl", (req, res) => {
    const location = `${specServerUrl(req, "soap")}/soap/petservice`;
    res.setHeader("Content-Disposition", 'attachment; filename="petservice.wsdl"');
    // function replacement so a `$&` in the URL stays literal instead of expanding
    res.type("text/xml").send(WSDL.replace("__SERVICE_LOCATION__", () => xmlAttr(location)));
  });

  // ---------------- API ----------------
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

  app.post("/api/ingest", (req: Request, res: Response) => {
    try {
      const out = store.ingestBatch(req.body);
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/api/summary", (req, res) => {
    const win = (req.query["window"] as string) ?? "5m";
    const windowMs = typeof win === "string" ? SUMMARY_WINDOWS[win] : undefined;
    if (typeof windowMs !== "number") {
      return res.status(400).json({ error: `window must be one of ${Object.keys(SUMMARY_WINDOWS).join("|")}` });
    }
    res.json(store.summary(windowMs));
  });

  app.get("/api/timeseries", (req, res) => {
    const bucketRaw = Number(req.query["bucket"] ?? 60);
    if (bucketRaw !== 60 && bucketRaw !== 3600) {
      return res.status(400).json({ error: "bucket must be 60 or 3600" });
    }
    const now = Date.now();
    const to = req.query["to"] === undefined ? now : Number(req.query["to"]);
    const from = req.query["from"] === undefined ? to - 3_600_000 : Number(req.query["from"]);
    if (!Number.isFinite(to) || !Number.isFinite(from)) {
      return res.status(400).json({ error: "from and to must be epoch milliseconds" });
    }
    if (from > to) return res.status(400).json({ error: "from must not be after to" });
    // the store clamps the span to LIMITS.timeseriesPoints and reports truncation
    res.json(store.timeseries(bucketRaw, from, to));
  });

  app.get("/api/recent", (req, res) => {
    const raw = req.query["limit"];
    const n = raw === undefined ? 100 : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.recentLimit) {
      return res.status(400).json({ error: `limit must be an integer between 1 and ${LIMITS.recentLimit}` });
    }
    res.json({ items: store.recent(n), histogramEdges: HISTOGRAM_EDGES });
  });

  app.get("/api/config/gateway", (_req, res) => res.json(sanitizeGwTargets(store.readGateway() ?? DEFAULT_GW_TARGETS)));
  app.put("/api/config/gateway", (req: Request, res: Response) => {
    const problem = validateGwTargets(req.body);
    if (problem) return res.status(400).json({ error: problem });
    const clean = sanitizeGwTargets(req.body, sanitizeGwTargets(store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway));
    store.writeGateway(clean);
    driver.setGw(clean);
    res.json({ saved: true, gateway: clean });
  });

  /**
   * Reachability probe for a candidate gateway config.
   *
   * Runs server-side on purpose. The dashboard ships a `connect-src 'self'` CSP,
   * so a browser-side fetch at the gateway (a different origin by definition)
   * is blocked before it leaves the page — and this is also the only probe that
   * exercises the same path the load driver will actually use.
   *
   * Body: one GwConfig plus an optional `protocol` ("rest" | "soap") selecting
   * which side of the persisted config it falls back to; defaults to "rest".
   */
  app.post("/api/config/gateway/test", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const protocol = body.protocol === "soap" ? "soap" : "rest";
    const problem = validateGwConfig(body);
    if (problem) return res.status(400).json({ ok: false, error: problem });
    const persisted = sanitizeGwTargets(store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway);
    const probe = sanitizeGwConfig(body, persisted[protocol]);
    const prefix = probe.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    const url = `${probe.baseUrl.replace(/\/+$/, "")}${prefix ? "/" + prefix : ""}/health`;

    const headers: Record<string, string> = {};
    const creds = readBasicAuthCreds();
    if (creds) headers["authorization"] = `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}`;
    if (probe.apiKey) headers[probe.apiKeyHeader || "X-API-Key"] = probe.apiKey;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GATEWAY_PROBE_TIMEOUT_MS);
    const started = Date.now();
    try {
      const upstream = await fetch(url, { method: "GET", headers, signal: ac.signal });
      await upstream.arrayBuffer(); // drain, so the socket is released
      res.json({ ok: upstream.ok, status: upstream.status, url, latencyMs: Date.now() - started });
    } catch (e) {
      const reason = ac.signal.aborted
        ? `no response within ${GATEWAY_PROBE_TIMEOUT_MS / 1000}s`
        : ((e as Error).cause as Error | undefined)?.message ?? (e as Error).message;
      res.json({ ok: false, url, error: reason, latencyMs: Date.now() - started });
    } finally {
      clearTimeout(timer);
    }
  });

  app.get("/api/config/profile", (_req, res) => res.json(store.readProfile() ?? DEFAULT_LOAD_PROFILE));
  app.put("/api/config/profile", (req: Request, res: Response) => {
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: "body must be a JSON object" });
    }
    // every field is clamped to a runnable range — a persisted profile can never
    // brick the process on the next restart
    const clean = sanitizeLoadProfile(req.body, store.readProfile() ?? cfg.defaultProfile);
    store.writeProfile(clean);
    driver.setProfile(clean);
    res.json({ saved: true, profile: clean });
  });

  app.post("/api/run/start", (_req, res) => {
    const current = driver.status();
    if (current.state === "running") {
      return res.json({ ok: true, runId: current.runId, alreadyRunning: true });
    }
    const profile = sanitizeLoadProfile(store.readProfile() ?? cfg.defaultProfile, cfg.defaultProfile);
    const gateway = sanitizeGwTargets(store.readGateway() ?? cfg.defaultGateway, cfg.defaultGateway);
    const runId = `run-${Date.now()}`;
    store.recordRunStart(runId, profile);
    driver.setGw(gateway);
    driver.setProfile(profile);
    res.json(driver.start(runId));
  });

  app.post("/api/run/stop", (_req, res) => {
    const out = driver.stop();
    if (out.runId) store.recordRunStop(out.runId);
    res.json(out);
  });

  app.get("/api/run/status", (_req, res) => {
    const s = driver.status();
    res.json({ ...s, gateway: driver.currentGw });
  });

  app.get("/api/runs", (_req, res) => res.json(store.listRuns()));

  /**
   * Wipe all metric data. Refused while a run is live: the driver holds up to a
   * flush interval of results in memory and would re-insert them, stamped with
   * the old run id, after the reset.
   */
  app.post("/api/metrics/reset", (_req, res) => {
    if (driver.status().state === "running") {
      return res.status(409).json({ error: "stop the run before resetting metrics" });
    }
    store.resetAll();
    res.json({ ok: true });
  });

  const DAY_MS = 86_400_000;
  app.post("/api/runs/prune", (req: Request, res: Response) => {
    const days = Number((req.body as Record<string, unknown> | undefined)?.olderThanDays);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: "olderThanDays must be a number between 1 and 3650" });
    }
    res.json({ deleted: store.pruneRuns(days * DAY_MS) });
  });

  // ---------------- static dashboard ----------------
  const publicDir = resolve(cfg.publicDir);
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir, { maxAge: "1h" }));
    // SPA fallback: anything that isn't an asset or a known API path
    app.use((req, res, next) => {
      if (/^\/(api|soap|admin|health)\b/.test(req.path)) return next();
      if (req.method !== "GET") return next();
      res.sendFile(join(publicDir, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.status(503).send("dashboard not built — run the UI build first (packages/ui → dist).");
    });
  }

  // Last-resort error handler: a throw in any handler returns JSON, never an
  // HTML stack trace, and never takes the process down.
  app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("[apigw-tester] request failed:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal error" });
  });

  return { app, store, driver };
}

export interface RunningServer {
  server: ReturnType<Express["listen"]>;
  store: MetricsStore;
  driver: DriverType;
}

export function startServer(): RunningServer {
  if (!readBasicAuthCreds()) {
    console.error("[apigw-tester] FATAL: APP_BASIC_AUTH not set. Example: APP_BASIC_AUTH=admin:s3cret");
    process.exit(1);
  }
  const cfg = readConfig();
  const { app, store, driver } = buildApp(cfg);
  const server = app.listen(cfg.port, () => {
    console.log(`[apigw-tester] http://localhost:${cfg.port}  (dashboard, petstore, load driver + metrics) — auth enabled`);
    console.log(`[apigw-tester] API definitions: /api/definitions/openapi.json · /api/definitions/petservice.wsdl`);
  });
  return { server, store, driver };
}
