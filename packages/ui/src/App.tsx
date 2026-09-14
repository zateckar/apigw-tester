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
import type { GwTargets, LoadProfile, RunEvent } from "./api";
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

/** long windows are much more expensive to compute — poll them less often */
const pollFor = (w: SummaryWindow): number => (w === "24h" || w === "7d" ? 30_000 : 5_000);

function errorOf(...queries: UseQueryResult<unknown, Error>[]): string | null {
  for (const q of queries) if (q.isError && q.error) return q.error.message;
  return null;
}

/** Render a number, or an em-dash when the data genuinely isn't there — so a
 *  failed fetch never renders as a healthy-looking zero. */
function stat(value: number | undefined, render: (n: number) => string): string {
  return value === undefined || !Number.isFinite(value) ? "—" : render(value);
}

export default function App() {
  const qc = useQueryClient();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1] as (typeof RANGES)[number]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recentProto, setRecentProto] = useState<"" | "rest" | "soap">("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);

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
  const recentQ = useQuery({ queryKey: ["recent"], queryFn: () => api.recent(150), refetchInterval: 5_000 });
  const runsQ = useQuery({ queryKey: ["runs"], queryFn: api.runs, refetchInterval: 30_000 });
  const defsQ = useQuery({ queryKey: ["definitions"], queryFn: api.definitions, refetchInterval: false });

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

  // memoized chart data so every poll produces a stable reference
  const points = useMemo(() => {
    const bucket = seriesQ.data?.bucketSec ?? 60;
    // hourly buckets need the date, or a week of data shows 24 repeating labels
    const fmt: Intl.DateTimeFormatOptions = bucket >= 3600
      ? { month: "short", day: "numeric", hour: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" };
    return (seriesQ.data?.points ?? []).map((p) => ({
      ...p,
      t: new Date(p.ts).toLocaleString([], fmt),
      restRps: p.restTotal / bucket,
      soapRps: p.soapTotal / bucket,
      bytesKb: p.bytesResp / 1024
    }));
  }, [seriesQ.data]);

  const recent = (recentQ.data?.items ?? []).filter(
    (r) => !recentProto || r.protocol === recentProto
  ).slice(0, 80);

  const contract = summary?.contract;

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

      {/* ---------- KPIs ---------- */}
      <div className="kpis">
        <div className="kpi" style={{ borderColor: "var(--accent)" }}>
          <div className="label">GW overhead ({range.label})</div>
          <div className="value" style={{ color: "var(--accent)" }}>
            {stat(summary?.overheadMs.p95, fmtMs)}
          </div>
          <div className="sub">
            p95 · p50 {stat(summary?.overheadMs.p50, fmtMs)} · p99 {stat(summary?.overheadMs.p99, fmtMs)}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Live RPS</div>
          <div className="value">{stat(status?.targetRps, (n) => n.toFixed(1))}</div>
          <div className="sub">target · {profile.mode}</div>
        </div>
        <div className="kpi">
          <div className="label">Requests ({range.label})</div>
          <div className="value">{stat(summary?.total, (n) => n.toLocaleString())}</div>
          <div className="sub">{stat(summary?.rps, (n) => n.toFixed(2))} avg rps</div>
        </div>
        <div className="kpi">
          <div className="label">Error rate ({range.label})</div>
          <div className={`value ${summary === undefined ? "" : summary.errorPct > 2 ? "err" : "ok"}`}>
            {stat(summary?.errorPct, (n) => `${n.toFixed(2)}%`)}
          </div>
          <div className="sub">{stat(summary?.errors, (n) => n.toLocaleString())} errors</div>
        </div>
        <div className="kpi">
          <div className="label">Latency p50/p95/p99 ({range.label})</div>
          <div className="value" style={{ fontSize: 15 }}>
            {stat(summary?.latencyMs.p50, fmtMs)} / {stat(summary?.latencyMs.p95, fmtMs)} / {stat(summary?.latencyMs.p99, fmtMs)}
          </div>
          <div className="sub">max {stat(summary?.latencyMs.max, fmtMs)}</div>
        </div>
        <div className="kpi" title="Requests deliberately violating the published OpenAPI/WSDL contract, and whether the gateway rejected them">
          <div className="label">Contract validation</div>
          <div className={`value ${contract === undefined ? "" : contract.wronglyAccepted > 0 ? "err" : "ok"}`}>
            {contract === undefined
              ? "—"
              : contract.invalidSent === 0
                ? "no probes"
                : `${((100 * contract.rejected4xx) / Math.max(1, contract.invalidSent)).toFixed(0)}% blocked`}
          </div>
          <div className="sub">
            {contract === undefined
              ? "—"
              : `${contract.invalidSent.toLocaleString()} invalid sent · ${contract.wronglyAccepted.toLocaleString()} wrongly accepted`}
          </div>
        </div>
      </div>

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
          <h2>GW overhead (ms / bucket) — what the gateway adds</h2>
          <Panel height={240}>
            {({ width, height }) => (
              <AreaChart width={width} height={height} data={points}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis stroke="#8b949e" fontSize={11} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }} formatter={(v: number) => fmtMs(v)} />
                <Legend />
                <Area type="monotone" dataKey="overheadP50" stroke="#3fb950" fillOpacity={0.12} fill="#3fb950" name="p50" />
                <Area type="monotone" dataKey="overheadP95" stroke="#d29922" fillOpacity={0.15} fill="#d29922" name="p95" />
                <Area type="monotone" dataKey="overheadP99" stroke="#f85149" fillOpacity={0.12} fill="#f85149" name="p99" />
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
          <h2>Error rate + volume (throughput)</h2>
          <Panel height={180}>
            {({ width, height }) => (
              <LineChart width={width} height={height} data={points}>
                <CartesianGrid stroke="#2d333b" strokeDasharray="3 3" />
                <XAxis dataKey="t" stroke="#8b949e" fontSize={11} minTickGap={40} />
                <YAxis yAxisId="l" stroke="#8b949e" fontSize={11} />
                <YAxis yAxisId="r" orientation="right" stroke="#8b949e" fontSize={11} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #2d333b" }} />
                <Line yAxisId="l" type="monotone" dataKey="errors" stroke="#f85149" dot={false} name="errors/bucket" />
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

      {/* ---------- Per stress-class ---------- */}
      <div className="section">
        <h2>Per stress class — how the GW handles each traffic pattern ({range.label} window)</h2>
        <table>
          <thead>
            <tr>
              <th>Class</th><th>Calls</th><th>Err %</th>
              <th>Latency p50</th><th>Latency p95</th><th>Latency p99</th>
              <th className="accent">GW OH p50</th><th className="accent">GW OH p95</th><th className="accent">GW OH p99</th><th className="accent">GW OH avg</th>
              <th>avg req</th><th>avg resp</th>
            </tr>
          </thead>
          <tbody>
            {(summary?.perClass ?? []).map((c) => (
              <tr key={c.cls}>
                <td><span className={`badge ${c.cls.replace("-", "")}`}>{c.cls}</span></td>
                <td>{c.total.toLocaleString()}</td>
                <td style={{ color: c.errorPct > 2 ? "var(--err)" : undefined }}>{c.errorPct.toFixed(1)}%</td>
                <td>{fmtMs(c.latencyMs.p50)}</td>
                <td>{fmtMs(c.latencyMs.p95)}</td>
                <td>{fmtMs(c.latencyMs.p99)}</td>
                <td className="accent-cell">{fmtMs(c.overheadMs.p50)}</td>
                <td className="accent-cell">{fmtMs(c.overheadMs.p95)}</td>
                <td className="accent-cell">{fmtMs(c.overheadMs.p99)}</td>
                <td className="accent-cell">{fmtMs(c.overheadMs.avg)}</td>
                <td>{fmtBytes(c.avgBytesReq)}</td>
                <td>{fmtBytes(c.avgBytesResp)}</td>
              </tr>
            ))}
            {(summary?.perClass.length ?? 0) === 0 && (
              <tr><td colSpan={12} className="hint">No traffic yet — start a run.</td></tr>
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
            <tr><th>Time</th><th>Proto</th><th>Method</th><th>Endpoint</th><th>Status</th><th>Latency</th><th>Resp</th><th>Error</th></tr>
          </thead>
          <tbody>
            {recent.map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td className="mono">{new Date(r.ts).toLocaleTimeString()}</td>
                <td><span className={`badge ${r.protocol}`}>{r.protocol}</span></td>
                <td className="mono">{r.method}</td>
                <td className="mono">{r.endpoint}</td>
                <td>
                  <span className={`badge ${r.status === 0 ? "warn" : r.status >= 500 ? "err" : r.status >= 400 ? "warn" : "ok"}`}>
                    {r.status === 0 ? "NET" : r.status}
                  </span>
                </td>
                <td>{fmtMs(r.latencyMs)}</td>
                <td>{fmtBytes(r.bytesResp)}</td>
                <td className="hint">{r.error ?? ""}</td>
              </tr>
            ))}
            {recent.length === 0 && <tr><td colSpan={8} className="hint">Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* ---------- Run history ---------- */}
      <div className="section">
        <h2>Run history</h2>
        <table>
          <thead>
            <tr><th>Run</th><th>Started</th><th>Stopped</th><th>Duration</th><th>Mode</th><th>Concurrency</th><th>SOAP %</th><th>Invalid %</th></tr>
          </thead>
          <tbody>
            {(runsQ.data ?? []).map((r: RunEvent) => (
              <tr key={r.id}>
                <td className="mono">{r.runId}</td>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
                <td>{r.stoppedAt ? new Date(r.stoppedAt).toLocaleString() : "…"}</td>
                <td>{fmtDuration(((r.stoppedAt ?? Date.now()) - r.startedAt) / 1000)}</td>
                <td>{r.profile?.mode ?? "—"}</td>
                <td>{r.profile?.maxConcurrency ?? "—"}</td>
                <td>{r.profile ? `${r.profile.soapRatioPct}%` : "—"}</td>
                <td>{r.profile?.invalidRatioPct != null ? `${r.profile.invalidRatioPct}%` : "—"}</td>
              </tr>
            ))}
            {(runsQ.data?.length ?? 0) === 0 && <tr><td colSpan={8} className="hint">No runs recorded yet.</td></tr>}
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
