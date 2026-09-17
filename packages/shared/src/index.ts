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
  // The bundled SUT's own port. A placeholder only: the petstore is its own
  // process now, its port is configurable, and it can be asked to bind an
  // ephemeral one — so the server derives the real default from its runtime
  // config and every handler answers with that. Nothing but a client with no
  // server reply yet should ever be reading this.
  baseUrl: "http://127.0.0.1:8081",
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

/**
 * Measurement schema this build produces.
 *
 * 1 — latency only.
 * 2 — per-request overhead: `ttfb − (serverMs + median direct probe)`, censored
 *     at zero and gated on probe freshness. Withdrawn: subtracting a median
 *     from each sample added the whole direct distribution's variance to every
 *     observation, and dropping the negatives that produced biased the survivors
 *     upward. Rows carrying it are not comparable with 3 and are ignored.
 * 3 — raw residuals: `ttfbMs` and `serverMs` are recorded as observed and the
 *     gateway's cost is read as a distribution difference against a concurrent
 *     direct-to-SUT reference stream. See {@link BaselineSample}.
 */
export const MEASUREMENT_VERSION = 3;

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
  /** Time to first byte: start → response headers arrived. Null when the
   *  request never got a response (network error / timeout). */
  ttfbMs: number | null;
  /**
   * The SUT's own processing time for this request, from its `X-Server-Ms`
   * response header. Null when the response never reached the backend (the
   * gateway answered it) or a gateway stripped the header.
   *
   * Recorded raw and never combined with a calibration constant: `ttfbMs -
   * serverMs` is then a *directly observed* residual — everything outside the
   * backend — for this one request, with no estimate inside it.
   */
  serverMs: number | null;
  /**
   * Time spent acquiring a socket for this request: a pool wait, or a DNS
   * lookup plus TCP and TLS handshakes on a miss.
   *
   * It sits inside `ttfbMs` and is not a cost the gateway imposes per request,
   * so the residual subtracts it — a measured quantity from this very request,
   * not a constant borrowed from another distribution. Both arms of the
   * comparison subtract their own, which they must: the reference stream runs
   * at a fraction of the load and keeps a near-idle pool, so it pays setup on a
   * different schedule entirely.
   *
   * Null means not measured, which is distinct from measured-and-zero. The
   * in-process driver issues requests through `fetch`, which exposes no
   * connection-level hook, so it always reports null and its residual carries
   * setup on both arms alike.
   */
  connectMs?: number | null;
  /** whether the socket came from the pool. Only meaningful when `connectMs`
   *  is non-null; a false here is what `connSetups` counts. */
  connReused?: boolean;
  measurementVersion?: number;
  /**
   * Why this observation's *timing* cannot be trusted: the generator was CPU
   * saturated, its event loop stalled, or health coverage was missing for the
   * window the request ran in. Null when the timing is sound.
   *
   * Only the residual is withheld — latency, status and throughput still count,
   * because they are what the run actually delivered. The residual is singled
   * out because a generator stall delays when we observe the response headers
   * but not the SUT's self-reported processing time, so the whole stall lands
   * inside `ttfbMs − serverMs` and would read as gateway overhead.
   */
  timingReason?: string | null;
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

/**
 * One observation from the direct-to-SUT reference stream: the same request
 * shapes, in the same class mix, issued concurrently with the load but with the
 * gateway bypassed.
 *
 * This is the control arm of the overhead measurement. It is deliberately *not*
 * a RequestResult: reference traffic is not gateway traffic, and folding it into
 * the request metrics would inflate throughput and dilute every status, latency
 * and contract number with requests the gateway never saw.
 */
export interface BaselineSample {
  ts: number; // epoch ms when the probe started
  class: ScenarioClass;
  /**
   * `ttfb − serverMs` for this probe, in ms. Signed: the two clocks are read at
   * different layers, so a fast local call legitimately lands slightly below
   * zero, and discarding those would shift the reference distribution up and
   * understate the gateway by exactly that amount.
   */
  residualMs: number;
}

export interface IngestBatch {
  batchId: string; // idempotency token
  results: RequestResult[];
  /** Scheduler accounting for the same interval. Carried on the batch so the
   *  shed rows commit in the very transaction as the requests they explain —
   *  a window can never show issued load without the load it failed to issue. */
  shed?: LoadShedSample[];
  /** Direct-to-SUT reference observations covering the same interval, ridden on
   *  the same batch so a minute's two residual distributions commit together
   *  and are always compared over matching time. */
  baseline?: BaselineSample[];
}

// ---------- Pre-aggregated ingest ------------------------------------------
//
// An IngestBatch carries one object per request. That is the right shape for an
// external poster and hopeless for a generator: at 10k rps it is 10k objects a
// second to serialize, parse, structured-clone across a thread boundary and
// walk — on the control plane's event loop, whose stalls are the very thing
// this rig withholds measurements over. The generator already has to visit
// every result once; rolling up there and shipping the roll-up costs the same
// visit and ships a payload whose size no longer depends on the rate.
//
// What crosses the boundary per flush, at any rps: one cell per
// (minute, protocol, endpoint, class) — a few dozen; one residual cell per
// (health window, class, arm) — a few dozen; one run cell per (minute, run);
// and a hard-capped tail of raw rows for the recent-requests table.

/**
 * One pre-rolled (minute, protocol, endpoint, class) cell — the same numbers
 * `rollup_minute` stores, computed at the source.
 *
 * `hist` and `statusHist` are positional over HISTOGRAM_EDGES_MS and
 * STATUS_BUCKETS respectively, exactly as they are on disk, and are merged
 * positionally on arrival. A producer that disagrees about either table
 * corrupts every row it touches, silently — which is why a producer that is not
 * this package (the Go worker) declares its tables and is checked against these.
 */
export interface AggCell {
  /** minute-aligned */
  bucketTs: number;
  firstTs: number;
  lastTs: number;
  protocol: Protocol;
  endpoint: string;
  cls: ScenarioClass;
  count: number;
  errors: number;
  ok2xx: number;
  rejected4xx: number;
  rejected4xxGw: number;
  reachedBackend: number;
  latencySumMs: number;
  maxLatencyMs: number;
  bytesReq: number;
  bytesResp: number;
  /** Requests that opened a connection rather than reusing one, their total
   *  acquisition time, and how many requests could be observed at all. Not a
   *  correction — the residual already subtracts acquisition per request — but
   *  the evidence for whether it mattered: a gateway that churns connections
   *  shows up here instead of hiding inside a Δ nobody can explain.
   *
   *  `connMeasured` is what makes the share readable: it is 0 on a producer
   *  that cannot see connection events, where a bare `connSetups` of 0 would
   *  otherwise be indistinguishable from perfect reuse. */
  connSetups: number;
  connSetupSumMs: number;
  connMeasured: number;
  hist: number[];
  statusHist: number[];
}

/** Which arm of the overhead comparison a residual belongs to. */
export type ResidualArmPath = "gw" | "direct";

/**
 * Residuals for one health window, one class, one arm.
 *
 * Keyed by health window rather than by minute because health is the one
 * judgement the source cannot make: only the control plane samples local health,
 * and it does so per {@link HEALTH_WINDOW_MS}. Shipping residuals at that
 * granularity lets the control plane drop exactly the contaminated windows —
 * the same rows a per-request check would have withheld — and then fold what
 * survives into the minute. A minute-grained cell would force a choice between
 * discarding a whole minute and keeping a stall inside it.
 */
export interface ResidualCell {
  /** HEALTH_WINDOW_MS-aligned */
  windowTs: number;
  cls: ScenarioClass;
  path: ResidualArmPath;
  count: number;
  sumMs: number;
  /** positional over RESIDUAL_EDGES_MS */
  hist: number[];
}

/**
 * How many requests a run contributed to a minute.
 *
 * Roll-ups carry no run id, so "how much of this window was somebody else's
 * traffic" has to be answered from somewhere else. It used to be counted off
 * the raw table, which works only while the raw table holds every request;
 * once the tail is capped, those counts describe the sample, not the run. This
 * is the exact count, and it costs one small row per (minute, run).
 */
export interface RunCell {
  /** minute-aligned */
  bucketTs: number;
  runId: string;
  count: number;
}

/**
 * The generator's ingest unit: roll-ups plus a bounded raw tail.
 *
 * `tail` is for the recent-requests table alone. Every chart, percentile and
 * verdict is read from the cells, which are exact — so the tail can be capped
 * hard ({@link RAW_TAIL_PER_FLUSH}) without costing any aggregate its accuracy.
 */
export interface AggregateBatch {
  batchId: string; // idempotency token
  cells: AggCell[];
  residuals: ResidualCell[];
  runs: RunCell[];
  tail: RequestResult[];
  shed?: LoadShedSample[];
  /**
   * Per-window evidence about the process that took these measurements.
   *
   * Present — possibly empty — from any generator that measures its own health,
   * and `undefined` from one that does not. That distinction is load-bearing:
   * an empty array means "this window was quiet", `undefined` means "ask the
   * control plane instead", and collapsing the two would silently apply the
   * wrong gate. The in-process TS driver leaves it undefined by design; its
   * clock *is* the control plane's event loop.
   */
  health?: WorkerHealthCell[];
}

/**
 * One health window's evidence from the generator that holds the clock.
 *
 * The quantity that matters is scheduling latency, not CPU: a response arrives,
 * the goroutine that will read the clock becomes runnable, and everything
 * between those two moments is added to the request's measured TTFB without
 * being added to the SUT's self-reported server time. It lands whole inside
 * `ttfb − serverMs` and reads as gateway overhead that never happened.
 *
 * `fromTs`/`toTs` are the span actually covered by samples, which is what makes
 * an unobserved window distinguishable from a quiet one — the same distinction
 * the control-plane sampler draws with "health coverage unavailable".
 */
export interface WorkerHealthCell {
  /** aligned to HEALTH_WINDOW_MS, matching the residual cells it qualifies */
  windowTs: number;
  fromTs: number;
  toTs: number;
  samples: number;
  /** p99 of goroutine scheduling latency across the window, ms */
  schedP99Ms: number;
  /** worst single scheduling latency in the window, ms — diagnostic only */
  schedMaxMs: number;
  /** share of the runtime's available CPU that was busy, 0-100 */
  cpuPct: number;
  goroutines: number;
}

/**
 * Raw rows a generator keeps per flush for the recent-requests table.
 *
 * The table shows at most LIMITS.recentLimit rows and the flush cadence is
 * about a second, so a handful of flushes already overfills it. Everything
 * above this is written, indexed, retained and then never read.
 */
export const RAW_TAIL_PER_FLUSH = 200;

/**
 * Width of a local-health verdict, in ms.
 *
 * The system sampler reads on this cadence, so it is the finest interval an
 * observation can be qualified against — two requests inside one window share
 * one verdict, and there is no more resolution to be had by asking per request.
 * Shared because the Go worker keys its residual cells by the same window.
 */
export const HEALTH_WINDOW_MS = 2_000;

// histogram bucket upper edges in ms (log-ish scale), 40 buckets
export const HISTOGRAM_EDGES_MS: number[] = buildEdges();

/**
 * Bucket upper edges for residual (`ttfb − serverMs`) distributions, in ms.
 *
 * Separate from HISTOGRAM_EDGES_MS, which starts at 1 ms and cannot represent a
 * negative value — both disqualifying for this metric. A residual on a local
 * hop is tens of microseconds, so 1 ms buckets would put an entire reference
 * distribution in one slot and report every gateway as costing "0 to 1 ms";
 * and the signed low end is what keeps the reference distribution unbiased
 * instead of floored at zero.
 *
 * Positive side: 20 µs upward at a 1.3 ratio, so a percentile read off a bucket
 * is within ~13% of the true value — far inside the noise of a wall-clock TTFB.
 * Negative side: coarse and bounded. A residual below −1 ms is a clock or
 * header problem rather than a measurement, and all that is needed from it is
 * a correct rank for the percentiles above.
 *
 * This array IS the on-disk layout of every residual histogram: entries may not
 * be reordered or removed, and any change to it needs a new column, because
 * stored rows merge positionally.
 */
export const RESIDUAL_EDGES_MS: number[] = buildResidualEdges();

function buildResidualEdges(): number[] {
  const edges: number[] = [-100, -30, -10, -3, -1, -0.5, -0.2, -0.1, -0.05, 0];
  let v = 0.02;
  while (v < 60_000) {
    edges.push(Number(v.toPrecision(4)));
    v *= 1.3;
  }
  return edges;
}

/**
 * Observations a stream needs before a percentile drawn from it is reported.
 *
 * Ten beyond the percentile itself: p99 off 200 samples is two data points and
 * a straight face. Applied to *both* arms of the comparison, since a difference
 * is only as sound as its thinner side.
 */
export function minSamplesForPercentile(p: number): number {
  if (p >= 100) return Infinity;
  // 1000/(100−p) rather than 10/(1−p/100): the latter is the same number in
  // exact arithmetic but rounds 90 up to 101 in binary floating point, which
  // would make the thresholds look arbitrary to anyone reading them back
  return Math.ceil(1000 / (100 - p));
}

/**
 * Size of the direct-to-SUT reference stream, as a share of the load being
 * generated. It has to scale: fixed-rate reference traffic is either a
 * meaningful fraction of a 10 rps run (and perturbs it) or far too thin at
 * 10k rps to support a p99.
 *
 * The ceiling is a backstop against a runaway target rate, not a governor. It
 * used to be 50, which bound at any load above 2,500 rps and silently walked
 * the share back down — 1% at 5k, 0.5% at 10k — so the reference became the
 * thinner arm by an ever-widening margin and capped every percentile the Δ
 * could report. At LIMITS.rps the declared share needs 200; 500 leaves the
 * percentage in charge across the whole supported range.
 */
export const REFERENCE_STREAM = {
  /** share of target rps mirrored directly to the SUT */
  pctOfLoad: 2,
  /** floor, so even an idle-rate run accumulates a reference distribution */
  minRps: 2,
  /** backstop, so a nonsense target rate cannot turn the control into the load */
  maxRps: 500
} as const;

/** Reference-stream rate for a given target rate, in rps. */
export function referenceRps(targetRps: number): number {
  if (!Number.isFinite(targetRps) || targetRps <= 0) return 0;
  const want = (targetRps * REFERENCE_STREAM.pctOfLoad) / 100;
  return Math.min(REFERENCE_STREAM.maxRps, Math.max(REFERENCE_STREAM.minRps, want));
}

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

/**
 * The three positional tables an {@link AggregateBatch} producer must agree
 * with. Any out-of-process producer declares its own copy at handshake time.
 */
export interface EdgeTables {
  latency: number[];
  residual: number[];
  status: string[];
}

export function edgeTables(): EdgeTables {
  return { latency: HISTOGRAM_EDGES_MS, residual: RESIDUAL_EDGES_MS, status: [...STATUS_BUCKETS] };
}

/**
 * Compare a producer's declared bucket tables against ours, returning the first
 * divergence or null.
 *
 * A second implementation of these tables is unavoidable — the Go worker cannot
 * import TypeScript — and an undetected drift between them does not fail, it
 * quietly mixes two different histograms into one column and answers every
 * percentile wrong for as long as the database lives. Comparing lengths alone
 * would catch an appended edge and miss a changed one, so this compares values.
 */
export function edgeTableMismatch(declared: Partial<EdgeTables> | undefined | null): string | null {
  if (!declared) return "producer declared no bucket tables";
  const ours = edgeTables();
  for (const name of ["latency", "residual", "status"] as const) {
    const theirs = declared[name];
    const mine: (number | string)[] = ours[name];
    if (!Array.isArray(theirs)) return `${name}: producer declared no table`;
    if (theirs.length !== mine.length) {
      return `${name}: producer has ${theirs.length} buckets, this build has ${mine.length}`;
    }
    for (let i = 0; i < mine.length; i++) {
      // numbers travel through JSON, so compare with the tolerance a float
      // round-trip needs rather than requiring bit equality
      const a = theirs[i] as number | string;
      const b = mine[i] as number | string;
      const same = typeof b === "number" && typeof a === "number"
        ? Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-12
        : a === b;
      if (!same) return `${name}[${i}]: producer has ${String(a)}, this build has ${String(b)}`;
    }
  }
  return null;
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
  /** measurements discarded for requests that WERE issued and answered.
   *  Carried here so the loss commits into the same minute as the traffic it
   *  silently thinned, and the window can be judged on it. */
  resultsLost?: number;
  /**
   * Requests that failed before reaching the target at all — a refused or
   * timed-out TCP connect, or a name that would not resolve.
   *
   * These were issued, unlike `dropped`, and they failed, unlike a normal
   * request — but they are not evidence about the gateway, so they are kept
   * out of its error rate and accounted here. Absent from generators that
   * cannot tell the two apart, which is distinct from a reported zero.
   */
  genFaults?: number;
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
  /**
   * Event-loop stall that starts showing up in measured latency.
   *
   * Applies only when the control plane's own loop is the instrument — i.e.
   * the in-process TS driver. With the Go backend every clock is read inside
   * the worker, and this process's loop delay says nothing about the numbers;
   * see workerSchedP99Ms.
   */
  eventLoopP99Ms: 10,
  /**
   * Scheduling latency, p99 over a health window, past which the generator's
   * own delay is a material part of what it measured.
   *
   * A p99 and not a max, deliberately. The metric this supersedes thresholded
   * the worst single wakeup in a 2s interval, which is one unlucky event out
   * of tens of thousands and is dominated by whatever the host did rather than
   * by the generator's load — on an idle process it reported the platform's
   * timer granularity and disqualified windows that were perfectly good.
   *
   * Calibrated against measured windows rather than picked, by asking where the
   * number starts to move the measurement. Per-window scheduling p99 was plotted
   * against the residual that window recorded, worker driving the Go SUT
   * directly, 30s per rate, two independent passes:
   *
   *   200 rps   p90 0.000ms   no window over any candidate limit
   *   1k  rps   p90 0.000ms   0 of 15 windows over 2ms
   *   5k  rps   p90 6.29ms    2 of 15 over 2ms; residual 1.0-2.0ms in the
   *                           windows kept, 3.8-4.8ms in those rejected — and
   *                           the reference arm inflates with the gateway arm,
   *                           which is the signature of the generator's own
   *                           delay rather than of anything the gateway did
   *   10k rps   p50 10.5ms    every window over; that run issued 101k of 300k
   *                           requests and failed 40% of them, so rejecting it
   *                           wholesale is the correct answer
   *
   * The distribution is bimodal at 5k — nothing observed between 1.3ms and
   * 6.3ms — so 2ms sits in an empty gap and 2ms and 5ms rejected exactly the
   * same windows in both passes. The limit is not on a knife edge, and no
   * runtime bucket edge lands on it.
   */
  workerSchedP99Ms: 2,
  /**
   * Share of the generator runtime's available CPU, past which it is the story.
   *
   * A backstop, not the primary gate: Go's /cpu/classes metrics are refreshed on
   * GC rather than continuously, so a quiet window can report a flat zero while
   * the next reads 86%. Scheduling latency is sampled every 250ms and is what
   * this gate actually rests on.
   */
  workerCpuPct: 85,
  /** share of intended load we may fail to issue before the window is suspect */
  shedPct: 1,
  /**
   * Share of issued requests that may fail before reaching the target at all.
   *
   * Tighter than shedPct, and deliberately so: shed load is a ceiling working
   * as designed, while a request that was issued and could not be connected is
   * the generator failing at the one thing it must do. It also rarely arrives
   * alone — a refused connection costs a concurrency slot for the dial
   * timeout, so a handful of them is the leading edge of a collapse, and the
   * window it starts in is the one worth disbelieving.
   */
  genFaultPct: 0.1,
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
  /** measurements lost after the request was served; the window's percentiles
   *  cover only issued − lost requests, and the loss is biased toward the
   *  busiest moments */
  resultsLost: number;
  /** requests that never reached the target; see LoadShedSample.genFaults */
  genFaults: number;
  /** mean rate the profile asked for over the window; null when not recorded */
  targetRps: number | null;
  /** rate actually issued */
  achievedRps: number;
  cpuProcessPctMax: number | null;
  eventLoopP99MsMax: number | null;
}

/**
 * What the gateway costs, as a difference between two distributions.
 *
 * For every request we record `residual = ttfb − serverMs`: the time that was
 * not the backend's. Two streams produce residuals over the same window and the
 * same class mix — the load, through the gateway, and a concurrent reference
 * stream straight to the SUT — and the gateway's cost is read off them at
 * matched percentiles:
 *
 *     Δp = percentile(p, residual | through gateway)
 *        − percentile(p, residual | direct)
 *
 * The p95 figure therefore answers "how much worse is the 95th percentile of
 * this path than the 95th percentile of the same traffic without the gateway",
 * which is the question an operator is actually asking. It is NOT the 95th
 * percentile of a per-request overhead — that quantity is not measurable
 * without pairing each request against a direct call it never had, and the
 * previous build's attempt to synthesise one by subtracting a running median
 * both inflated the variance and, by discarding the negative results, biased
 * what survived upward.
 *
 * Δ may legitimately be negative. It means the two distributions differ by less
 * than the measurement noise, i.e. the gateway's cost is below what this rig
 * can resolve — reported as measured rather than clamped to zero, because a
 * floor at zero is exactly how a rig talks itself into a finding it does not
 * have.
 */
export interface OverheadDelta {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  /** mean(gateway residual) − mean(direct residual) */
  avg: number | null;
  /** residuals behind the gateway arm; requests the gateway answered itself
   *  have no backend time to subtract and cannot contribute one */
  gwSamples: number;
  /** residuals behind the direct arm */
  directSamples: number;
  /** set when a percentile above is null, saying which arm was too thin and
   *  what it would take; null when every reported percentile is supported */
  unavailable: string | null;
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
  /** What the gateway path costs over the direct path, at matched percentiles.
   *  Includes every difference between the two routes — extra hops and TLS
   *  termination as well as the gateway's own work. */
  overheadMs: OverheadDelta;
  /** How often the load path had to open a connection rather than reuse one. */
  connSetup: ConnSetupStats;
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
 * Connection reuse on the load path.
 *
 * The overhead Δ already subtracts each request's own acquisition time, so this
 * is not a correction — it is the evidence for whether that correction was
 * doing any work. A gateway that closes connections aggressively, caps
 * keep-alive, or forces renegotiation makes every request pay a handshake; that
 * is a real and serious property of the gateway, but it is not per-request
 * latency and averaging it into one would misattribute it. Reported separately
 * so it can be seen and judged on its own terms.
 *
 * `measured` is 0 when the generator cannot see connection events at all (the
 * in-process driver), which is why `pct` is a share of measured requests rather
 * than of all of them — a zero here would otherwise read as "perfect reuse".
 */
export interface ConnSetupStats {
  /** requests that opened a connection instead of reusing one */
  setups: number;
  /** requests whose connection acquisition could be observed */
  measured: number;
  /** setups as a share of measured requests; null when nothing was measured */
  pct: number | null;
  /** mean acquisition time across the setups; null when there were none */
  avgMs: number | null;
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
  /** Δ against the reference stream restricted to this same class, so a
   *  big-response row is compared only with direct big-response calls. */
  overheadMs: OverheadDelta;
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
  overheadP50: number | null;
  overheadP95: number | null;
  overheadP99: number | null;
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
  /** ceiling on Δp95 — how much worse the gateway path's 95th-percentile
   *  residual may be than the direct path's. See {@link OverheadDelta}. */
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
  /** measurements of requests that WERE issued and answered but never reached
   *  the store: a full results queue or a failed batch write. The opposite
   *  diagnosis to droppedRequests — the gateway did this work, the charts just
   *  describe a subset of it, and a biased one, since results are lost exactly
   *  when they arrive fastest. Non-zero means the percentiles are understated
   *  in the tail. */
  resultsLost: number;
  invalidSent: number;
  /** invalid requests the GATEWAY rejected (4xx with no backend fingerprint) */
  invalidRejectedByGateway: number;
  /** invalid requests that reached the backend, i.e. the gateway let them past */
  invalidLeaked: number;
}

export const EMPTY_RUN_COUNTERS: RunCounters = {
  sent: 0, ok: 0, errors: 0, clientErrors: 0, gatewayErrors: 0,
  rateLimited: 0, unauthorized: 0, timeouts: 0, droppedRequests: 0, resultsLost: 0,
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
  /** Interval covered by this health observation. */
  intervalStartTs?: number;
  cpuCorePct?: number | null;
  cpuCapacityPct?: number | null;
  cpuThrottledMs?: number | null;
  eventLoopMaxMs?: number | null;
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
