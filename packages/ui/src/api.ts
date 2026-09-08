import { getCreds, setCreds } from "./main";

export type Protocol = "rest" | "soap";

export type ScenarioClass =
  | "small-rest" | "big-response" | "big-request" | "slow-upstream" | "concurrency" | "soap";

export interface ClassStat {
  cls: ScenarioClass;
  total: number;
  errors: number;
  errorPct: number;
  rps: number;
  latencyMs: { p50: number; p95: number; p99: number; avg: number };
  overheadMs: { p50: number; p95: number; p99: number; avg: number };
  avgBytesReq: number;
  avgBytesResp: number;
}

export interface MetricSummary {
  windowSec: number;
  total: number;
  errors: number;
  errorPct: number;
  rps: number;
  latencyMs: { p50: number; p90: number; p95: number; p99: number; avg: number; max: number };
  overheadMs: { p50: number; p90: number; p95: number; p99: number; avg: number };
  bytes: { req: number; resp: number; respPerSec: number };
  perProtocol: { protocol: Protocol; total: number; errors: number }[];
  perEndpoint: EndpointStat[];
  perClass: ClassStat[];
}

export interface EndpointStat {
  protocol: Protocol;
  endpoint: string;
  total: number;
  errors: number;
  errorPct: number;
  rps: number;
  p50: number;
  p95: number;
  avgLatencyMs: number;
  avgRespBytes: number;
}

export interface TimePoint {
  ts: number;
  total: number;
  errors: number;
  rps: number;
  p50: number;
  p90: number;
  p99: number;
  overheadP50: number;
  overheadP95: number;
  overheadP99: number;
  bytesResp: number;
  restTotal: number;
  soapTotal: number;
  restErrors: number;
  soapErrors: number;
}

export interface TimeSeries {
  bucketSec: number;
  points: TimePoint[];
}

export interface RequestResult {
  runId: string;
  ts: number;
  protocol: Protocol;
  endpoint: string;
  class: ScenarioClass;
  method: string;
  status: number;
  latencyMs: number;
  baselineMs: number;
  overheadMs: number;
  bytesReq: number;
  bytesResp: number;
  error: string | null;
}

export interface GwConfig {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  pathPrefix: string;
}

export type LoadMode = "constant" | "ramp" | "spike" | "sine-daily" | "real";

export interface ScenarioWeights {
  listPets: number;
  getPet: number;
  createPet: number;
  updatePet: number;
  deletePet: number;
  placeOrder: number;
}

export interface LoadProfile {
  mode: LoadMode;
  rps?: number;
  rampFrom?: number;
  rampTo?: number;
  rampMinutes?: number;
  spikeBase?: number;
  spikePeak?: number;
  spikeEveryMinutes?: number;
  spikeDurationSeconds?: number;
  sineMin?: number;
  sineMax?: number;
  maxConcurrency: number;
  soapRatioPct: number;
  scenarioWeights: ScenarioWeights;
}

export interface RunStatus {
  state: "idle" | "running" | "stopping";
  runId: string | null;
  startedAt: number | null;
  uptimeSec: number | null;
  profile: LoadProfile | null;
  targetRps: number;
  counters: { sent: number; ok: number; errors: number; timeouts: number };
  gateway?: GwConfig;
}

export interface RunEvent {
  id: number;
  runId: string;
  startedAt: number;
  stoppedAt: number | null;
  profile: LoadProfile;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Basic auth for every request. Browsers will also do a native prompt when the
  // fetch itself lacks credentials, which lets us keep this minimal.
  const creds = getCreds();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(creds ? { authorization: creds } : {})
    }
  });
  if (res.status === 401 && !path.endsWith("/auth-check")) {
    // trigger the native Basic prompt once, then let the UI render it
    setCreds(null);
    window.location.reload();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}


export const api = {
  summary: (window: string) => req<MetricSummary>(`/api/summary?window=${window}`),
  timeseries: (hours: number) => {
    const to = Date.now();
    const from = to - hours * 3600_000;
    const bucket = hours <= 2 ? 60 : 3600;
    return req<TimeSeries>(`/api/timeseries?bucket=${bucket}&from=${from}&to=${to}`);
  },
  recent: (limit = 100) => req<{ items: RequestResult[] }>(`/api/recent?limit=${limit}`),
  status: () => req<RunStatus>("/api/run/status"),
  runs: () => req<RunEvent[]>("/api/runs"),
  gateway: () => req<GwConfig | null>("/api/config/gateway"),
  profile: () => req<LoadProfile | null>("/api/config/profile"),
  saveGateway: (cfg: GwConfig) =>
    req<{ saved: true }>("/api/config/gateway", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    }),
  saveProfile: (p: LoadProfile) =>
    req<{ saved: true }>("/api/config/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p)
    }),
  startRun: () =>
    req<{ ok: true; runId: string }>("/api/run/start", { method: "POST" }),
  stopRun: () => req<{ stopped: true }>("/api/run/stop", { method: "POST" })
};

export const DEFAULT_PROFILE: LoadProfile = {
  mode: "constant",
  rps: 10,
  maxConcurrency: 25,
  soapRatioPct: 25,
  scenarioWeights: {
    listPets: 50, getPet: 20, createPet: 10, updatePet: 5, deletePet: 5, placeOrder: 10
  }
};

export const DEFAULT_GW: GwConfig = {
  baseUrl: "http://petstore:8081",
  apiKey: "",
  apiKeyHeader: "X-API-Key",
  pathPrefix: ""
};

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtMs(n: number): string {
  if (n < 1) return `${(n * 1000).toFixed(0)} µs`;
  if (n < 1000) return `${n.toFixed(0)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
