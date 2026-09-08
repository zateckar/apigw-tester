import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Panel
} from "./Panel";
import { api, fmtBytes, fmtDuration, fmtMs, DEFAULT_GW, DEFAULT_PROFILE } from "./api";
import type { GwConfig, LoadProfile, RunEvent } from "./api";
import ConfigDrawer from "./ConfigDrawer";

const RANGES = [
  { label: "15m", hours: 0.25, summary: "5m" },
  { label: "1h", hours: 1, summary: "1h" },
  { label: "6h", hours: 6, summary: "1h" },
  { label: "24h", hours: 24, summary: "24h" },
  { label: "7d", hours: 24 * 7, summary: "24h" }
] as const;

export default function App() {
  const qc = useQueryClient();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recentProto, setRecentProto] = useState<"" | "rest" | "soap">("");

  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gwQ = useQuery({ queryKey: ["gw"], queryFn: api.gateway });
  const profileQ = useQuery({ queryKey: ["profile"], queryFn: api.profile });
  const summaryQ = useQuery({
    queryKey: ["summary", range.summary],
    queryFn: () => api.summary(range.summary)
  });
  const seriesQ = useQuery({
    queryKey: ["series", range.hours],
    queryFn: () => api.timeseries(range.hours)
  });
  const recentQ = useQuery({ queryKey: ["recent"], queryFn: () => api.recent(150) });
  const runsQ = useQuery({ queryKey: ["runs"], queryFn: api.runs });

  const startMut = useMutation({
    mutationFn: api.startRun,
    onSuccess: () => void qc.invalidateQueries()
  });
  const stopMut = useMutation({
    mutationFn: api.stopRun,
    onSuccess: () => void qc.invalidateQueries()
  });

  const status = statusQ.data;
  const summary = summaryQ.data;
  const running = status?.state === "running";
  const gw = gwQ.data ?? status?.gateway ?? DEFAULT_GW;
  const profile = profileQ.data ?? status?.profile ?? DEFAULT_PROFILE;

  // memoized chart data so every poll produces a stable reference
  const points = useMemo(() => {
    const bucket = seriesQ.data?.bucketSec ?? 60;
    return (seriesQ.data?.points ?? []).map((p) => ({
      ...p,
      t: new Date(p.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      restRps: p.restTotal / bucket,
      soapRps: p.soapTotal / bucket,
      bytesKb: p.bytesResp / 1024
    }));
  }, [seriesQ.data]);

  const recent = (recentQ.data?.items ?? []).filter(
    (r) => !recentProto || r.protocol === recentProto
  ).slice(0, 80);

  return (
    <div className="app">
      {/* ---------- Top bar ---------- */}
      <div className="topbar">
        <div className="brand">
          <h1>API GW Tester</h1>
          <span className="state">
            <span className={`dot ${running ? "running" : status?.state ?? "idle"}`} />
            {status?.state ?? "loading"}
            {status?.runId ? ` · ${status.runId}` : ""}
            {status?.uptimeSec != null ? ` · up ${fmtDuration(status.uptimeSec)}` : ""}
          </span>
          <span className="hint mono" title="Gateway base URL">
            {gw.baseUrl}{gw.pathPrefix || ""}
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

      {/* ---------- KPIs ---------- */}
      <div className="kpis">
        <div className="kpi" style={{ borderColor: "var(--accent)" }}>
          <div className="label">GW overhead (window)</div>
          <div className="value" style={{ color: "var(--accent)" }}>
            {fmtMs(summary?.overheadMs.p95 ?? 0)}
          </div>
          <div className="sub">p95 · p50 {fmtMs(summary?.overheadMs.p50 ?? 0)} · p99 {fmtMs(summary?.overheadMs.p99 ?? 0)}</div>
        </div>
        <div className="kpi">
          <div className="label">Live RPS</div>
          <div className="value">{(status?.targetRps ?? 0).toFixed(1)}</div>
          <div className="sub">target · {profile.mode}</div>
        </div>
        <div className="kpi">
          <div className="label">Requests ({range.label})</div>
          <div className="value">{(summary?.total ?? 0).toLocaleString()}</div>
          <div className="sub">{(summary?.rps ?? 0).toFixed(2)} avg rps</div>
        </div>
        <div className="kpi">
          <div className="label">Error rate</div>
          <div className={`value ${(summary?.errorPct ?? 0) > 2 ? "err" : "ok"}`}>
            {(summary?.errorPct ?? 0).toFixed(2)}%
          </div>
          <div className="sub">{(summary?.errors ?? 0).toLocaleString()} errors</div>
        </div>
        <div className="kpi">
          <div className="label">Total latency p50/p95/p99</div>
          <div className="value" style={{ fontSize: 15 }}>
            {fmtMs(summary?.latencyMs.p50 ?? 0)} / {fmtMs(summary?.latencyMs.p95 ?? 0)} / {fmtMs(summary?.latencyMs.p99 ?? 0)}
          </div>
          <div className="sub">max {fmtMs(summary?.latencyMs.max ?? 0)}</div>
        </div>
        <div className="kpi">
          <div className="label">Resp throughput</div>
          <div className="value">{fmtBytes(summary?.bytes.respPerSec ?? 0)}/s</div>
          <div className="sub">total {fmtBytes(summary?.bytes.resp ?? 0)}</div>
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

      {/* ---------- Per stress-class ---------- */}
      <div className="section">
        <h2>Per stress class — how the GW handles each traffic pattern ({range.summary} window)</h2>
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
        <h2>Per endpoint — {range.summary} window</h2>
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
            [ {["", "rest", "soap"].map((p) => (
              <a key={p} onClick={() => setRecentProto(p as typeof recentProto)}
                 style={{ cursor: "pointer", color: recentProto === p ? "var(--accent)" : "inherit", marginLeft: 8 }}>
                {p || "all"}
              </a>
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
            <tr><th>Run</th><th>Started</th><th>Stopped</th><th>Duration</th><th>Mode</th><th>Concurrency</th><th>SOAP %</th></tr>
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
              </tr>
            ))}
            {(runsQ.data?.length ?? 0) === 0 && <tr><td colSpan={7} className="hint">No runs recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {drawerOpen && (
        <ConfigDrawer
          gw={gw as GwConfig}
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
