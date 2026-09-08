import { Fragment, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "./api";
import type { GwConfig, LoadProfile, LoadMode, ScenarioWeights } from "./api";

interface Props {
  gw: GwConfig;
  profile: LoadProfile;
  onClose: () => void;
}

const MODES: { value: LoadMode; label: string; help: string }[] = [
  { value: "constant", label: "Constant", help: "Steady RPS all day long." },
  { value: "ramp", label: "Ramp", help: "Linear RPS ramp from A to B over N minutes." },
  { value: "spike", label: "Spike", help: "Periodic bursts: base RPS ↔ peak RPS every N minutes." },
  { value: "sine-daily", label: "Sine (day/night)", help: "24h sinusoid between sineMin and sineMax — mimics office-hours traffic." },
  { value: "real", label: "Realistic (mixed day)", help: "Workweek-like pattern: quiet early, peak mid-morning/evening, lunch dip; ±20 % per-minute jitter, gentle day-to-day drift, random phase. Driven by the base RPS you enter." }
];

const SCEN_LABELS: { key: keyof ScenarioWeights; label: string }[] = [
  { key: "listPets", label: "List pets" },
  { key: "getPet", label: "Get pet (+photo)" },
  { key: "createPet", label: "Create pet" },
  { key: "updatePet", label: "Update pet" },
  { key: "deletePet", label: "Delete pet" },
  { key: "placeOrder", label: "Place/get order" }
];

export default function ConfigDrawer({ gw, profile, onClose }: Props) {
  const [g, setG] = useState<GwConfig>({ ...gw });
  const [p, setP] = useState<LoadProfile>({ ...profile });
  const [testState, setTestState] = useState<{ ok?: boolean; note?: string }>({});

  const saveGw = useMutation({ mutationFn: () => api.saveGateway(g) });
  const saveProfile = useMutation({ mutationFn: () => api.saveProfile(p) });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await saveGw.mutateAsync();
      await saveProfile.mutateAsync();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestState({});
    try {
      // quick probe: ask metrics to store then hit status; deeper probing belongs to loadgen
      const res = await fetch(`${g.baseUrl.replace(/\/+$/, "")}/health`).catch(() => null);
      if (res && res.ok) setTestState({ ok: true, note: `200 from ${g.baseUrl}/health` });
      else if (res) setTestState({ ok: false, note: `HTTP ${res.status}` });
      else setTestState({ ok: false, note: "unreachable (note: from your browser, CORS may block non-GW hosts)" });
    } catch {
      setTestState({ ok: false, note: "unreachable" });
    }
  }

  const num = (v: number | undefined, d = 0): number => Number.isFinite(v) ? (v as number) : d;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <h2>Configuration</h2>

        <h3>API Gateway</h3>
        <div className="form-grid">
          <label>Base URL</label>
          <input value={g.baseUrl} onChange={(e) => setG({ ...g, baseUrl: e.target.value })}
                 placeholder="https://gw.example.com" />
          <label>API key</label>
          <input value={g.apiKey} type="password" onChange={(e) => setG({ ...g, apiKey: e.target.value })}
                 placeholder="leave empty for no-auth" />
          <label>API key header</label>
          <input value={g.apiKeyHeader} onChange={(e) => setG({ ...g, apiKeyHeader: e.target.value })}
                 placeholder="X-API-Key" />
          <label>Path prefix</label>
          <input value={g.pathPrefix} onChange={(e) => setG({ ...g, pathPrefix: e.target.value })}
                 placeholder="/v1" />
        </div>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button onClick={() => void handleTest()}>Test connection</button>
          <span className="hint" style={{ alignSelf: "center" }}>
            {testState.note ?? ""}
            {testState.ok === true ? "" : ""}
          </span>
        </div>

        <h3>Load profile</h3>
        <div className="form-grid">
          <label>Mode</label>
          <select value={p.mode} onChange={(e) => setP({ ...p, mode: e.target.value as LoadMode })}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <p className="hint">{MODES.find((m) => m.value === p.mode)?.help}</p>

        <div className="form-grid">
          {p.mode === "constant" && (
            <>
              <label>Requests / sec</label>
              <input type="number" min={0.1} step={0.1} value={num(p.rps, 10)}
                     onChange={(e) => setP({ ...p, rps: +e.target.value })} />
            </>
          )}
          {p.mode === "ramp" && (
            <>
              <label>From rps</label>
              <input type="number" value={num(p.rampFrom, 1)} onChange={(e) => setP({ ...p, rampFrom: +e.target.value })} />
              <label>To rps</label>
              <input type="number" value={num(p.rampTo, 100)} onChange={(e) => setP({ ...p, rampTo: +e.target.value })} />
              <label>Duration (minutes)</label>
              <input type="number" value={num(p.rampMinutes, 10)} onChange={(e) => setP({ ...p, rampMinutes: +e.target.value })} />
            </>
          )}
          {p.mode === "spike" && (
            <>
              <label>Base rps</label>
              <input type="number" value={num(p.spikeBase, 5)} onChange={(e) => setP({ ...p, spikeBase: +e.target.value })} />
              <label>Peak rps</label>
              <input type="number" value={num(p.spikePeak, 100)} onChange={(e) => setP({ ...p, spikePeak: +e.target.value })} />
              <label>Spike every (min)</label>
              <input type="number" value={num(p.spikeEveryMinutes, 10)} onChange={(e) => setP({ ...p, spikeEveryMinutes: +e.target.value })} />
              <label>Spike duration (sec)</label>
              <input type="number" value={num(p.spikeDurationSeconds, 30)} onChange={(e) => setP({ ...p, spikeDurationSeconds: +e.target.value })} />
            </>
          )}
          {p.mode === "sine-daily" && (
            <>
              <label>Min rps (night)</label>
              <input type="number" value={num(p.sineMin, 2)} onChange={(e) => setP({ ...p, sineMin: +e.target.value })} />
              <label>Max rps (day)</label>
              <input type="number" value={num(p.sineMax, 50)} onChange={(e) => setP({ ...p, sineMax: +e.target.value })} />
            </>
          )}
          {p.mode === "real" && (
            <>
              <label>Base rps (daytime target)</label>
              <input type="number" min={1} step={0.5} value={num(p.rps, 25)}
                     onChange={(e) => setP({ ...p, rps: +e.target.value })} />
              <label>Night-time floor (rps)</label>
              <input type="number" min={0} step={0.5} value={num(p.sineMin, Math.max(1, num(p.rps, 25) * 0.08))}
                     onChange={(e) => setP({ ...p, sineMin: +e.target.value })} />
              <p className="hint" style={{ gridColumn: "1 / -1", margin: "4px 0 0" }}>
                Actual RPS = base × day curve (9am + 3pm peaks, lunch dip, ~8× quieter at night) ×
                slow drift (0.6–1.8×, 3-minute mean-revert) × ±20% jitter. Each run starts at a
                random time-of-day so consecutive runs don't align.
              </p>
            </>
          )}

          <label>Max concurrency</label>
          <input type="number" min={1} value={num(p.maxConcurrency, 25)}
                 onChange={(e) => setP({ ...p, maxConcurrency: +e.target.value })} />

          <label>SOAP traffic %</label>
          <input type="number" min={0} max={100} value={num(p.soapRatioPct, 25)}
                 onChange={(e) => setP({ ...p, soapRatioPct: +e.target.value })} />
        </div>

        <h3>Scenario mix (weights)</h3>
        <div className="form-grid">
          {SCEN_LABELS.map(({ key, label }) => (
            <Fragment key={key}>
              <label>{label}</label>
              <input type="number" min={0} value={p.scenarioWeights[key]}
                     onChange={(e) =>
                       setP({ ...p, scenarioWeights: { ...p.scenarioWeights, [key]: Math.max(0, +e.target.value) } })
                     } />
            </Fragment>
          ))}
        </div>

        <div className="form-row" style={{ marginTop: 24 }}>
          <button className="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Apply (hot-reload)"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Apply persists the settings and the load generator picks them up within ~15s, or immediately if you submit via API.
        </p>
      </div>
    </>
  );
}
