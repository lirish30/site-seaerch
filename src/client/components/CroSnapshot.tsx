import { useId, useState } from "react";
import {
  BIZ_MODEL_KEYS, MODEL_SHORT, SCENARIO_LABEL, assumptionsToForm, customerJobsLine, effectiveModel, money, parseAssumptionsForm, parseScenarioForm, rebuildVisible, scenarioRange, scenarioToForm,
  type AssumptionOverrides, type AssumptionsForm, type BizModelKey, type CroAudit, type ScenarioField, type ScenarioForm, type ScenarioInputs,
} from "../cro";
import Icon from "./Icon";
import { Badge } from "./Score";

const TIERS = ["low", "medium", "high"] as const;
const CONFIDENCE_TONE = { high: "positive", medium: "warning", low: "critical" } as const;

type Fmt = "number" | "dollars" | "percent";
/** A text field that shows "2,000", "$775" or "2%" until you click into it, then the plain number you type and the form parses. */
function formatted(raw: string, fmt: Fmt): string {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return raw;
  const s = n.toLocaleString("en-US", { maximumFractionDigits: 20 });
  return fmt === "dollars" ? `$${s}` : fmt === "percent" ? `${raw.trim()}%` : s;
}
function NumInput({ value, fmt, onChange, disabled, label, mono = false }: { value: string; fmt: Fmt; onChange: (v: string) => void; disabled?: boolean; label?: string; mono?: boolean }) {
  const [focus, setFocus] = useState(false);
  return <input type="text" inputMode="decimal" className={mono ? "mono" : undefined} value={focus ? value : formatted(value, fmt)} disabled={disabled} aria-label={label}
    onFocus={(e) => { setFocus(true); const el = e.currentTarget; requestAnimationFrame(() => el.select()); }} onBlur={() => setFocus(false)} onChange={(e) => onChange(e.target.value)} />;
}

export function CroSnapshot({ audit, busy, rebuildOwed, onRebuild }: { audit: CroAudit; busy: boolean; rebuildOwed: boolean; onRebuild: (overrides: AssumptionOverrides) => void }) {
  const m = effectiveModel(audit);
  const [f, setF] = useState<AssumptionsForm | null>(m ? assumptionsToForm(m) : null);
  const [error, setError] = useState("");
  const jobId = useId(), errId = useId(), trafficId = useId();
  if (!m || !f) return null;
  const parsed = parseAssumptionsForm(f, m);
  const changed = rebuildVisible(parsed, rebuildOwed);
  const set = (p: Partial<AssumptionsForm>) => { setF({ ...f, ...p }); setError(""); };
  const rebuild = () => { if (parsed.ok) onRebuild(parsed.value); else setError(parsed.error); };
  return (
    <section className="section-card cro-snapshot" aria-label="How this business makes money">
      <header className="cro-card-head">
        <Icon name="briefcase" size={16} />
        <h3>How this business makes money</h3>
        <Badge tone={CONFIDENCE_TONE[m.confidence]} dot>{m.confidence[0].toUpperCase() + m.confidence.slice(1)} confidence</Badge>
        <span className="cro-grow" />
        <span className="cro-hint">Correct anything that’s wrong</span>
      </header>
      <div className="cro-card-body">
        <div className="cro-fields">
          <label><span className="cro-lbl">Business model</span>
            <span className="field"><select value={f.model} disabled={busy} onChange={(e) => set({ model: e.target.value as BizModelKey })}>
              {BIZ_MODEL_KEYS.map((k) => <option key={k} value={k}>{MODEL_SHORT[k]}</option>)}</select><Icon name="chevron-down" size={13} className="chev" /></span></label>
          <label><span className="cro-lbl">Main goal</span>
            <span className="field"><input value={f.primary} maxLength={200} disabled={busy} onChange={(e) => set({ primary: e.target.value })} /></span></label>
          <div role="group" aria-labelledby={jobId}>
            <span className="cro-lbl" id={jobId}>Typical job value</span>
            <span className="field cro-range">
              <NumInput value={f.low} fmt="dollars" disabled={busy} onChange={(v) => set({ low: v })} label="Typical job value, low" />
              <span className="cro-dash" aria-hidden="true">–</span>
              <NumInput value={f.high} fmt="dollars" disabled={busy} onChange={(v) => set({ high: v })} label="Typical job value, high" />
            </span>
          </div>
          <label><span className="cro-lbl">Sales cycle</span>
            <span className="field"><input value={f.cycle} maxLength={100} disabled={busy} onChange={(e) => set({ cycle: e.target.value })} /></span></label>
          <div role="radiogroup" aria-labelledby={trafficId}>
            <span className="cro-lbl" id={trafficId}>Website traffic</span>
            <span className="cro-seg">{TIERS.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={f.tier === t} disabled={busy} onClick={() => set({ tier: t })}>{t[0].toUpperCase() + t.slice(1)}</button>))}</span>
          </div>
        </div>
        {m.customer_jobs.length > 0 && <p className="cro-jobs"><b>Customers come here to</b>{customerJobsLine(m.customer_jobs)}</p>}
        {changed && <div className="cro-actions">
          <button className="btn primary" disabled={busy} aria-describedby={error ? errId : undefined} onClick={rebuild}>{busy ? "Rebuilding…" : "Rebuild roadmap"}</button>
          {!parsed.ok && !error && <span className="cro-hint">{parsed.error}</span>}
        </div>}
        {error && <p id={errId} className="cro-note err" role="alert">{error}</p>}
      </div>
    </section>
  );
}

const SCENARIO_FIELDS: readonly (readonly [ScenarioField, string, Fmt])[] = [
  ["visitors", "Visitors a month", "number"], ["currentRate", "Converting today", "percent"], ["targetRate", "After the changes", "percent"],
  ["closeRate", "Leads that buy", "percent"], ["dealValue", "Average job", "dollars"],
];

function ScenarioFigures({ inputs }: { inputs: ScenarioInputs }) {
  const r = scenarioRange(inputs);
  return (
    <div className="cro-big" aria-live="polite">
      <div><b>{r.leads[0]}–{r.leads[1]}</b><span>more leads a month</span></div>
      <div><b>{money(r.revenue[0])}–{money(r.revenue[1])}</b><span>in new business a month</span></div>
    </div>
  );
}

export function CroScenario({ audit, busy, onSave }: { audit: CroAudit; busy: boolean; onSave: (s: ScenarioInputs) => Promise<boolean> }) {
  const [f, setF] = useState<ScenarioForm | null>(audit.scenario_inputs ? scenarioToForm(audit.scenario_inputs) : null);
  const [note, setNote] = useState("");
  if (!f) return null;
  const parsed = parseScenarioForm(f);
  const edit = (k: ScenarioField, v: string) => { setF({ ...f, [k]: v }); setNote(""); };
  const save = async () => { if (parsed.ok) setNote((await onSave(parsed.value)) ? "Saved." : ""); };
  return (
    <section className="section-card cro-scenario" aria-label="What it could be worth">
      <header className="cro-card-head">
        <Icon name="trending" size={16} />
        <h3>What it could be worth</h3>
        <span className="cro-grow" />
        {note && <span className="cro-ok" role="status">{note}</span>}
        <button className="btn sm" onClick={save} disabled={busy || !parsed.ok}>{busy ? "Saving…" : "Save these assumptions"}</button>
      </header>
      <div className="cro-card-body">
        {parsed.ok ? <ScenarioFigures inputs={parsed.value} /> : <p className="cro-note err" role="alert">{parsed.error}</p>}
        <div className="cro-fields five">
          {SCENARIO_FIELDS.map(([k, label, fmt]) => (
            <label key={k}><span className="cro-lbl">{label}</span>
              <span className="field"><NumInput mono value={f[k]} fmt={fmt} onChange={(v) => edit(k, v)} /></span></label>
          ))}
        </div>
        <p className="cro-foot-note"><Icon name="info" size={13} />{SCENARIO_LABEL.replace("assumptions shown", "assumptions above")}. Never a promise. Low figure assumes half the lift.</p>
      </div>
    </section>
  );
}
