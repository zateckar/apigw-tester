import { useQuery, useMutation, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Panel
} from "./Panel";
import {
  api, downloadDefinition, fmtBytes, fmtDuration, fmtMs,
  DEFAULT_GW, DEFAULT_PROFILE, type SummaryWindow
} from "./api";
import type { GwTargets, LoadProfile, PolicyState, RunEvent, StatusBucket, VerdictState } from "./api";
import { GATEWAY_FAULT_BUCKETS, VALIDITY_LIMITS } from "@apigw/shared";
import ConfigDrawer from "./ConfigDrawer";

/** label and summary window are the same value on purpose: the KPI tiles used
 *  to be captioned with one range while showing numbers from another. */
const RANGES: { label: SummaryWindow; hours: number }[] = [
  { label: "15m", hours: 0.25 },
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 }
];

/** long windows are much more expensive to compute — poll them less often;
 *  and summary/timeseries data only changes on the loadgen flush (10s), so a
 *  faster poll is half re-compute of identical numbers */
const pollFor = (w: SummaryWindow): number => (w === "24h" || w === "7d" ? 30_000 : 10_000);

function errorOf(...queries: UseQueryResult<unknown, Error>[]): string | null {
  for (const q of queries) if (q.isError && q.error) return q.error.message;
  return null;
}

/** Render a number, or an em-dash when the data genuinely isn't there — so a
 *  failed fetch never renders as a healthy-looking zero. */
function stat(value: number | null | undefined, render: (n: number) => string): string {
  return value == null || !Number.isFinite(value) ? "—" : render(value);
}

/** Colour a status bucket by who is at fault: red for the gateway's own
 *  failures, amber for anything else that isn't a success. */
function statusColor(bucket: StatusBucket): string | undefined {
  if (GATEWAY_FAULT_BUCKETS.includes(bucket)) return "var(--err)";
  if (bucket === "2xx" || bucket === "3xx" || bucket === "1xx") return undefined;
  return "var(--warn, #d29922)";
}

const POLICY_LABEL: Record<PolicyState, string> = {
  pass: "pass",
  fail: "FAIL",
  "not-enforced": "not enforced",
  error: "probe error",
  skipped: "skipped"
};

/** "not enforced" is deliberately neutral: plenty of gateways legitimately
 *  have no cache or quota, and painting that red trains people to ignore red. */
function policyBadge(state: PolicyState): string {
  if (state === "pass") return "ok";
  if (state === "fail") return "err";
  return "warn";
}

const VERDICT_LABEL: Record<VerdictState, string> = {
  pass: "PASS",
  fail: "FAIL",
  inconclusive: "INCONCLUSIVE"
};

export default function App() {
  const qc = useQueryClient();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1] as (typeof RANGES)[number]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recentProto, setRecentProto] = useState<"" | "rest" | "soap">("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  /** per-run verdict + why, fetched on demand; "loading" while in flight */
  const [verdicts, setVerdicts] = useState<Record<string, { state: VerdictState; reasons: string[] } | "loading">>({});

  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 5_000 });
  const gwQ = useQuery({ queryKey: ["gw"], queryFn: api.gateway, refetchInterval: 30_000 });
  const profileQ = useQuery({ queryKey: ["profile"], queryFn: api.profile, refetchInterval: 30_000 });
  const summaryQ = useQuery({
    queryKey: ["summary", range.label],
    queryFn: () => api.summary(range.label),
    refetchInterval: pollFor(range.label)
  });
  const seriesQ = useQuery({
    queryKey: ["series", range.hours],
    queryFn: () => api.timeseries(range.hours),
    refetchInterval: pollFor(range.label)
  });
  const recentQ = useQuery({ queryKey: ["recent"], queryFn: () => api.recent(150), refetchInterval: 10_000 });
  const runsQ = useQuery({ queryKey: ["runs"], queryFn: api.runs, refetchInterval: 30_000 });
  const systemQ = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 5_000 });
  const defsQ = useQuery({ queryKey: ["definitions"], queryFn: api.definitions, refetchInterval: false });
  const policyQ = useQuery({ queryKey: ["policy"], queryFn: api.policy, refetchInterval: 15_000 });

  const startMut = useMutation({
    mutationFn: api.startRun,
    onSuccess: () => { setActionError(null); void qc.invalidateQueries(); },
    onError: (e: Error) => setActionError(e.message)
  });
  const stopMut = useMutation({
    mutationFn: api.stopRun,
    onSuccess: () => { setActionError(null); void qc.invalidateQueries(); },
    onError: (e: Error) => setActionError(e.message)
  });

  const statusMut = {
    onSuccess: () => { setActionError(null); void qc.invalidateQueries(); },
    onError: (e: Error) => setActionError(e.message)
  };
  const resetMut = useMutation({ mutationFn: api.resetMetrics, ...statusMut });
  const [policyNote, setPolicyNote] = useState<string | null>(null);
  const policyMut = useMutation({
    mutationFn: api.runPolicy,
    onSuccess: () => {
      setActionError(null);
      // the pass runs server-side and takes tens of seconds (one probe waits
      // out a 10s upstream hang); the 15s poll picks the results up
      setPolicyNote("Probing… results appear here as they land.");
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["policy"] }), 3_000);
    },
    onError: (e: Error) => setActionError(e.message)
  });
  const [pruneDays, setPruneDays] = useState("30");
  const pruneMut = useMutation({
    mutationFn: (days: number) => api.pruneRuns(days),
    onSuccess: (out) => {
      setActionError(null);
      setDownloadNote(`Pruned ${out.deleted} run${out.deleted === 1 ? "" : "s"}`);
      void qc.invalidateQueries();
    },
    onError: (e: Error) => setActionError(e.message)
  });

  const status = statusQ.data;
  const summary = summaryQ.data;
  const running = status?.state === "running";
  const gw = gwQ.data ?? status?.gateway ?? DEFAULT_GW;
  const gwLabel = gw.rest.baseUrl === gw.soap.baseUrl
    ? `${gw.rest.baseUrl}${gw.rest.pathPrefix || ""}`
    : `REST ${gw.rest.baseUrl}${gw.rest.pathPrefix || ""} · SOAP ${gw.soap.baseUrl}${gw.soap.pathPrefix || ""}`;
  const profile = profileQ.data ?? status?.profile ?? DEFAULT_PROFILE;
  const loadError = errorOf(statusQ, summaryQ, seriesQ, recentQ, runsQ, gwQ, profileQ);
  const sys = systemQ.data;

  // memoized chart data so every poll produces a stable reference
  const points = useMemo(() => {
    const bucket = seriesQ.data?.bucketSec ?? 60;
    // hourly buckets need the date, or a week of data shows 24 repeating labels
    const fmt: Intl.DateTimeFormatOptions = bucket >= 3600
      ? { month: "short", day: "numeric", hour: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" };
    const pts = seriesQ.data?.points ?? [];
    // drop still-accumulating tail buckets — they render as a false dive to
    // zero on latency charts and a sagging last bar on rps/bytes
    let end = pts.length;
    while (end > 0 && pts[end - 1]?.partial) end--;
    return pts.slice(0, end).map((p) => ({
      ...p,
      t: new Date(p.ts).toLocaleString([], fmt),
      restRps: p.restTotal / bucket,
      soapRps: p.soapTotal / bucket,
      bytesKb: p.bytesResp / 1024
    }));
  }, [seriesQ.data]);

  // host-metric history: unit conversions (bytes → GB, ns-sourced B/s stay B/s)
  // happen here so the recharts fields match what the axes and tooltips claim
  const sysPoints = useMemo(() => {
    const fmt: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
    return (sys?.history ?? []).map((s) => ({
      t: new Date(s.ts).toLocaleString([], fmt),
      cpuProcessPct: s.cpuProcessPct,
      cpuSystemPct: s.cpuSystemPct,
      memUsedGb: s.memUsedBytes / 1024 ** 3,
      memTotalGb: s.memTotalBytes / 1024 ** 3,
      appInBps: s.appInBps,
      appOutBps: s.appOutBps,
      procReadBps: s.procReadBps,
      procWriteBps: s.procWriteBps
    }));
  }, [sys]);

  const recent = (recentQ.data?.items ?? []).filter(
    (r) => !recentProto || r.protocol === recentProto
  ).slice(0, 80);

  const contract = summary?.contract;
  const st = summary?.status;
  const validity = summary?.validity;
  /** No gateway in the path: the rig is pointed at its own bundled petstore,
   *  so every gateway-shaped number is vacuous and must not read as a finding. */
  const noGateway = status?.targetIsSelf?.rest === true && status?.targetIsSelf?.soap === true;

  /**
   * The misconfiguration warning.
   *
   * Pointing the rig at a real gateway for the first time usually fails in one
   * of three boring ways — wrong key, tripped quota, unreachable upstream — and
   * every one of them used to render as a flawless run because 4xx counted as
   * success. Call it out above the fold instead.
   */
  const gwWarning = useMemo(() => {
    if (!summary || !st || summary.total < 20 || noGateway) return null;
    const share = (n: number) => (100 * n) / summary.total;
    if (share(st.unauthorized) > 25) {
      return `${share(st.unauthorized).toFixed(0)}% of requests came back 401/403 — the gateway is rejecting the API key, not measuring your traffic. Check Configure → API Gateway.`;
    }
    if (share(st.rateLimited) > 10) {
      return `${share(st.rateLimited).toFixed(0)}% of requests were rate-limited (429). Latency and overhead numbers for this window describe the gateway's throttle, not its proxying — lower the RPS or raise the quota.`;
    }
    if (share(st.gatewayErrors) > 10) {
      return `${share(st.gatewayErrors).toFixed(0)}% of requests failed at the gateway itself (502/503/504 or no response) — it cannot reach a healthy upstream.`;
    }
    return null;
  }, [summary, st, noGateway]);

  /**
   * A gateway that answers 401 or 429 to *everything* also "blocks" every
   * invalid probe — but on the credential, not on the contract. Reporting
   * "100% blocked" there would be true and useless, so the tile stands down
   * until the gateway is actually passing traffic.
   */
  const contractMoot = gwWarning !== null;

  /**
   * Verdicts are fetched on demand, one run at a time. Each one re-aggregates
   * that run's whole window server-side, so eagerly computing them for every
   * row of the history would be an expensive way to fill a table nobody asked
   * to see.
   */
  async function loadVerdict(runId: string) {
    setVerdicts((v) => ({ ...v, [runId]: "loading" }));
    try {
      const report = await api.report(runId);
      setVerdicts((v) => ({ ...v, [runId]: { state: report.verdict.state, reasons: report.verdict.reasons } }));
    } catch (e) {
      setVerdicts((v) => { const { [runId]: _drop, ...rest } = v; return rest; });
      setActionError((e as Error).message);
    }
  }

  async function grab(path: string, filename: string) {
    setDownloadNote(null);
    try {
      await downloadDefinition(path, filename);
      setDownloadNote(`Downloaded ${filename}`);
    } catch (e) {
      setDownloadNote((e as Error).message);
    }
  }

  return (
    <div className="app">
      {/* ---------- Top bar ---------- */}
      <div className="topbar">
        <div className="brand">
          <h1>API GW Tester</h1>
          <span className="state">
            <span className={`dot ${running ? "running" : status?.state ?? "idle"}`} />
            {status?.state ?? (statusQ.isError ? "unreachable" : "loading")}
            {status?.runId ? ` · ${status.runId}` : ""}
            {status?.uptimeSec != null ? ` · up ${fmtDuration(status.uptimeSec)}` : ""}
          </span>
          <span className="hint mono" title="Gateway targets">
            {gwLabel}
          </span>
        </div>
        <div className="controls">
          <button onClick={() => setDrawerOpen(true)}>Configure</button>
          {running ? (
            <button className="danger" onClick={() => stopMut.mutate()} disabled={stopMut.isPending}>
              Stop run
            </button>
          ) : (
            <button className="primary" onClick={() => startMut.mutate()} disabled={startMut.isPending}>
              Start run
            </button>
          )}
        </div>
      </div>

      {(loadError || actionError) && (
        <div className="banner err" role="alert">
          {actionError ?? `Cannot reach the API: ${loadError}`}
        </div>
      )}

      {gwWarning && (
        <div className="banner err" role="alert">
          <strong>Gateway is not proxying your traffic.</strong> {gwWarning}
        </div>
      )}

      {/* No run can be started at all. There is no second generator to quietly
          switch to, and a rig that changes instrument without saying so is
          worse than one that stops. */}
      {status?.generatorError && (
        <div className="banner err" role="alert">
          <strong>No load generator.</strong> {status.generatorError}
        </div>
      )}

      {/* The in-process driver is a test fixture: it cannot time connections,
          and its own scheduling delay lands inside what it measures. */}
      {status?.backend === "ts" && (
        <div className="banner err" role="alert">
          <strong>Running on the in-process test fixture (LOADGEN_BACKEND=ts).</strong>{" "}
          Connection setup is not measured and is included in non-backend time, and this
          process&rsquo;s own scheduling delay is inside every number below. Not a supported
          configuration — unset LOADGEN_BACKEND to use the Go worker.
        </div>
      )}

      {/* The generator, not the gateway, may be the story. Say so before the
          reader has drawn any conclusions from the percentiles below. */}
      {validity && !validity.ok && (
        <div className="banner err" role="alert">
          <strong>These numbers are not trustworthy.</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {validity.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* ---------- KPIs ---------- */}
      <div className="kpis">
        <div
          className="kpi"
          style={{ borderColor: "var(--accent)" }}
          title={
            "ttfb − serverMs − connectMs, measured on every request that came back carrying the backend's own " +
            "X-Server-Ms header, read at the 95th percentile. It is everything the request spent outside the " +
            "backend: the gateway's work AND the network to it and back. It is not the gateway's processing cost " +
            "on its own — nothing in a single stream can separate those — so read it as a ceiling on what the " +
            "gateway costs. Connection setup is measured per request and taken out, so a gateway is not charged " +
            "here for handshakes; see the reuse line below for whether it caused any. A negative value means the " +
            "two clocks differ by less than this rig can resolve, and is reported rather than floored at zero."
          }
        >
          <div className="label">Non-backend time, p95 ({range.label})</div>
          <div className="value" style={{ color: "var(--accent)" }}>
            {stat(summary?.nonBackendMs.p95, fmtMs)}
          </div>
          <div className="sub">
            {noGateway
              ? "no gateway configured — this is loopback slop"
              : `p50 ${stat(summary?.nonBackendMs.p50, fmtMs)} · p90 ${stat(summary?.nonBackendMs.p90, fmtMs)} · p99 ${stat(summary?.nonBackendMs.p99, fmtMs)}`}
          </div>
          <div className="sub">
            {(summary?.nonBackendMs.count ?? 0).toLocaleString()} of {(summary?.total ?? 0).toLocaleString()} requests
            {" measured"}
            {summary != null && summary.total > 0 && summary.nonBackendMs.count === 0 &&
              " — no response carried X-Server-Ms, so there is no backend time to subtract"}
          </div>
          {/* the per-class table below is the number to compare between runs:
              this tile pools every class, so it moves with the scenario mix */}
          {summary != null && summary.connSetup.measured > 0 && (
            <div
              className="sub"
              style={{ color: (summary.connSetup.pct ?? 0) > 5 ? "var(--err)" : undefined }}
              title={
                "Requests that had to open a connection rather than reuse a pooled one. This cost is measured " +
                "per request and taken out of the figure above, so it is reported here instead of inflating " +
                "that number. A high share against a real gateway means it is refusing or capping keep-alive, " +
                "which every caller pays for in handshakes."
              }
            >
              {(100 - (summary.connSetup.pct ?? 0)).toFixed(1)}% connections reused
              {summary.connSetup.avgMs !== null &&
                ` · ${summary.connSetup.setups.toLocaleString()} setups at ${fmtMs(summary.connSetup.avgMs)}`}
            </div>
          )}
        </div>
        <div
          className="kpi"
          title="Target is what the profile asks for; achieved is what was actually issued. A gap means the concurrency ceiling is shedding load — the gateway was never offered the rate the charts imply, and its latency looks better for it."
        >
          <div className="label">RPS target → achieved</div>
          <div className={`value ${validity && validity.shedPct > 1 ? "err" : ""}`} style={{ fontSize: 17 }}>
            {stat(status?.targetRps, (n) => n.toFixed(1))}
            {" → "}
            {stat(validity?.achievedRps, (n) => n.toFixed(1))}
          </div>
          <div
            className="sub"
            title={
              status?.throttledSinceMs != null
                ? `Concurrency cap ${status.effectiveMaxConcurrency ?? "?"} is saturated since ${fmtDuration(Math.max(0, Math.floor((Date.now() - status.throttledSinceMs) / 1000)))} — delivering less than the target rate (target latency too high?)`
                : undefined
            }
          >
            {profile.mode} · conc {status?.effectiveMaxConcurrency ?? profile.maxConcurrency}
            {validity && validity.droppedRequests > 0 && (
              <span style={{ color: "var(--err)" }}>
                {" "}· shed {validity.droppedRequests.toLocaleString()} ({validity.shedPct.toFixed(1)}%)
              </span>
            )}
            {validity && validity.resultsLost > 0 && (
              <span
                style={{ color: "var(--err)" }}
                title="Requests the gateway served whose measurement never reached the store. Unlike shed load, this traffic did happen — the charts just do not describe all of it."
              >
                {" "}· {validity.resultsLost.toLocaleString()} measurements lost
              </span>
            )}
            {status?.throttledSinceMs != null && <span style={{ color: "var(--err)" }}> · throttled</span>}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Requests ({range.label})</div>
          <div className="value">{stat(summary?.total, (n) => n.toLocaleString())}</div>
          <div className="sub">{stat(summary?.rps, (n) => n.toFixed(2))} avg rps</div>
        </div>
        <div
          className="kpi"
          title="Every request that did not come back 2xx/3xx, minus the deliberately-invalid slice that is supposed to be rejected. A gateway answering 401 or 429 to everything shows 100% here."
        >
          <div className="label">Failure rate ({range.label})</div>
          <div className={`value ${summary === undefined ? "" : summary.unexpectedFailurePct > 2 ? "err" : "ok"}`}>
            {stat(summary?.unexpectedFailurePct, (n) => `${n.toFixed(2)}%`)}
          </div>
          <div className="sub">
            {st === undefined
              ? "—"
              : `${st.clientErrors.toLocaleString()} × 4xx · ${st.serverErrors.toLocaleString()} × 5xx · ${st.networkErrors.toLocaleString()} no-response`}
          </div>
        </div>
        <div
          className="kpi"
          title="Failures the gateway itself produced: 502 (no healthy upstream), 503 (overloaded / circuit open), 504 (upstream timed out) and outright connection failures. Distinct from a backend 500, which the gateway merely relayed."
        >
          <div className="label">Gateway faults ({range.label})</div>
          <div className={`value ${st === undefined ? "" : st.gatewayErrors > 0 ? "err" : "ok"}`}>
            {stat(st?.gatewayErrors, (n) => n.toLocaleString())}
          </div>
          <div className="sub">
            {st === undefined
              ? "—"
              : `${st.rateLimited.toLocaleString()} rate-limited · ${st.unauthorized.toLocaleString()} unauthorized`}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Latency p50/p95/p99 ({range.label})</div>
          <div className="value" style={{ fontSize: 15 }}>
            {stat(summary?.latencyMs.p50, fmtMs)} / {stat(summary?.latencyMs.p95, fmtMs)} / {stat(summary?.latencyMs.p99, fmtMs)}
          </div>
          <div className="sub">max {stat(summary?.latencyMs.max, fmtMs)}</div>
        </div>
        <div
          className="kpi"
          title="Requests deliberately violating the published OpenAPI/WSDL contract. Only a rejection the GATEWAY produced counts: a response carrying the SUT's X-Server-Ms header proves the request got all the way through, so the gateway did not validate it — whatever the backend then did about it."
        >
          <div className="label">Blocked by gateway</div>
          <div className={`value ${contract === undefined || noGateway || contractMoot ? "" : contract.leakedToBackend > 0 ? "err" : "ok"}`}>
            {contract === undefined
              ? "—"
              : noGateway || contractMoot
                ? "n/a"
                : contract.invalidSent === 0
                  ? "no probes"
                  : `${((100 * contract.rejectedByGateway) / Math.max(1, contract.invalidSent)).toFixed(0)}%`}
          </div>
          <div className="sub">
            {contract === undefined
              ? "—"
              : noGateway
                ? "no gateway in the path — pointed at the built-in petstore"
                : contractMoot
                  ? "gateway is rejecting everything — fix that before reading this"
                  : `${contract.invalidSent.toLocaleString()} invalid sent · ${contract.leakedToBackend.toLocaleString()} reached the backend`}
          </div>
        </div>
      </div>

      {/* ---------- Status distribution ---------- */}
      {st && st.buckets.length > 0 && (
        <div
          className="strip"
          title="What the target actually answered. 502/503/504 and no-response are the gateway's own faults; 500 is the backend's, merely relayed."
        >
          {st.buckets.map((b) => (
            <div className="sitem" key={b.bucket}>
              <span>{b.bucket === "net" ? "no response" : b.bucket}</span>
              <b style={{ color: statusColor(b.bucket) }}>{b.count.toLocaleString()}</b>
            </div>
          ))}
        </div>
      )}

      {/* ---------- Host strip: is the app itself the bottleneck? ---------- */}
      {sys && (
        <div className="strip" title="Resources of the machine this tester runs on — high CPU or loop delay here means the app, not the gateway, is throttling the run">
          <div className="sitem">
            <span>CPU (app)</span>
            <b style={{ color: (sys.current.cpuProcessPct ?? 0) > 85 ? "var(--err)" : undefined }}>
              {stat(sys.current.cpuProcessPct ?? undefined, (n) => `${n.toFixed(0)}%`)}
            </b>
          </div>
          <div className="sitem">
            <span>Memory (host)</span>
            <b>{fmtBytes(sys.current.memUsedBytes)} / {fmtBytes(sys.current.memTotalBytes)}</b>
          </div>
          <div className="sitem">
            <span>Loop p99</span>
            <b style={{ color: (sys.current.eventLoopP99ms ?? 0) > 100 ? "var(--err)" : undefined }}>
              {stat(sys.current.eventLoopP99ms ?? undefined, (n) => `${n.toFixed(1)} ms`)}
            </b>
          </div>
          {/* The generator's own scheduler, when the Go worker is generating.
              That is the clock the measurements are read on, so it — not the
              loop above — is what the validity verdict gates on. */}
          {validity?.workerSchedP99MsMax != null && (
            <div className="sitem" title="Worst 2-second window's goroutine scheduling latency at p99, inside the load generator. Added to every measured TTFB without being added to the backend's own clock.">
              <span>Generator sched p99</span>
              <b style={{ color: validity.workerSchedP99MsMax > VALIDITY_LIMITS.workerSchedP99Ms ? "var(--err)" : undefined }}>
                {validity.workerSchedP99MsMax.toFixed(2)} ms
              </b>
            </div>
          )}
          <div className="sitem">
            <span>App ⇅</span>
            <b>{fmtBytes(sys.current.appInBps)}/s in · {fmtBytes(sys.current.appOutBps)}/s out</b>
          </div>
        </div>
      )}

      {/* ---------- Range tabs ---------- */}
      <div className="range-tabs">
        {RANGES.map((r) => (
          <button key={r.label} className={r.label === range.label ? "active" : ""} onClick={() => setRange(r)}>
            {r.label}
          </button>
        ))}
        <div className="spacer" />
        {seriesQ.data?.truncated && <span className="hint">range clipped to the retained window</span>}
        {seriesQ.isFetching && <span className="hint">updating…</span>}
      </div>

      {/* ---------- Charts grid ---------- */}
      <div className="grid-2">
        <div className="section">
          <h2>Non-backend time — ttfb − serverMs − connectMs, all traffic</h2>
          <Panel height={240}>
            {({ width, height }) => (
              <AreaChart width={width} height={height} data={points}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis stroke="#8b949e" fontSize={11} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }} formatter={(v: number) => fmtMs(v)} />
                <Legend />
                <Area type="monotone" dataKey="nonBackendP50" stroke="#3fb950" fillOpacity={0.12} fill="#3fb950" name="p50" />
                <Area type="monotone" dataKey="nonBackendP95" stroke="#d29922" fillOpacity={0.15} fill="#d29922" name="p95" />
                <Area type="monotone" dataKey="nonBackendP99" stroke="#f85149" fillOpacity={0.12} fill="#f85149" name="p99" />
              </AreaChart>
            )}
          </Panel>
        </div>

        <div className="section">
          <h2>Total latency (through GW, vs SUT baseline)</h2>
          <Panel height={240}>
            {({ width, height }) => (
              <AreaChart width={width} height={height} data={points}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis stroke="#8b949e" fontSize={11} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }} formatter={(v: number) => fmtMs(v)} />
                <Legend />
                <Area type="monotone" dataKey="p50" stroke="#58a6ff" fillOpacity={0.1} fill="#58a6ff" name="p50 through GW" />
                <Area type="monotone" dataKey="p99" stroke="#f85149" fillOpacity={0.12} fill="#f85149" name="p99 through GW" />
              </AreaChart>
            )}
          </Panel>
        </div>
      </div>

      <div className="grid-2">
        <div className="section">
          <h2>Failures by kind + volume</h2>
          <Panel height={180}>
            {({ width, height }) => (
              <LineChart width={width} height={height} data={points}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis yAxisId="l" stroke="#8b949e" fontSize={11} />
                <YAxis yAxisId="r" orientation="right" stroke="#8b949e" fontSize={11} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }} />
                <Legend />
                {/* split on purpose: a gateway that starts rate-limiting or
                    rejecting credentials moves the 4xx line while the 5xx line
                    stays flat — one chart, two very different diagnoses */}
                <Line yAxisId="l" type="monotone" dataKey="gatewayErrors" stroke="#f85149" dot={false} name="gateway faults" />
                <Line yAxisId="l" type="monotone" dataKey="errors" stroke="#db6d28" dot={false} name="5xx + no response" />
                <Line yAxisId="l" type="monotone" dataKey="clientErrors" stroke="#d29922" dot={false} name="4xx" />
                <Line yAxisId="r" type="monotone" dataKey="rps" stroke="#58a6ff" dot={false} name="rps" />
              </LineChart>
            )}
          </Panel>
        </div>

        <div className="section">
          <h2>Bytes transferred (through GW, KB/bucket)</h2>
          <Panel height={180}>
            {({ width, height }) => (
              <BarChart width={width} height={height} data={points}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis stroke="#8b949e" fontSize={11} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }} formatter={(v: number) => `${v.toFixed(1)} KB`} />
                <Bar dataKey="bytesKb" fill="#3fb950" radius={[3, 3, 0, 0]} name="resp KB" />
              </BarChart>
            )}
          </Panel>
        </div>
      </div>

      {/* ---------- Host load ---------- */}
      <div className="grid-2">
        <div className="section">
          <h2>Host CPU (% of machine capacity)</h2>
          <Panel height={180}>
            {({ width, height }) => (
              <AreaChart width={width} height={height} data={sysPoints}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis stroke="#8b949e" fontSize={11} domain={[0, 100]} unit="%" />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }} formatter={(v: number) => `${v.toFixed(1)}%`} />
                <Legend />
                <Area type="monotone" dataKey="cpuProcessPct" stroke="#58a6ff" fillOpacity={0.12} fill="#58a6ff" name="app process" />
                <Area type="monotone" dataKey="cpuSystemPct" stroke="#8b949e" fillOpacity={0.08} fill="#8b949e" name="whole host" />
              </AreaChart>
            )}
          </Panel>
        </div>

        <div className="section">
          <h2>Host memory (GB) · app traffic (B/s)</h2>
          <Panel height={180}>
            {({ width, height }) => (
              <AreaChart width={width} height={height} data={sysPoints}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis yAxisId="l" stroke="#8b949e" fontSize={11} />
                <YAxis yAxisId="r" orientation="right" stroke="#8b949e" fontSize={11} tickFormatter={(v: number) => fmtBytes(v)} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }}
                         formatter={(v: number, name: string) => (name.includes("GB") ? `${v.toFixed(2)} GB` : `${fmtBytes(v)}/s`)} />
                <Legend />
                <Area yAxisId="l" type="monotone" dataKey="memUsedGb" stroke="#d29922" fillOpacity={0.12} fill="#d29922" name="mem used (GB)" />
                <Area yAxisId="r" type="monotone" dataKey="appOutBps" stroke="#3fb950" fillOpacity={0.08} fill="#3fb950" name="app out" />
                <Area yAxisId="r" type="monotone" dataKey="appInBps" stroke="#58a6ff" fillOpacity={0.08} fill="#58a6ff" name="app in" />
              </AreaChart>
            )}
          </Panel>
        </div>
      </div>

      {/* ---------- API definitions ---------- */}
      <div className="section">
        <h2>API definitions — import these into your gateway</h2>
        <p className="hint">
          The load driver generates traffic that conforms to these documents, so you can switch request
          and response validation on. Advertised servers: REST <span className="mono">{defsQ.data?.serverUrl ?? gw.rest.baseUrl}</span>
          {" · "}SOAP <span className="mono">{defsQ.data?.serverUrlSoap ?? gw.soap.baseUrl}</span>
        </p>
        <div className="form-row">
          <button onClick={() => void grab("/api/definitions/openapi.json", "apigw-tester-openapi.json")}>
            Download OpenAPI (JSON)
          </button>
          <button onClick={() => void grab("/api/definitions/openapi.yaml", "apigw-tester-openapi.yaml")}>
            Download OpenAPI (YAML)
          </button>
          <button onClick={() => void grab("/api/definitions/petservice.wsdl", "petservice.wsdl")}>
            Download WSDL
          </button>
          {downloadNote && <span className="hint" style={{ alignSelf: "center" }}>{downloadNote}</span>}
        </div>
      </div>

      {/* ---------- Gateway policy checks ---------- */}
      <div className="section">
        <h2>
          Gateway policies{" "}
          <span className="hint">
            — does the gateway actually <em>enforce</em> anything, or is it only proxying?
          </span>
        </h2>
        <p className="hint">
          Deliberate single probes with a stated expectation, run every{" "}
          {policyQ.data?.config.intervalSec ?? "—"}s. <strong>not enforced</strong> means the policy is
          demonstrably not configured — information, not a defect, unless you mark it required in
          Configure. Whether the response carried the SUT&apos;s fingerprint is what separates
          &ldquo;the gateway stopped it&rdquo; from &ldquo;the backend did&rdquo;.
          {noGateway && " No gateway is configured, so these describe the built-in petstore."}
        </p>
        <div className="form-row" style={{ marginBottom: 10 }}>
          <button onClick={() => policyMut.mutate()} disabled={policyMut.isPending}>
            {policyMut.isPending ? "Probing…" : "Run policy checks now"}
          </button>
          {policyNote && <span className="hint" style={{ alignSelf: "center" }}>{policyNote}</span>}
        </div>
        <table>
          <thead>
            <tr><th>Policy</th><th>Result</th><th>Status</th><th>Detail</th><th>Checked</th></tr>
          </thead>
          <tbody>
            {(policyQ.data?.results ?? []).map((p) => (
              <tr key={p.id}>
                <td>
                  {p.label}
                  {policyQ.data?.config.required.includes(p.id) && (
                    <span className="hint"> · required</span>
                  )}
                  <div className="hint mono" style={{ fontSize: 11 }}>{p.probe}</div>
                </td>
                <td><span className={`badge ${policyBadge(p.state)}`}>{POLICY_LABEL[p.state]}</span></td>
                <td className="mono">{p.status ?? "—"}</td>
                <td className="hint">{p.detail}</td>
                <td className="hint">{new Date(p.checkedAt).toLocaleTimeString()}</td>
              </tr>
            ))}
            {(policyQ.data?.results.length ?? 0) === 0 && (
              <tr><td colSpan={5} className="hint">No policy probes have run yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---------- Per stress-class ---------- */}
      <div className="section">
        <h2>Per stress class — how the GW handles each traffic pattern ({range.label} window)</h2>
        <table>
          <thead>
            <tr>
              <th>Class</th><th>Calls</th><th>Err %</th><th>4xx</th><th>GW faults</th>
              <th>Latency p50</th><th>Latency p95</th><th>Latency p99</th>
              <th className="accent" title="ttfb − serverMs − connectMs for this class alone: everything the request spent outside the backend, network included. This is the number to compare between runs — unlike the headline tile, it is not diluted by the profile's class mix.">Non-backend p50</th>
              <th className="accent">p95</th><th className="accent">p99</th><th className="accent">mean</th>
              <th>avg req</th><th>avg resp</th>
            </tr>
          </thead>
          <tbody>
            {(summary?.perClass ?? []).map((c) => (
              <tr key={c.cls}>
                <td><span className={`badge ${c.cls.replace("-", "")}`}>{c.cls}</span></td>
                <td>{c.total.toLocaleString()}</td>
                <td style={{ color: c.errorPct > 2 ? "var(--err)" : undefined }}>{c.errorPct.toFixed(1)}%</td>
                {/* 4xx is expected for the invalid class and a red flag anywhere else */}
                <td style={{ color: c.clientErrors > 0 && c.cls !== "invalid" ? "var(--warn, #d29922)" : undefined }}>
                  {c.clientErrors.toLocaleString()}
                </td>
                <td style={{ color: c.gatewayErrors > 0 ? "var(--err)" : undefined }}>
                  {c.gatewayErrors.toLocaleString()}
                </td>
                <td>{fmtMs(c.latencyMs.p50)}</td>
                <td>{fmtMs(c.latencyMs.p95)}</td>
                <td>{fmtMs(c.latencyMs.p99)}</td>
                <td className="accent-cell">{fmtMs(c.nonBackendMs.p50)}</td>
                <td className="accent-cell">{fmtMs(c.nonBackendMs.p95)}</td>
                <td className="accent-cell">{fmtMs(c.nonBackendMs.p99)}</td>
                <td className="accent-cell">
                  {fmtMs(c.nonBackendMs.avg)}
                  <small className="hint"> · {c.nonBackendMs.count.toLocaleString()} of {c.total.toLocaleString()} measured</small>
                </td>
                <td>{fmtBytes(c.avgBytesReq)}</td>
                <td>{fmtBytes(c.avgBytesResp)}</td>
              </tr>
            ))}
            {(summary?.perClass.length ?? 0) === 0 && (
              <tr><td colSpan={14} className="hint">No traffic yet — start a run.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---------- Per-endpoint ---------- */}
      <div className="section">
        <h2>Per endpoint — {range.label} window</h2>
        <table>
          <thead>
            <tr><th>Protocol</th><th>Endpoint</th><th>Requests</th><th>Errors</th><th>Err %</th><th>rps</th><th>p50</th><th>p95</th><th>avg bytes</th></tr>
          </thead>
          <tbody>
            {(summary?.perEndpoint ?? []).slice(0, 15).map((e) => (
              <tr key={`${e.protocol}-${e.endpoint}`}>
                <td><span className={`badge ${e.protocol}`}>{e.protocol}</span></td>
                <td className="mono">{e.endpoint}</td>
                <td>{e.total.toLocaleString()}</td>
                <td>{e.errors}</td>
                <td style={{ color: e.errorPct > 2 ? "var(--err)" : undefined }}>{e.errorPct.toFixed(1)}%</td>
                <td>{e.rps.toFixed(2)}</td>
                <td>{fmtMs(e.p50)}</td>
                <td>{fmtMs(e.p95)}</td>
                <td>{fmtBytes(e.avgRespBytes)}</td>
              </tr>
            ))}
            {(summary?.perEndpoint.length ?? 0) === 0 && (
              <tr><td colSpan={9} className="hint">No traffic yet — start a run.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---------- Recent requests ---------- */}
      <div className="section">
        <h2>
          Recent requests{" "}
          <span className="hint">
            [ {(["", "rest", "soap"] as const).map((p) => (
              <button key={p} type="button" className="linklike"
                      aria-pressed={recentProto === p}
                      onClick={() => setRecentProto(p)}
                      style={{ color: recentProto === p ? "var(--accent)" : "inherit", marginLeft: 8 }}>
                {p || "all"}
              </button>
            ))} ]
          </span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Request id</th><th>Proto</th><th>Method</th><th>Endpoint</th>
              <th>Status</th><th>Answered by</th><th>Latency</th><th>TTFB</th><th>Body</th>
              <th title="ttfb − serverMs for this one request: everything that was not the backend. Not the gateway's cost on its own — it also carries the hop to the gateway and back. This is the raw pair of clocks; the headline figure additionally subtracts each request's connection setup, which is not recorded on this row.">Non-backend</th>
              <th>Resp</th><th>Error</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td className="mono">{new Date(r.ts).toLocaleTimeString()}</td>
                {/* the full id is on the title so it can be copied and grepped
                    straight out of the gateway's access log or trace backend */}
                <td className="mono hint" title={r.requestId || "not recorded"}>
                  {r.requestId ? r.requestId.slice(0, 8) : "—"}
                </td>
                <td><span className={`badge ${r.protocol}`}>{r.protocol}</span></td>
                <td className="mono">{r.method}</td>
                <td className="mono">{r.endpoint}</td>
                <td>
                  <span className={`badge ${r.status === 0 ? "err" : r.status >= 500 ? "err" : r.status >= 400 ? "warn" : "ok"}`}>
                    {r.status === 0 ? "NET" : r.status}
                  </span>
                </td>
                {/* X-Server-Ms on the response is the backend's fingerprint:
                    "gateway" here means the response never reached the SUT */}
                <td className="hint">{r.reachedBackend ? "backend" : "gateway"}</td>
                <td>{fmtMs(r.latencyMs)}</td>
                <td>{r.ttfbMs === null || r.ttfbMs === undefined ? "—" : fmtMs(r.ttfbMs)}</td>
                <td className="hint">{r.ttfbMs === null || r.ttfbMs === undefined ? "—" : fmtMs(Math.max(0, r.latencyMs - r.ttfbMs))}</td>
                <td title={r.serverMs == null ? "no backend timing on this response" : undefined}>
                  {r.ttfbMs == null || r.serverMs == null ? "—" : fmtMs(r.ttfbMs - r.serverMs)}
                </td>
                <td>{fmtBytes(r.bytesResp)}</td>
                <td className="hint">{r.error ?? ""}</td>
              </tr>
            ))}
            {recent.length === 0 && <tr><td colSpan={13} className="hint">Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* ---------- Run history ---------- */}
      <div className="section">
        <h2>Run history</h2>
        <table>
          <thead>
            <tr>
              <th>Run</th><th>Started</th><th>Duration</th><th>Mode</th>
              <th>Verdict</th><th>Report</th>
            </tr>
          </thead>
          <tbody>
            {(runsQ.data ?? []).map((r: RunEvent) => (
              <tr key={r.id}>
                <td className="mono">{r.runId}</td>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
                <td>{fmtDuration(((r.stoppedAt ?? Date.now()) - r.startedAt) / 1000)}</td>
                <td>
                  {r.profile?.mode ?? "—"}
                  <span className="hint">
                    {r.profile ? ` · ${r.profile.soapRatioPct}% SOAP · ${r.profile.invalidRatioPct}% invalid` : ""}
                  </span>
                </td>
                <td>
                  {verdicts[r.runId] === "loading" ? (
                    <span className="hint">checking…</span>
                  ) : verdicts[r.runId] ? (
                    (() => {
                      const v = verdicts[r.runId] as { state: VerdictState; reasons: string[] };
                      // the reasons are the whole value of a verdict: "inconclusive"
                      // on its own tells you nothing you can act on
                      const why = v.reasons.length > 0
                        ? v.reasons.join("\n")
                        : v.state === "pass" ? "Every configured threshold held." : undefined;
                      return (
                        <span className={`badge ${v.state === "pass" ? "ok" : v.state === "fail" ? "err" : "warn"}`} title={why}>
                          {VERDICT_LABEL[v.state]}
                        </span>
                      );
                    })()
                  ) : (
                    <button className="linklike" type="button" onClick={() => void loadVerdict(r.runId)}>
                      check
                    </button>
                  )}
                </td>
                <td>
                  <button className="linklike" type="button"
                          onClick={() => void grab(`/api/runs/${encodeURIComponent(r.runId)}/report.md`, `${r.runId}-report.md`)}>
                    Markdown
                  </button>
                  {" · "}
                  <button className="linklike" type="button"
                          onClick={() => void grab(`/api/runs/${encodeURIComponent(r.runId)}/report`, `${r.runId}-report.json`)}>
                    JSON
                  </button>
                </td>
              </tr>
            ))}
            {(runsQ.data?.length ?? 0) === 0 && <tr><td colSpan={6} className="hint">No runs recorded yet.</td></tr>}
          </tbody>
        </table>
        <div className="form-row" style={{ marginTop: 12 }}>
          <label htmlFor="prune-days" className="hint" style={{ alignSelf: "center" }}>Delete runs older than</label>
          <input id="prune-days" type="number" min={1} max={3650} value={pruneDays}
                 onChange={(e) => setPruneDays(e.target.value)} style={{ width: 70 }} />
          <span className="hint" style={{ alignSelf: "center" }}>days</span>
          <button className="danger" disabled={pruneMut.isPending}
                  onClick={() => {
                    const days = Number(pruneDays);
                    if (!Number.isFinite(days) || days < 1) { setActionError("enter how many days of run history to keep"); return; }
                    pruneMut.mutate(days);
                  }}>
            {pruneMut.isPending ? "Pruning…" : "Prune old runs"}
          </button>
          <button className="danger" disabled={running || resetMut.isPending}
                  title={running ? "stop the run first — its buffered results would be re-inserted after the reset" : undefined}
                  onClick={() => {
                    if (window.confirm("Delete ALL metrics (raw requests, roll-ups and run history)? Gateway and profile settings are kept.")) {
                      resetMut.mutate();
                    }
                  }}>
            {resetMut.isPending ? "Resetting…" : "Reset all metrics"}
          </button>
        </div>
      </div>

      {drawerOpen && (
        <ConfigDrawer
          gw={gw as GwTargets}
          profile={profile as LoadProfile}
          onClose={() => {
            setDrawerOpen(false);
            void qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}
