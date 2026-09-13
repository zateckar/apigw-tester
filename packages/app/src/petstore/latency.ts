import type { ChaosConfig, EndpointLatencyProfile, LatencyDistribution } from "@apigw/shared";
import { LIMITS } from "@apigw/shared";

/** Sample a delay in ms. Always returns a finite value within [0, LIMITS.delayMs]
 *  so it can be handed straight to setTimeout. */
export function sampleLatency(d: LatencyDistribution, rand: () => number): number {
  const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(LIMITS.delayMs, Math.max(0, n)) : 0);
  switch (d.kind) {
    case "fixed":
      return clamp(d.ms);
    case "uniform": {
      const lo = Math.min(d.minMs, d.maxMs);
      const hi = Math.max(d.minMs, d.maxMs);
      return clamp(lo + rand() * (hi - lo));
    }
    case "normal": {
      // Box-Muller
      const u1 = Math.max(rand(), 1e-9);
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return clamp(d.meanMs + z * d.stddevMs);
    }
    default:
      return 0; // future kinds default to no delay
  }
}

export const DEFAULT_LATENCY_PROFILE: EndpointLatencyProfile = {
  "list-pets": { kind: "uniform", minMs: 20, maxMs: 250 },
  "get-pet": { kind: "normal", meanMs: 60, stddevMs: 25 },
  "create-pet": { kind: "normal", meanMs: 120, stddevMs: 50 },
  "update-pet": { kind: "normal", meanMs: 100, stddevMs: 40 },
  "delete-pet": { kind: "normal", meanMs: 80, stddevMs: 30 },
  "place-order": { kind: "uniform", minMs: 50, maxMs: 400 },
  "get-order": { kind: "normal", meanMs: 55, stddevMs: 20 },
  "pet-photo": { kind: "uniform", minMs: 100, maxMs: 900 },
  "soap-ops": { kind: "normal", meanMs: 75, stddevMs: 30 },
  "unmapped": { kind: "fixed", ms: 50 }
};

export const DEFAULT_CHAOS: ChaosConfig = { errorRatePct: 0, timeoutRatePct: 0 };

export function decideChaos(chaos: ChaosConfig, rand: () => number): "ok" | "error" | "timeout" {
  const r = rand() * 100;
  if (r < chaos.errorRatePct) return "error";
  if (r < chaos.errorRatePct + chaos.timeoutRatePct) return "timeout";
  return "ok";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Validate one distribution from operator input. Rejects the string-meanMs
 *  class of mistake that used to silently become setTimeout(NaN). */
export function validateDistribution(v: unknown): LatencyDistribution | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "must be an object";
  const d = v as Record<string, unknown>;
  const bound = (n: number): number => Math.min(LIMITS.delayMs, Math.max(0, n));
  switch (d["kind"]) {
    case "fixed": {
      const ms = num(d["ms"]);
      if (ms === null) return "fixed.ms must be a number";
      return { kind: "fixed", ms: bound(ms) };
    }
    case "uniform": {
      const lo = num(d["minMs"]);
      const hi = num(d["maxMs"]);
      if (lo === null || hi === null) return "uniform.minMs and uniform.maxMs must be numbers";
      return { kind: "uniform", minMs: bound(Math.min(lo, hi)), maxMs: bound(Math.max(lo, hi)) };
    }
    case "normal": {
      const mean = num(d["meanMs"]);
      const sd = num(d["stddevMs"]);
      if (mean === null || sd === null) return "normal.meanMs and normal.stddevMs must be numbers";
      return { kind: "normal", meanMs: bound(mean), stddevMs: bound(Math.abs(sd)) };
    }
    default:
      return "kind must be one of fixed|uniform|normal";
  }
}

/** Validate a PATCH /admin/latency-profile body. */
export function validateLatencyPatch(
  patch: unknown
): { ok: true; value: EndpointLatencyProfile } | { ok: false; error: string } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { ok: false, error: "body must be an object keyed by endpoint" };
  }
  const out: EndpointLatencyProfile = {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    // never let a payload key reach Object.prototype
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return { ok: false, error: `illegal endpoint key '${key}'` };
    }
    const d = validateDistribution(value);
    if (typeof d === "string") return { ok: false, error: `${key}: ${d}` };
    out[key] = d;
  }
  return { ok: true, value: out };
}
