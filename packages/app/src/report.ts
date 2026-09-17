import type {
  ConnSetupStats,
  GwTargets,
  MetricSummary,
  PolicyConfig,
  PolicyResult,
  RunEvent,
  RunReport,
  SloCheck,
  SloThresholds,
  VerdictState,
  WindowScope
} from "@apigw/shared";
import { VALIDITY_LIMITS } from "@apigw/shared";

/**
 * Turning a run into a shareable answer.
 *
 * A gateway acceptance test has exactly one deliverable: did it pass. Getting
 * there needs three things a raw metrics window does not give you — the run's
 * own boundaries, thresholds to judge against, and an honest third outcome.
 *
 * `inconclusive` is that third outcome, and it is the important one. A run
 * whose window failed the validity gate cannot be called a pass (the numbers
 * are not trustworthy), and calling it a fail would blame the gateway for the
 * rig's own saturation. Reporting a confident verdict from a saturated
 * generator is how load tests end up lying.
 */

/** API keys never belong in a document meant to be handed to someone else. */
export function redactGateway(gw: GwTargets): GwTargets {
  const strip = (t: GwTargets["rest"]): GwTargets["rest"] => ({
    ...t,
    apiKey: t.apiKey ? "[redacted]" : ""
  });
  return { rest: strip(gw.rest), soap: strip(gw.soap) };
}

function check(
  id: string,
  label: string,
  actual: number | null,
  threshold: number | null,
  compare: (a: number, t: number) => boolean
): SloCheck | null {
  if (threshold === null || actual === null) return null;
  return {
    id,
    label,
    actual,
    threshold,
    state: compare(actual, threshold) ? "pass" : "fail"
  };
}

const atMost = (a: number, t: number): boolean => a <= t;

export interface BuildReportInput {
  run: RunEvent;
  summary: MetricSummary;
  scope: WindowScope;
  gateway: GwTargets;
  policies: PolicyResult[];
  policyConfig: PolicyConfig;
  slo: SloThresholds;
}

export function buildRunReport(input: BuildReportInput): RunReport {
  const { run, summary, scope, gateway, policies, policyConfig, slo } = input;
  const stoppedAt = run.stoppedAt;
  const durationSec = Math.max(0, ((stoppedAt ?? Date.now()) - run.startedAt) / 1000);

  const checks: SloCheck[] = [];
  const push = (c: SloCheck | null): void => { if (c) checks.push(c); };

  push(check("unexpected-failures", "Unexpected failure rate", summary.unexpectedFailurePct, slo.maxUnexpectedFailurePct, atMost));
  push(check(
    "gateway-errors", "Gateway fault rate",
    summary.total === 0 ? null : (100 * summary.status.gatewayErrors) / summary.total,
    slo.maxGatewayErrorPct, atMost
  ));
  push(check("non-backend-p95", "Non-backend time at p95 (ms)", summary.nonBackendMs.p95, slo.maxNonBackendP95Ms, atMost));
  // only assert contract leakage when invalid traffic was actually generated —
  // a run with invalidRatioPct = 0 has nothing to say about it either way
  push(check(
    "contract-leak", "Contract violations that reached the backend",
    summary.contract.invalidSent === 0 ? null : summary.contract.leakedToBackend,
    slo.maxLeakedToBackend, atMost
  ));

  const requiredPolicies = policies.filter((p) => policyConfig.required.includes(p.id));
  // a probe that errored says nothing about the policy — it says the probe did
  // not get an answer (unreachable, throttled, or no gateway in the path at
  // all). Counting that as "not enforced" would invent a failure.
  const measured = requiredPolicies.filter((p) => p.state !== "error");
  const assertingPolicies = slo.requirePolicies && requiredPolicies.length > 0;
  if (assertingPolicies && measured.length > 0) {
    const failed = measured.filter((p) => p.state !== "pass");
    checks.push({
      id: "required-policies",
      label: "Required gateway policies enforced",
      actual: `${measured.length - failed.length}/${measured.length}`,
      threshold: `${measured.length}/${measured.length}`,
      state: failed.length === 0 ? "pass" : "fail"
    });
  }

  const reasons: string[] = [];
  for (const c of checks) {
    if (c.state === "fail") reasons.push(`${c.label}: ${fmt(c.actual)} exceeds ${fmt(c.threshold)}`);
  }

  let state: VerdictState;
  if (summary.total === 0) {
    state = "inconclusive";
    reasons.unshift("no traffic was recorded for this run");
  } else if (!summary.validity.ok) {
    // the measurement itself is suspect, so neither pass nor fail is honest
    state = "inconclusive";
    reasons.unshift(...summary.validity.reasons);
  } else if (slo.maxNonBackendP95Ms != null && summary.nonBackendMs.p95 === null) {
    // a threshold that could not be evaluated is not a pass. There is only one
    // way to get here now: no request in the window carried X-Server-Ms, so
    // there was nothing to subtract the backend's own time from.
    state = "inconclusive";
    reasons.unshift(
      "non-backend time was asserted on but could not be measured: no request in this window carried the " +
      "backend's X-Server-Ms header, so none of them has a backend time to subtract. A gateway that strips " +
      "the header, or that answered everything itself, cannot be measured this way"
    );
  } else if (scope.foreignPct > VALIDITY_LIMITS.foreignPct) {
    // the window is mostly somebody else's traffic: judging this run on it
    // would be judging the wrong run
    state = "inconclusive";
    reasons.unshift(
      `${scope.foreignPct.toFixed(1)}% of the window (${scope.foreignRequests.toLocaleString()} of ` +
      `${scope.totalRequests.toLocaleString()} requests) belongs to other runs — roll-ups are minute-granular, ` +
      `so a run this short shares buckets with whatever ran either side of it`
    );
  } else if (assertingPolicies && measured.length === 0) {
    // you asked for policies to be enforced and not one of them could be
    // checked — a pass here would be a green tick over an unanswered question
    state = "inconclusive";
    reasons.unshift(
      `the required gateway policies could not be probed: ${requiredPolicies[0]?.detail ?? "probe error"}`
    );
  } else if (checks.length === 0) {
    state = "inconclusive";
    reasons.unshift("no thresholds were configured, so there is nothing to judge against");
  } else {
    state = checks.some((c) => c.state === "fail") ? "fail" : "pass";
  }

  return {
    runId: run.runId,
    startedAt: run.startedAt,
    stoppedAt,
    durationSec,
    profile: run.profile,
    scope,
    gateway: redactGateway(gateway),
    summary,
    policies,
    verdict: { state, checks, reasons }
  };
}

function fmt(v: number | string): string {
  return typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v;
}

const VERDICT_MARK: Record<VerdictState, string> = {
  pass: "PASS",
  fail: "FAIL",
  inconclusive: "INCONCLUSIVE"
};

const POLICY_MARK: Record<PolicyResult["state"], string> = {
  pass: "pass",
  fail: "FAIL",
  "not-enforced": "not enforced",
  error: "probe error",
  skipped: "skipped"
};

/** Markdown rendering, for pasting into a ticket or a review. */
export function renderRunReportMarkdown(r: RunReport): string {
  const iso = (ms: number | null): string => (ms === null ? "—" : new Date(ms).toISOString());
  const ms = (n: number | null): string => n === null ? "unavailable" : `${n.toFixed(1)} ms`;
  const pct = (n: number): string => `${n.toFixed(2)} %`;
  /** Reuse reads better than churn, but the count is what is auditable.
   *  Tolerates the field being absent: a summary rendered from a build that
   *  predates connection tagging should read as "unmeasured", not throw and
   *  cost the whole report. */
  const connSetupLine = (c: ConnSetupStats | undefined): string => {
    if (!c || c.measured === 0) return "not measured by this generator";
    const reusePct = 100 - (c.pct ?? 0);
    return `${reusePct.toFixed(1)} % reused — ${c.setups.toLocaleString()} of ` +
      `${c.measured.toLocaleString()} requests opened a connection` +
      (c.avgMs === null ? "" : `, averaging ${c.avgMs.toFixed(1)} ms to acquire`);
  };
  const L: string[] = [];

  L.push(`# Gateway test report — ${r.runId}`);
  L.push("");
  L.push(`**Verdict: ${VERDICT_MARK[r.verdict.state]}**`);
  if (r.verdict.reasons.length > 0) {
    L.push("");
    for (const reason of r.verdict.reasons) L.push(`- ${reason}`);
  }
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Started | ${iso(r.startedAt)} |`);
  L.push(`| Stopped | ${iso(r.stoppedAt)} |`);
  L.push(`| Duration | ${(r.durationSec / 60).toFixed(1)} min |`);
  L.push(`| REST target | \`${r.gateway.rest.baseUrl}${r.gateway.rest.pathPrefix}\` |`);
  L.push(`| SOAP target | \`${r.gateway.soap.baseUrl}${r.gateway.soap.pathPrefix}\` |`);
  L.push(`| Mode | ${r.profile.mode} |`);
  // a reader has to know when the window is not exclusively this run's
  if (r.scope.foreignRequests > 0) {
    L.push(`| Window purity | ${(100 - r.scope.foreignPct).toFixed(1)} % this run (${r.scope.foreignRequests.toLocaleString()} requests from other runs share its minute buckets) |`);
  }
  L.push("");

  if (r.verdict.checks.length > 0) {
    L.push("## Thresholds");
    L.push("");
    L.push("| Check | Actual | Threshold | |");
    L.push("|---|---|---|---|");
    for (const c of r.verdict.checks) {
      L.push(`| ${c.label} | ${fmt(c.actual)} | ≤ ${fmt(c.threshold)} | ${c.state === "pass" ? "pass" : "**FAIL**"} |`);
    }
    L.push("");
  }

  const s = r.summary;
  L.push("## Traffic");
  L.push("");
  L.push("| | |");
  L.push("|---|---|");
  L.push(`| Requests | ${s.total.toLocaleString()} |`);
  L.push(`| Achieved rate | ${s.validity.achievedRps.toFixed(1)} rps${s.validity.targetRps === null ? "" : ` (target ${s.validity.targetRps.toFixed(1)})`} |`);
  L.push(`| Unexpected failures | ${s.unexpectedFailures.toLocaleString()} (${pct(s.unexpectedFailurePct)}) |`);
  L.push(`| Gateway faults | ${s.status.gatewayErrors.toLocaleString()} |`);
  L.push(`| Rate limited | ${s.status.rateLimited.toLocaleString()} |`);
  L.push(`| Unauthorized | ${s.status.unauthorized.toLocaleString()} |`);
  L.push(`| Latency p50 / p95 / p99 | ${ms(s.latencyMs.p50)} / ${ms(s.latencyMs.p95)} / ${ms(s.latencyMs.p99)} |`);
  L.push(`| Requests carrying backend timing | ${s.nonBackendMs.count.toLocaleString()} of ${s.total.toLocaleString()} |`);
  L.push(`| Connection reuse | ${connSetupLine(s.connSetup)} |`);
  L.push(`| **Non-backend time, p50 / p95 / p99** | **${ms(s.nonBackendMs.p50)} / ${ms(s.nonBackendMs.p95)} / ${ms(s.nonBackendMs.p99)}** |`);
  L.push("");
  L.push(
    "Non-backend time is `ttfb − serverMs − connect`, measured on every request that came back carrying the " +
    "backend's own `X-Server-Ms` header. It is everything that request spent outside the backend: the " +
    "gateway's work and the network to it and back. It is not the gateway's processing cost in isolation — a " +
    "single stream has nothing to subtract the path itself against — so read it as a ceiling on what the " +
    "gateway costs. A negative value means the two clocks differ by less than this rig can resolve, and is " +
    "reported as measured rather than floored at zero."
  );
  L.push("");
  L.push(
    "Connection acquisition is measured per request and subtracted, so a gateway is not charged for " +
    "handshakes. That makes the reuse rate above a finding in its own right rather than a footnote: a gateway " +
    "that refuses keep-alive makes every caller pay a handshake this number will show and the figure above " +
    "deliberately will not."
  );
  L.push("");
  L.push(
    "The headline figure pools every class in the window, so it moves with the scenario mix; the per-class " +
    "numbers are the ones to compare between runs."
  );
  L.push("");

  L.push("### Status distribution");
  L.push("");
  if (s.status.buckets.length === 0) {
    L.push("_none recorded_");
  } else {
    L.push("| Status | Count |");
    L.push("|---|---|");
    for (const b of s.status.buckets) L.push(`| ${b.bucket === "net" ? "no response" : b.bucket} | ${b.count.toLocaleString()} |`);
  }
  L.push("");

  L.push("## Measurement validity");
  L.push("");
  if (s.validity.ok) {
    L.push("The generator kept up and stayed within its resource limits, so the numbers above stand.");
  } else {
    L.push("**These numbers are not trustworthy:**");
    L.push("");
    for (const reason of s.validity.reasons) L.push(`- ${reason}`);
  }
  L.push("");
  L.push(`Load shed: ${s.validity.droppedRequests.toLocaleString()} requests (${pct(s.validity.shedPct)}). ` +
    `Peak control-plane CPU: ${s.validity.cpuProcessPctMax === null ? "—" : `${s.validity.cpuProcessPctMax.toFixed(0)} %`}.`);
  // Exactly one of these two describes the process that held the stopwatch, and
  // the other is null. Naming which one it was is the point: an event-loop
  // number quoted under a Go-backed run would look like evidence and be none.
  if (s.validity.workerSchedP99MsMax !== null) {
    L.push("");
    L.push(`The load was generated by the Go worker, so the instrument on trial is its scheduler. ` +
      `Worst 2-second window's scheduling latency at p99: ${ms(s.validity.workerSchedP99MsMax)} ` +
      `(limit ${VALIDITY_LIMITS.workerSchedP99Ms} ms). ` +
      `Peak worker CPU: ${s.validity.workerCpuPctMax === null ? "—" : `${s.validity.workerCpuPctMax.toFixed(0)} %`}.`);
  } else if (s.validity.eventLoopP99MsMax !== null) {
    L.push("");
    L.push(`The load was generated in-process, so the instrument on trial is this event loop. ` +
      `Peak event-loop p99: ${ms(s.validity.eventLoopP99MsMax)} (limit ${VALIDITY_LIMITS.eventLoopP99Ms} ms).`);
  }
  L.push("");

  L.push("## Contract validation");
  L.push("");
  L.push("| | |");
  L.push("|---|---|");
  L.push(`| Invalid requests sent | ${s.contract.invalidSent.toLocaleString()} |`);
  L.push(`| Blocked by the gateway | ${s.contract.rejectedByGateway.toLocaleString()} |`);
  L.push(`| Reached the backend | ${s.contract.leakedToBackend.toLocaleString()} |`);
  L.push(`| Accepted outright (2xx) | ${s.contract.wronglyAccepted.toLocaleString()} |`);
  L.push("");

  L.push("## Gateway policies");
  L.push("");
  if (r.policies.length === 0) {
    L.push("_no policy probes have run_");
  } else {
    L.push("| Policy | Result | Detail |");
    L.push("|---|---|---|");
    for (const p of r.policies) {
      L.push(`| ${p.label} | ${POLICY_MARK[p.state]} | ${p.detail.replace(/\|/g, "\\|")} |`);
    }
  }
  L.push("");
  return L.join("\n");
}
