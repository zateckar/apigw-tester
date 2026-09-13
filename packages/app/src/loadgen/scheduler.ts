import type { LoadMode, LoadProfile } from "@apigw/shared";
import { LIMITS } from "@apigw/shared";

export type LoadModeEx = LoadMode;

export interface TickResult {
  due: number;
  targetRps: number;
}

/**
 * Token-bucket RPS scheduler. Open model: arrivals follow the profile even if
 * completions lag. Mode "real" layers a 24h workload curve, a noisy multiplier
 * with slow-moving trend, plus inter-request jitter.
 */

/* Slow state for mode=real. Owned by the TokenBucket (not stashed on the
 * profile object) so that read-only callers — /api/run/status, the UI poll —
 * can never advance the drift model just by looking at it. */
export class RealTrafficShaper {
  private phase: number;           // slowly-evolving [0..2π) cycle fraction (0=start of day)
  private noiseLevel = 1;          // slow trend, mean-reverting to 1
  private lastTickMs: number | null = null;

  constructor(phase = Math.random() * 2 * Math.PI) {
    // randomize the day-cycle so multiple runs don't all hit "9am"
    this.phase = phase;
  }

  targetRps(nowMs: number, p: LoadProfile): number {
    // --- Time-of-day curve (local time) ---
    const dayMs = 24 * 60 * 60 * 1000;
    const dayFrac = ((nowMs % dayMs) / dayMs + this.phase / (2 * Math.PI)) % 1;

    // Heavier during 8am-12pm and 1pm-5pm, light 12-1pm and 5pm-8am
    const work = Math.exp(-Math.pow((dayFrac - 0.37) / 0.09, 2)) +      // ~9am peak (37% of day)
      0.85 * Math.exp(-Math.pow((dayFrac - 0.62) / 0.10, 2));           // ~3pm peak, lower
    const night = 0.08;

    const baseUserRps = p.rps ?? 25;
    // interpolate between night (0.08) and peak (1.0) based on work function
    const curveRps = baseUserRps * (night + (1 - night) * Math.min(1.15, work));

    // --- Slow drift: mean-reverting noise with timescale ~3 minutes ---
    if (this.lastTickMs !== null) {
      const dtMin = (nowMs - this.lastTickMs) / 60_000;
      const drift = (1 - this.noiseLevel) * Math.min(1, dtMin / 3);
      const jump = (Math.random() - 0.5) * 0.12 * Math.sqrt(Math.max(dtMin, 0.01));
      this.noiseLevel = Math.max(0.6, Math.min(1.8, this.noiseLevel + drift + jump));
    }
    this.lastTickMs = nowMs;

    // --- Per-tick jitter: ±20% ---
    const jitter = 1 + (Math.random() - 0.5) * 0.4;

    return Math.max(0, curveRps * this.noiseLevel * jitter);
  }
}

/**
 * Target RPS for a profile at a point in time.
 *
 * `shaper` is only consulted for mode "real"; pass one from a component that
 * owns the run (the TokenBucket). Callers that merely want to display a number
 * must omit it — without a shaper this function is pure.
 */
export function targetRpsAt(
  profile: LoadProfile,
  nowMs: number,
  startedAtMs: number,
  shaper?: RealTrafficShaper
): number {
  const mode = (profile.mode as LoadModeEx) ?? "constant";
  const cap = (n: number): number => (Number.isFinite(n) ? Math.min(LIMITS.rps, Math.max(0, n)) : 0);
  switch (mode) {
    case "constant":
      return cap(profile.rps ?? 0);
    case "ramp": {
      const from = profile.rampFrom ?? 1;
      const to = profile.rampTo ?? 100;
      const mins = Math.max(0.1, profile.rampMinutes ?? 10);
      const elapsed = (nowMs - startedAtMs) / 60_000;
      const t = Math.min(1, Math.max(0, elapsed / mins));
      return cap(from + (to - from) * t);
    }
    case "spike": {
      const base = profile.spikeBase ?? 5;
      const peak = profile.spikePeak ?? 100;
      const every = Math.max(0.5, profile.spikeEveryMinutes ?? 10);
      const dur = Math.max(1, profile.spikeDurationSeconds ?? 30) / 60; // minutes
      const elapsedMin = (nowMs - startedAtMs) / 60_000;
      const pos = elapsedMin % every;
      return cap(pos < dur ? peak : base);
    }
    case "sine-daily": {
      const min = profile.sineMin ?? 2;
      const max = profile.sineMax ?? 50;
      const periodMs = 24 * 60 * 60 * 1000;
      const phase = ((nowMs % periodMs) / periodMs) * 2 * Math.PI;
      const amp = (max - min) / 2;
      const center = min + amp;
      // -π/2 puts the trough at midnight UTC and the peak at midday
      return cap(center + amp * Math.sin(phase - Math.PI / 2));
    }
    case "real":
      // without a shaper, report the curve without advancing the drift state
      return cap(shaper ? shaper.targetRps(nowMs, profile) : (profile.rps ?? 25));
    default:
      // unknown mode treated as constant
      return cap(profile.rps ?? 0);
  }
}

export class TokenBucket {
  private tokens = 0;
  private lastMs: number | null = null;
  private shaper = new RealTrafficShaper();

  /** Call at a fixed cadence. Returns how many requests should be issued now. */
  tick(nowMs: number, profile: LoadProfile, startedAtMs: number): TickResult {
    const targetRps = targetRpsAt(profile, nowMs, startedAtMs, this.shaper);
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      return { due: 0, targetRps };
    }
    const dtSec = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    // allow burst up to 1s of target rps
    this.tokens = Math.min(targetRps, this.tokens + dtSec * targetRps);
    const due = Math.floor(this.tokens);
    this.tokens -= due;
    if (targetRps === 0) this.tokens = 0;
    return { due, targetRps };
  }
}
