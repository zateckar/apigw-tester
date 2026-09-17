import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemSampler, readCpuCapacity } from "./system.js";
import { aggregateBatch } from "./aggregate.js";
import { MEASUREMENT_VERSION, type AggregateBatch } from "@apigw/shared";

// counters across two "reads" of a fake /proc file: the second content carries
// +200 rx per non-lo interface, tx unchanged
const NETDEV_A = `
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000   10000    0    0    0     0          0         0  1000000   10000    0    0    0     0       0          0
  eth0: 5000000    6000    0    0    0     0          0         0  7000000    8000    0    0    0     0       0          0
  eth1: 3000000    3000    0    0    0     0          0         0  4000000    5000    0    0    0     0       0          0
`;
const NETDEV_B = NETDEV_A
  .replace("  eth0: 5000000", "  eth0: 5000200")
  .replace("  eth1: 3000000", "  eth1: 3000200");

// Linux /proc/diskstats layout: major minor name then io counters
//   [3] reads completed [4] reads merged [5] sectors read [6] ms reading
//   [7] writes done    [8] writes merged [9] sectors written ...
// so sectorsRead is fields[5] and sectorsWritten is fields[9].
// sda starts at 1000 sectors read / 2000 written; loop/ram must be skipped
const DISKSTATS_A = `
   8       0 sda 100 0 1000 0 200 0 2000 0 0 0 0 0 0 0 0 0
   8       1 sda1 50 0 500 0 100 0 1000 0 0 0 0 0 0 0 0 0
   7       0 loop0 10 0 20 0 0 0 40 0 0 0 0 0 0 0 0 0
   1       0 ram0 5 0 10 0 0 0 20 0 0 0 0 0 0 0 0 0
`;
// sda sectors written 2000 → 3000 (+512 KiB); the loop/ram counters jump
// wildly to prove they stay excluded from the totals
const DISKSTATS_B = `
   8       0 sda 100 0 1000 0 200 0 3000 0 0 0 0 0 0 0 0 0
   8       1 sda1 50 0 500 0 100 0 1000 0 0 0 0 0 0 0 0 0
   7       0 loop0 10 0 999999 0 0 0 888888 0 0 0 0 0 0 0 0 0
   1       0 ram0 5 0 777777 0 0 0 666666 0 0 0 0 0 0 0 0 0
`;

function tempProcFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sysmon-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function batch(bytesReq: number, bytesResp: number): AggregateBatch {
  return aggregateBatch({
    batchId: `b-${Math.random()}`,
    results: [{
      runId: "r", requestId: `req-${Math.random()}`, ts: Date.now(), protocol: "rest", endpoint: "GET /x",
      class: "small-rest", method: "GET", status: 200,
      latencyMs: 1, ttfbMs: 1, serverMs: null, measurementVersion: MEASUREMENT_VERSION,
      bytesReq, bytesResp, reachedBackend: true, error: null
    }]
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createSystemSampler lifecycle", () => {
  it("start/stop are idempotent and latest() is sane before and after start", async () => {
    const s = createSystemSampler({ intervalMs: 30 });
    // before start: a levels-only sample — CPU and loop are null because
    // there is no previous sample to delta against
    const pre = s.latest();
    expect(pre.memTotalBytes).toBeGreaterThan(0);
    expect(pre.memUsedBytes).toBeGreaterThan(0);
    expect(pre.cpuProcessPct).toBeNull();
    expect(pre.eventLoopP99ms).toBeNull();

    s.start();
    s.start(); // must not arm a second timer
    await sleep(90); // ~3 ticks
    const cur = s.latest();
    expect(cur.memTotalBytes).toBeGreaterThan(0);
    expect(cur.procRssBytes).toBeGreaterThan(0);
    expect(cur.procHeapUsedBytes).toBeGreaterThan(0);
    // after the second tick the CPU rate exists and is a 0-100 capacity share
    expect(cur.cpuProcessPct).not.toBeNull();
    expect(cur.cpuSystemPct).not.toBeNull();
    expect(cur.cpuProcessPct as number).toBeGreaterThanOrEqual(0);
    expect(cur.cpuProcessPct as number).toBeLessThanOrEqual(100);
    expect(cur.cpuSystemPct as number).toBeGreaterThanOrEqual(0);
    expect(cur.cpuSystemPct as number).toBeLessThanOrEqual(100);
    if (cur.eventLoopP99ms !== null) {
      expect(cur.eventLoopP99ms).toBeGreaterThanOrEqual(0);
      expect(cur.eventLoopP50ms as number).toBeGreaterThanOrEqual(0);
    }
    expect(s.history().length).toBeGreaterThanOrEqual(2);
    s.stop();
    s.stop(); // no-op
    const frozen = s.history().length;
    await sleep(80);
    expect(s.history().length).toBe(frozen); // stopped means stopped
  });

  it("history() trims to historySize and history(n) returns the newest n", async () => {
    const s = createSystemSampler({ intervalMs: 20, historySize: 3 });
    // start is awaited before first sample
    s.start();
    for (let i = 0; i < 10; i++) await sleep(25);
    s.stop();
    expect(s.history().length).toBeLessThanOrEqual(3);
    expect(s.history(2).length).toBe(2);
    const all = s.history();
    const two = s.history(2);
    // newest-n, ordered oldest → newest
    expect(two[1]?.ts).toBe(all[all.length - 1]?.ts);
    expect((two[1]?.ts ?? 0) >= (two[0]?.ts ?? 0)).toBe(true);
  });
});

describe("createSystemSampler /proc parsing", () => {
  it("computes NIC and host-disk B/s from fake /proc files", async () => {
    const netPath = tempProcFile("dev", NETDEV_A);
    const diskPath = tempProcFile("diskstats", DISKSTATS_A);
    const s = createSystemSampler({
      intervalMs: 40, procNetDevPath: netPath, procDiskstatsPath: diskPath,
      procSelfIoPath: tempProcFile("io", "rchar: 1000\nwchar: 2000\nread_bytes: 0\nwrite_bytes: 0\n")
    });
    s.start();
    await sleep(60); // baseline tick(s)
    // grow the counters; a tick can sneak between the two writes, so the
    // assertions span every sample instead of pinning the very latest one
    writeFileSync(netPath, NETDEV_B);
    writeFileSync(diskPath, DISKSTATS_B);
    await sleep(60);
    s.stop();
    // aggregate over every sample: at least one tick must have observed the
    // grown counters and produced a positive rate from each source
    const hist = s.history();
    const anyMax = (get: (v: (typeof hist)[number]) => number | null): number =>
      hist.reduce((m, v) => Math.max(m, get(v) ?? 0), 0);
    // NIC: +400 rx (+200 per interface) once NETDEV_B is in play
    expect(hist.some((v) => v.netRxBps !== null)).toBe(true);
    expect(anyMax((v) => v.netRxBps)).toBeGreaterThan(0);
    expect(hist.some((v) => v.netTxBps !== null)).toBe(true);
    // disk: sda sectors written 2000 → 3000 = 512 KiB; the loop/ram jumps must
    // stay excluded — they'd fake a GB/s spike, not a MB/s one
    const peakDiskWrite = anyMax((v) => v.diskWriteBps);
    expect(peakDiskWrite).toBeGreaterThan(0);
    expect(peakDiskWrite).toBeLessThan(50 * 1024 * 1024);
    expect(hist.some((v) => v.diskReadBps !== null)).toBe(true);
    // /proc/self/io with zero read_bytes/write_bytes falls back to rchar/wchar
    expect(s.latest().procReadBps).not.toBeNull();
    expect(s.latest().procWriteBps).not.toBeNull();
  });

  it("degrades to nulls when the /proc paths do not exist", async () => {
    const missing = join(tmpdir(), "definitely-not-there-sysmon");
    const s = createSystemSampler({
      intervalMs: 30,
      procNetDevPath: join(missing, "netdev"),
      procDiskstatsPath: join(missing, "diskstats"),
      procSelfIoPath: join(missing, "io")
    });
    s.start();
    await sleep(90);
    s.stop();
    const cur = s.latest();
    for (const k of ["netRxBps", "netTxBps", "diskReadBps", "diskWriteBps", "procReadBps", "procWriteBps"] as const) {
      expect(cur[k]).toBeNull();
    }
    // the always-available fields must still be there — degradation ≠ breakage
    expect(cur.memTotalBytes).toBeGreaterThan(0);
    expect(cur.cpuProcessPct).not.toBeNull();
  });
});

describe("app traffic accounting", () => {
  it("derives appInBps/appOutBps from batches pushed via noteBatch", async () => {
    const s = createSystemSampler({ intervalMs: 30 });
    s.start();
    s.noteBatch(batch(1000, 5000));
    await sleep(50);
    s.noteBatch(batch(2000, 6000)); // closes the first window: 1000/5000 over ~50ms
    await sleep(60);
    s.stop();
    const last = s.history().at(-1);
    expect((last?.appInBps ?? 0)).toBeGreaterThan(0);
    expect((last?.appOutBps ?? 0)).toBeGreaterThan(0);
    expect(last?.appOutBps ?? 0).toBeGreaterThan(last?.appInBps ?? 0); // 5000 > 1000 either way the window splits
  });

  it("an empty or malformed batch cannot poison the rates", () => {
    const s = createSystemSampler();
    s.noteBatch(aggregateBatch({ batchId: "x", results: [] }));
    s.noteBatch({} as unknown as AggregateBatch);
    expect(s.latest().appInBps).toBe(0);
    expect(s.latest().appOutBps).toBe(0);
  });
});


it("honors the tightest CPU quota, cpuset and ancestor throttling", () => {
  const parent = mkdtempSync(join(tmpdir(), "cpu-parent-"));
  const child = mkdtempSync(join(tmpdir(), "cpu-child-"));
  try {
    writeFileSync(join(parent, "cpu.max"), "150000 100000");
    writeFileSync(join(child, "cpu.max"), "200000 100000");
    writeFileSync(join(child, "cpuset.cpus.effective"), "0-3,6");
    writeFileSync(join(parent, "cpu.stat"), "throttled_usec 2000\n");
    writeFileSync(join(child, "cpu.stat"), "throttled_usec 1000\n");
    expect(readCpuCapacity([child, parent], 16)).toEqual({ cores: 1.5, throttledUs: 3000 });
  } finally { rmSync(parent, { recursive: true }); rmSync(child, { recursive: true }); }
});


it("records a synchronous stall in the loop it is watching", async () => {
  // There was a qualityBetween() here that turned these samples into a verdict
  // used to withhold measurements. The verdict moved into validityFor, which
  // reads the roll-up rather than this in-memory ring — but the sampler still
  // has to see a stall at all, or nothing downstream can.
  const sampler = createSystemSampler({ intervalMs: 30 });
  sampler.start();
  try {
    await sleep(60);
    const until = performance.now() + 80;
    while (performance.now() < until) { /* simulate synchronous metrics work */ }
    await sleep(40);
    sampler.sampleNow();
    const worst = Math.max(...sampler.history().map((s) => s.eventLoopP99ms ?? 0));
    expect(worst).toBeGreaterThan(20);
  } finally { sampler.stop(); }
});
