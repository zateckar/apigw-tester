import { getCreds, setCreds } from "./main";

// Types come from the same package the server uses — the UI used to re-declare
// all of them, which let the two drift apart silently.
export type {
  ClassStat,
  EndpointStat,
  GwConfig,
  LoadMode,
  LoadProfile,
  MetricSummary,
  Protocol,
  RequestResult,
  RunEvent,
  RunStatus,
  ScenarioClass,
  ScenarioWeights,
  TimePoint,
  TimeSeries
} from "@apigw/shared";

import type { GwConfig, LoadProfile, MetricSummary, RequestResult, RunEvent, RunStatus, TimeSeries } from "@apigw/shared";
import { DEFAULT_GW_CONFIG, DEFAULT_LOAD_PROFILE, LIMITS } from "@apigw/shared";

/** Windows GET /api/summary accepts. Keep in sync with SUMMARY_WINDOWS in app.ts. */
export const SUMMARY_WINDOWS = ["5m", "15m", "1h", "6h", "24h", "7d"] as const;
export type SummaryWindow = (typeof SUMMARY_WINDOWS)[number];

export class ApiError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const creds = getCreds();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(creds ? { authorization: creds } : {})
    }
  });
  if (res.status === 401) {
    // drop the credential and let <Root> swap in the login gate. Reloading here
    // turned a persistent 401 into a reload loop against a failing server.
    setCreds(null);
    throw new ApiError(401, path, "Unauthorized — sign in again.");
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = `${res.status} — ${body.error}`;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, path, `${path} failed: ${detail}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch an API definition with auth and hand it to the browser as a download. */
export async function downloadDefinition(path: string, filename: string): Promise<void> {
  const creds = getCreds();
  const res = await fetch(path, { headers: creds ? { authorization: creds } : {} });
  if (!res.ok) throw new ApiError(res.status, path, `${path} failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // give the click a tick before revoking
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export interface DefinitionIndex {
  openapiJson: string;
  openapiYaml: string;
  wsdl: string;
  serverUrl: string;
  note: string;
}

/** Result of POST /api/config/gateway/test. */
export interface GatewayProbe {
  ok: boolean;
  url: string;
  latencyMs: number;
  status?: number;
  error?: string;
}

export const api = {
  summary: (window: SummaryWindow) => req<MetricSummary>(`/api/summary?window=${window}`),
  timeseries: (hours: number) => {
    const to = Date.now();
    const from = to - hours * 3600_000;
    const bucket = hours <= 2 ? 60 : 3600;
    return req<TimeSeries>(`/api/timeseries?bucket=${bucket}&from=${from}&to=${to}`);
  },
  recent: (limit = 100) =>
    req<{ items: RequestResult[] }>(`/api/recent?limit=${Math.min(limit, LIMITS.recentLimit)}`),
  status: () => req<RunStatus>("/api/run/status"),
  runs: () => req<RunEvent[]>("/api/runs"),
  gateway: () => req<GwConfig>("/api/config/gateway"),
  profile: () => req<LoadProfile>("/api/config/profile"),
  definitions: () => req<DefinitionIndex>("/api/definitions"),
  saveGateway: (cfg: GwConfig) =>
    req<{ saved: true; gateway: GwConfig }>("/api/config/gateway", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    }),
  saveProfile: (p: LoadProfile) =>
    req<{ saved: true; profile: LoadProfile }>("/api/config/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p)
    }),
  // probed by the server, not the browser: the dashboard's `connect-src 'self'`
  // CSP blocks any cross-origin fetch, and the gateway is always another origin
  testGateway: (cfg: GwConfig) =>
    req<GatewayProbe>("/api/config/gateway/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    }),
  startRun: () => req<{ ok: true; runId: string }>("/api/run/start", { method: "POST" }),
  stopRun: () => req<{ stopped: true }>("/api/run/stop", { method: "POST" })
};

export const DEFAULT_PROFILE: LoadProfile = DEFAULT_LOAD_PROFILE;
export const DEFAULT_GW: GwConfig = DEFAULT_GW_CONFIG;

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1) return `${(n * 1000).toFixed(0)} µs`;
  if (n < 1000) return `${n.toFixed(0)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
