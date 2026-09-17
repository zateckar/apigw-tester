import { describe, expect, it } from "bun:test";
import {
  DEFAULT_GW_TARGETS, DEFAULT_LOAD_PROFILE, DEFAULT_POLICY_CONFIG, DEFAULT_SLO,
  type MetricSummary, type PolicyResult, type RunEvent, type SloThresholds,
  type WindowScope, type WindowValidity
} from "@apigw/shared";
import { buildRunReport, redactGateway, renderRunReportMarkdown } from "./report.js";

const okValidity: WindowValidity = {
  ok: true, reasons: [], droppedRequests: 0, shedPct: 0, resultsLost: 0, genFaults: 0,
  targetRps: 25, achievedRps: 25, cpuProcessPctMax: 20,
  // the in-process driver's shape: this loop is the instrument, so the worker
  // numbers are null. A Go-backed window is the mirror image.
  eventLoopP99MsMax: 4, workerSchedP99MsMax: null, workerCpuPctMax: null
};

function summary(over: Partial<MetricSummary> = {}): MetricSummary {
  return {
    windowSec: 600, total: 1000, errors: 0, errorPct: 0,
    unexpectedFailures: 0, unexpectedFailurePct: 0, rps: 1.7,
    latencyMs: { p50: 10, p90: 20, p95: 25, p99: 40, avg: 12, max: 90 },
    nonBackendMs: { p50: 2, p90: 5, p95: 6, p99: 9, avg: 3, count: 1000 },
    connSetup: { setups: 12, measured: 1000, pct: 1.2, avgMs: 4 },
    bytes: { req: 1, resp: 1, respPerSec: 1 },
    status: {
      buckets: [{ bucket: "2xx", count: 1000 }],
      ok: 1000, clientErrors: 0, serverErrors: 0, gatewayErrors: 0,
      rateLimited: 0, unauthorized: 0, networkErrors: 0
    },
    validity: okValidity,
    perProtocol: [], perEndpoint: [], perClass: [],
    contract: {
      invalidSent: 20, rejectedByGateway: 20, rejectedByBackend: 0,
      leakedToBackend: 0, wronglyAccepted: 0, rejected4xx: 20
    },
    ...over
  };
}

const run: RunEvent = {
  id: 1, runId: "run-1", startedAt: 1_000_000, stoppedAt: 1_600_000,
  profile: { ...DEFAULT_LOAD_PROFILE }
};

function build(over: {
  summary?: MetricSummary; slo?: Partial<SloThresholds>; policies?: PolicyResult[];
  required?: string[]; scope?: Partial<WindowScope>;
} = {}) {
  const scope: WindowScope = { foreignRequests: 0, totalRequests: 1000, foreignPct: 0, ...over.scope };
  return buildRunReport({
    run,
    scope,
    summary: over.summary ?? summary(),
    gateway: DEFAULT_GW_TARGETS,
    policies: over.policies ?? [],
    policyConfig: { ...DEFAULT_POLICY_CONFIG, required: (over.required ?? []) as never },
    slo: { ...DEFAULT_SLO, ...over.slo }
  });
}

function policy(id: string, state: PolicyResult["state"]): PolicyResult {
  return {
    id: id as PolicyResult["id"], label: id, probe: "p", expectation: "e",
    state, detail: "d", status: 401, reachedBackend: false, latencyMs: 5, checkedAt: 1
  };
}

describe("run verdict", () => {
  it("passes a clean run against the default thresholds", () => {
    const r = build();
    expect(r.verdict.state).toBe("pass");
    expect(r.verdict.reasons).toEqual([]);
    expect(r.verdict.checks.every((c) => c.state === "pass")).toBe(true);
  });

  it("fails on a threshold breach and says which one", () => {
    const r = build({ summary: summary({ unexpectedFailures: 90, unexpectedFailurePct: 9 }) });
    expect(r.verdict.state).toBe("fail");
    expect(r.verdict.reasons.join(" ")).toMatch(/Unexpected failure rate/);
  });

  it("is inconclusive — not a pass — when the window failed the validity gate", () => {
    // the crux: a saturated generator inflates every latency it reports, so a
    // clean-looking run is not evidence of anything. Calling it a fail would
    // blame the gateway for our own saturation; calling it a pass would be a lie.
    const bad: WindowValidity = {
      ...okValidity, ok: false, droppedRequests: 5000, shedPct: 40,
      reasons: ["40.0% of the intended load was never issued"]
    };
    const r = build({ summary: summary({ validity: bad }) });
    expect(r.verdict.state).toBe("inconclusive");
    expect(r.verdict.reasons[0]).toMatch(/never issued/);
  });

  it("is inconclusive when the window is mostly another run's traffic", () => {
    // two 20-second runs inside the same minute would otherwise be reported as
    // each other: roll-up buckets carry no run id
    const r = build({ scope: { foreignRequests: 600, totalRequests: 1000, foreignPct: 60 } });
    expect(r.verdict.state).toBe("inconclusive");
    expect(r.verdict.reasons[0]).toMatch(/belongs to other runs/);
  });

  it("tolerates a sliver of neighbouring traffic without going inconclusive", () => {
    const r = build({ scope: { foreignRequests: 3, totalRequests: 1000, foreignPct: 0.3 } });
    expect(r.verdict.state).toBe("pass");
    // still stated in the report, because the reader should know it happened
    expect(renderRunReportMarkdown(r)).toMatch(/Window purity/);
  });

  it("is inconclusive when no traffic was recorded at all", () => {
    const r = build({ summary: summary({ total: 0 }) });
    expect(r.verdict.state).toBe("inconclusive");
    expect(r.verdict.reasons.join(" ")).toMatch(/no traffic/);
  });

  it("is inconclusive when nothing was asserted", () => {
    // a green tick that checked nothing is worse than an honest shrug
    const r = build({
      slo: {
        maxNonBackendP95Ms: null, maxUnexpectedFailurePct: null,
        maxLeakedToBackend: null, maxGatewayErrorPct: null, requirePolicies: false
      }
    });
    expect(r.verdict.state).toBe("inconclusive");
    expect(r.verdict.reasons.join(" ")).toMatch(/no thresholds/);
  });

  it("does not assert contract leakage when no invalid traffic was generated", () => {
    const r = build({ summary: summary({ contract: { ...summary().contract, invalidSent: 0, rejectedByGateway: 0, rejected4xx: 0 } }) });
    expect(r.verdict.checks.some((c) => c.id === "contract-leak")).toBe(false);
    expect(r.verdict.state).toBe("pass");
  });

  it("fails when a policy the operator marked required is not enforced", () => {
    const r = build({
      policies: [policy("rate-limit", "not-enforced"), policy("auth-bad-key", "pass")],
      required: ["rate-limit"]
    });
    expect(r.verdict.state).toBe("fail");
    const check = r.verdict.checks.find((c) => c.id === "required-policies");
    expect(check?.state).toBe("fail");
    // the denominator is the required set, not every policy that was probed
    expect(check?.actual).toBe("0/1");
  });

  it("is inconclusive when no required policy could be probed at all", () => {
    // e.g. the target is the rig's own petstore: the probes report an error,
    // and treating that as "not enforced" would invent a gateway failure
    const r = build({
      policies: [{ ...policy("rate-limit", "error"), detail: "no gateway in front of it" }],
      required: ["rate-limit"]
    });
    expect(r.verdict.state).toBe("inconclusive");
    expect(r.verdict.reasons[0]).toMatch(/could not be probed/);
    expect(r.verdict.checks.some((c) => c.id === "required-policies")).toBe(false);
  });

  it("judges the policies it could probe and ignores the ones it could not", () => {
    const r = build({
      policies: [policy("rate-limit", "error"), policy("auth-bad-key", "pass")],
      required: ["rate-limit", "auth-bad-key"]
    });
    expect(r.verdict.state).toBe("pass");
    // the denominator drops the unprobeable one rather than counting it against
    expect(r.verdict.checks.find((c) => c.id === "required-policies")?.actual).toBe("1/1");
  });

  it("ignores an unenforced policy nobody asked for", () => {
    // a gateway with no cache is a normal gateway, not a defect
    const r = build({ policies: [policy("cache", "not-enforced")] });
    expect(r.verdict.state).toBe("pass");
  });
});

describe("report rendering", () => {
  it("strips API keys from the gateway it reports", () => {
    // a report exists to be handed to someone else
    const redacted = redactGateway({
      rest: { ...DEFAULT_GW_TARGETS.rest, apiKey: "super-secret" },
      soap: { ...DEFAULT_GW_TARGETS.soap, apiKey: "" }
    });
    expect(redacted.rest.apiKey).toBe("[redacted]");
    expect(redacted.soap.apiKey).toBe("");

    const r = build();
    expect(JSON.stringify(r)).not.toContain("super-secret");
  });

  it("leads the markdown with the verdict and its reasons", () => {
    const md = renderRunReportMarkdown(build({ summary: summary({ unexpectedFailurePct: 9, unexpectedFailures: 90 }) }));
    expect(md).toMatch(/\*\*Verdict: FAIL\*\*/);
    expect(md).toMatch(/Unexpected failure rate/);
    // and the validity section is always present, pass or fail
    expect(md).toMatch(/## Measurement validity/);
    expect(md).toMatch(/## Gateway policies/);
  });

  it("escapes a pipe in a policy detail so the table survives", () => {
    const md = renderRunReportMarkdown(build({
      policies: [{ ...policy("cache", "fail"), detail: "got a|b instead" }]
    }));
    expect(md).toContain("got a\\|b instead");
  });
});


it("cannot pass non-backend acceptance when nothing carried a backend clock", () => {
  // A gateway that strips X-Server-Ms, or answers everything itself, leaves
  // p95 null. Treating "we could not measure it" as "it was within budget" is
  // the one failure mode an acceptance gate must not have, so the verdict is
  // inconclusive and says what was missing.
  const report = buildRunReport({
    run: { id: 1, runId: "stripped", startedAt: 0, stoppedAt: 60_000, profile: DEFAULT_LOAD_PROFILE },
    summary: summary({
      nonBackendMs: { p50: null, p90: null, p95: null, p99: null, avg: null, count: 0 }
    }),
    scope: { totalRequests: 100, foreignRequests: 0, foreignPct: 0 },
    gateway: DEFAULT_GW_TARGETS, policies: [], policyConfig: DEFAULT_POLICY_CONFIG, slo: { ...DEFAULT_SLO, maxNonBackendP95Ms: 10 }
  });
  expect(report.verdict.state).toBe("inconclusive");
  expect(report.verdict.reasons[0]).toContain("X-Server-Ms");
});
