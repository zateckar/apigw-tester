import type {
  GwConfig,
  GwTargets,
  PolicyConfig,
  PolicyId,
  PolicyResult,
  PolicyState
} from "@apigw/shared";
import { SERVER_MS_HEADER } from "../petstore/server.js";

/**
 * Gateway policy probes.
 *
 * The load mix proves a gateway can proxy traffic. It says nothing about
 * whether the gateway's *policies* actually fire, and a gateway whose rate
 * limit, payload cap or auth is silently not applied is the failure mode that
 * matters most — nothing in a latency chart will ever reveal it.
 *
 * Each probe is one deliberate request (or a short burst) with a stated
 * expectation, run on its own cadence rather than mixed into the load: a quota
 * burst and a cache re-read need a shape the traffic generator cannot express
 * as a percentage of requests.
 *
 * Two design rules everything here follows:
 *
 *   1. `X-Server-Ms` decides who answered. A response carrying it came from the
 *      SUT, so the gateway passed the request through; without it the gateway
 *      manufactured the response itself. That single bit is what separates
 *      "the gateway enforced the policy" from "the backend happened to say no".
 *
 *   2. "Not configured" is not "broken". A gateway with no cache and no quota
 *      is a legitimate gateway. Those come back `not-enforced`, and only turn
 *      into a failure when the operator has listed the policy as required.
 */

/** Ceiling on a single probe; policy probes must never wedge the scheduler. */
const PROBE_TIMEOUT_MS = 20_000;
/** Requests fired back-to-back at the rate-limit probe. */
const RATE_LIMIT_BURST = 40;
/** Body size for the payload-limit probe — above any sane gateway's default. */
const OVERSIZED_BYTES = 12 * 1024 * 1024;
/** Upstream sleep for the timeout probe, in ms. Long enough to exceed a
 *  typical gateway read timeout (30-60s is common, but so is 10s). */
const SLOW_UPSTREAM_MS = 10_000;

export interface ProbeContext {
  targets: GwTargets;
  /** prefix builder shared with the driver, so probes hit the same URLs */
  urlFor: (protocol: "rest" | "soap", path: string) => string;
  /** headers the driver would send for this target, minus the API key. Only the
   *  two auth probes want these — every other probe must present a credential
   *  the gateway accepts, or it measures the auth policy a second time. */
  baseHeaders: (protocol: "rest" | "soap") => Record<string, string>;
  /** baseHeaders plus the configured API key: what an authorised caller sends */
  authedHeaders: (protocol: "rest" | "soap") => Record<string, string>;
  /** true when the target is this rig's own petstore — no gateway in the path */
  selfTarget: boolean;
}

interface RawResponse {
  status: number;
  reachedBackend: boolean;
  latencyMs: number;
  headers: Headers;
  error: string | null;
}

async function call(
  url: string,
  init: RequestInit,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<RawResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    // drain so the socket is released; probe bodies are small except the
    // oversized one, which the gateway should have refused anyway
    await res.arrayBuffer().catch(() => undefined);
    return {
      status: res.status,
      reachedBackend: res.headers.get(SERVER_MS_HEADER) !== null,
      latencyMs: Date.now() - started,
      headers: res.headers,
      error: null
    };
  } catch (e) {
    const err = e as Error;
    return {
      status: 0,
      reachedBackend: false,
      latencyMs: Date.now() - started,
      headers: new Headers(),
      error: ac.signal.aborted ? `no response within ${timeoutMs / 1000}s` : (err.cause as Error | undefined)?.message ?? err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

interface ProbeDef {
  id: PolicyId;
  label: string;
  probe: string;
  expectation: string;
  run: (ctx: ProbeContext) => Promise<Omit<PolicyResult, "id" | "label" | "probe" | "expectation" | "checkedAt">>;
}

/** Shorthand for a finished probe outcome. */
function outcome(
  state: PolicyState,
  detail: string,
  r: { status: number; reachedBackend: boolean; latencyMs: number } | null
): Omit<PolicyResult, "id" | "label" | "probe" | "expectation" | "checkedAt"> {
  return {
    state,
    detail,
    status: r ? (r.status === 0 ? null : r.status) : null,
    reachedBackend: r ? r.reachedBackend : null,
    latencyMs: r ? r.latencyMs : null
  };
}

/** A transport failure is a broken probe, not a policy verdict. */
function transportFailed(r: RawResponse): boolean {
  return r.status === 0 && r.error !== null;
}

/**
 * A 429 answers a question no probe but the rate-limit one asked.
 *
 * The burst probe deliberately exhausts the quota, and live load is usually
 * running alongside; anything that follows can be throttled before it ever
 * reaches the policy it is testing. Reporting that as "expected 413, got 429"
 * would be a fabricated failure, so it comes back as a probe error.
 */
function quotaBlocked(
  r: RawResponse
): Omit<PolicyResult, "id" | "label" | "probe" | "expectation" | "checkedAt"> | null {
  if (r.status !== 429) return null;
  return outcome("error", "throttled (429) before the probe could run — re-run once the quota window has passed", r);
}

export const PROBES: readonly ProbeDef[] = [
  {
    id: "auth-bad-key",
    label: "Rejects an invalid API key",
    probe: "GET /api/pets with a deliberately wrong API key",
    expectation: "401 or 403, and the request must not reach the backend",
    run: async (ctx) => {
      const headers = { ...ctx.baseHeaders("rest"), [ctx.targets.rest.apiKeyHeader || "X-API-Key"]: "definitely-not-a-valid-key" };
      const r = await call(ctx.urlFor("rest", "/api/pets?size=1"), { method: "GET", headers });
      if (transportFailed(r)) return outcome("error", r.error ?? "unreachable", r);
      const throttled = quotaBlocked(r);
      if (throttled) return throttled;
      if (r.status === 401 || r.status === 403) {
        return r.reachedBackend
          ? outcome("fail", `answered ${r.status}, but the response came from the backend — the gateway forwarded a request it should have stopped`, r)
          : outcome("pass", `gateway answered ${r.status} without reaching the backend`, r);
      }
      if (r.reachedBackend) {
        return outcome("not-enforced", `a bogus key was proxied straight through (${r.status}) — this gateway is not authenticating callers`, r);
      }
      return outcome("fail", `expected 401/403, got ${r.status}`, r);
    }
  },
  {
    id: "auth-no-key",
    label: "Rejects a request with no credential",
    probe: "GET /api/pets with no API key at all",
    expectation: "401 or 403, and the request must not reach the backend",
    run: async (ctx) => {
      const r = await call(ctx.urlFor("rest", "/api/pets?size=1"), { method: "GET", headers: ctx.baseHeaders("rest") });
      if (transportFailed(r)) return outcome("error", r.error ?? "unreachable", r);
      const throttled = quotaBlocked(r);
      if (throttled) return throttled;
      if (r.status === 401 || r.status === 403) {
        return outcome("pass", `gateway answered ${r.status}`, r);
      }
      if (r.reachedBackend) {
        return outcome("not-enforced", `an anonymous request was proxied through (${r.status}) — the gateway requires no credential`, r);
      }
      return outcome("fail", `expected 401/403, got ${r.status}`, r);
    }
  },
  {
    id: "payload-limit",
    label: "Caps oversized request bodies",
    probe: `POST /api/echo with a ${Math.round(OVERSIZED_BYTES / 1024 / 1024)} MB body`,
    expectation: "413 (or 400), refused without streaming the whole body upstream",
    run: async (ctx) => {
      const headers = { ...ctx.authedHeaders("rest"), "Content-Type": "application/json" };
      const body = JSON.stringify({ _pad: "x".repeat(OVERSIZED_BYTES - 20) });
      const r = await call(ctx.urlFor("rest", "/api/echo"), { method: "POST", headers, body });
      if (transportFailed(r)) {
        // a gateway that cuts the connection mid-upload is enforcing a limit,
        // just rudely — that is a pass, not a broken probe
        return outcome("pass", `connection refused mid-upload (${r.error}) — a limit is being applied, though without a clean 413`, r);
      }
      const throttled = quotaBlocked(r);
      if (throttled) return throttled;
      if (r.status === 413) return outcome("pass", "gateway answered 413", r);
      if (r.status === 400 && !r.reachedBackend) return outcome("pass", "gateway rejected the body with 400", r);
      if (r.reachedBackend) {
        return outcome("not-enforced", `a ${Math.round(OVERSIZED_BYTES / 1024 / 1024)} MB body was proxied to the backend (${r.status}) — no payload cap`, r);
      }
      return outcome("fail", `expected 413, got ${r.status}`, r);
    }
  },
  {
    id: "upstream-timeout",
    label: "Times out a hanging upstream cleanly",
    probe: `GET /api/slow/${SLOW_UPSTREAM_MS} — the backend sleeps ${SLOW_UPSTREAM_MS / 1000}s`,
    expectation: "either a clean 504, or the full response — never a dangling connection",
    run: async (ctx) => {
      const r = await call(ctx.urlFor("rest", `/api/slow/${SLOW_UPSTREAM_MS}`), { method: "GET", headers: ctx.authedHeaders("rest") });
      const throttled = quotaBlocked(r);
      if (throttled) return throttled;
      if (r.status === 504) return outcome("pass", `gateway gave up cleanly with 504 after ${r.latencyMs} ms`, r);
      if (transportFailed(r)) {
        return outcome("fail", `no response at all after ${r.latencyMs} ms (${r.error}) — the gateway dropped the connection instead of answering 504`, r);
      }
      if (r.status >= 200 && r.status < 300) {
        return outcome("not-enforced", `waited out the full ${r.latencyMs} ms and returned ${r.status} — the gateway's read timeout is longer than ${SLOW_UPSTREAM_MS / 1000}s`, r);
      }
      return outcome("fail", `expected 504 or a completed response, got ${r.status}`, r);
    }
  },
  {
    id: "cache",
    label: "Serves a repeated GET from cache",
    probe: "the same GET twice; the second is checked for the backend's fingerprint",
    expectation: "the second response has no X-Server-Ms, i.e. the gateway answered it",
    run: async (ctx) => {
      const headers = ctx.authedHeaders("rest");
      // a fixed URL: a cache keyed on the query string needs both hits identical
      const url = ctx.urlFor("rest", "/api/pets?status=available&size=10");
      const first = await call(url, { method: "GET", headers });
      if (transportFailed(first)) return outcome("error", first.error ?? "unreachable", first);
      const second = await call(url, { method: "GET", headers });
      if (transportFailed(second)) return outcome("error", second.error ?? "unreachable", second);
      const throttled = quotaBlocked(first) ?? quotaBlocked(second);
      if (throttled) return throttled;
      const cacheHeader = second.headers.get("x-cache") ?? second.headers.get("age") ?? null;
      if (!second.reachedBackend && first.reachedBackend) {
        return outcome("pass", `the second identical GET was answered by the gateway${cacheHeader ? ` (${cacheHeader})` : ""}`, second);
      }
      if (cacheHeader !== null) {
        return outcome("pass", `gateway reported a cache header (${cacheHeader})`, second);
      }
      return outcome("not-enforced", "both identical GETs reached the backend — no response caching in effect", second);
    }
  },
  {
    id: "unknown-route",
    label: "Refuses a route that is not in the contract",
    probe: "GET /api/definitely-not-a-route",
    expectation: "404 or 405 from the gateway, without consulting the backend",
    run: async (ctx) => {
      const r = await call(ctx.urlFor("rest", "/api/definitely-not-a-route"), { method: "GET", headers: ctx.authedHeaders("rest") });
      if (transportFailed(r)) return outcome("error", r.error ?? "unreachable", r);
      const throttled = quotaBlocked(r);
      if (throttled) return throttled;
      if ((r.status === 404 || r.status === 405) && !r.reachedBackend) {
        return outcome("pass", `gateway answered ${r.status} without consulting the backend`, r);
      }
      if (r.reachedBackend) {
        return outcome("not-enforced", `an undeclared path was proxied to the backend (${r.status}) — the gateway is not restricting routes to the contract`, r);
      }
      return outcome("fail", `expected 404/405, got ${r.status}`, r);
    }
  },
  {
    id: "cors-preflight",
    label: "Answers a CORS preflight",
    probe: "OPTIONS /api/pets with Origin and Access-Control-Request-Method",
    expectation: "2xx with Access-Control-Allow-Origin, handled by the gateway",
    run: async (ctx) => {
      const headers = {
        ...ctx.authedHeaders("rest"),
        Origin: "https://preflight.example.test",
        "Access-Control-Request-Method": "GET"
      };
      const r = await call(ctx.urlFor("rest", "/api/pets"), { method: "OPTIONS", headers });
      if (transportFailed(r)) return outcome("error", r.error ?? "unreachable", r);
      const throttled = quotaBlocked(r);
      if (throttled) return throttled;
      const allow = r.headers.get("access-control-allow-origin");
      if (r.status >= 200 && r.status < 300 && allow !== null) {
        return outcome("pass", `preflight answered ${r.status}, Access-Control-Allow-Origin: ${allow}`, r);
      }
      if (allow === null) {
        return outcome("not-enforced", `no Access-Control-Allow-Origin on the response (${r.status}) — CORS is not configured here`, r);
      }
      return outcome("fail", `preflight answered ${r.status}`, r);
    }
  },
  // deliberately last: this probe's whole job is to exhaust the quota, and
  // everything after it would be answered 429 before reaching its own policy
  {
    id: "rate-limit",
    label: "Enforces a rate limit",
    probe: `${RATE_LIMIT_BURST} identical GETs fired back-to-back`,
    expectation: "at least one 429, ideally with Retry-After",
    run: async (ctx) => {
      const headers = ctx.authedHeaders("rest");
      const url = ctx.urlFor("rest", "/api/pets?size=1");
      // deliberately concurrent: a sequential burst is paced by round-trip time
      // and would not trip a per-second quota on a slow link
      const results = await Promise.all(
        Array.from({ length: RATE_LIMIT_BURST }, () => call(url, { method: "GET", headers }, 10_000))
      );
      const limited = results.filter((r) => r.status === 429);
      const reachable = results.filter((r) => !transportFailed(r));
      if (reachable.length === 0) {
        return outcome("error", results[0]?.error ?? "unreachable", null);
      }
      if (limited.length === 0) {
        return outcome(
          "not-enforced",
          `all ${reachable.length} burst requests were accepted — no quota tripped at this rate`,
          reachable[0] ?? null
        );
      }
      const retryAfter = limited.find((r) => r.headers.get("retry-after") !== null);
      const note = retryAfter ? `, Retry-After: ${retryAfter.headers.get("retry-after")}` : " (no Retry-After header)";
      return outcome("pass", `${limited.length}/${reachable.length} burst requests were rate-limited${note}`, limited[0] ?? null);
    }
  }
];

/**
 * Run every probe in sequence and return one result each.
 *
 * Sequential on purpose: several probes are deliberately abusive (a burst, a
 * 12 MB upload, a 10s hang) and running them concurrently would have them
 * interfere — the burst would trip a quota that then fails the cache probe.
 */
export async function runPolicyProbes(ctx: ProbeContext, cfg: PolicyConfig): Promise<PolicyResult[]> {
  // With no gateway in the path these probes measure the bundled petstore, and
  // some of them would report a pass for it: express answers an undeclared
  // route 404 without the X-Server-Ms stamp, which reads exactly like a gateway
  // refusing it. Saying "not measured" is the only honest answer here.
  if (ctx.selfTarget) {
    const checkedAt = Date.now();
    return PROBES.map((def) => ({
      id: def.id, label: def.label, probe: def.probe, expectation: def.expectation, checkedAt,
      state: "error" as const,
      detail: "the target is this rig's own petstore — there is no gateway in front of it to enforce anything",
      status: null, reachedBackend: null, latencyMs: null
    }));
  }

  const out: PolicyResult[] = [];
  for (const def of PROBES) {
    let result: PolicyResult;
    try {
      const r = await def.run(ctx);
      result = { id: def.id, label: def.label, probe: def.probe, expectation: def.expectation, checkedAt: Date.now(), ...r };
    } catch (e) {
      result = {
        id: def.id, label: def.label, probe: def.probe, expectation: def.expectation,
        checkedAt: Date.now(), state: "error", detail: (e as Error).message,
        status: null, reachedBackend: null, latencyMs: null
      };
    }
    // a policy the operator says must hold turns "not configured" into a defect
    if (result.state === "not-enforced" && cfg.required.includes(def.id)) {
      result = { ...result, state: "fail", detail: `${result.detail} — but this policy is listed as required` };
    }
    out.push(result);
  }
  return out;
}

/** Build the probe context from the driver's own target configuration. */
export function probeContext(
  targets: GwTargets,
  authHeaderFor: (t: GwConfig) => string | null,
  selfTarget = false
): ProbeContext {
  const prefixFor = (t: GwConfig): string => {
    const base = t.baseUrl.replace(/\/+$/, "");
    const prefix = t.pathPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
    return prefix ? `${base}/${prefix}` : base;
  };
  const baseHeaders = (protocol: "rest" | "soap"): Record<string, string> => {
    const h: Record<string, string> = {};
    const auth = authHeaderFor(targets[protocol]);
    if (auth) h["authorization"] = auth;
    return h;
  };
  return {
    targets,
    selfTarget,
    urlFor: (protocol, path) => prefixFor(targets[protocol]) + path,
    baseHeaders,
    authedHeaders: (protocol) => {
      const t = targets[protocol];
      const h = baseHeaders(protocol);
      if (t.apiKey) h[t.apiKeyHeader || "X-API-Key"] = t.apiKey;
      return h;
    }
  };
}
