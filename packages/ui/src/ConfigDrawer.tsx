import { Fragment, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "./api";
import type { GwConfig, LoadProfile, LoadMode, ScenarioWeights } from "./api";
import { sanitizeGwConfig, sanitizeLoadProfile, validateGwConfig } from "@apigw/shared";

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
  { key: "placeOrder", label: "Place order" }
];

type NumKey = "rps" | "rampFrom" | "rampTo" | "rampMinutes" | "spikeBase" | "spikePeak"
  | "spikeEveryMinutes" | "spikeDurationSeconds" | "sineMin" | "sineMax"
  | "maxConcurrency" | "soapRatioPct" | "invalidRatioPct";

/** raw text per numeric field, so clearing one doesn't silently commit 0 */
type Drafts = Partial<Record<string, string>>;

interface NumFieldProps {
  id: string;
  label: string;
  k: NumKey;
  min?: number;
  max?: number;
  step?: number;
  fallback: number;
  profile: LoadProfile;
  drafts: Drafts;
  setProfile: Dispatch<SetStateAction<LoadProfile>>;
  setDrafts: Dispatch<SetStateAction<Drafts>>;
}

/**
 * Controlled numeric input that keeps your keystrokes but never commits junk.
 *
 * Declared at module scope on purpose. A component defined inside ConfigDrawer is
 * a fresh function identity on every render, so React would treat it as a new
 * element type, unmount the <input> and drop focus after every keystroke — which
 * made these fields typeable one digit at a time.
 */
function NumField({ id, label, k, min, max, step, fallback, profile, drafts, setProfile, setDrafts }: NumFieldProps) {
  const committed = (profile[k] as number | undefined) ?? fallback;
  const value = drafts[k] ?? String(committed);
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(step !== undefined ? { step } : {})}
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          setDrafts((d) => ({ ...d, [k]: raw }));
          const n = Number(raw);
          // empty or unparsable: hold the previous committed value
          if (raw.trim() === "" || !Number.isFinite(n)) return;
          const clamped = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, n));
          setProfile((prev) => ({ ...prev, [k]: clamped }));
        }}
        onBlur={() => setDrafts((d) => { const { [k]: _drop, ...rest } = d; return rest; })}
      />
    </>
  );
}

export default function ConfigDrawer({ gw, profile, onClose }: Props) {
  const [g, setG] = useState<GwConfig>({ ...gw });
  const [p, setP] = useState<LoadProfile>({ ...profile });
  const [drafts, setDrafts] = useState<Drafts>({});
  const [testState, setTestState] = useState<{ ok?: boolean; note?: string; busy?: boolean }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  /** the four wiring props every NumField needs, so the call sites stay readable */
  const numProps = { profile: p, drafts, setProfile: setP, setDrafts };

  const saveGw = useMutation({ mutationFn: (cfg: GwConfig) => api.saveGateway(cfg) });
  const saveProfile = useMutation({ mutationFn: (prof: LoadProfile) => api.saveProfile(prof) });

  // Escape closes; focus starts inside the dialog rather than behind it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    drawerRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const problem = validateGwConfig(g);
      if (problem) { setSaveError(problem); return; }
      // clamp client-side with the same rules the server applies, so what the
      // drawer shows after saving is what actually runs
      const cleanGw = sanitizeGwConfig(g, gw);
      const cleanProfile = sanitizeLoadProfile(p, profile);
      await saveGw.mutateAsync(cleanGw);
      await saveProfile.mutateAsync(cleanProfile);
      onClose();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** The server does the probing — see api.testGateway for why it can't be the browser. */
  async function handleTest() {
    const problem = validateGwConfig(g);
    if (problem) { setTestState({ ok: false, note: problem }); return; }
    setTestState({ busy: true, note: "probing…" });
    try {
      const r = await api.testGateway(sanitizeGwConfig(g, gw));
      if (r.ok) setTestState({ ok: true, note: `${r.status} from ${r.url} in ${r.latencyMs} ms` });
      else if (r.status !== undefined) setTestState({ ok: false, note: `HTTP ${r.status} from ${r.url}` });
      else setTestState({ ok: false, note: `${r.url}: ${r.error ?? "unreachable"}` });
    } catch (e) {
      setTestState({ ok: false, note: (e as Error).message });
    }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Configuration" tabIndex={-1}>
        <h2>Configuration</h2>

        <h3>API Gateway</h3>
        <div className="form-grid">
          <label htmlFor="gw-base">Base URL</label>
          <input id="gw-base" value={g.baseUrl} onChange={(e) => setG({ ...g, baseUrl: e.target.value })}
                 placeholder="https://gw.example.com" />
          <label htmlFor="gw-key">API key</label>
          <input id="gw-key" value={g.apiKey} type="password" autoComplete="off"
                 onChange={(e) => setG({ ...g, apiKey: e.target.value })}
                 placeholder="leave empty for no-auth" />
          <label htmlFor="gw-key-header">API key header</label>
          <input id="gw-key-header" value={g.apiKeyHeader} onChange={(e) => setG({ ...g, apiKeyHeader: e.target.value })}
                 placeholder="X-API-Key" />
          <label htmlFor="gw-prefix">Path prefix</label>
          <input id="gw-prefix" value={g.pathPrefix} onChange={(e) => setG({ ...g, pathPrefix: e.target.value })}
                 placeholder="/v1" />
        </div>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button onClick={() => void handleTest()} disabled={testState.busy === true}>
            {testState.busy === true ? "Testing…" : "Test connection"}
          </button>
          <span className={`hint ${testState.ok === false ? "err" : ""}`} style={{ alignSelf: "center" }}>
            {testState.note ?? ""}
          </span>
        </div>
        <p className="hint">
          The probe runs from the server against <span className="mono">{"{base URL}{path prefix}/health"}</span>,
          using the same credentials and API-key header the load driver will send.
        </p>

        <h3>Load profile</h3>
        <div className="form-grid">
          <label htmlFor="mode">Mode</label>
          <select id="mode" value={p.mode} onChange={(e) => setP({ ...p, mode: e.target.value as LoadMode })}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <p className="hint">{MODES.find((m) => m.value === p.mode)?.help}</p>

        <div className="form-grid">
          {p.mode === "constant" && (
            <NumField id="rps" label="Requests / sec" k="rps" min={0} max={10_000} step={0.1} fallback={10} {...numProps} />
          )}
          {p.mode === "ramp" && (
            <>
              <NumField id="rampFrom" label="From rps" k="rampFrom" min={0} max={10_000} fallback={1} {...numProps} />
              <NumField id="rampTo" label="To rps" k="rampTo" min={0} max={10_000} fallback={100} {...numProps} />
              <NumField id="rampMinutes" label="Duration (minutes)" k="rampMinutes" min={0.1} max={10080} fallback={10} {...numProps} />
            </>
          )}
          {p.mode === "spike" && (
            <>
              <NumField id="spikeBase" label="Base rps" k="spikeBase" min={0} max={10_000} fallback={5} {...numProps} />
              <NumField id="spikePeak" label="Peak rps" k="spikePeak" min={0} max={10_000} fallback={100} {...numProps} />
              <NumField id="spikeEvery" label="Spike every (min)" k="spikeEveryMinutes" min={0.1} max={10080} fallback={10} {...numProps} />
              <NumField id="spikeDur" label="Spike duration (sec)" k="spikeDurationSeconds" min={1} max={86400} fallback={30} {...numProps} />
            </>
          )}
          {p.mode === "sine-daily" && (
            <>
              <NumField id="sineMin" label="Min rps (night)" k="sineMin" min={0} max={10_000} fallback={2} {...numProps} />
              <NumField id="sineMax" label="Max rps (day)" k="sineMax" min={0} max={10_000} fallback={50} {...numProps} />
            </>
          )}
          {p.mode === "real" && (
            <>
              <NumField id="realRps" label="Base rps (daytime target)" k="rps" min={0} max={10_000} step={0.5} fallback={25} {...numProps} />
              <p className="hint" style={{ gridColumn: "1 / -1", margin: "4px 0 0" }}>
                Actual RPS = base × day curve (9am + 3pm peaks, lunch dip, ~8× quieter at night) ×
                slow drift (0.6–1.8×, 3-minute mean-revert) × ±20% jitter. Each run starts at a
                random time-of-day so consecutive runs don&apos;t align.
              </p>
            </>
          )}

          <NumField id="maxConc" label="Max concurrency" k="maxConcurrency" min={1} max={5000} fallback={25} {...numProps} />
          <NumField id="soapPct" label="SOAP traffic %" k="soapRatioPct" min={0} max={100} fallback={25} {...numProps} />
          <NumField id="invalidPct" label="Invalid traffic %" k="invalidRatioPct" min={0} max={100} fallback={2} {...numProps} />
        </div>
        <p className="hint">
          <strong>Invalid traffic %</strong> is the slice deliberately violating the published OpenAPI/WSDL
          contract (bad enums, wrong types, missing required fields, malformed XML). Keep it small — it exists
          so you can confirm your gateway&apos;s content validation actually rejects it. The rest of the load
          is always contract-valid.
        </p>

        <h3>Scenario mix (weights)</h3>
        <p className="hint">Relative weights across the REST operations. They do not need to add up to 100.</p>
        <div className="form-grid">
          {SCEN_LABELS.map(({ key, label }) => (
            <Fragment key={key}>
              <label htmlFor={`w-${key}`}>{label}</label>
              <input id={`w-${key}`} type="number" min={0} max={1_000_000}
                     value={drafts[`w-${key}`] ?? String(p.scenarioWeights[key])}
                     onChange={(e) => {
                       const raw = e.target.value;
                       setDrafts((d) => ({ ...d, [`w-${key}`]: raw }));
                       const n = Number(raw);
                       if (raw.trim() === "" || !Number.isFinite(n)) return;
                       setP((prev) => ({
                         ...prev,
                         scenarioWeights: { ...prev.scenarioWeights, [key]: Math.max(0, n) }
                       }));
                     }}
                     onBlur={() => setDrafts((d) => { const { [`w-${key}`]: _drop, ...rest } = d; return rest; })} />
            </Fragment>
          ))}
        </div>

        {saveError && <div className="banner err" role="alert" style={{ marginTop: 16 }}>{saveError}</div>}

        <div className="form-row" style={{ marginTop: 24 }}>
          <button className="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Apply (hot-reload)"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Apply persists the settings and the load generator picks them up immediately. Values outside the
          supported range are clamped rather than rejected.
        </p>
      </div>
    </>
  );
}
