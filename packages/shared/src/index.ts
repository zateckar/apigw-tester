// Shared types across petstore, loadgen, metrics and ui.

// ---------- Petstore domain ----------
export type PetStatus = "available" | "pending" | "sold";

export interface Pet {
  id: number;
  name: string;
  status: PetStatus;
  category: { id: number; name: string };
  tags: { id: number; name: string }[];
  photoUrls: string[];
  description?: string;
}

export interface Order {
  id: number;
  petId: number;
  quantity: number;
  shipDate: string;
  status: "placed" | "approved" | "delivered";
  complete: boolean;
}

// ---------- Variability / chaos knobs (petstore) ----------
export type LatencyDistribution =
  | { kind: "fixed"; ms: number }
  | { kind: "uniform"; minMs: number; maxMs: number }
  | { kind: "normal"; meanMs: number; stddevMs: number };

export interface EndpointLatencyProfile {
  [endpointKey: string]: LatencyDistribution;
}

export interface ChaosConfig {
  errorRatePct: number; // probability a request returns 500
  timeoutRatePct: number; // probability a request hangs past client timeout
}

// ---------- Gateway + load config ----------
export interface GwConfig {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  pathPrefix: string;
}

export const DEFAULT_GW_CONFIG: GwConfig = {
  baseUrl: "http://petstore:8081",
  apiKey: "",
  apiKeyHeader: "X-API-Key",
  pathPrefix: ""
};

export type LoadMode = "constant" | "ramp" | "spike" | "sine-daily" | "real";

export interface LoadProfile {
  mode: LoadMode;
  // constant
  rps?: number;
  // ramp
  rampFrom?: number;
  rampTo?: number;
  rampMinutes?: number;
  // spike
  spikeBase?: number;
  spikePeak?: number;
  spikeEveryMinutes?: number;
  spikeDurationSeconds?: number;
  // sine-daily
  sineMin?: number;
  sineMax?: number;
  // common
  maxConcurrency: number;
  soapRatioPct: number; // 0-100 of traffic through the SOAP endpoint
  scenarioWeights: {
    listPets: number;
    getPet: number;
    createPet: number;
    updatePet: number;
    deletePet: number;
    placeOrder: number;
  };
}

export const DEFAULT_LOAD_PROFILE: LoadProfile = {
  mode: "constant",
  rps: 10,
  maxConcurrency: 25,
  soapRatioPct: 25,
  scenarioWeights: {
    listPets: 50,
    getPet: 20,
    createPet: 10,
    updatePet: 5,
    deletePet: 5,
    placeOrder: 10
  }
};

// ---------- Request / metrics records ----------
export type Protocol = "rest" | "soap";

/** Stress class the request belongs to; drives the per-class GW-overhead math. */
export type ScenarioClass =
  | "small-rest"      // typical small JSON CRUD call
  | "big-response"    // target returns a large body (GW copies/buffers it)
  | "big-request"     // client sends a large body (GW reads/proxies it)
  | "slow-upstream"   // target sleeps 500+ms before responding (GW keeps connection open)
  | "concurrency"     // issued during a surge burst
  | "soap";           // any SOAP call (XML envelope)

export interface RequestResult {
  runId: string;
  ts: number; // epoch ms when the request started
  protocol: Protocol;
  endpoint: string; // logical endpoint key, e.g. "GET /api/pets/{id}"
  class: ScenarioClass;
  method: string;
  status: number; // 0 = network error / timeout
  latencyMs: number;
  /** Estimated ms cost the gateway added vs. hitting the SUT directly. */
  baselineMs: number;
  overheadMs: number; // latencyMs - baselineMs (can clip negative to 0 downstream)
  bytesReq: number;
  bytesResp: number;
  error: string | null;
}

export interface IngestBatch {
  batchId: string; // idempotency token
  results: RequestResult[];
}

// histogram bucket upper edges in ms (log-ish scale), 40 buckets
export const HISTOGRAM_EDGES_MS: number[] = buildEdges();

function buildEdges(): number[] {
  const edges: number[] = [];
  let v = 1;
  while (edges.length < 40) {
    const rounded = Math.round(v);
    // rounding at the low end collides, e.g. round(1)=1 then round(1.35)=1
    edges.push(Math.max(rounded, edges.length === 0 ? 1 : (edges[edges.length - 1] as number) + 1));
    v *= 1.35;
  }
  return edges;
}

export interface MetricSummary {
  windowSec: number;
  total: number;
  errors: number;
  errorPct: number;
  rps: number;
  latencyMs: { p50: number; p90: number; p95: number; p99: number; avg: number; max: number };
  /** How much of the observed latency the gateway is responsible for. */
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

export interface TimePoint {
  ts: number; // bucket epoch ms
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

// ---------- Run control ----------
export type RunState = "idle" | "running" | "stopping";

export interface RunStatus {
  state: RunState;
  runId: string | null;
  startedAt: number | null;
  uptimeSec: number | null;
  profile: LoadProfile | null;
  targetRps: number;
  counters: { sent: number; ok: number; errors: number; timeouts: number };
}

export interface RunEvent {
  id: number;
  runId: string;
  startedAt: number;
  stoppedAt: number | null;
  profile: LoadProfile;
}
