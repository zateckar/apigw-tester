import { parentPort, workerData } from "node:worker_threads";
import { createMetricsStore, type MetricsStore } from "./server.js";

const store = createMetricsStore(workerData.dbPath);
parentPort!.on("message", ({ id, method, args }: { id: number; method: keyof MetricsStore; args: unknown[] }) => {
  try {
    if (!Object.hasOwn(store, method)) throw new Error("Unknown metrics operation");
    const result = (store[method] as (...args: unknown[]) => unknown)(...args);
    parentPort!.postMessage({ id, result });
    if (method === "close") parentPort!.close();
  } catch (error) {
    parentPort!.postMessage({ id, error: (error as Error).message });
  }
});
