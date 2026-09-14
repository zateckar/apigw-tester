import { Fragment, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type {
  ForwardBasicAuth, GwConfig, GwTargets, LoadProfile, LoadMode, PolicyConfig, PolicyId,
  Protocol, ScenarioWeights, SloThresholds
} from "./api";
import {
  DEFAULT_POLICY_CONFIG, DEFAULT_SLO,
  sanitizeGwConfig, sanitizeGwTargets, sanitizeLoadProfile, sanitizePolicyConfig, sanitizeSlo,
  validateGwConfig, validateGwTargets
} from "@apigw/shared";

interface Props {
  gw: GwTargets;
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
  | "maxConcurrency" | "soapRatioPct" | "invalidRatioPct" | "durationMinutes";

const POLICY_LABELS: { id: PolicyId; label: string }[] = [
  { id: "auth-bad-key", label: "Rejects an invalid API key" },
  { id: "auth-no-key", label: "Rejects a request with no credential" },
  { id: "rate-limit", label: "Enforces a rate limit" },
  { id: "payload-limit", label: "Caps oversized request bodies" },
  { id: "upstream-timeout", label: "Times out a hanging upstream" },
  { id: "cache", label: "Serves a repeated GET from cache" },
  { id: "unknown-route", label: "Refuses an undeclared route" },
  { id: "cors-preflight", label: "Answers a CORS preflight" }
];

/** A threshold input where clearing the box means "do not assert this",
 *  which is a different thing from asserting zero. */
function SloField(
  { id, label, unit, value, onChange }:
  { id: string; label: string; unit: string; value: number | null; onChange: (v: number | null) => void }
) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" min={0} step="any" placeholder="not asserted"
             value={value === null ? "" : String(value)}
             onChange={(e) => {
               const raw = e.target.value;
               if (raw.trim() === "") return onChange(null);
               const n = Number(raw);
               onChange(Number.isFinite(n) ? Math.max(0, n) : null);
             }}
             aria-describedby={`${id}-unit`} />
      <span id={`${id}-unit`} className="hint" style={{ gridColumn: "1 / -1", marginTop: -6 }}>{unit}</span>
    </>
  );
}

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

interface GwTargetSectionProps {
  idPrefix: Protocol;
  label: string;
  cfg: GwConfig;
  fallback: GwConfig;
  onChange: (next: GwConfig) => void;
  testState: { ok?: boolean; note?: string; busy?: boolean };
  setTestState: Dispatch<SetStateAction<Record<Protocol, { ok?: boolean; note?: string; busy?: boolean }>>>;
}

/**
 * One protocol's gateway target. Module-scope for the same reason as NumField:
 * a component re-created inside ConfigDrawer would remount its inputs on every
 * keystroke and steal focus.
 */
function GwTargetSection({ idPrefix, label, cfg, fallback, onChange, testState, setTestState }: GwTargetSectionProps) {
  /** The server does the probing — see api.testGateway for why it can't be the browser. */
  async function handleTest() {
    const problem = validateGwConfig(cfg);
    if (problem) { setTestState((s) => ({ ...s, [idPrefix]: { ok: false, note: problem } })); return; }
    setTestState((s) => ({ ...s, [idPrefix]: { busy: true, note: "probing…" } }));
    try {
      const r = await api.testGateway(sanitizeGwConfig(cfg, fallback), idPrefix);
      // a 401/403 is ambiguous unless you know whether we sent a credential
      const authNote = (r.status === 401 || r.status === 403)
        ? r.sentBasicAuth
          ? " — our Basic credential was rejected"
          : " — no Basic credential was sent (forwarding is off for this target)"
        : "";
      setTestState((s) => ({
        ...s,
        [idPrefix]: r.ok
          ? { ok: true, note: `${r.status} from ${r.url} in ${r.latencyMs} ms` }
          : r.status !== undefined
            ? { ok: false, note: `HTTP ${r.status} from ${r.url}${authNote}` }
            : { ok: false, note: `${r.url}: ${r.error ?? "unreachable"}` }
      }));
    } catch (e) {
      setTestState((s) => ({ ...s, [idPrefix]: { ok: false, note: (e as Error).message } }));
    }
  }

  return (
    <>
      <h3>{label}</h3>
      <div className="form-grid">
        <label htmlFor={`${idPrefix}-gw-base`}>Base URL</label>
        <input id={`${idPrefix}-gw-base`} value={cfg.baseUrl} onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value })}
               placeholder="https://gw.example.com" />
        <label htmlFor={`${idPrefix}-gw-key`}>API key</label>
        <input id={`${idPrefix}-gw-key`} value={cfg.apiKey} type="password" autoComplete="off"
               onChange={(e) => onChange({ ...cfg, apiKey: e.target.value })}
               placeholder="leave empty for no-auth" />
        <label htmlFor={`${idPrefix}-gw-key-header`}>API key header</label>
        <input id={`${idPrefix}-gw-key-header`} value={cfg.apiKeyHeader} onChange={(e) => onChange({ ...cfg, apiKeyHeader: e.target.value })}
               placeholder="X-API-Key" />
        <label htmlFor={`${idPrefix}-gw-prefix`}>Path prefix</label>
        <input id={`${idPrefix}-gw-prefix`} value={cfg.pathPrefix} onChange={(e) => onChange({ ...cfg, pathPrefix: e.target.value })}
               placeholder="/v1" />
        <label htmlFor={`${idPrefix}-gw-fwd`}>Send our Basic credential</label>
        <select id={`${idPrefix}-gw-fwd`} value={cfg.forwardBasicAuth}
                onChange={(e) => onChange({ ...cfg, forwardBasicAuth: e.target.value as ForwardBasicAuth })}>
          <option value="auto">Auto — only to the built-in petstore</option>
          <option value="always">Always — the gateway expects it</option>
          <option value="never">Never</option>
        </select>
      </div>
      <p className="hint">
        This rig&apos;s own dashboard credential. <strong>Auto</strong> sends it only when the target is this
        process (the bundled petstore, which requires it); an external gateway gets nothing, so your admin
        password never lands in a third party&apos;s access log and the gateway&apos;s own auth is not confused
        by a header it did not ask for. Pick <strong>Always</strong> only if the gateway is configured to
        accept or pass through the same credential.
      </p>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button onClick={() => void handleTest()} disabled={testState.busy === true}>
          {testState.busy === true ? "Testing…" : "Test connection"}
        </button>
        <span className={`hint ${testState.ok === false ? "err" : ""}`} style={{ alignSelf: "center" }}>
          {testState.note ?? ""}
        </span>
      </div>
    </>
  );
}

export default function ConfigDrawer({ gw, profile, onClose }: Props) {
  const [g, setG] = useState<GwTargets>({ rest: { ...gw.rest }, soap: { ...gw.soap } });
  const [p, setP] = useState<LoadProfile>({ ...profile });
  const [drafts, setDrafts] = useState<Drafts>({});
  // these two are not passed down as props: they are edited only here, so the
  // drawer fetches them on open rather than making the dashboard hold them
  const sloQ = useQuery({ queryKey: ["slo"], queryFn: api.slo });
  const policyQ = useQuery({ queryKey: ["policy"], queryFn: api.policy });
  const [slo, setSlo] = useState<SloThresholds>(DEFAULT_SLO);
  const [policy, setPolicy] = useState<PolicyConfig>(DEFAULT_POLICY_CONFIG);
  // adopt the server's values once they land, without clobbering later edits
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !sloQ.data || !policyQ.data) return;
    adopted.current = true;
    setSlo(sloQ.data);
    setPolicy(policyQ.data.config);
  }, [sloQ.data, policyQ.data]);
  const [testStates, setTestStates] = useState<Record<Protocol, { ok?: boolean; note?: string; busy?: boolean }>>({
    rest: {},
    soap: {}
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  /** the four wiring props every NumField needs, so the call sites stay readable */
  const numProps = { profile: p, drafts, setProfile: setP, setDrafts };

  const saveGw = useMutation({ mutationFn: (cfg: GwTargets) => api.saveGateway(cfg) });
  const saveProfile = useMutation({ mutationFn: (prof: LoadProfile) => api.saveProfile(prof) });
  const saveSlo = useMutation({ mutationFn: (s: SloThresholds) => api.saveSlo(s) });
  const savePolicy = useMutation({ mutationFn: (c: PolicyConfig) => api.savePolicy(c) });

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
      const problem = validateGwTargets(g);
      if (problem) { setSaveError(problem); return; }
      // clamp client-side with the same rules the server applies, so what the
      // drawer shows after saving is what actually runs
      const cleanGw = sanitizeGwTargets(g, gw);
      const cleanProfile = sanitizeLoadProfile(p, profile);
      await saveGw.mutateAsync(cleanGw);
      await saveProfile.mutateAsync(cleanProfile);
      await saveSlo.mutateAsync(sanitizeSlo(slo, slo));
      await savePolicy.mutateAsync(sanitizePolicyConfig(policy, policy));
      onClose();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Configuration" tabIndex={-1}>
        <h2>Configuration</h2>

        <GwTargetSection idPrefix="rest" label="API Gateway — REST"
                         cfg={g.rest} fallback={gw.rest}
                         onChange={(next) => setG((prev) => ({ ...prev, rest: next }))}
                         testState={testStates.rest} setTestState={setTestStates} />
        <GwTargetSection idPrefix="soap" label="API Gateway — SOAP"
                         cfg={g.soap} fallback={gw.soap}
                         onChange={(next) => setG((prev) => ({ ...prev, soap: next }))}
                         testState={testStates.soap} setTestState={setTestStates} />
        <p className="hint">
          REST and SOAP traffic may be fronted at different gateway URLs and keys. The probe runs from the
          server against <span className="mono">{"{base URL}{path prefix}/health"}</span>, using the same
          credentials and API-key header the load driver will send.
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
          <NumField id="durationMin" label="Stop after (minutes)" k="durationMinutes" min={0} max={10080} fallback={0} {...numProps} />
        </div>
        <p className="hint">
          <strong>Stop after</strong> ends the run automatically so you can collect a report for a
          bounded window — 0 means run until stopped by hand. An acceptance test wants a fixed
          window; an always-on rig does not.
        </p>
        <p className="hint">
          <strong>Max concurrency</strong> acts as a ceiling on in-flight requests: throughput can never exceed
          it ÷ mean latency. When it would throttle the configured target rate, the driver raises it automatically
          (to target rate × 5s, at most 5000) and warns if even the raised cap saturates.
        </p>
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

        <h3>Pass / fail thresholds</h3>
        <p className="hint">
          What a run has to achieve to count as a pass. Leave a box empty to not assert it at all.
          A run whose window fails the validity gate — generator saturated, or load shed — comes back
          <strong> inconclusive</strong> rather than pass or fail: the numbers cannot carry a verdict.
        </p>
        <div className="form-grid">
          <SloField id="slo-fail" label="Max unexpected failures" unit="% of requests that did not return 2xx/3xx, excluding the deliberate invalid slice"
                    value={slo.maxUnexpectedFailurePct} onChange={(v) => setSlo({ ...slo, maxUnexpectedFailurePct: v })} />
          <SloField id="slo-gwerr" label="Max gateway faults" unit="% — 502/503/504 and outright connection failures"
                    value={slo.maxGatewayErrorPct} onChange={(v) => setSlo({ ...slo, maxGatewayErrorPct: v })} />
          <SloField id="slo-oh" label="Max GW overhead p95" unit="ms the gateway may add at the 95th percentile"
                    value={slo.maxOverheadP95Ms} onChange={(v) => setSlo({ ...slo, maxOverheadP95Ms: v })} />
          <SloField id="slo-leak" label="Max contract leaks" unit="contract violations the gateway may let reach the backend"
                    value={slo.maxLeakedToBackend} onChange={(v) => setSlo({ ...slo, maxLeakedToBackend: v })} />
        </div>

        <h3>Gateway policy checks</h3>
        <div className="form-grid">
          <label htmlFor="pol-enabled">Run policy probes</label>
          <input id="pol-enabled" type="checkbox" checked={policy.enabled}
                 onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })} />
          <label htmlFor="pol-interval">Every (seconds)</label>
          <input id="pol-interval" type="number" min={15} max={3600} value={String(policy.intervalSec)}
                 onChange={(e) => {
                   const n = Number(e.target.value);
                   if (Number.isFinite(n)) setPolicy({ ...policy, intervalSec: Math.min(3600, Math.max(15, n)) });
                 }} />
        </div>
        <p className="hint">
          Several probes are deliberately abusive (a concurrent burst, a multi-MB upload, a request
          that hangs for 10s) and hit the same gateway the load test is measuring — a tight cadence
          perturbs the very numbers you are collecting. Tick a policy below to assert your gateway
          <em> should</em> enforce it: then &ldquo;not enforced&rdquo; becomes a failure instead of an observation.
        </p>
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
          {POLICY_LABELS.map(({ id, label }) => (
            <label key={id} style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: "normal" }}>
              <input type="checkbox" checked={policy.required.includes(id)}
                     onChange={(e) => setPolicy({
                       ...policy,
                       required: e.target.checked
                         ? [...policy.required, id]
                         : policy.required.filter((p) => p !== id)
                     })} />
              <span>{label}</span>
            </label>
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
