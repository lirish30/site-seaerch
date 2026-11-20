import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { ownerBadge } from "../projectView";
import { unsaved } from "../settingsData";
import { addPhase, addStep, movePhase, moveStep, parseEstimate, removePhase, removeStep, requiresChoices, setPhaseTitle, stepRows, templateProblems, totalEstimate } from "../sopView";
import { formatMinutes } from "../timeView";
import { PACKAGE_KEYS } from "../../worker/db/packages";
import { CADENCES, MILESTONE_KEYS, OWNER_LABEL, OWNER_TAGS, type Cadence, type MilestoneKey, type OwnerTag, type SopStep, type SopTemplate, type SopTemplateInput } from "../../worker/sop/model";

const MILESTONE_LABEL: Record<MilestoneKey, string> = { design_approved: "Design approved", site_finished: "Site finished" };
const CADENCE_LABEL: Record<Cadence, string> = { weekly: "Every week", monthly: "Every month", quarterly: "Every quarter", annual: "Every year" };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const words = (key: string) => key.replace(/_/g, " ");

const toInput = (t: SopTemplate): SopTemplateInput => ({ key: t.key, name: t.name, kind: t.kind, cadence: t.cadence, cadenceDay: t.cadenceDay, appliesTo: [...t.appliesTo], active: t.active, steps: t.steps.map((s) => ({ ...s, requires: [...s.requires] })) });
const blank = (): SopTemplateInput => ({ key: "", name: "", kind: "project", cadence: null, cadenceDay: null, appliesTo: [], active: true, steps: addPhase([]) });

/** One step: a row that opens into its fields. Everything typed here is text (a title, a done-when, a name); nothing is read as HTML. */
function StepCard({ step, others, first, last, onChange, onMove, onRemove }: {
  step: SopStep; others: SopStep[]; first: boolean; last: boolean; onChange: (patch: Partial<SopStep>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  const [est, setEst] = useState(() => (step.estMinutes > 0 ? formatMinutes(step.estMinutes) : "0"));
  const parsed = parseEstimate(est);
  const id = `sp-${step.key}`;
  const nullable = (v: string) => (v.trim() === "" ? null : v);
  return (
    <details className="sp-step">
      <summary>
        <span className="wk-key">{step.key}</span>
        <span className="sp-step-title">{step.title || "Untitled step"}</span>
        <span className="badge2">{ownerBadge(step.owner)}</span>
        <span className="muted small">{step.estMinutes > 0 ? formatMinutes(step.estMinutes) : "no estimate"}</span>
      </summary>
      <div className="sp-fields">
        <label className="deal-field" htmlFor={`${id}-title`}><span>Title</span>
          <input id={`${id}-title`} value={step.title} maxLength={120} onChange={(e) => onChange({ title: e.target.value })} /></label>
        <div className="sp-grid">
          <label className="deal-field" htmlFor={`${id}-owner`}><span>Who does it</span>
            <select id={`${id}-owner`} value={step.owner} onChange={(e) => onChange({ owner: e.target.value as OwnerTag })}>{OWNER_TAGS.map((o) => <option key={o} value={o}>{OWNER_LABEL[o]}</option>)}</select></label>
          <label className="deal-field" htmlFor={`${id}-est`}><span>Estimate (like 45m or 1h 30m)</span>
            <input id={`${id}-est`} value={est} aria-invalid={parsed === null} onChange={(e) => { setEst(e.target.value); const m = parseEstimate(e.target.value); if (m !== null) onChange({ estMinutes: m }); }} /></label>
          <label className="deal-field" htmlFor={`${id}-ms`}><span>Milestone this step marks</span>
            <select id={`${id}-ms`} value={step.milestone ?? ""} onChange={(e) => onChange({ milestone: (e.target.value || null) as MilestoneKey | null })}>
              <option value="">None</option>{MILESTONE_KEYS.map((m) => <option key={m} value={m}>{MILESTONE_LABEL[m]}</option>)}</select></label>
        </div>
        {parsed === null && <p className="warn small" role="alert">Estimate: use minutes or hours, like 45m or 1h 30m.</p>}
        <label className="deal-field" htmlFor={`${id}-done`}><span>Done when <small className="muted">{step.doneWhen.length} / 300</small></span>
          <textarea id={`${id}-done`} value={step.doneWhen} maxLength={300} rows={2} onChange={(e) => onChange({ doneWhen: e.target.value })} /></label>
        <label className="deal-field" htmlFor={`${id}-sum`}><span>What the client sees <small className="muted">{(step.clientSummary ?? "").length} / 80</small></span>
          <input id={`${id}-sum`} value={step.clientSummary ?? ""} maxLength={80} onChange={(e) => onChange({ clientSummary: nullable(e.target.value) })} /></label>
        <div className="sp-grid">
          <label className="deal-field" htmlFor={`${id}-doc`}><span>Linked document template</span>
            <input id={`${id}-doc`} value={step.docTemplate ?? ""} maxLength={80} onChange={(e) => onChange({ docTemplate: nullable(e.target.value) })} /></label>
          <label className="deal-field" htmlFor={`${id}-mail`}><span>Linked email template</span>
            <input id={`${id}-mail`} value={step.emailTemplate ?? ""} maxLength={80} onChange={(e) => onChange({ emailTemplate: nullable(e.target.value) })} /></label>
        </div>
        <label className="sp-check"><input type="checkbox" checked={step.skippable} onChange={(e) => onChange({ skippable: e.target.checked })} /><span>This step can be skipped, and steps after it still go ahead</span></label>
        <details className="sp-requires">
          <summary>Waits for {step.requires.length === 0 ? "no other step" : `${step.requires.length} other ${step.requires.length === 1 ? "step" : "steps"}`}</summary>
          {others.length === 0 ? <p className="muted small">There are no other steps yet.</p> : (
            <ul>
              {others.map((o) => (
                <li key={o.key}>
                  <label className="sp-check">
                    <input type="checkbox" checked={step.requires.includes(o.key)}
                      onChange={(e) => onChange({ requires: e.target.checked ? [...step.requires, o.key] : step.requires.filter((r) => r !== o.key) })} />
                    <span><span className="wk-key">{o.key}</span> {o.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </details>
        <div className="wk-task-actions">
          <button type="button" className="btn" disabled={first} onClick={() => onMove(-1)}>Move up</button>
          <button type="button" className="btn" disabled={last} onClick={() => onMove(1)}>Move down</button>
          <button type="button" className="btn" onClick={onRemove}>Remove step</button>
        </div>
      </div>
    </details>
  );
}

/**
 * The editor for one template: its name and kind, and its phases of steps. The problems the save would refuse are listed as you edit, so the Save button explains itself;
 * the server checks them again. Saving makes the next version, and a project already running keeps the steps it was started with.
 */
export default function SopEditor({ template, active, onSaved, onClose }: { template: SopTemplate | null; active: boolean; onSaved: (t: SopTemplate) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<SopTemplateInput>(() => (template ? toInput(template) : blank()));
  const baseline = useRef(JSON.stringify(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const isNew = template === null;
  const dirty = JSON.stringify(draft) !== baseline.current;
  const problems = templateProblems({ ...draft, active });
  const rows = stepRows(draft);

  // The Settings sidebar asks before leaving a page with edits that are not saved.
  useEffect(() => { unsaved.current = dirty; }, [dirty]);
  useEffect(() => () => { unsaved.current = false; }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const edit = (patch: Partial<SopTemplateInput>) => { setDraft((d) => ({ ...d, ...patch })); setError(""); setServerProblems([]); };
  const editSteps = (fn: (s: SopStep[]) => SopStep[]) => { setDraft((d) => ({ ...d, steps: fn(d.steps) })); setError(""); setServerProblems([]); };
  const patchStep = (key: string, patch: Partial<SopStep>) => editSteps((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const setKind = (kind: "project" | "recurring") => edit(kind === "project" ? { kind, cadence: null, cadenceDay: null } : { kind, cadence: draft.cadence ?? "weekly", cadenceDay: draft.cadenceDay ?? 1 });
  const setCadence = (cadence: Cadence) => {
    const day = draft.cadenceDay;
    if (cadence === "weekly") edit({ cadence, cadenceDay: day !== null && day >= 1 && day <= 7 ? day : 1 });
    else if (cadence === "monthly") edit({ cadence, cadenceDay: day !== null && day >= 1 && day <= 28 ? day : 1 });
    else edit({ cadence, cadenceDay: day !== null && day >= 1 && day <= 28 ? day : null });
  };

  const save = async () => {
    setBusy(true); setError(""); setServerProblems([]);
    try {
      const body: SopTemplateInput = { ...draft, active };
      const r = await api.put<{ template: SopTemplate }>(`/sops/${encodeURIComponent(draft.key)}`, body);
      baseline.current = JSON.stringify(draft);
      unsaved.current = false;
      onSaved(r.template);
    } catch (e) {
      const list = e instanceof ApiError ? (e.body as { problems?: unknown } | undefined)?.problems : undefined;
      if (Array.isArray(list) && list.every((p) => typeof p === "string") && list.length) setServerProblems(list as string[]);
      else setError(e instanceof Error ? e.message : "Couldn’t save the template.");
    } finally { setBusy(false); }
  };

  const close = () => { if (!dirty || window.confirm("You have unsaved changes. Close without saving?")) { unsaved.current = false; onClose(); } };
  const shown = [...problems, ...serverProblems.filter((p) => !problems.includes(p))];

  return (
    <section className="st-card sp-editor" aria-label={isNew ? "New template" : `Edit ${template.name}`}>
      <header>
        <div>
          <h2>{isNew ? "New template" : template.name}</h2>
          <p>{draft.steps.length} {draft.steps.length === 1 ? "step" : "steps"}, {totalEstimate(draft)}. {isNew ? "" : `Version ${template.version} now; saving makes version ${template.version + 1}.`}</p>
        </div>
        <button type="button" className="btn" onClick={close}>Close</button>
      </header>
      <div className="st-card-body sp-body">
        <p className="muted small">A project already running keeps the steps it started with. Saving changes the template for projects started from now on.</p>
        <div className="sp-grid">
          <label className="deal-field" htmlFor="sp-name"><span>Name</span><input id="sp-name" value={draft.name} maxLength={80} onChange={(e) => edit({ name: e.target.value })} /></label>
          <label className="deal-field" htmlFor="sp-key"><span>Key (letters, digits, dots and dashes)</span>
            <input id="sp-key" value={draft.key} maxLength={20} readOnly={!isNew} onChange={(e) => edit({ key: e.target.value.trim() })} /></label>
          <label className="deal-field" htmlFor="sp-kind"><span>Kind</span>
            <select id="sp-kind" value={draft.kind} onChange={(e) => setKind(e.target.value as "project" | "recurring")}><option value="project">A project, done once</option><option value="recurring">Recurring, on a cadence</option></select></label>
          {draft.kind === "recurring" && (
            <label className="deal-field" htmlFor="sp-cadence"><span>How often</span>
              <select id="sp-cadence" value={draft.cadence ?? "weekly"} onChange={(e) => setCadence(e.target.value as Cadence)}>{CADENCES.map((c) => <option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}</select></label>
          )}
          {draft.kind === "recurring" && draft.cadence === "weekly" && (
            <label className="deal-field" htmlFor="sp-day"><span>On</span>
              <select id="sp-day" value={draft.cadenceDay ?? 1} onChange={(e) => edit({ cadenceDay: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>
          )}
          {draft.kind === "recurring" && draft.cadence !== null && draft.cadence !== "weekly" && (
            <label className="deal-field" htmlFor="sp-dom"><span>Day of the month (1 to 28){draft.cadence === "monthly" ? "" : ", optional"}</span>
              <input id="sp-dom" inputMode="numeric" value={draft.cadenceDay ?? ""} onChange={(e) => { const v = e.target.value.trim(); edit({ cadenceDay: v === "" ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : draft.cadenceDay }); }} /></label>
          )}
        </div>
        <fieldset className="deal-field sp-applies">
          <legend>Used for these packages</legend>
          <div className="sp-applies-list">
            {PACKAGE_KEYS.map((k) => (
              <label key={k} className="sp-check">
                <input type="checkbox" checked={draft.appliesTo.includes(k)} onChange={(e) => edit({ appliesTo: e.target.checked ? [...draft.appliesTo, k] : draft.appliesTo.filter((x) => x !== k) })} />
                <span>{words(k)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {rows.map((r, pi) => (
          <section key={r.phaseKey} className="sp-phase" aria-label={`Phase ${r.phaseTitle}`}>
            <div className="sp-phase-head">
              <label className="deal-field" htmlFor={`sp-ph-${r.phaseKey}`}><span>Phase {r.phaseKey}</span>
                <input id={`sp-ph-${r.phaseKey}`} value={r.phaseTitle} maxLength={80} onChange={(e) => editSteps((s) => setPhaseTitle(s, r.phaseKey, e.target.value))} /></label>
              <button type="button" className="btn" disabled={pi === 0} onClick={() => editSteps((s) => movePhase(s, r.phaseKey, -1))}>Move phase up</button>
              <button type="button" className="btn" disabled={pi === rows.length - 1} onClick={() => editSteps((s) => movePhase(s, r.phaseKey, 1))}>Move phase down</button>
              <button type="button" className="btn" onClick={() => { if (window.confirm(`Remove the phase "${r.phaseTitle}" and its ${r.steps.length} ${r.steps.length === 1 ? "step" : "steps"}?`)) editSteps((s) => removePhase(s, r.phaseKey)); }}>Remove phase</button>
            </div>
            {r.steps.map((s, si) => (
              <StepCard key={s.key} step={s} others={requiresChoices(draft, s.key)} first={si === 0} last={si === r.steps.length - 1}
                onChange={(patch) => patchStep(s.key, patch)} onMove={(dir) => editSteps((all) => moveStep(all, s.key, dir))}
                onRemove={() => {
                  const waiting = draft.steps.filter((x) => x.requires.includes(s.key)).length;
                  if (waiting === 0 || window.confirm(`${waiting} other ${waiting === 1 ? "step waits" : "steps wait"} on this one. Remove it anyway? They will stop waiting on it.`)) editSteps((all) => removeStep(all, s.key));
                }} />
            ))}
            <div><button type="button" className="btn" onClick={() => editSteps((s) => addStep(s, r.phaseKey))}>Add a step to this phase</button></div>
          </section>
        ))}
        <div><button type="button" className="btn" onClick={() => editSteps((s) => addPhase(s))}>Add a phase</button></div>

        <div className="sp-save">
          {shown.length > 0 && (
            <div className="sp-problems" role="alert">
              <p><b>{shown.length === 1 ? "One thing to fix before this can be saved:" : `${shown.length} things to fix before this can be saved:`}</b></p>
              <ul>{shown.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {error && <p className="warn small" role="alert">{error}</p>}
          <button type="button" className="btn primary" disabled={busy || problems.length > 0 || (!isNew && !dirty)} onClick={() => void save()}>
            {busy ? "Saving…" : isNew ? "Create template" : `Save as version ${template.version + 1}`}
          </button>
          {!isNew && !dirty && <span className="muted small">No changes to save.</span>}
        </div>
      </div>
    </section>
  );
}
