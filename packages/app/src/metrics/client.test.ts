import { describe, expect, it } from "bun:test";
import { createMetricsClient } from "./client.js";

describe("metrics worker", () => {
  it("orders writes before reads and reports operation failures without losing the worker", async () => {
    const store = createMetricsClient(":memory:");
    try {
      const write = store.recordRunStart("worker-test", {});
      const read = store.listRuns();
      await write;
      expect((await read)[0]?.runId).toBe("worker-test");
      const error = await store.ingestBatch({ batchId: "", results: [] }).catch(e => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("batchId");
      expect((await store.listRuns()).length).toBe(1);
      await store.resetAll();
      expect(await store.listRuns()).toEqual([]);
    } finally { await store.close(); }
    expect(await store.listRuns().catch(e => e)).toBeInstanceOf(Error);
  });

  it("bounds outstanding work rather than growing an unlimited queue", async () => {
    const store = createMetricsClient(":memory:");
    const work = Array.from({ length: 140 }, () => store.listRuns());
    const outcomes = await Promise.allSettled(work);
    expect(outcomes.some(r => r.status === "rejected")).toBe(true);
    expect(outcomes.some(r => r.status === "fulfilled")).toBe(true);
    await store.close();
  });
});
