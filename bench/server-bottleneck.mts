/**
 * micro-benchmark: identify the bottleneck when 500 rps hits the single app.
 * - starts the same app from packages/app
 * - measures per-endpoint RTT at 1, 50, 200, 500 concurrent fetches
 * - then isolates where time goes with timing callbacks
 */
import { buildApp } from "../packages/app/dist/app.js";
import type { AddressInfo } from "node:net";

const { app } = buildApp({
  dbPath: ":memory:",
  publicDir: "nope",
  port: 0,
  defaultGateway: { baseUrl: "", apiKey: "", apiKeyHeader: "X", pathPrefix: "" },
  defaultProfile: { mode: "constant", rps: 1, maxConcurrency: 1, soapRatioPct: 0, scenarioWeights: { listPets: 100, getPet: 0, createPet: 0, updatePet: 0, deletePet: 0, placeOrder: 0 } }
});
const srv = app.listen(0);
await new Promise<void>((r) => srv.once("listening", r));
const port = (srv.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

async function bench(path: string, concurrency: number, count: number, label: string) {
  const latencies: number[] = [];
  const doOne = () => {
    const t0 = performance.now();
    return fetch(base + path).then(async (r) => {
      await r.arrayBuffer();
      latencies.push(performance.now() - t0);
    }).catch(() => { latencies.push(-1); });
  };
  let inflight = 0;
  const promises = new Set<Promise<void>>();
  for (let i = 0; i < count; i++) {
    while (inflight >= concurrency) {
      await Promise.race(promises);
    }
    const p = doOne().finally(() => { promises.delete(p); inflight--; });
    promises.add(p);
    inflight++;
  }
  await Promise.all(promises);
  const ok = latencies.filter((v) => v >= 0);
  ok.sort((a, b) => a - b);
  const p50 = ok[Math.floor(ok.length * 0.5)];
  const p95 = ok[Math.floor(ok.length * 0.95)];
  const p99 = ok[Math.floor(ok.length * 0.99)];
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  const failed = latencies.length - ok.length;
  console.log(`${label.padEnd(28)} n=${count} c=${concurrency}: avg=${avg.toFixed(1)}ms p50=${p50?.toFixed(1)} p95=${p95?.toFixed(1)} p99=${p99?.toFixed(1)} ${failed > 0 ? `FAILS=${failed}` : ""}`);
}

console.log("=== /api/pets?size=5 (no delay, padded ~2KB) ===");
await bench("/api/pets?size=5&_b=1", 1, 200, "serial");
await bench("/api/pets?size=5&_b=2", 50, 500, "50 concurrent");
await bench("/api/pets?size=5&_b=3", 200, 1000, "200 concurrent");
await bench("/api/pets?size=5&_b=4", 500, 1500, "500 concurrent");

console.log("\n=== /api/big/262144 (256KB body) ===");
await bench("/api/big/262144", 1, 50, "serial");
await bench("/api/big/262144", 50, 300, "50 concurrent");
await bench("/api/big/262144", 200, 800, "200 concurrent");

console.log("\n=== /api/slow/50 (fixed 50ms sleep) ===");
await bench("/api/slow/50", 50, 500, "50 concurrent");
await bench("/api/slow/50", 500, 1000, "500 concurrent");

srv.close();
process.exit(0);
