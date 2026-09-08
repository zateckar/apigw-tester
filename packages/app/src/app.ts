import express, { type Express, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { HISTOGRAM_EDGES } from "./metrics/server.js";
import { createMetricsStore, type MetricsStore } from "./metrics/server.js";
import { createApp as createPetstoreApp } from "./petstore/server.js";
import { Driver, type Driver as DriverType } from "./loadgen/driver.js";
import { readConfig, type AppConfig } from "./config.js";
import { requireAuth, readBasicAuthCreds } from "./auth.js";
import type { GwConfig, LoadProfile } from "@apigw/shared";
import { DEFAULT_GW_CONFIG, DEFAULT_LOAD_PROFILE } from "@apigw/shared";

export interface BuiltApp {
  app: Express;
  store: MetricsStore;
  driver: DriverType;
}

export function buildApp(cfg: AppConfig): BuiltApp {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  // Public healthcheck (load balancers). Everything else is behind Basic auth.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Body parsers BEFORE the auth gate so `Authorization:` headers on JSON/XML
  // requests parse normally — body content doesn't matter for the check.
  app.use(express.text({ type: ["text/xml", "application/soap+xml"], limit: "1mb" }));
  app.use(express.json({ limit: "5mb" }));

  // Auth gate: every subsequent route requires APP_BASIC_AUTH credentials.
  app.use(requireAuth());

  // ---------------- SUT: petstore ----------------
  const petstore = createPetstoreApp();
  app.use(petstore.app);

  // ---------------- metrics store (in-process) ----------------
  const store = createMetricsStore(cfg.dbPath);

  // ---------------- load driver (in-process) ----------------
  const driver = new Driver();
  driver.setIngest(store.ingestBatch); // driver flushes straight into the store
  driver.setBaselineUrl(cfg.defaultGateway.baseUrl); // probe the SUT directly (bypasses GW)
  void driver.init().catch((e) => console.error("driver init failed", e));

  // seed from persisted config so a restart keeps your settings
  const savedGw = store.readGateway();
  const savedProfile = store.readProfile();
  if (savedGw) driver.setGw(savedGw); else store.writeGateway(cfg.defaultGateway);
  if (savedProfile) driver.setProfile(savedProfile); else store.writeProfile(cfg.defaultProfile);

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
    const windowMs =
      win === "5m" ? 300_000 :
      win === "15m" ? 900_000 :
      win === "1h" ? 3_600_000 :
      86_400_000;
    res.json(store.summary(windowMs));
  });

  app.get("/api/timeseries", (req, res) => {
    const bucketSec = Number(req.query["bucket"] ?? 60) as 60 | 3600;
    const to = Number(req.query["to"] ?? Date.now());
    const from = Number(req.query["from"] ?? to - 3_600_000);
    res.json(store.timeseries(bucketSec === 3600 ? 3600 : 60, from, to));
  });

  app.get("/api/recent", (req, res) => {
    const limit = Math.min(500, Number(req.query["limit"] ?? 100));
    res.json({ items: store.recent(limit), histogramEdges: HISTOGRAM_EDGES });
  });

  app.get("/api/config/gateway", (_req, res) => res.json(store.readGateway() ?? DEFAULT_GW_CONFIG));
  app.put("/api/config/gateway", (req: Request, res: Response) => {
    const cfg = req.body as GwConfig;
    if (!cfg || typeof cfg.baseUrl !== "string") return res.status(400).json({ error: "baseUrl required" });
    store.writeGateway(cfg);
    driver.setGw(cfg);
    res.json({ saved: true });
  });

  app.get("/api/config/profile", (_req, res) => res.json(store.readProfile() ?? DEFAULT_LOAD_PROFILE));
  app.put("/api/config/profile", (req: Request, res: Response) => {
    const p = req.body as LoadProfile;
    store.writeProfile(p);
    driver.setProfile(p);
    res.json({ saved: true });
  });

  app.post("/api/run/start", (_req, res) => {
    const runId = `run-${Date.now()}`;
    store.recordRunStart(runId, store.readProfile() ?? DEFAULT_LOAD_PROFILE);
    driver.setGw(store.readGateway() ?? DEFAULT_GW_CONFIG);
    driver.setProfile(store.readProfile() ?? DEFAULT_LOAD_PROFILE);
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

  // ---------------- static dashboard ----------------
  const publicDir = resolve(cfg.publicDir);
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir, { maxAge: "1h" }));
    // SPA fallback: anything that isn't an asset or /api goes to index.html
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/soap/") || req.path.startsWith("/admin/")) return next();
      if (req.method !== "GET") return next();
      const idx = join(publicDir, "index.html");
      res.sendFile(idx);
    });
  } else {
    app.get("/", (_req, res) => {
      res.status(503).send("dashboard not built — run the UI build first (packages/ui → dist).");
    });
  }

  return { app, store, driver };
}

export function startServer(): ReturnType<Express["listen"]> {
  if (!readBasicAuthCreds()) {
    console.error("[apigw-tester] FATAL: APP_BASIC_AUTH not set. Example: APP_BASIC_AUTH=admin:s3cret");
    process.exit(1);
  }
  const cfg = readConfig();
  const { app } = buildApp(cfg);
  const server = app.listen(cfg.port, () => {
    console.log(`[apigw-tester] http://localhost:${cfg.port}  (dashboard, petstore, load driver + metrics) — auth enabled`);
  });
  return server;
}
