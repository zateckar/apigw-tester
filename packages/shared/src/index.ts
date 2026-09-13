// Shared types across petstore, loadgen, metrics and ui.

// ---------- Petstore domain ----------
export const PET_STATUSES = ["available", "pending", "sold"] as const;
export type PetStatus = (typeof PET_STATUSES)[number];

export function isPetStatus(v: unknown): v is PetStatus {
  return typeof v === "string" && (PET_STATUSES as readonly string[]).includes(v);
}

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

/** Hard ceilings for operator-supplied knobs. Everything crossing an HTTP
 *  boundary is clamped to these so a bad value can never wedge the process. */
export const LIMITS = {
  /** max simulated per-request delay the petstore will honour (X-Test-Delay-Ms, latency profiles) */
  delayMs: 30_000,
  /** max synthetic response padding (X-Test-Size-B) */
  padBytes: 10 * 1024 * 1024,
  /** max body /api/big/:size will produce */
  bigBytes: 10 * 1024 * 1024,
  /** max sleep /api/slow/:ms will honour */
  slowMs: 10_000,
  /** max rows GET /api/recent will return */
  recentLimit: 500,
  /** max points a single /api/timeseries response may contain */
  timeseriesPoints: 10_000,
  rps: 10_000,
  maxConcurrency: 5_000,
  /** pets retained by the in-memory SUT before the oldest generated ones are evicted */
  petStoreSize: 5_000
} as const;

// ---------- Gateway + load config ----------
export interface GwConfig {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  pathPrefix: string;
}

export const DEFAULT_GW_CONFIG: GwConfig = {
  // the bundled petstore on this same process/port — works out of the box
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  apiKeyHeader: "X-API-Key",
  pathPrefix: ""
};

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
  /** 0-100 of traffic deliberately violating the published OpenAPI/WSDL contract,
   *  so a content-validating gateway can be observed rejecting it. Keep small. */
  invalidRatioPct: number;
  scenarioWeights: ScenarioWeights;
}

export const DEFAULT_LOAD_PROFILE: LoadProfile = {
  mode: "constant",
  rps: 10,
  maxConcurrency: 25,
  soapRatioPct: 25,
  invalidRatioPct: 2,
  scenarioWeights: {
    listPets: 50,
    getPet: 20,
    createPet: 10,
    updatePet: 5,
    deletePet: 5,
    placeOrder: 10
  }
};

// ---------- Config sanitizers ----------
// Single source of truth: the HTTP layer, the driver and the UI all go through
// these, so no unchecked operator input ever reaches a timer or the scheduler.

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function optClamp(v: unknown, lo: number, hi: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
}

const LOAD_MODES: readonly LoadMode[] = ["constant", "ramp", "spike", "sine-daily", "real"];

/** Coerce arbitrary JSON into a LoadProfile that is always safe to run. */
export function sanitizeLoadProfile(input: unknown, base: LoadProfile = DEFAULT_LOAD_PROFILE): LoadProfile {
  const raw = (input ?? {}) as Partial<LoadProfile>;
  const mode = LOAD_MODES.includes(raw.mode as LoadMode) ? (raw.mode as LoadMode) : base.mode;

  const wIn = (raw.scenarioWeights ?? {}) as Partial<ScenarioWeights>;
  const weights: ScenarioWeights = {
    listPets: clampNum(wIn.listPets, 0, 1e6, base.scenarioWeights.listPets),
    getPet: clampNum(wIn.getPet, 0, 1e6, base.scenarioWeights.getPet),
    createPet: clampNum(wIn.createPet, 0, 1e6, base.scenarioWeights.createPet),
    updatePet: clampNum(wIn.updatePet, 0, 1e6, base.scenarioWeights.updatePet),
    deletePet: clampNum(wIn.deletePet, 0, 1e6, base.scenarioWeights.deletePet),
    placeOrder: clampNum(wIn.placeOrder, 0, 1e6, base.scenarioWeights.placeOrder)
  };
  // an all-zero mix would make weighted selection meaningless — fall back
  if (Object.values(weights).every((w) => w === 0)) Object.assign(weights, base.scenarioWeights);

  const out: LoadProfile = {
    mode,
    maxConcurrency: Math.round(clampNum(raw.maxConcurrency, 1, LIMITS.maxConcurrency, base.maxConcurrency)),
    soapRatioPct: clampNum(raw.soapRatioPct, 0, 100, base.soapRatioPct),
    invalidRatioPct: clampNum(raw.invalidRatioPct, 0, 100, base.invalidRatioPct),
    scenarioWeights: weights
  };

  const rps = optClamp(raw.rps, 0, LIMITS.rps);
  if (rps !== undefined) out.rps = rps;
  else if (base.rps !== undefined) out.rps = base.rps;

  const pairs: [keyof LoadProfile, number, number][] = [
    ["rampFrom", 0, LIMITS.rps],
    ["rampTo", 0, LIMITS.rps],
    ["rampMinutes", 0.1, 7 * 24 * 60],
    ["spikeBase", 0, LIMITS.rps],
    ["spikePeak", 0, LIMITS.rps],
    ["spikeEveryMinutes", 0.1, 7 * 24 * 60],
    ["spikeDurationSeconds", 1, 24 * 3600],
    ["sineMin", 0, LIMITS.rps],
    ["sineMax", 0, LIMITS.rps]
  ];
  const target = out as unknown as Record<string, unknown>;
  for (const [key, lo, hi] of pairs) {
    const v = optClamp(raw[key], lo, hi) ?? optClamp(base[key], lo, hi);
    if (v !== undefined) target[key] = v;
  }
  return out;
}

/** Header names must not carry CR/LF or separators — otherwise a saved config
 *  could inject arbitrary headers into every generated request. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function sanitizeGwConfig(input: unknown, base: GwConfig = DEFAULT_GW_CONFIG): GwConfig {
  const raw = (input ?? {}) as Partial<GwConfig>;
  const strip = (s: unknown, fallback: string): string =>
    typeof s === "string" ? s.replace(/[\r\n\0]/g, "") : fallback;

  let baseUrl = strip(raw.baseUrl, base.baseUrl).trim().replace(/\/+$/, "");
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
  } catch {
    baseUrl = base.baseUrl;
  }

  const header = strip(raw.apiKeyHeader, base.apiKeyHeader).trim();
  return {
    baseUrl,
    apiKey: strip(raw.apiKey, base.apiKey),
    apiKeyHeader: HEADER_NAME_RE.test(header) ? header : "X-API-Key",
    pathPrefix: strip(raw.pathPrefix, base.pathPrefix).trim()
  };
}

/** Throws with a human-readable reason if the gateway config is unusable. */
export function validateGwConfig(input: unknown): string | null {
  const raw = (input ?? {}) as Partial<GwConfig>;
  if (typeof raw.baseUrl !== "string" || raw.baseUrl.trim() === "") return "baseUrl is required";
  try {
    const u = new URL(raw.baseUrl.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "baseUrl must be http:// or https://";
  } catch {
    return "baseUrl must be an absolute URL";
  }
  return null;
}

// ---------- Request / metrics records ----------
export type Protocol = "rest" | "soap";

/** Stress class the request belongs to; drives the per-class GW-overhead math. */
export type ScenarioClass =
  | "small-rest"      // typical small JSON CRUD call
  | "big-response"    // target returns a large body (GW copies/buffers it)
  | "big-request"     // client sends a large body (GW reads/proxies it)
  | "slow-upstream"   // target sleeps 500+ms before responding (GW keeps connection open)
  | "concurrency"     // issued during a surge burst
  | "soap"            // any SOAP call (XML envelope)
  | "invalid";        // deliberately violates the published contract (expect a 4xx from the GW)

export const SCENARIO_CLASSES: readonly ScenarioClass[] = [
  "small-rest", "big-response", "big-request", "slow-upstream", "concurrency", "soap", "invalid"
];

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
  overheadMs: number; // latencyMs - baselineMs (clipped at 0)
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
  /** Contract-violating traffic and how the target handled it. */
  contract: { invalidSent: number; rejected4xx: number; wronglyAccepted: number };
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
  /** true when the requested span was clamped to LIMITS.timeseriesPoints */
  truncated?: boolean;
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
  counters: { sent: number; ok: number; errors: number; timeouts: number; invalidSent: number; invalidRejected: number };
  gateway?: GwConfig;
}

export interface RunEvent {
  id: number;
  runId: string;
  startedAt: number;
  stoppedAt: number | null;
  profile: LoadProfile;
}
