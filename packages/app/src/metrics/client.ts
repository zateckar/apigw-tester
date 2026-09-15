import { Worker } from "node:worker_threads";
import type { MetricsStore } from "./server.js";

export type AsyncMetricsStore = {
  [K in keyof MetricsStore]: (...args: Parameters<MetricsStore[K]>) => Promise<ReturnType<MetricsStore[K]>>;
};

/** One owner for SQLite, with FIFO operations and bounded pending work.
 * Calls fail explicitly on overload or worker failure; writes are never
 * silently retried after an uncertain result. Ingest retains batch deduping. */
export function createMetricsClient(dbPath: string): AsyncMetricsStore {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { dbPath } });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let failure: Error | null = null;
  let closing = false;
  const fail = (error: Error) => {
    failure = error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", code => fail(new Error(`Metrics worker exited (${code})`)));
  worker.on("message", ({ id, result, error }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (error) call.reject(new Error(error));
    else call.resolve(result);
  });
  return new Proxy({} as AsyncMetricsStore, {
    get(_target, method: string) {
      // Avoid making the proxy a promise-like object.
      if (method === "then") return undefined;
      return (...args: unknown[]) => new Promise((resolve, reject) => {
        if (failure || closing) { reject(failure ?? new Error("Metrics store is closing")); return; }
        if (pending.size >= 128 && method !== "close") { reject(new Error("Metrics worker queue is full")); return; }
        if (method === "close") closing = true;
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, method, args }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    }
  });
}
