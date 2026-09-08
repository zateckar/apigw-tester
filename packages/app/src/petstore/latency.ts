import type { ChaosConfig, EndpointLatencyProfile, LatencyDistribution } from "@apigw/shared";

export function sampleLatency(d: LatencyDistribution, rand: () => number): number {
  switch (d.kind) {
    case "fixed":
      return Math.max(0, d.ms);
    case "uniform": {
      const lo = Math.min(d.minMs, d.maxMs);
      const hi = Math.max(d.minMs, d.maxMs);
      return lo + rand() * (hi - lo);
    }
    case "normal": {
      // Box-Muller
      const u1 = Math.max(rand(), 1e-9);
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.max(0, d.meanMs + z * (d.stddevMs ?? 1));
    }
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
  "slow-target": { kind: "fixed", ms: 5 },
  "big-body": { kind: "fixed", ms: 5 },
  "unmapped": { kind: "fixed", ms: 50 }
};

export const DEFAULT_CHAOS: ChaosConfig = { errorRatePct: 0, timeoutRatePct: 0 };

export function decideChaos(chaos: ChaosConfig, rand: () => number): "ok" | "error" | "timeout" {
  const r = rand() * 100;
  if (r < chaos.errorRatePct) return "error";
  if (r < chaos.errorRatePct + chaos.timeoutRatePct) return "timeout";
  return "ok";
}
