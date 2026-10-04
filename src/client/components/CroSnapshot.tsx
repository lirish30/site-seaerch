import { useId, useState } from "react";
import {
  BIZ_MODELS, BIZ_MODEL_KEYS, SCENARIO_LABEL, assumptionsToForm, effectiveModel, money, parseAssumptionsForm, parseScenarioForm, rebuildVisible, scenarioRange, scenarioToForm,
  type AssumptionOverrides, type AssumptionsForm, type BizModelKey, type CroAudit, type ScenarioForm, type ScenarioInputs,
} from "../cro";

const TIERS = ["low", "medium", "high"] as const;

export function CroSnapshot({ audit, busy, rebuildOwed, onRebuild }: { audit: CroAudit; busy: boolean; rebuildOwed: boolean; onRebuild: (overrides: AssumptionOverrides) => void }) {
  const m = effectiveModel(audit);
  const [f, setF] = useState<AssumptionsForm | null>(m ? assumptionsToForm(m) : null);
  const [error, setError] = useState("");
  const jobId = useId(), errId = useId();
  if (!m || !f) return null;
  const parsed = parseAssumptionsForm(f, m);
  const changed = rebuildVisible(parsed, rebuildOwed);
  const set = (p: Partial<AssumptionsForm>) => { setF({ ...f, ...p }); setError(""); };
  const rebuild = () => { if (parsed.ok) onRebuild(parsed.value); else setError(parsed.error); };
  return (
    <section className="card cro-snapshot" aria-label="How this business makes money">
      <h3>How this business makes money <span className="muted small">({m.confidence} confidence; correct anything that's wrong)</span></h3>
      <div className="cro-fields">
        <label>Business model<select value={f.model} disabled={busy} onChange={(e) => set({ model: e.target.value as BizModelKey })}>
          {BIZ_MODEL_KEYS.map((k) => <option key={k} value={k}>{BIZ_MODELS[k].label}</option>)}</select></label>
        <label>Main goal<input value={f.primary} maxLength={200} disabled={busy} onChange={(e) => set({ primary: e.target.value })} /></label>
        <div className="cro-field" role="group" aria-labelledby={jobId}>
          <span id={jobId}>Typical job value ($)</span>
          <span className="row nowrap">
            <input type="number" min={0} inputMode="decimal" value={f.low} disabled={busy} onChange={(e) => set({ low: e.target.value })} aria-label="Typical job value, low" />–
            <input type="number" min={0} inputMode="decimal" value={f.high} disabled={busy} onChange={(e) => set({ high: e.target.value })} aria-label="Typical job value, high" />
          </span>
        </div>
        <label>Sales cycle<input value={f.cycle} maxLength={100} disabled={busy} onChange={(e) => set({ cycle: e.target.value })} /></label>
        <label>Website traffic<select value={f.tier} disabled={busy} onChange={(e) => set({ tier: e.target.value as (typeof TIERS)[number] })}>
          {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      </div>
      {m.customer_jobs.length > 0 && <p className="muted small">Customers come here to: {m.customer_jobs.join("; ")}</p>}
      {changed && <div className="row">
        <button className="primary" disabled={busy} aria-describedby={error ? errId : undefined} onClick={rebuild}>{busy ? "Rebuilding…" : "Rebuild roadmap"}</button>
        {!parsed.ok && !error && <span className="muted small">{parsed.error}</span>}
      </div>}
      {error && <p id={errId} className="error small" role="alert">{error}</p>}
    </section>
  );
}

const SCENARIO_FIELDS: readonly (readonly [keyof ScenarioInputs, string, boolean])[] = [
  ["visitors", "Visitors a month", false], ["currentRate", "Converting today (%)", true], ["targetRate", "After the changes (%)", true],
  ["closeRate", "Leads that buy (%)", true], ["dealValue", "Average job ($)", false],
];

function ScenarioFigures({ inputs }: { inputs: ScenarioInputs }) {
  const r = scenarioRange(inputs);
  return <p className="cro-big" aria-live="polite">{r.leads[0]}–{r.leads[1]} more leads a month · {money(r.revenue[0])}–{money(r.revenue[1])} in new business</p>;
}

export function CroScenario({ audit, busy, onSave }: { audit: CroAudit; busy: boolean; onSave: (s: ScenarioInputs) => Promise<boolean> }) {
  const [f, setF] = useState<ScenarioForm | null>(audit.scenario_inputs ? scenarioToForm(audit.scenario_inputs) : null);
  const [note, setNote] = useState("");
  if (!f) return null;
  const parsed = parseScenarioForm(f);
  const edit = (k: keyof ScenarioInputs, v: string) => { setF({ ...f, [k]: v }); setNote(""); };
  const save = async () => { if (parsed.ok) setNote((await onSave(parsed.value)) ? "Saved." : ""); };
  return (
    <section className="card" aria-label="What it could be worth">
      <h3>What it could be worth</h3>
      {parsed.ok ? <ScenarioFigures inputs={parsed.value} /> : <p className="error small" role="alert">{parsed.error}</p>}
      <div className="cro-fields">
        {SCENARIO_FIELDS.map(([k, label, percent]) => (
          <label key={k}>{label}<input type="number" min={0} max={percent ? 100 : undefined} step={percent ? 0.1 : 1} inputMode="decimal" value={f[k]} onChange={(e) => edit(k, e.target.value)} /></label>
        ))}
      </div>
      <p className="muted small">{SCENARIO_LABEL}. Never a promise.</p>
      <div className="row">
        <button onClick={save} disabled={busy || !parsed.ok}>{busy ? "Saving…" : "Save these assumptions"}</button>
        {note && <span className="ok small" role="status">{note}</span>}
      </div>
    </section>
  );
}
