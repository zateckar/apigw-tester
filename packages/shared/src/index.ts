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

/**
 * Whether generated requests carry this rig's own `Authorization: Basic …`
 * (the APP_BASIC_AUTH credential that guards the dashboard).
 *
 * - `auto`   — forward only when the target resolves to this process, i.e. the
 *              bundled petstore. Anything else is a third party and must not
 *              receive the dashboard credential.
 * - `always` — forward regardless. Use when the gateway itself is configured to
 *              accept (or pass through) the same Basic credential.
 * - `never`  — never forward, even to the bundled petstore.
 *
 * `auto` is the default because the built-in target needs the header while an
 * external gateway must never see it: sending it leaks the admin credential
 * into a third-party system's access log, and a gateway doing its own auth may
 * reject or rewrite a header it did not expect.
 */
export type ForwardBasicAuth = "auto" | "always" | "never";
export const FORWARD_BASIC_AUTH_MODES: readonly ForwardBasicAuth[] = ["auto", "always", "never"];

export interface GwConfig {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  pathPrefix: string;
  forwardBasicAuth: ForwardBasicAuth;
}

export const DEFAULT_GW_CONFIG: GwConfig = {
  // the bundled petstore on this same process/port — works out of the box
  baseUrl: "http://127.0.0.1:8080",
  apiKey: "",
  apiKeyHeader: "X-API-Key",
  pathPrefix: "",
  forwardBasicAuth: "auto"
};

/** REST and SOAP traffic may be fronted by the gateway at different URLs and keys. */
export interface GwTargets {
  rest: GwConfig;
  soap: GwConfig;
}

export const DEFAULT_GW_TARGETS: GwTargets = {
  rest: { ...DEFAULT_GW_CONFIG },
  soap: { ...DEFAULT_GW_CONFIG }
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
  /** Stop the run automatically after this many minutes. Absent or 0 = run
   *  until stopped by hand. An acceptance test wants a bounded run it can
   *  produce a report for; an always-on rig does not. */
  durationMinutes?: number;
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
    // 0 is meaningful here: "no automatic stop". Hence the 0 floor rather
    // than the 0.1 the other duration knobs use.
    ["durationMinutes", 0, 7 * 24 * 60],
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
  const forward = raw.forwardBasicAuth;
  return {
    baseUrl,
    apiKey: strip(raw.apiKey, base.apiKey),
    apiKeyHeader: HEADER_NAME_RE.test(header) ? header : "X-API-Key",
    pathPrefix: strip(raw.pathPrefix, base.pathPrefix).trim(),
    // an unrecognised value falls back to the base rather than to "always":
    // failing open here would re-introduce the credential leak this exists to stop
    forwardBasicAuth: FORWARD_BASIC_AUTH_MODES.includes(forward as ForwardBasicAuth)
      ? (forward as ForwardBasicAuth)
      : base.forwardBasicAuth
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

function cloneTargets(t: GwTargets): GwTargets {
  return { rest: { ...t.rest }, soap: { ...t.soap } };
}

/** Coerce arbitrary JSON into per-protocol gateway targets. A legacy flat
 *  GwConfig (with a top-level baseUrl, no rest/soap keys) upgrades its fields
 *  onto both targets, so a row persisted by an older version keeps working. */
export function sanitizeGwTargets(input: unknown, base: GwTargets = DEFAULT_GW_TARGETS): GwTargets {
  const raw = (input ?? {}) as Record<string, unknown>;
  const flat = typeof raw.baseUrl === "string" && raw.rest === undefined && raw.soap === undefined;
  const restIn = flat ? raw : raw.rest;
  const soapIn = flat ? raw : raw.soap;
  const out = cloneTargets(base);
  if (restIn !== undefined && restIn !== null) out.rest = sanitizeGwConfig(restIn, out.rest);
  if (soapIn !== undefined && soapIn !== null) out.soap = sanitizeGwConfig(soapIn, out.soap);
  return out;
}

/** Validate both sides; failures are prefixed so the UI can point at the block. */
export function validateGwTargets(input: unknown): string | null {
  const raw = (input ?? {}) as Record<string, unknown>;
  for (const side of ["rest", "soap"] as const) {
    const problem = validateGwConfig(raw[side]);
    if (problem) return `${side}.${problem}`;
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

// ---------- Status-code classification ----------
//
// A gateway test rig lives or dies on telling *who* produced a status. Folding
// everything into "errors >= 500" made a gateway that 401s or 429s every single
// request read as 0% error rate — the most likely first-run failure mode, and
// the one the dashboard used to hide. So statuses are kept as a real dimension.

/**
 * Fixed, ordered status buckets. This array IS the on-disk layout of the
 * per-bucket status histogram, so entries may be appended but never reordered
 * or removed — an older database's rows are merged positionally.
 */
export const STATUS_BUCKETS = [
  "net",   // no HTTP response at all: connection refused/reset, TLS failure, timeout
  "1xx",
  "2xx",
  "3xx",
  "400",   // malformed / contract-invalid
  "401",   // gateway auth: missing or bad credential
  "403",   // gateway authz: credential understood but not allowed
  "404",   // route not mapped on the gateway (or genuinely absent upstream)
  "405",   // method not allowed by the gateway's route definition
  "408",   // gateway gave up reading the request
  "413",   // body over the gateway's payload limit
  "429",   // rate limit / quota / spike arrest
  "4xx",   // any other client error
  "500",   // upstream application error
  "502",   // gateway could not reach a healthy upstream
  "503",   // gateway overloaded, circuit open, no upstream available
  "504",   // upstream did not answer inside the gateway's timeout
  "5xx"    // any other server error
] as const;

export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** Buckets produced by the gateway itself rather than by the backend. A
 *  non-zero count here is always the gateway's problem, never the SUT's. */
export const GATEWAY_FAULT_BUCKETS: readonly StatusBucket[] = ["net", "502", "503", "504"];

const EXACT_STATUS_BUCKET: Record<number, StatusBucket> = {
  400: "400", 401: "401", 403: "403", 404: "404", 405: "405",
  408: "408", 413: "413", 429: "429",
  500: "500", 502: "502", 503: "503", 504: "504"
};

/** Index into STATUS_BUCKETS for an HTTP status (0 = no response). */
export function statusBucketIndex(status: number): number {
  const name = statusBucketOf(status);
  return STATUS_BUCKETS.indexOf(name);
}

export function statusBucketOf(status: number): StatusBucket {
  if (!Number.isFinite(status) || status <= 0) return "net";
  const exact = EXACT_STATUS_BUCKET[status];
  if (exact) return exact;
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

/** A request the caller would consider successful: any 2xx or 3xx. */
export function isSuccess(status: number): boolean {
  return status >= 200 && status < 400;
}

/** Produced by the gateway, not the backend: no response, 502, 503 or 504. */
export function isGatewayFault(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export interface RequestResult {
  runId: string;
  /** Correlation id echoed to the target as `X-Request-Id` (and as the span id
   *  inside `traceparent`), so a row here can be looked up in the gateway's own
   *  access log or trace backend. */
  requestId: string;
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
  /**
   * Whether this request reached the backend at all, proven by the SUT's
   * `X-Server-Ms` response header. False means the response was manufactured by
   * the gateway (its own 401/404/429, a contract rejection, a 502 with no
   * upstream) — which is precisely what distinguishes "the gateway blocked it"
   * from "the backend blocked it".
   */
  reachedBackend: boolean;
  error: string | null;
}

export interface IngestBatch {
  batchId: string; // idempotency token
  results: RequestResult[];
  /** Scheduler accounting for the same interval. Carried on the batch so the
   *  shed rows commit in the very transaction as the requests they explain —
   *  a window can never show issued load without the load it failed to issue. */
  shed?: LoadShedSample[];
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

// ---------- Measurement validity ----------
//
// This rig is the load generator, the backend and the dashboard in one process.
// When it saturates, the latency it reports is partly its own queueing — and a
// confident p99 drawn from a saturated generator is worse than no number at
// all. Two independent signals say "do not trust this window":
//
//   1. load shedding — the concurrency cap stopped us issuing requests the
//      profile asked for, so the gateway was never actually offered the rate
//      the chart claims (classic coordinated omission: latency looks BETTER
//      exactly when the target is struggling);
//   2. generator saturation — CPU pegged or the event loop stalling, which
//      inflates every measured latency regardless of what the gateway did.

/** Per-minute scheduler accounting, written alongside the metric roll-ups. */
export interface LoadShedSample {
  bucketTs: number;
  /** requests the concurrency ceiling prevented us from issuing */
  dropped: number;
  /** sum of the per-tick target rps, for the mean target over the bucket */
  targetSum: number;
  ticks: number;
}

/** Per-minute host health, so a window older than the in-memory ring can still
 *  be judged. */
export interface HostHealthSample {
  bucketTs: number;
  samples: number;
  cpuSum: number;
  cpuMax: number;
  loopP99Sum: number;
  loopP99Max: number;
}

/** Beyond these, the generator rather than the gateway is the story. */
export const VALIDITY_LIMITS = {
  /** share of total machine capacity this process may burn */
  cpuProcessPct: 85,
  /** event-loop stall that starts showing up in measured latency */
  eventLoopP99Ms: 100,
  /** share of intended load we may fail to issue before the window is suspect */
  shedPct: 1,
  /** share of a run report's window that may belong to other runs. Roll-ups are
   *  minute-granular, so a short run shares its first and last bucket with
   *  whatever ran either side of it. */
  foreignPct: 1
} as const;

export interface WindowValidity {
  /** false when any reason below fired: the UI must visibly qualify the numbers */
  ok: boolean;
  reasons: string[];
  droppedRequests: number;
  /** dropped ÷ (dropped + issued), as a percentage */
  shedPct: number;
  /** mean rate the profile asked for over the window; null when not recorded */
  targetRps: number | null;
  /** rate actually issued */
  achievedRps: number;
  cpuProcessPctMax: number | null;
  eventLoopP99MsMax: number | null;
}

/** Full status distribution plus the roll-ups worth putting on a tile. */
export interface StatusBreakdown {
  /** every bucket with a non-zero count, most frequent first */
  buckets: { bucket: StatusBucket; count: number }[];
  ok: number;             // 2xx + 3xx
  clientErrors: number;   // all 4xx
  serverErrors: number;   // all 5xx
  /** 502/503/504 and outright connection failures — the gateway's own fault */
  gatewayErrors: number;
  rateLimited: number;    // 429
  unauthorized: number;   // 401 + 403
  networkErrors: number;  // no response at all
}

export interface MetricSummary {
  windowSec: number;
  total: number;
  /** 5xx plus outright connection failures. Deliberately NOT 4xx — see
   *  `unexpectedFailures` for the number that answers "is the gateway ok?". */
  errors: number;
  errorPct: number;
  /**
   * Every request that did not succeed, minus the deliberately-invalid slice
   * (which is *supposed* to be rejected). This is the headline health number:
   * a gateway answering 401 or 429 to everything drives it to 100%, where the
   * legacy `errorPct` would have reported a healthy-looking 0%.
   */
  unexpectedFailures: number;
  unexpectedFailurePct: number;
  rps: number;
  latencyMs: { p50: number; p90: number; p95: number; p99: number; avg: number; max: number };
  /** How much of the observed latency the gateway is responsible for. */
  overheadMs: { p50: number; p90: number; p95: number; p99: number; avg: number };
  bytes: { req: number; resp: number; respPerSec: number };
  status: StatusBreakdown;
  /** Whether this window's numbers are trustworthy at all. Read it before the
   *  percentiles: a saturated generator inflates every latency it reports. */
  validity: WindowValidity;
  perProtocol: { protocol: Protocol; total: number; errors: number }[];
  perEndpoint: EndpointStat[];
  perClass: ClassStat[];
  /** Contract-violating traffic and, crucially, *who* stopped it. */
  contract: ContractStats;
}

/**
 * Outcome of the deliberately contract-violating slice.
 *
 * The bundled petstore validates its own input, so "answered 4xx" alone proves
 * nothing about the gateway — it reads ~100% blocked whether or not gateway
 * validation is switched on. `X-Server-Ms` breaks the tie: a response carrying
 * it came from the backend, so the gateway let the request through.
 */
export interface ContractStats {
  invalidSent: number;
  /** 4xx with no backend fingerprint: the gateway rejected it. The number that
   *  actually demonstrates gateway content validation is working. */
  rejectedByGateway: number;
  /** 4xx that reached the backend: the SUT caught what the gateway missed. */
  rejectedByBackend: number;
  /** Reached the backend at all, whatever happened next. With gateway content
   *  validation enabled and correctly configured this must be 0. */
  leakedToBackend: number;
  /** Answered 2xx — a contract violation that nobody caught. Always a bug. */
  wronglyAccepted: number;
  /** Retained for continuity: every 4xx, from either source. */
  rejected4xx: number;
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
  /** 4xx in this class — expected for `invalid`, a red flag anywhere else */
  clientErrors: number;
  /** 502/503/504 + connection failures attributable to the gateway */
  gatewayErrors: number;
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
  /** 4xx in this bucket — plotted separately so a gateway that starts
   *  rate-limiting or rejecting credentials shows up as its own line */
  clientErrors: number;
  /** 502/503/504 + connection failures in this bucket */
  gatewayErrors: number;
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
  /** true when this bucket is still accumulating (current bucket or empty tail while traffic is live) */
  partial?: boolean;
}

export interface TimeSeries {
  bucketSec: number;
  points: TimePoint[];
  /** true when the requested span was clamped to LIMITS.timeseriesPoints */
  truncated?: boolean;
}

// ---------- Gateway policy checks ----------
//
// The load mix proves the gateway can proxy traffic. It says nothing about
// whether the gateway's *policies* actually fire — and an API gateway whose
// rate limit, payload cap or auth is silently not applied is the failure mode
// that matters most. These are deliberate single probes with an expected
// outcome, run on their own cadence rather than mixed into the load, because
// several of them (a quota burst, a cache re-read) need a shape the traffic
// generator cannot express as a percentage.

export type PolicyId =
  | "auth-bad-key"
  | "auth-no-key"
  | "rate-limit"
  | "payload-limit"
  | "upstream-timeout"
  | "cache"
  | "unknown-route"
  | "cors-preflight";

export const POLICY_IDS: readonly PolicyId[] = [
  "auth-bad-key", "auth-no-key", "rate-limit", "payload-limit",
  "upstream-timeout", "cache", "unknown-route", "cors-preflight"
];

/**
 * - `pass`         — the gateway enforced the policy as expected.
 * - `fail`         — the gateway answered, but wrongly (e.g. let a bad key through).
 * - `not-enforced` — the policy is demonstrably not configured. Information,
 *                    not a defect, unless the operator listed it as required:
 *                    plenty of gateways legitimately have no cache or quota.
 * - `error`        — the probe itself could not run (target unreachable).
 * - `skipped`      — not applicable to this configuration.
 */
export type PolicyState = "pass" | "fail" | "not-enforced" | "error" | "skipped";

export interface PolicyResult {
  id: PolicyId;
  label: string;
  /** what the probe did, in one line — shown so a result is auditable */
  probe: string;
  /** what a gateway enforcing this policy is expected to answer */
  expectation: string;
  state: PolicyState;
  detail: string;
  status: number | null;
  /** whether the response carried the SUT's fingerprint; null when not applicable */
  reachedBackend: boolean | null;
  latencyMs: number | null;
  checkedAt: number;
}

export interface PolicyConfig {
  enabled: boolean;
  /** how often the whole set is re-run while a run is live */
  intervalSec: number;
  /**
   * Policies the operator asserts this gateway SHOULD enforce. For these a
   * `not-enforced` result is a failure; for the rest it is merely reported.
   * Empty by default — we do not know your gateway's intended posture, and
   * inventing failures for policies you never configured is noise.
   */
  required: PolicyId[];
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  enabled: true,
  // Several probes are deliberately abusive (a concurrent burst, a multi-MB
  // upload, a request that hangs for 10s). They run against the same gateway
  // the load test is measuring, so a tight cadence would perturb the very
  // numbers this tool exists to report. Five minutes is frequent enough that
  // any run long enough to matter gets several passes.
  intervalSec: 300,
  required: []
};

export const POLICY_LIMITS = {
  minIntervalSec: 15,
  maxIntervalSec: 3600
} as const;

export function sanitizePolicyConfig(input: unknown, base: PolicyConfig = DEFAULT_POLICY_CONFIG): PolicyConfig {
  const raw = (input ?? {}) as Partial<PolicyConfig>;
  const required = Array.isArray(raw.required)
    ? [...new Set(raw.required.filter((id): id is PolicyId => POLICY_IDS.includes(id as PolicyId)))]
    : [...base.required];
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    intervalSec: Math.round(
      clampNum(raw.intervalSec, POLICY_LIMITS.minIntervalSec, POLICY_LIMITS.maxIntervalSec, base.intervalSec)
    ),
    required
  };
}

// ---------- Pass/fail thresholds ----------

/** Any field left null is simply not asserted. */
export interface SloThresholds {
  maxOverheadP95Ms: number | null;
  maxUnexpectedFailurePct: number | null;
  /** contract violations the gateway let reach the backend */
  maxLeakedToBackend: number | null;
  maxGatewayErrorPct: number | null;
  /** every policy listed as required must come back `pass` */
  requirePolicies: boolean;
}

export const DEFAULT_SLO: SloThresholds = {
  maxOverheadP95Ms: null,
  maxUnexpectedFailurePct: 1,
  maxLeakedToBackend: 0,
  maxGatewayErrorPct: 0.5,
  requirePolicies: true
};

export function sanitizeSlo(input: unknown, base: SloThresholds = DEFAULT_SLO): SloThresholds {
  const raw = (input ?? {}) as Partial<SloThresholds>;
  // null is a real value here ("do not assert"), so it must survive the round
  // trip rather than being coerced to the base like an unparsable number is
  const opt = (v: unknown, lo: number, hi: number, fallback: number | null): number | null => {
    if (v === null) return null;
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    maxOverheadP95Ms: opt(raw.maxOverheadP95Ms, 0, 600_000, base.maxOverheadP95Ms),
    maxUnexpectedFailurePct: opt(raw.maxUnexpectedFailurePct, 0, 100, base.maxUnexpectedFailurePct),
    maxLeakedToBackend: opt(raw.maxLeakedToBackend, 0, 1e9, base.maxLeakedToBackend),
    maxGatewayErrorPct: opt(raw.maxGatewayErrorPct, 0, 100, base.maxGatewayErrorPct),
    requirePolicies: typeof raw.requirePolicies === "boolean" ? raw.requirePolicies : base.requirePolicies
  };
}

export type VerdictState = "pass" | "fail" | "inconclusive";

export interface SloCheck {
  id: string;
  label: string;
  actual: number | string;
  threshold: number | string;
  state: "pass" | "fail";
}

/**
 * Everything needed to decide whether a gateway passed, in one shareable
 * document. `inconclusive` is a first-class outcome: a run whose window failed
 * the validity gate cannot honestly be called a pass, and calling it a fail
 * would blame the gateway for the rig's own saturation.
 */
/**
 * How cleanly the report's window maps onto the run.
 *
 * The summary comes from minute-granular roll-ups, so a run that starts or ends
 * mid-minute shares those buckets with whatever ran either side of it. Saying
 * how much of the window is not this run's traffic is the difference between a
 * number that is slightly coarse and one that is quietly wrong.
 */
export interface WindowScope {
  /** requests inside the window that belong to a different run */
  foreignRequests: number;
  /** every request the window covers, this run's and the others' */
  totalRequests: number;
  /** foreignRequests as a percentage of totalRequests */
  foreignPct: number;
}

export interface RunReport {
  runId: string;
  startedAt: number;
  stoppedAt: number | null;
  durationSec: number;
  profile: LoadProfile;
  scope: WindowScope;
  /** API keys are stripped — a report is meant to be shared */
  gateway: GwTargets;
  summary: MetricSummary;
  policies: PolicyResult[];
  verdict: {
    state: VerdictState;
    checks: SloCheck[];
    reasons: string[];
  };
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
  /** Concurrency ceiling the driver actually applies: auto-raised above
   *  profile.maxConcurrency when that value would itself throttle the
   *  target rate. */
  effectiveMaxConcurrency: number;
  /** epoch ms when sustained concurrency-cap throttling began; null while healthy */
  throttledSinceMs: number | null;
  counters: RunCounters;
  gateway?: GwTargets;
  /**
   * Whether each target resolves to this very process, i.e. the bundled
   * petstore with no gateway in the path. Everything gateway-shaped — contract
   * blocking, gateway faults, overhead — is vacuous in that configuration, and
   * the dashboard must say so rather than reporting "0% blocked" in red.
   */
  targetIsSelf: { rest: boolean; soap: boolean };
}

export interface RunCounters {
  sent: number;
  /** 2xx/3xx only. A 4xx is NOT a success — a gateway rejecting every request
   *  on a bad key used to land here and read as a perfectly healthy run. */
  ok: number;
  /** 5xx plus connection failures */
  errors: number;
  /** all 4xx */
  clientErrors: number;
  /** 502/503/504 plus connection failures: the gateway's own faults */
  gatewayErrors: number;
  /** 429 — surfaced on its own because hitting the gateway's quota silently
   *  invalidates every latency number in the run */
  rateLimited: number;
  /** 401 + 403 — almost always a misconfigured key rather than a real finding */
  unauthorized: number;
  timeouts: number;
  /** requests the concurrency ceiling stopped us from issuing this run — load
   *  the gateway was never actually offered, however healthy the charts look */
  droppedRequests: number;
  invalidSent: number;
  /** invalid requests the GATEWAY rejected (4xx with no backend fingerprint) */
  invalidRejectedByGateway: number;
  /** invalid requests that reached the backend, i.e. the gateway let them past */
  invalidLeaked: number;
}

export const EMPTY_RUN_COUNTERS: RunCounters = {
  sent: 0, ok: 0, errors: 0, clientErrors: 0, gatewayErrors: 0,
  rateLimited: 0, unauthorized: 0, timeouts: 0, droppedRequests: 0,
  invalidSent: 0, invalidRejectedByGateway: 0, invalidLeaked: 0
};

export interface RunEvent {
  id: number;
  runId: string;
  startedAt: number;
  stoppedAt: number | null;
  profile: LoadProfile;
}

// ---------- Host metrics ----------
// A single point-in-time reading of the machine this app runs on, so the
// dashboard can tell "the app saturated" apart from "the gateway got slow".
export interface SystemSample {
  ts: number; // epoch ms when the sample was taken
  // CPU is normalised to total machine capacity (0-100), so a pegged 4-core
  // VM reads ~100, not 400 like `top` would show
  cpuProcessPct: number | null; // share of ALL cores this process burns
  cpuSystemPct: number | null;  // share of ALL cores everything burns (idle excluded)
  memUsedBytes: number;
  memTotalBytes: number;
  procRssBytes: number;
  procHeapUsedBytes: number;
  // event-loop stall percentiles over the sample interval, ms; null where
  // perf_hooks.monitorEventLoopDelay is unavailable
  eventLoopP50ms: number | null;
  eventLoopP99ms: number | null;
  // process disk I/O, bytes/s — from /proc/self/io because Node's
  // resourceUsage() reports fsRead/fsWrite as COUNTS, not bytes
  procReadBps: number | null;
  procWriteBps: number | null;
  // whole-host NIC and disk rates, Linux /proc only → null on Windows/macOS
  netRxBps: number | null;
  netTxBps: number | null;
  diskReadBps: number | null;
  diskWriteBps: number | null;
  // request/response bytes the app itself moves (per second); always available,
  // computed from ingested batches rather than the OS
  appInBps: number;
  appOutBps: number;
}

export interface SystemMetrics {
  current: SystemSample;
  history: SystemSample[];
}
