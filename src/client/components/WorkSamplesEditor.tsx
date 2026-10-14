import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { WorkSample } from "../emailView";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const MAX = 20;

function SampleRow({ s, onSave, onDelete }: { s: WorkSample; onSave: (id: string, patch: Partial<WorkSample>) => Promise<void>; onDelete: (s: WorkSample) => Promise<void> }) {
  const [f, setF] = useState({ title: s.title, url: s.url, result_line: s.result_line, tags: s.tags });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [saved, setSaved] = useState(false);
  const dirty = f.title !== s.title || f.url !== s.url || f.result_line !== s.result_line || f.tags !== s.tags;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: e.target.value }); setSaved(false); setErr(""); };
  async function save() {
    setBusy(true); setErr("");
    try { await onSave(s.id, f); setSaved(true); } catch (e) { setErr(`Couldn't save: ${errText(e, "request failed")}`); } finally { setBusy(false); }
  }
  return (
    <li className="sample">
      <div className="sample-fields">
        <input aria-label={`Title for ${s.title}`} placeholder="Riverside Dental redesign" value={f.title} onChange={set("title")} />
        <input aria-label={`Link for ${s.title}`} placeholder="https://…" value={f.url} onChange={set("url")} />
        <input aria-label={`Result for ${s.title}`} placeholder="What changed (e.g. booking requests up 40%)" value={f.result_line} onChange={set("result_line")} />
        <input aria-label={`Tags for ${s.title}`} placeholder="Tags: dental, healthcare, speed" value={f.tags} onChange={set("tags")} />
      </div>
      <p className="row">
        <button onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</button>
        <button className="link-btn danger" onClick={() => onDelete(s)}>Delete</button>
        {saved && !dirty && <span className="muted">Saved</span>}{err && <span className="error" role="alert">{err}</span>}
      </p>
    </li>
  );
}

/** The work an email may cite. The drafter picks the best fit per company from this list and never claims anything outside it. */
export default function WorkSamplesEditor() {
  const [samples, setSamples] = useState<WorkSample[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [draft, setDraft] = useState({ title: "", url: "", result_line: "", tags: "" });
  const [adding, setAdding] = useState(false); const [addErr, setAddErr] = useState(""); const [listErr, setListErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get<WorkSample[]>("/work-samples").then((r) => { if (alive.current) setSamples(r); })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load work samples.")); });
  }, []);

  async function save(id: string, patch: Partial<WorkSample>) {
    const u = await api.put<WorkSample>(`/work-samples/${id}`, patch);
    if (alive.current) setSamples((cur) => cur && cur.map((x) => (x.id === id ? u : x)));
  }
  async function remove(s: WorkSample) {
    if (!window.confirm(`Delete "${s.title}"? Future emails won't be able to cite it.`)) return;
    setListErr("");
    try { await api.del(`/work-samples/${s.id}`); if (alive.current) setSamples((cur) => cur && cur.filter((x) => x.id !== s.id)); }
    catch (e) { if (alive.current) setListErr(`Couldn't delete: ${errText(e, "request failed")}`); }
  }
  async function add() {
    setAdding(true); setAddErr("");
    try {
      const created = await api.post<WorkSample>("/work-samples", draft);
      if (alive.current) { setSamples((cur) => [...(cur ?? []), created]); setDraft({ title: "", url: "", result_line: "", tags: "" }); }
    } catch (e) { if (alive.current) setAddErr(e instanceof ApiError && e.status === 400 && /invalid/i.test(e.message) ? "Add a title and an https:// link." : `Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setAdding(false); }
  }

  return (
    <div className="card work-samples">
      <h2>Work samples</h2>
      <p className="muted small">Projects you're proud of. Full-time emails cite the one or two that fit each company best, and never mention work that isn't listed here. Tags help the match (an industry, a skill).</p>
      {loadErr && <p className="error" role="alert">{loadErr}</p>}
      {!samples && !loadErr && <p className="muted">Loading…</p>}
      {samples && samples.length === 0 && <p className="muted">No samples yet. Add your best two or three below.</p>}
      {samples && samples.length > 0 && <ul className="samples">{samples.map((s) => <SampleRow key={s.id} s={s} onSave={save} onDelete={remove} />)}</ul>}
      {listErr && <p className="error" role="alert">{listErr}</p>}
      {samples && samples.length < MAX && <>
        <h3>Add a sample</h3>
        <div className="sample-fields">
          <input aria-label="New sample title" placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <input aria-label="New sample link" placeholder="https://…" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          <input aria-label="New sample result" placeholder="What changed (optional)" value={draft.result_line} onChange={(e) => setDraft({ ...draft, result_line: e.target.value })} />
          <input aria-label="New sample tags" placeholder="Tags (optional)" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
        </div>
        <p className="row"><button className="primary" onClick={add} disabled={adding || !draft.title.trim() || !draft.url.trim()}>{adding ? "Adding…" : "Add sample"}</button>
          {addErr && <span className="error" role="alert">{addErr}</span>}</p>
      </>}
      {samples && samples.length >= MAX && <p className="muted small">You've reached {MAX} samples. Delete one to add another.</p>}
    </div>
  );
}
