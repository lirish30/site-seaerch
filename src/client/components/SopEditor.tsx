import { useEffect, useRef, useState } from "react";
import { SwitchRow } from "./StepFields";
import { Chip, Seg } from "./ds";
import Icon from "./Icon";
import { api, ApiError } from "../api";
import { ownerBadge } from "../projectView";
import { unsaved } from "../settingsData";
import { addPhase, addStep, keyProblem, movePhase, moveStep, parseEstimate, removePhase, removeStep, requiresChoices, setPhaseTitle, stepRows, templateProblems, totalEstimate } from "../sopView";
import { formatMinutes } from "../timeView";
import { PACKAGE_KEYS } from "../../worker/db/packages";
import { CADENCES, MILESTONE_KEYS, OWNER_LABEL, OWNER_TAGS, type Cadence, type MilestoneKey, type OwnerTag, type SopStep, type SopTemplate, type SopTemplateInput } from "../../worker/sop/model";

const MILESTONE_LABEL: Record<MilestoneKey, string> = { design_approved: "Design approved", site_finished: "Site finished" };
const CADENCE_LABEL: Record<Cadence, string> = { weekly: "Every week", monthly: "Every month", quarterly: "Every quarter", annual: "Every year" };
const OWNER_TONE: Record<OwnerTag, "signal" | "info" | "neutral"> = { claude: "signal", claude_drafts: "info", logan: "neutral" };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const words = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** Above this many other steps, the "Waits for" picker gets a filter and an earlier/all switch. */
const LONG = 12;

const toInput = (t: SopTemplate): SopTemplateInput => ({ key: t.key, name: t.name, kind: t.kind, cadence: t.cadence, cadenceDay: t.cadenceDay, appliesTo: [...t.appliesTo], active: t.active, steps: t.steps.map((s) => ({ ...s, requires: [...s.requires] })) });
const blank = (): SopTemplateInput => ({ key: "", name: "", kind: "project", cadence: null, cadenceDay: null, appliesTo: [], active: true, steps: addPhase([]) });

/**
 * "Waits for", grouped for long templates: the other steps by phase, only the steps before this one unless you ask for all
 * (a step can still wait on a later one; any already picked always shows), and a filter by name or key. The phases near this
 * step and any phase with a pick start open; the rest fold to one line that says how many are picked.
 */
function WaitsForGrouped({ step, others, order, value, onChange }: { step: SopStep; others: SopStep[]; order: string[]; value: string[]; onChange: (next: string[]) => void }) {
  const long = others.length > LONG;
  const [scope, setScope] = useState<"earlier" | "all">("earlier");
  const [q, setQ] = useState("");
  const me = order.indexOf(step.key);
  const pool = !long || scope === "all" ? others : others.filter((o) => order.indexOf(o.key) < me || value.includes(o.key));
  const needle = q.trim().toLowerCase();
  const shown = needle ? pool.filter((o) => o.title.toLowerCase().includes(needle) || o.key.toLowerCase().includes(needle)) : pool;
  const groups: { key: string; title: string; steps: SopStep[] }[] = [];
  for (const o of shown) {
    let g = groups.find((x) => x.key === o.phaseKey);
    if (!g) { g = { key: o.phaseKey, title: o.phaseTitle, steps: [] }; groups.push(g); }
    g.steps.push(o);
  }
  const phaseOrder = [...new Set(order.map((k) => [...others, step].find((s) => s.key === k)?.phaseKey))];
  const myPhase = phaseOrder.indexOf(step.phaseKey);
  const near = (pk: string) => { const i = phaseOrder.indexOf(pk); return i === myPhase || i === myPhase - 1; };
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isOpen = (g: { key: string; steps: SopStep[] }) => !long || !!needle || (toggled[g.key] ?? (near(g.key) || g.steps.some((s) => value.includes(s.key))));

  return (
    <fieldset className="sox-wf">
      <legend className="ds-label">Waits for {value.length === 0 ? <span className="ds-help">nothing: it can start straight away</span> : <span className="ds-help">{value.length} {value.length === 1 ? "step" : "steps"} to finish first: {value.join(", ")}</span>}</legend>
      {long && (
        <div className="sox-wf-tools">
          <span className="sox-wf-q"><input type="search" placeholder="Filter steps by name or key" aria-label="Filter steps" value={q} onChange={(e) => setQ(e.target.value)} /></span>
          <Seg label="Which steps to list" value={scope} onChange={setScope} options={[{ key: "earlier", label: "Earlier steps" }, { key: "all", label: "All steps" }]} />
        </div>
      )}
      {others.length === 0 ? <p className="ds-help">There are no other steps yet.</p>
        : groups.length === 0 ? <p className="ds-help">{needle ? "No step matches that." : "No earlier steps: this is the first one. Switch to All steps to pick a later one."}</p>
        : groups.map((g) => {
          const picked = g.steps.filter((s) => value.includes(s.key)).length;
          const open = isOpen(g);
          return (
            <div key={g.key} className="sox-wf-group">
              {long && (
                <button type="button" className="sox-wf-head" aria-expanded={open} onClick={() => setToggled((t) => ({ ...t, [g.key]: !open }))}>
                  <Icon name="chevron-down" size={12} />Phase {g.key} · {g.title || "Untitled"}
                  <span className={`n${picked ? " on" : ""}`}>{picked ? `${picked} of ${g.steps.length} picked` : `${g.steps.length} ${g.steps.length === 1 ? "step" : "steps"}`}</span>
                </button>
              )}
              {open && (
                <div className="ds-waits-list">
                  {g.steps.map((o) => {
                    const on = value.includes(o.key);
                    return (
                      <button key={o.key} type="button" className="ds-wait" aria-pressed={on} onClick={() => onChange(on ? value.filter((k) => k !== o.key) : [...value, o.key])}>
                        <span className="ds-wait-key">{o.key}</span>{o.title || "Untitled step"}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
    </fieldset>
  );
}

/** One step: a row that opens into its fields. Everything typed here is text (a title, a done-when, a name); nothing is read as HTML. */
function StepCard({ step, others, order, first, last, onChange, onMove, onRemove, onBadEstimate }: {
  step: SopStep; others: SopStep[]; order: string[]; first: boolean; last: boolean; onChange: (patch: Partial<SopStep>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
  /** Tells the editor whether this step's estimate box holds text that is not a valid estimate (the draft then still has the old value). */
  onBadEstimate: (key: string, bad: boolean) => void;
}) {
  const [est, setEst] = useState(() => (step.estMinutes > 0 ? formatMinutes(step.estMinutes) : "0"));
  const parsed = parseEstimate(est);
  const bad = parsed === null;
  useEffect(() => { onBadEstimate(step.key, bad); }, [step.key, bad]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onBadEstimate(step.key, false), [step.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = `sp-${step.key}`;
  const nullable = (v: string) => (v.trim() === "" ? null : v);
  return (
    <details className="sox-step">
      <summary>
        <Icon name="chevron-right" size={14} className="chev" />
        <span className="sox-key">{step.key}</span>
        <span className={`t${step.title ? "" : " none"}`}>{step.title || "Untitled step"}</span>
        <span className="meta">
          {bad && <Chip tone="critical" dot>Check estimate</Chip>}
          {step.milestone && <Chip tone="positive">{MILESTONE_LABEL[step.milestone]}</Chip>}
          {step.skippable && <Chip tone="outline">Skippable</Chip>}
          {step.requires.length > 0 && <span className="sox-sub" title={`Waits for ${step.requires.join(", ")}`}>waits for {step.requires.length}</span>}
          <Chip tone={OWNER_TONE[step.owner]}>{ownerBadge(step.owner)}</Chip>
          <span className="sox-mono" style={{ fontSize: 12, minWidth: 52, textAlign: "right" }}>{step.estMinutes > 0 ? formatMinutes(step.estMinutes) : "–"}</span>
        </span>
      </summary>
      <div className="ds-step-form ds-form">
        <label className="deal-field wide" htmlFor={`${id}-title`}><span>Title</span>
          <input id={`${id}-title`} value={step.title} maxLength={120} onChange={(e) => onChange({ title: e.target.value })} /></label>
        <label className="deal-field" htmlFor={`${id}-owner`}><span>Who does it</span>
          <select id={`${id}-owner`} value={step.owner} onChange={(e) => onChange({ owner: e.target.value as OwnerTag })}>{OWNER_TAGS.map((o) => <option key={o} value={o}>{OWNER_LABEL[o]}</option>)}</select></label>
        <label className="deal-field" htmlFor={`${id}-est`}><span>Estimate</span>
          <input id={`${id}-est`} value={est} placeholder="45m or 1h 30m" aria-invalid={parsed === null} onChange={(e) => { setEst(e.target.value); const m = parseEstimate(e.target.value); if (m !== null) onChange({ estMinutes: m }); }} />
          {parsed === null ? <small role="alert" style={{ color: "var(--critical)" }}>Use minutes or hours, like 45m or 1h 30m.</small> : <small>Minutes or hours, up to 10 hours.</small>}</label>
        <label className="deal-field" htmlFor={`${id}-ms`}><span>Milestone this step marks</span>
          <select id={`${id}-ms`} value={step.milestone ?? ""} onChange={(e) => onChange({ milestone: (e.target.value || null) as MilestoneKey | null })}>
            <option value="">None</option>{MILESTONE_KEYS.map((m) => <option key={m} value={m}>{MILESTONE_LABEL[m]}</option>)}</select></label>
        <span aria-hidden="true" />
        <label className="deal-field wide" htmlFor={`${id}-done`}><span>Done when <small>{step.doneWhen.length} / 300</small></span>
          <textarea id={`${id}-done`} value={step.doneWhen} maxLength={300} rows={2} onChange={(e) => onChange({ doneWhen: e.target.value })} /></label>
        <label className="deal-field wide" htmlFor={`${id}-sum`}><span>What the client sees <small>{(step.clientSummary ?? "").length} / 80</small></span>
          <input id={`${id}-sum`} value={step.clientSummary ?? ""} maxLength={80} onChange={(e) => onChange({ clientSummary: nullable(e.target.value) })} /></label>
        <label className="deal-field" htmlFor={`${id}-doc`}><span>Linked document template</span>
          <input id={`${id}-doc`} value={step.docTemplate ?? ""} maxLength={80} onChange={(e) => onChange({ docTemplate: nullable(e.target.value) })} /></label>
        <label className="deal-field" htmlFor={`${id}-mail`}><span>Linked email template</span>
          <input id={`${id}-mail`} value={step.emailTemplate ?? ""} maxLength={80} onChange={(e) => onChange({ emailTemplate: nullable(e.target.value) })} /></label>
        <div className="wide"><SwitchRow checked={step.skippable} onChange={(v) => onChange({ skippable: v })} label="Can be skipped" help="If this step is skipped, the steps after it still go ahead." /></div>
        <div className="wide"><WaitsForGrouped step={step} others={others} order={order} value={step.requires} onChange={(next) => onChange({ requires: next })} /></div>
        <div className="ds-form-actions">
          <button type="button" className="btn sm" disabled={first} onClick={() => onMove(-1)}><Icon name="chevron-up" size={13} />Move up</button>
          <button type="button" className="btn sm" disabled={last} onClick={() => onMove(1)}><Icon name="chevron-down" size={13} />Move down</button>
          <span className="ds-grow" />
          <button type="button" className="btn sm" onClick={onRemove}>Remove step</button>
        </div>
      </div>
    </details>
  );
}

/**
 * The editor for one template: its name and kind, and its phases of steps. The problems the save would refuse are listed as you edit, so the Save button explains itself;
 * the server checks them again. Saving makes the next version, and a project already running keeps the steps it was started with.
 */
export default function SopEditor({ template, active, existingKeys, onSaved, onClose }: { template: SopTemplate | null; active: boolean; existingKeys: string[]; onSaved: (t: SopTemplate) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<SopTemplateInput>(() => (template ? toInput(template) : blank()));
  const baseline = useRef(JSON.stringify(draft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [badEstimates, setBadEstimates] = useState<string[]>([]);
  const isNew = template === null;
  const dirty = JSON.stringify(draft) !== baseline.current;
  // A new template under a key another template has would replace that one, so it is refused here. An estimate box holding text that is not an estimate would save the old value.
  const problems = [
    ...(isNew ? [keyProblem(draft.key, existingKeys)] : []).filter((p): p is string => p !== null),
    ...templateProblems({ ...draft, active }),
    ...badEstimates.map((k) => `Step ${k}: the estimate is not a length of time. Use minutes or hours up to 10 hours, like 45m or 1h 30m.`),
  ];
  const rows = stepRows(draft);
  const order = rows.flatMap((r) => r.steps.map((s) => s.key));

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
  const phaseMinutes = (steps: SopStep[]) => steps.reduce((n, s) => n + s.estMinutes, 0);

  return (
    <section className="st-card sox-ed" aria-label={isNew ? "New template" : `Edit ${template.name}`}>
      <header>
        <div>
          <h2>{isNew ? "New template" : template.name}{dirty && <> <Chip tone="warning" dot>Unsaved</Chip></>}</h2>
          <p>{draft.steps.length} {draft.steps.length === 1 ? "step" : "steps"} in {rows.length} {rows.length === 1 ? "phase" : "phases"}, {totalEstimate(draft)}. {isNew ? "" : `Version ${template.version} now; saving makes version ${template.version + 1}.`}</p>
        </div>
        <button type="button" className="btn sm" onClick={close}><Icon name="x" size={13} />Close</button>
      </header>
      <div className="st-card-body">
        <div className="sox-ed-meta">
          <label className="deal-field" htmlFor="sp-name"><span>Name</span><input id="sp-name" value={draft.name} maxLength={80} placeholder="Website build" onChange={(e) => edit({ name: e.target.value })} /></label>
          <label className="deal-field" htmlFor="sp-key"><span>Key</span>
            <input id="sp-key" value={draft.key} maxLength={20} readOnly={!isNew} placeholder="WEB-1" onChange={(e) => edit({ key: e.target.value.trim() })} />
            <small>{isNew ? "Letters, digits, dots and dashes. It can't change later." : "Set when the template was made."}</small></label>
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
        <fieldset className="sox-applies">
          <legend className="ds-label">Used for these packages <span className="ds-help">{draft.appliesTo.length ? `${draft.appliesTo.length} picked` : "none: start it by hand"}</span></legend>
          {PACKAGE_KEYS.map((k) => {
            const on = draft.appliesTo.includes(k);
            return (
              <button key={k} type="button" className="sox-pick" aria-pressed={on} onClick={() => edit({ appliesTo: on ? draft.appliesTo.filter((x) => x !== k) : [...draft.appliesTo, k] })}>
                {on && <Icon name="check" size={12} />}{words(k)}
              </button>
            );
          })}
        </fieldset>

        <p className="sox-overline">Phases and steps <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· open a step to edit it</span></p>
        {rows.map((r, pi) => (
          <section key={r.phaseKey} className="sox-phase" aria-label={`Phase ${r.phaseTitle}`}>
            <div className="sox-phase-head">
              <span className="sox-key">Phase {r.phaseKey}</span>
              <input id={`sp-ph-${r.phaseKey}`} aria-label={`Phase ${r.phaseKey} title`} value={r.phaseTitle} maxLength={80} placeholder="Phase title" onChange={(e) => editSteps((s) => setPhaseTitle(s, r.phaseKey, e.target.value))} />
              <span className="sox-sub">{r.steps.length} {r.steps.length === 1 ? "step" : "steps"}{phaseMinutes(r.steps) > 0 ? ` · ${formatMinutes(phaseMinutes(r.steps))}` : ""}</span>
              <button type="button" className="sox-x" title="Move phase up" aria-label="Move phase up" disabled={pi === 0} onClick={() => editSteps((s) => movePhase(s, r.phaseKey, -1))}><Icon name="chevron-up" size={14} /></button>
              <button type="button" className="sox-x" title="Move phase down" aria-label="Move phase down" disabled={pi === rows.length - 1} onClick={() => editSteps((s) => movePhase(s, r.phaseKey, 1))}><Icon name="chevron-down" size={14} /></button>
              <button type="button" className="sox-x" title="Remove phase" aria-label="Remove phase" onClick={() => { if (window.confirm(`Remove the phase "${r.phaseTitle}" and its ${r.steps.length} ${r.steps.length === 1 ? "step" : "steps"}?`)) editSteps((s) => removePhase(s, r.phaseKey)); }}><Icon name="x" size={14} /></button>
            </div>
            {r.steps.map((s, si) => (
              <StepCard key={s.key} step={s} others={requiresChoices(draft, s.key)} order={order} first={si === 0} last={si === r.steps.length - 1}
                onChange={(patch) => patchStep(s.key, patch)} onMove={(dir) => editSteps((all) => moveStep(all, s.key, dir))}
                onBadEstimate={(k, bad) => setBadEstimates((all) => (bad ? (all.includes(k) ? all : [...all, k]) : all.filter((x) => x !== k)))}
                onRemove={() => {
                  const waiting = draft.steps.filter((x) => x.requires.includes(s.key)).length;
                  if (waiting === 0 || window.confirm(`${waiting} other ${waiting === 1 ? "step waits" : "steps wait"} on this one. Remove it anyway? They will stop waiting on it.`)) editSteps((all) => removeStep(all, s.key));
                }} />
            ))}
            <div className="sox-phase-foot"><button type="button" className="sox-add" onClick={() => editSteps((s) => addStep(s, r.phaseKey))}><Icon name="plus" size={13} />Add a step to {r.phaseTitle || "this phase"}</button></div>
          </section>
        ))}
        <div><button type="button" className="sox-add" onClick={() => editSteps((s) => addPhase(s))}><Icon name="plus" size={13} />Add a phase</button></div>

        {shown.length > 0 && (
          <div className="sox-problems" role="alert">
            <b><Icon name="alert" size={14} />{shown.length === 1 ? "One thing to fix before this can be saved:" : `${shown.length} things to fix before this can be saved:`}</b>
            <ul>{shown.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        {error && <p className="bx-err" role="alert">{error}</p>}
      </div>
      <div className="sox-save">
        <button type="button" className="btn primary" disabled={busy || problems.length > 0 || (!isNew && !dirty)} onClick={() => void save()}>
          {busy ? "Saving…" : isNew ? "Create template" : `Save as version ${template.version + 1}`}
        </button>
        <button type="button" className="btn-plain" onClick={close}>{dirty ? "Discard and close" : "Close"}</button>
        <span className="sox-sub">{!isNew && !dirty ? "No changes to save. " : ""}A project already running keeps the steps it started with.</span>
      </div>
    </section>
  );
}
