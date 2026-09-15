import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp, type BuiltApp } from "../src/app.js";
import { DEFAULT_LOAD_PROFILE } from "../../shared/src/index.js";

// Isolated loopback workload: never reads a saved gateway or production DB.
const rps = Number(process.argv[2] ?? 100);
const seconds = Number(process.argv[3] ?? 30);
if (!Number.isFinite(rps) || rps < 1 || rps > 10_000 || !Number.isFinite(seconds) || seconds < 5 || seconds > 600) {
  throw new Error("Usage: bun packages/app/scripts/benchmark.ts [rps:1..10000] [seconds:5..600]");
}
process.env["APP_BASIC_AUTH"] = `benchmark:${randomUUID()}`;
const dir = mkdtempSync(join(tmpdir(), "apigw-benchmark-"));
let app: BuiltApp;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => app.fetch(req) });
const url = `http://127.0.0.1:${server.port}`;
const target = { baseUrl: url, pathPrefix: "", apiKey: "", apiKeyHeader: "X-API-Key", forwardBasicAuth: "auto" as const };
let poll: ReturnType<typeof setInterval> | undefined;
try {
  app = buildApp({
    port: server.port!, selfUrl: url, dbPath: join(dir, "metrics.sqlite"), publicDir: join(dir, "no-ui"),
    defaultGateway: { rest: target, soap: target }, defaultProfile: { ...DEFAULT_LOAD_PROFILE, rps }
  });
  await app.fetch(new Request(`${url}/health`));
  await Bun.sleep(2000); // initial direct-path calibration
  const cpu = process.cpuUsage();
  const started = performance.now();
  let polling = false;
  poll = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      await app.store.summary(3600_000);
      await app.store.timeseries(60, Date.now() - 3600_000, Date.now());
      await app.store.recent(100);
    } finally { polling = false; }
  }, 5000);
  app.driver.start("local-benchmark");
  await Bun.sleep(seconds * 1000);
  const elapsed = (performance.now() - started) / 1000;
  const used = process.cpuUsage(cpu);
  const counters = app.driver.status().counters;
  clearInterval(poll);
  while (polling) await Bun.sleep(10);
  await app.driver.shutdown();
  const summary = await app.store.summary(3600_000);
  console.log(JSON.stringify({
    runtime: Bun.version, targetRps: rps, elapsedSeconds: elapsed,
    cpuSeconds: (used.user + used.system) / 1e6,
    averageCpuCores: (used.user + used.system) / 1e6 / elapsed,
    issuedRps: counters.sent / elapsed, counters,
    overhead: summary.overheadMs,
    note: "Loopback, default mixed workload, fresh disk DB, metrics polling every 5s; excludes external gateway/TLS."
  }, null, 2));
} finally {
  if (poll) clearInterval(poll);
  if (app!) await app.shutdown();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
