import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ownerBadge, phaseGroups, stepsEditable } from "../projectView";
import { diffDetails, diffSummary, parseEstimate, stepsFromTaskRows, templateProblems } from "../sopView";
import { formatMinutes } from "../timeView";
import { announceProjectsChanged, workError, type ProjectDetail } from "../workData";
import type { Task } from "../../worker/db/tasks";
import { OWNER_LABEL, OWNER_TAGS, type OwnerTag, type SopTemplate, type SopTemplateInput } from "../../worker/sop/model";

type Patch = Partial<Pick<Task, "title" | "owner" | "estMinutes" | "doneWhen" | "clientSummary" | "skippable" | "requires">>;

/** The fields of one step as the owner edits them, and the PATCH that carries only what changed. */
function StepEdit({ task, others, onChanged }: { task: Task; others: Task[]; onChanged: () => Promise<void> }) {
  const [title, setTitle] = useState(task.title);
  const [owner, setOwner] = useState<OwnerTag>(task.owner);
  const [est, setEst] = useState(task.estMinutes > 0 ? formatMinutes(task.estMinutes) : "0");
  const [doneWhen, setDoneWhen] = useState(task.doneWhen);
  const [summary, setSummary] = useState(task.clientSummary ?? "");
  const [skippable, setSkippable] = useState(task.skippable);
  const [requires, setRequires] = useState(task.requires);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const minutes = parseEstimate(est);

  const patch: Patch = {};
  if (title !== task.title) patch.title = title;
  if (owner !== task.owner) patch.owner = owner;
  if (minutes !== null && minutes !== task.estMinutes) patch.estMinutes = minutes;
  if (doneWhen !== task.doneWhen) patch.doneWhen = doneWhen;
  if ((summary.trim() || null) !== task.clientSummary) patch.clientSummary = summary.trim() || null;
  if (skippable !== task.skippable) patch.skippable = skippable;
  if ([...requires].sort().join("|") !== [...task.requires].sort().join("|")) patch.requires = requires;
  const changed = Object.keys(patch).length > 0;
  const id = `ps-${task.id}`;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(""); setSaved(false);
    try { await fn(); await onChanged(); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => { await api.patch(`/tasks/${task.id}`, patch); setSaved(true); });
  const remove = () => {
    if (!window.confirm(`Remove the step "${task.title}" from this project? Only a step that was never started can go. Skip it instead if it has been.`)) return;
    void run(async () => { await api.del(`/tasks/${task.id}`); announceProjectsChanged(); });
  };

  return (
    <div className="sp-fields">
      <label className="deal-field" htmlFor={`${id}-title`}><span>Title</span><input id={`${id}-title`} value={title} maxLength={120} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} /></label>
      <div className="sp-grid">
        <label className="deal-field" htmlFor={`${id}-owner`}><span>Who does it</span>
          <select id={`${id}-owner`} value={owner} onChange={(e) => { setOwner(e.target.value as OwnerTag); setSaved(false); }}>{OWNER_TAGS.map((o) => <option key={o} value={o}>{OWNER_LABEL[o]}</option>)}</select></label>
        <label className="deal-field" htmlFor={`${id}-est`}><span>Estimate (like 45m or 1h 30m)</span>
          <input id={`${id}-est`} value={est} aria-invalid={minutes === null} onChange={(e) => { setEst(e.target.value); setSaved(false); }} /></label>
      </div>
      <label className="deal-field" htmlFor={`${id}-done`}><span>Done when</span><textarea id={`${id}-done`} rows={2} value={doneWhen} maxLength={300} onChange={(e) => { setDoneWhen(e.target.value); setSaved(false); }} /></label>
      <label className="deal-field" htmlFor={`${id}-sum`}><span>What the client sees <small className="muted">{summary.length} / 80</small></span>
        <input id={`${id}-sum`} value={summary} maxLength={80} onChange={(e) => { setSummary(e.target.value); setSaved(false); }} /></label>
      <label className="sp-check"><input type="checkbox" checked={skippable} onChange={(e) => { setSkippable(e.target.checked); setSaved(false); }} /><span>This step can be skipped, and steps after it still go ahead</span></label>
      <details className="sp-requires">
        <summary>Waits for {requires.length === 0 ? "no other step" : `${requires.length} other ${requires.length === 1 ? "step" : "steps"}`}</summary>
        <ul>
          {others.map((o) => (
            <li key={o.id}>
              <label className="sp-check">
                <input type="checkbox" checked={requires.includes(o.stepKey!)} onChange={(e) => { setRequires(e.target.checked ? [...requires, o.stepKey!] : requires.filter((r) => r !== o.stepKey)); setSaved(false); }} />
                <span><span className="wk-key">{o.stepKey}</span> {o.title}</span>
              </label>
            </li>
          ))}
        </ul>
      </details>
      {minutes === null && <p className="warn small" role="alert">Estimate: use minutes or hours up to 10 hours, like 45m or 1h 30m.</p>}
      {error && <p className="warn small" role="alert">{error}</p>}
      {saved && !changed && <p className="small" role="status">Saved for this project. The template is unchanged until you save it as the template.</p>}
      <div className="wk-task-actions">
        <button type="button" className="btn primary" disabled={busy || !changed || minutes === null || !title.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save this step"}</button>
        <button type="button" className="btn" disabled={busy} onClick={remove}>Remove step</button>
      </div>
    </div>
  );
}

/** What pushing the project's steps back to its template would do, shown before it is confirmed. */
interface Preview { template: SopTemplate; after: SopTemplateInput; summary: string[]; details: string[]; problems: string[] }

/**
 * This client's own copy of the plan. Each step opens for editing (it changes this project only), and "Save as template" offers the project's steps as the template's next version after
 * showing what would change. Nothing here touches a template unless the push is confirmed.
 */
export default function ProjectSopTab({ data, onChanged }: { data: ProjectDetail; onChanged: () => Promise<void> }) {
  const { project, template } = data;
  const steps = data.tasks.filter((t) => t.isStep);
  const groups = phaseGroups(steps);
  const editable = stepsEditable(project);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const review = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const key = template!.key;
      const current = (await api.get<{ template: SopTemplate }>(`/sops/${encodeURIComponent(key)}`)).template;
      const after: SopTemplateInput = { key: current.key, name: current.name, kind: current.kind, cadence: current.cadence, cadenceDay: current.cadenceDay, appliesTo: current.appliesTo, active: current.active, steps: stepsFromTaskRows(data.tasks) };
      setPreview({ template: current, after, summary: diffSummary(current, after), details: diffDetails(current, after), problems: templateProblems(after) });
    } catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  const push = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.post<{ version: number }>(`/projects/${project.id}/sop/push`, { confirm: true });
      setPreview(null);
      setNotice(`Saved as version ${r.version} of ${template?.name ?? "the template"}. Projects started from now on use it; running ones keep their own steps.`);
      await onChanged();
    } catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };

  const unchanged = !!preview && preview.summary.length === 1 && preview.summary[0] === "no change to the steps";
  return (
    <section aria-label="SOP">
      <p>{template
        ? <>Started from <b>{template.name}</b>, version {project.templateVersion ?? "?"}.{project.templateVersion !== null && template.version > project.templateVersion ? ` The template is now on version ${template.version}; this project keeps its own copy.` : ""}</>
        : "This project was made by hand. It has no template."}</p>
      <p className="muted small">This is this client’s own copy of the plan: the tasks. Changes you make to a step here affect this project only.</p>

      {template && editable && (
        <div className="wk-task-actions">
          <button type="button" className="btn" disabled={busy || !!preview} onClick={() => void review()}>Save as template</button>
        </div>
      )}
      {error && <p className="warn small" role="alert">{error}</p>}
      {notice && <p className="small" role="status">{notice} <Link to="/settings/sops">Open SOPs</Link></p>}
      {preview && (
        <div className="sp-confirm" role="group" aria-label="Save as template">
          <p><b>Save this project’s {stepsFromTaskRows(data.tasks).length} steps as version {preview.template.version + 1} of {preview.template.name}?</b></p>
          <p>Compared with the template as it is now: {preview.summary.join(", ")}.</p>
          {preview.details.length > 0 && <ul className="co-ul">{preview.details.map((d) => <li key={d}>{d}</li>)}</ul>}
          <p>This changes the template for every future project, not the ones running.</p>
          {preview.problems.length > 0 && <div className="sp-problems" role="alert"><p><b>The template could not be saved with these steps:</b></p><ul>{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
          <div className="wk-task-actions">
            <button type="button" className="btn primary" disabled={busy || preview.problems.length > 0 || unchanged} onClick={() => void push()}>{busy ? "Saving…" : `Save as version ${preview.template.version + 1}`}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          </div>
          {unchanged && <p className="muted small">Nothing differs from the template, so there is nothing to save.</p>}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.phaseKey} className="wk-phase">
          <h3>{g.title}<span className="wk-count">{g.total} {g.total === 1 ? "step" : "steps"}</span></h3>
          <ul className="wk-list">
            {g.tasks.map((t) => (
              <li key={t.id} className="sp-step">
                <details>
                  <summary>
                    <span className="wk-row-main">{t.stepKey && <b className="wk-key">{t.stepKey}</b>} <span className="sp-step-title">{t.title}</span></span>
                    <span className="badge2">{ownerBadge(t.owner)}</span>
                    <span className="muted small">{t.estMinutes > 0 ? formatMinutes(t.estMinutes) : "no estimate"}</span>
                  </summary>
                  {editable
                    ? <StepEdit key={`${t.id}:${t.updatedAt}`} task={t} others={steps.filter((o) => o.id !== t.id && o.stepKey)} onChanged={onChanged} />
                    : <div className="sp-fields"><p className="muted small">This project is {project.status}, so its steps cannot be edited.</p></div>}
                </details>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
