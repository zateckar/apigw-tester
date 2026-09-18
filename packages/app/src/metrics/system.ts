import os from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { AggregateBatch, SystemSample } from "@apigw/shared";

export interface SystemSamplerOpts {
  /** Sample cadence; default 2s matches the dashboard poll. */
  intervalMs?: number;
  cgroupRootPath?: string;
  /** Samples retained in memory, oldest dropped first; default 600 (~20 min). */
  historySize?: number;
  /** Injectable so tests can point at fixture files. */
  procNetDevPath?: string;
  procDiskstatsPath?: string;
  procSelfIoPath?: string;
}

export interface SystemSampler {
  start(): void;
  stop(): void;
  latest(): SystemSample;
  sampleNow(): void;
  history(n?: number): SystemSample[];
  /** Called once per ingested batch so appInBps/appOutBps can be derived
   *  without the sampler reaching into the metrics store. */
  noteBatch(batch: AggregateBatch): void;
}

interface BytePair {
  read: number;
  write: number;
}

/**
 * One snapshot worth of cumulative counters: everything rate-like is computed
 * as a delta between two of these, so callers only ever see per-second rates.
 */
interface Counters {
  tsMs: number; // wall clock, used for byte-rate elapsed time
  hrtUs: number; // monotonic hrtime in µs, used for CPU elapsed time
  throttledUs: number | null;
  capacity: number;
  procCpuUs: number; // process user+system, µs
  sysBusyUs: number; // all cores, user+system+irq etc., µs (idle excluded)
  procIo: BytePair | null; // cumulative process I/O bytes or null off /proc
  // null (not 0) when the source file didn't parse: a 0 delta would then
  // publish an honest-looking flatline instead of "we can't measure this"
  netRx: number | null;
  netTx: number | null;
  diskRead: number | null; // bytes (sectors × 512)
  diskWrite: number | null;
}

const NS_PER_MS = 1_000_000;
const SECTOR_BYTES = 512;
/** Per-field matchers: /proc/self/io is a flat human-readable key/value file. */
const RCHARS_RE = /^rchar: (\d+)$/m;
const WCHARS_RE = /^wchar: (\d+)$/m;
const READ_BYTES_RE = /^read_bytes: (\d+)$/m;
const WRITE_BYTES_RE = /^write_bytes: (\d+)$/m;

/**
 * Process I/O in bytes. Node's resourceUsage().fsRead/fsWrite are file-system
 * OPERATION counts, not bytes, so the only honest byte source is /proc/self/io
 * — with the catch that its rchar/wchar fields include terminal and pipe I/O.
 * When read_bytes/write_bytes exist (Linux sets them where the storage layer
 * collects them; both are zero on fun-storage setups) they take precedence.
 */
function readProcSelfIo(path: string): BytePair | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const readBytes = READ_BYTES_RE.exec(text);
  const writeBytes = WRITE_BYTES_RE.exec(text);
  if (readBytes && writeBytes) {
    const r = Number(readBytes[1]);
    const w = Number(writeBytes[1]);
    if (r > 0 || w > 0) return { read: r, write: w };
  }
  const rchars = RCHARS_RE.exec(text);
  const wchars = WCHARS_RE.exec(text);
  if (rchars && wchars) return { read: Number(rchars[1]), write: Number(wchars[1]) };
  return null;
}

/**
 * Whole-host NIC bytes. An interface name of "lo" is skipped; everything else
 * — including the veth pairs and bridge devices a container sees — counts,
 * because from this app's perspective that traffic is real.
 */
function parseProcNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue; // headers and blanks
    const iface = line.slice(0, colon).trim();
    if (iface === "lo") continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    // /proc/net/dev format: rx bytes, packets, errs, drop, fifo, frame,
    // compressed, multicast — then the same eight for tx; bytes live at 0 and 8
    const rxB = fields[0];
    const txB = fields[8];
    if (Number.isFinite(rxB)) rx += rxB as number;
    if (Number.isFinite(txB)) tx += txB as number;
  }
  return { rx, tx };
}

/**
 * Whole-host disk bytes. Sectors are 512 bytes by the kernel's own
 * documentation — even on 4K-native drives. Virtual devices (loop/ram) are
 * skipped: upstream `sr`, dm-` partitions and md RAID are kept because they
 * carry real payloads in a VM or container host.
 */
function parseProcDiskstats(text: string): BytePair {
  let read = 0;
  let write = 0;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // name sits at field 3 after major/minor; short lines are pre-3.0 kernel
    // rows or blanks, never devices
    if (fields.length < 14) continue;
    const name = fields[2] ?? "";
    if (/^(loop|ram)/.test(name)) continue;
    const sectorsRead = Number(fields[5]);
    const sectorsWritten = Number(fields[9]);
    if (Number.isFinite(sectorsRead)) read += sectorsRead * SECTOR_BYTES;
    if (Number.isFinite(sectorsWritten)) write += sectorsWritten * SECTOR_BYTES;
  }
  return { read, write };
}

function nullSample(ts: number): SystemSample {
  // deliberately labelled: a null CPU also means "no previous sample to
  // delta against", which only lasts until the first tick
  return {
    ts,
    cpuProcessPct: null,
    cpuSystemPct: null,
    memUsedBytes: os.totalmem() - os.freemem(),
    memTotalBytes: os.totalmem(),
    procRssBytes: process.memoryUsage().rss,
    procHeapUsedBytes: process.memoryUsage().heapUsed,
    eventLoopP50ms: null,
    eventLoopP99ms: null,
    procReadBps: null,
    procWriteBps: null,
    netRxBps: null,
    netTxBps: null,
    diskReadBps: null,
    diskWriteBps: null,
    appInBps: 0,
    appOutBps: 0
  };
}

/**
 * Periodic reader of process counters and Linux /proc gauges. Everything that
 * cannot be measured on this platform degrades to null in every sample; the
 * sampler itself never throws from a tick.
 */
/** Container CPU quota and cpuset bound the available capacity. Ancestors
 * may impose a tighter quota than the process's own cgroup. */
export function readCpuCapacity(paths: string[], fallback: number): { cores: number; throttledUs: number | null } {
  let cores = fallback;
  let throttledUs: number | null = null;
  for (const path of paths) {
    try {
      const [quota, period] = readFileSync(join(path, "cpu.max"), "utf8").trim().split(/\s+/);
      if (quota !== "max" && Number(quota) > 0 && Number(period) > 0) cores = Math.min(cores, Number(quota) / Number(period));
    } catch { /* not cgroup v2 */ }
    try {
      const cpus = readFileSync(join(path, "cpuset.cpus.effective"), "utf8").trim();
      if (/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cpus)) {
        const n = cpus.split(",").reduce((sum, range) => { const [a, b = a] = range.split("-").map(Number); return sum + b! - a! + 1; }, 0);
        if (n > 0) cores = Math.min(cores, n);
      }
    } catch { /* unavailable */ }
    try {
      const text = readFileSync(join(path, "cpu.stat"), "utf8");
      const match = /^throttled_usec\s+(\d+)$/m.exec(text);
      if (match) throttledUs = (throttledUs ?? 0) + Number(match[1]);
    } catch { /* unavailable */ }
  }
  return { cores: Math.max(0.01, cores), throttledUs };
}

export function createSystemSampler(opts: SystemSamplerOpts = {}): SystemSampler {
  const intervalMs = opts.intervalMs ?? 2000;
  const root = opts.cgroupRootPath ?? "/sys/fs/cgroup";
  const cgroupPaths = [root];
  if (!opts.cgroupRootPath && process.platform === "linux") {
    try {
      const group = /^0::(.*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
      let path = join(root, group ?? "");
      while (path.startsWith(root + "/") && existsSync(path)) {
        cgroupPaths.push(path);
        path = dirname(path);
      }
    } catch { /* root may already be the container's cgroup mount */ }
  }
  const historySize = opts.historySize ?? 600;
  const procNetDevPath = opts.procNetDevPath ?? "/proc/net/dev";
  const procDiskstatsPath = opts.procDiskstatsPath ?? "/proc/diskstats";
  const procSelfIoPath = opts.procSelfIoPath ?? "/proc/self/io";

  // A 20ms-resolution histogram trades a pinch of low-end accuracy for a
  // permanent memory cap; enabled once because the histogram survives reset().
  //
  // What this number can and cannot carry. On Windows (15.6ms system tick) an
  // idle Bun process with no application in it reports an event-loop p99 of up
  // to ~21ms, at 0% process CPU. Finer resolution makes it worse by catching
  // more outliers, and p99 is indistinguishable from max here at ~100 samples
  // per interval, so neither is a lever. The floor is the platform's, not ours.
  //
  // The worker holds the clock, so validityFor reads the worker's goroutine
  // scheduling p99 and does not consult this at all for a window the worker
  // covered; it used to, and disqualified idle windows for the host's timer
  // granularity. This remains the fallback for a window with no worker health,
  // and VALIDITY_LIMITS.eventLoopP99Ms is set above the measured floor so that
  // fallback is a gate rather than a permanent fail.
  let loopHist: ReturnType<typeof monitorEventLoopDelay> | null = null;
  try {
    loopHist = monitorEventLoopDelay({ resolution: 20 });
    loopHist.enable();
  } catch {
    loopHist = null;
  }

  let timer: NodeJS.Timeout | null = null;
  let prev: Counters | null = null;
  let latestSample: SystemSample | null = null;
  const samples: SystemSample[] = [];

  // app traffic is pushed in, not polled: the sampler stays decoupled from the
  // store and the app bytes still line up with the sample that saw them
  let appInAcc = 0;
  let appOutAcc = 0;
  let appTs: number | null = null;
  let appInBps = 0;
  let appOutBps = 0;

  function readCounters(): Counters {
    const cpu = process.cpuUsage();
    let sysBusyUs = 0;
    for (const c of os.cpus()) {
      sysBusyUs += (c.times.user + c.times.nice + c.times.sys + c.times.irq) * 1000; // ms → µs
    }
    let netRx: number | null = null;
    let netTx: number | null = null;
    try {
      const net = parseProcNetDev(readFileSync(procNetDevPath, "utf8"));
      netRx = net.rx;
      netTx = net.tx;
    } catch {
      // /proc absent or unreadable → the B/s fields stay null this sample
    }
    let diskRead: number | null = null;
    let diskWrite: number | null = null;
    try {
      const d = parseProcDiskstats(readFileSync(procDiskstatsPath, "utf8"));
      diskRead = d.read;
      diskWrite = d.write;
    } catch {
      // same degradation as above
    }
    const capacity = readCpuCapacity(cgroupPaths, Math.max(os.availableParallelism(), 1));
    return {
      capacity: capacity.cores, throttledUs: capacity.throttledUs,
      tsMs: Date.now(),
      hrtUs: Number(process.hrtime.bigint() / 1000n),
      procCpuUs: cpu.user + cpu.system,
      sysBusyUs,
      procIo: readProcSelfIo(procSelfIoPath),
      netRx,
      netTx,
      diskRead,
      diskWrite
    };
  }

  function tick(): void {
    try {
      const cur = readCounters();
      if (prev === null) {
        // first sample after start: nothing to delta — publish the level fields
        latestSample = nullSample(cur.tsMs);
        ring(latestSample);
      } else {
        const elapsedUs = Math.max(cur.hrtUs - prev.hrtUs, 1);
        const elapsedMs = Math.max(cur.tsMs - prev.tsMs, 1);
        const coreCount = Math.max(os.cpus().length, 1);
        const clamp = (v: number): number => Math.min(100, Math.max(0, v));
        latestSample = {
          ts: cur.tsMs,
          intervalStartTs: prev.tsMs,
          cpuCorePct: (100 * (cur.procCpuUs - prev.procCpuUs)) / elapsedUs,
          cpuCapacityPct: clamp((100 * (cur.procCpuUs - prev.procCpuUs)) / (elapsedUs * cur.capacity)),
          cpuThrottledMs: prev.throttledUs === null || cur.throttledUs === null ? null : Math.max(0, cur.throttledUs - prev.throttledUs) / 1000,
          eventLoopMaxMs: loopHist === null ? null : loopHist.max / NS_PER_MS,
          // both CPU numbers are a share of TOTAL machine capacity, not of one core
          cpuProcessPct: clamp((100 * (cur.procCpuUs - prev.procCpuUs)) / (elapsedUs * coreCount)),
          cpuSystemPct: clamp((100 * (cur.sysBusyUs - prev.sysBusyUs)) / (elapsedUs * coreCount)),
          memUsedBytes: os.totalmem() - os.freemem(),
          memTotalBytes: os.totalmem(),
          procRssBytes: process.memoryUsage().rss,
          procHeapUsedBytes: process.memoryUsage().heapUsed,
          eventLoopP50ms: loopHist === null ? null : loopHist.percentile(50) / NS_PER_MS,
          eventLoopP99ms: loopHist === null ? null : loopHist.percentile(99) / NS_PER_MS,
          procReadBps: rate(prev.procIo?.read, cur.procIo?.read, elapsedMs),
          procWriteBps: rate(prev.procIo?.write, cur.procIo?.write, elapsedMs),
          netRxBps: rate(prev.netRx, cur.netRx, elapsedMs),
          netTxBps: rate(prev.netTx, cur.netTx, elapsedMs),
          diskReadBps: rate(prev.diskRead, cur.diskRead, elapsedMs),
          diskWriteBps: rate(prev.diskWrite, cur.diskWrite, elapsedMs),
          appInBps,
          appOutBps
        };
        loopHist?.reset();
        ring(latestSample);
      }
      prev = cur;
    } catch {
      // a tick must never take the whole process down; counter jumps (interface
      // hot-plug, disk replaced) show up as a null or clamped sample instead
    }
  }

  function rate(before: number | null | undefined, after: number | null | undefined, elapsedMs: number): number | null {
    if (before == null || after == null || elapsedMs <= 0) return null;
    // a counter going backwards means the source reset (interface swapped) —
    // jitter is worse than a gap, so report a null
    if (after < before) return null;
    return ((after - before) * 1000) / elapsedMs;
  }

  function ring(s: SystemSample): void {
    samples.push(s);
    if (samples.length > historySize) samples.splice(0, samples.length - historySize);
  }

  function noteBatch(batch: AggregateBatch): void {
    if (!batch || !Array.isArray(batch.cells)) return;
    const now = Date.now();
    if (appTs !== null && now > appTs) {
      // publish the rate accumulated since the previous batch, then restart —
      // between batches the counter targets are zero-width so nothing decays wrong
      const elapsedMs = now - appTs;
      appInBps = (appInAcc * 1000) / elapsedMs;
      appOutBps = (appOutAcc * 1000) / elapsedMs;
      appInAcc = 0;
      appOutAcc = 0;
    }
    appTs = now;
    // summed over cells, not requests: the byte totals are already in the
    // roll-up, and walking every result here would put the per-request pass
    // this batch shape exists to remove straight back onto the event loop
    for (const c of batch.cells) {
      appInAcc += Number.isFinite(c?.bytesReq) ? c.bytesReq : 0;
      appOutAcc += Number.isFinite(c?.bytesResp) ? c.bytesResp : 0;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      loopHist?.enable();
      timer = setInterval(tick, intervalMs);
      // the sampler must never be the reason the process refuses to exit
      timer.unref();
      tick();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      loopHist?.disable();
    },
    sampleNow: tick,
    latest() {
      // before start() (or after a tick threw) report levels with null rates
      return latestSample ?? nullSample(Date.now());
    },
    history(n = samples.length) {
      return samples.slice(Math.max(0, samples.length - n));
    },
    noteBatch
  };
}
