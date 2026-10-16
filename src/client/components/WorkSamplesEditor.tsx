import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { WorkSample } from "../emailView";
import { notifySettingsChanged } from "../settingsData";
import { isHttps, prettyLink } from "../settingsPagesView";
import Icon from "./Icon";
import { Callout, Field } from "./SettingsPage";

export const MAX_SAMPLES = 20;
type Fields = Pick<WorkSample, "title" | "url" | "result_line" | "tags">;
const BLANK: Fields = { title: "", url: "", result_line: "", tags: "" };
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
export const tagList = (tags: string) => tags.split(",").map((t) => t.trim()).filter(Boolean);

/** The work samples and the calls that change them. Each change is saved straight away (there is no Save bar on this page). */
export function useWorkSamples() {
  const [samples, setSamples] = useState<WorkSample[] | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    api.get<WorkSample[]>("/work-samples").then((r) => { if (alive.current) setSamples(r); })
      .catch((e) => { if (alive.current) setError(errText(e, "Couldn't load work samples.")); });
    return () => { alive.current = false; };
  }, []);
  const add = useCallback(async (f: Fields) => {
    const created = await api.post<WorkSample>("/work-samples", f);
    if (alive.current) setSamples((cur) => [...(cur ?? []), created]);
    notifySettingsChanged();
  }, []);
  const save = useCallback(async (id: string, f: Fields) => {
    const u = await api.put<WorkSample>(`/work-samples/${id}`, f);
    if (alive.current) setSamples((cur) => cur && cur.map((x) => (x.id === id ? u : x)));
  }, []);
  const remove = useCallback(async (id: string) => {
    await api.del(`/work-samples/${id}`);
    if (alive.current) setSamples((cur) => cur && cur.filter((x) => x.id !== id));
    notifySettingsChanged();
  }, []);
  return { samples, error, add, save, remove };
}
export type WorkSamplesState = ReturnType<typeof useWorkSamples>;

/** Checks a sample before it is sent; the worker enforces the same rules. */
export function sampleErrors(f: Fields): { title?: string; url?: string } {
  return { title: f.title.trim() ? undefined : "Add a title.", url: isHttps(f.url) ? undefined : "Link must start with https://" };
}

function SampleForm({ initial, submit, cancel, label }: { initial: Fields; submit: (f: Fields) => Promise<void>; cancel: () => void; label: string }) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tried, setTried] = useState(false);
  const bad = tried ? sampleErrors(f) : {};
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: e.target.value }); setErr(""); };
  async function go(e: React.FormEvent) {
    e.preventDefault(); setTried(true);
    const problems = sampleErrors(f);
    if (problems.title || problems.url) return;
    setBusy(true); setErr("");
    try { await submit({ title: f.title.trim(), url: f.url.trim(), result_line: f.result_line.trim(), tags: f.tags.trim() }); }
    catch (x) { setErr(x instanceof ApiError && x.status === 400 && /invalid/i.test(x.message) ? "Check the title and that the link starts with https://." : `Couldn't save: ${errText(x, "request failed")}`); setBusy(false); }
  }
  return (
    <form className="sw-card sw-form" onSubmit={go} aria-label={label}>
      <Field label="Title" htmlFor="sw-title" error={bad.title}><input id="sw-title" autoFocus maxLength={120} placeholder="Riverside Dental redesign" value={f.title} onChange={set("title")} /></Field>
      <Field label="Link" htmlFor="sw-url" error={bad.url}><input id="sw-url" inputMode="url" maxLength={500} placeholder="https://riversidedental.com" value={f.url} onChange={set("url")} /></Field>
      <Field label="Result" htmlFor="sw-result" help="What changed, so drafts can mention it."><input id="sw-result" maxLength={200} placeholder="Booking requests up 40%" value={f.result_line} onChange={set("result_line")} /></Field>
      <Field label="Tags" htmlFor="sw-tags" help="Comma separated: an industry or a skill. They help match a sample to a company."><input id="sw-tags" maxLength={200} placeholder="dental, healthcare" value={f.tags} onChange={set("tags")} /></Field>
      {err && <p className="sw-err" role="alert">{err}</p>}
      <div className="acts">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : label}</button>
        <button type="button" className="btn-plain" onClick={cancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function SampleCard({ s, onEdit, onDelete, error }: { s: WorkSample; onEdit: () => void; onDelete: () => void; error: string }) {
  const tags = tagList(s.tags);
  return (
    <article className="sw-card">
      <div className="sw-top">
        <div className="sw-thumb"><Icon name="image" size={14} /></div>
        <div className="sw-name"><b title={s.title}>{s.title}</b><a href={s.url} target="_blank" rel="noopener noreferrer">{prettyLink(s.url)}</a></div>
        <button type="button" className="sw-ico" aria-label={`Edit ${s.title}`} title="Edit" onClick={onEdit}><Icon name="pen" size={14} /></button>
        <button type="button" className="sw-ico" aria-label={`Delete ${s.title}`} title="Delete" onClick={onDelete}><Icon name="x" size={14} /></button>
      </div>
      {s.result_line.trim()
        ? <div className="sw-result"><Icon name="trending" size={13} /><span>{s.result_line}</span></div>
        : <button type="button" className="sw-result missing" onClick={onEdit}><Icon name="alert" size={13} /><span>Add a result so drafts can mention it</span></button>}
      {tags.length > 0 && <div className="sw-tags">{tags.map((t) => <span key={t} className="badge2">{t}</span>)}</div>}
      {error && <p className="sw-err" role="alert">{error}</p>}
    </article>
  );
}

/**
 * The work an email may cite: a two-column grid of cards with edit and delete on each. The drafter picks the best fit per company
 * from this list and never claims anything outside it. `adding` shows a blank form first; the page's Add button turns it on.
 */
export default function WorkSamplesEditor({ state, adding, onAdd, closeAdd }: { state: WorkSamplesState; adding: boolean; onAdd: () => void; closeAdd: () => void }) {
  const { samples, add, save, remove } = state;
  const [editing, setEditing] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<{ id: string; msg: string } | null>(null);
  if (!samples) return null;
  async function del(s: WorkSample) {
    if (!window.confirm(`Delete "${s.title}"? Future emails won't be able to cite it.`)) return;
    setRowErr(null);
    try { await remove(s.id); } catch (e) { setRowErr({ id: s.id, msg: `Couldn't delete: ${errText(e, "request failed")}` }); }
  }
  if (!samples.length && !adding) return (
    <div className="sw-empty">
      <h2>No work samples yet</h2>
      <p>Add your best two or three projects. Full-time emails link only to what is listed here, and never mention work that isn't.</p>
      <button type="button" className="btn primary" onClick={onAdd}><Icon name="plus" size={16} />Add sample</button>
    </div>
  );
  return (
    <div className="sw-grid">
      {adding && <SampleForm label="Add sample" initial={BLANK} cancel={closeAdd} submit={async (f) => { await add(f); closeAdd(); }} />}
      {samples.map((s) => editing === s.id
        ? <SampleForm key={s.id} label="Save sample" initial={{ title: s.title, url: s.url, result_line: s.result_line, tags: s.tags }} cancel={() => setEditing(null)} submit={async (f) => { await save(s.id, f); setEditing(null); }} />
        : <SampleCard key={s.id} s={s} error={rowErr?.id === s.id ? rowErr.msg : ""} onEdit={() => setEditing(s.id)} onDelete={() => void del(s)} />)}
    </div>
  );
}

export const SamplesLimitNote = () => <Callout compact icon="info">You've reached {MAX_SAMPLES} samples. Delete one to add another.</Callout>;
