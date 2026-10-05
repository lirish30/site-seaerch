import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { fromLines, groupByCategory, toLines } from "../services";
import type { Service } from "../types";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Details form with its own draft: a failed save keeps what was typed and says why. */
function ServiceDetails({ s, onSave }: { s: Service; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const [summary, setSummary] = useState(s.summary);
  const [deliverables, setDeliverables] = useState(toLines(s.deliverables));
  const [prerequisites, setPrerequisites] = useState(toLines(s.prerequisites));
  const [first, setFirst] = useState(s.first_engagement ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [saved, setSaved] = useState(false);
  const id = `svc-${s.id}`;
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setSaved(false); setErr(""); };
  async function save() {
    setBusy(true); setErr(""); setSaved(false);
    try {
      await onSave({ summary, deliverables: fromLines(deliverables), prerequisites: fromLines(prerequisites), first_engagement: first.trim() || null });
      setSaved(true);
    } catch (e) { setErr(`Couldn't save: ${errText(e, "request failed")}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="svc-details">
      <label htmlFor={`${id}-sum`}>Summary</label>
      <textarea id={`${id}-sum`} rows={2} value={summary} onChange={(e) => touch(setSummary)(e.target.value)} />
      <div className="field-row">
        <div>
          <label htmlFor={`${id}-del`}>Deliverables (one per line)</label>
          <textarea id={`${id}-del`} rows={4} value={deliverables} onChange={(e) => touch(setDeliverables)(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${id}-pre`}>Prerequisites (one per line)</label>
          <textarea id={`${id}-pre`} rows={4} value={prerequisites} onChange={(e) => touch(setPrerequisites)(e.target.value)} />
        </div>
      </div>
      <label htmlFor={`${id}-first`}>First engagement</label>
      <input id={`${id}-first`} value={first} placeholder="The small first project you would pitch" onChange={(e) => touch(setFirst)(e.target.value)} />
      <p className="row"><button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        {saved && <span className="muted">Saved</span>}{err && <span className="error" role="alert">{err}</span>}</p>
    </div>
  );
}

export default function ServicesEditor() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [loadErr, setLoadErr] = useState(""); const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ name: "", category: "", summary: "" });
  const [adding, setAdding] = useState(false); const [addErr, setAddErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get<Service[]>("/services").then((r) => { if (alive.current) setServices(r); })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load services.")); });
  }, []);

  const replace = (u: Service) => setServices((cur) => cur && cur.map((x) => (x.id === u.id ? u : x)));
  async function patch(s: Service, body: Record<string, unknown>) {
    const u = await api.patch<Service>(`/services/${s.id}`, body);
    if (alive.current) { replace(u); setRowErr((r) => ({ ...r, [s.id]: "" })); }
  }
  // Toggles apply on click; if the request fails the box snaps back and the row says why.
  async function toggle(s: Service, field: "active" | "is_specialty") {
    setRowErr((r) => ({ ...r, [s.id]: "" }));
    try { await patch(s, { [field]: !s[field] }); }
    catch (e) { if (alive.current) setRowErr((r) => ({ ...r, [s.id]: `Couldn't update ${s.name}: ${errText(e, "request failed")}` })); }
  }
  async function add() {
    setAdding(true); setAddErr("");
    try {
      const body = { name: draft.name, summary: draft.summary, ...(draft.category.trim() ? { category: draft.category } : {}) };
      const created = await api.post<Service>("/services", body);
      if (alive.current) { setServices((cur) => [...(cur ?? []), created]); setDraft({ name: "", category: draft.category, summary: "" }); }
    } catch (e) { if (alive.current) setAddErr(`Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setAdding(false); }
  }

  const groups = services ? groupByCategory(services) : [];
  return (
    <div className="card services">
      <h2>Services you sell</h2>
      <p className="muted small">Turn off what you don't sell and mark your specialties. Offers on lead pages are chosen from the active services.</p>
      {loadErr && <p className="error" role="alert">{loadErr}</p>}
      {!services ? (loadErr ? null : <p className="muted">Loading…</p>) : groups.map((g) => (
        <section key={g.category}>
          <h3>{g.category}</h3>
          {g.services.map((s) => (
            <div key={s.id} className={`svc${s.active ? "" : " off"}`}>
              <div className="svc-head">
                <details>
                  <summary><strong>{s.name}</strong>{s.is_specialty && <span className="badge">Specialty</span>}{!s.active && <span className="muted small"> Off</span>}</summary>
                  <ServiceDetails s={s} onSave={(b) => patch(s, b)} />
                </details>
                <label className="check"><input type="checkbox" checked={s.active} onChange={() => toggle(s, "active")} aria-label={`Active: ${s.name}`} /> Active</label>
                <label className="check"><input type="checkbox" checked={s.is_specialty} onChange={() => toggle(s, "is_specialty")} aria-label={`Specialty: ${s.name}`} /> Specialty</label>
              </div>
              {rowErr[s.id] && <p className="error small" role="alert">{rowErr[s.id]}</p>}
            </div>
          ))}
        </section>
      ))}
      <h3>Add service</h3>
      <div className="field-row">
        <div><label htmlFor="svc-new-name">Name</label>
          <input id="svc-new-name" value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setAddErr(""); }} /></div>
        <div><label htmlFor="svc-new-cat">Category</label>
          <input id="svc-new-cat" list="svc-cats" placeholder="Other" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          <datalist id="svc-cats">{groups.map((g) => <option key={g.category} value={g.category} />)}</datalist></div>
      </div>
      <label htmlFor="svc-new-sum">Summary</label>
      <input id="svc-new-sum" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
      <p className="row"><button className="primary" onClick={add} disabled={adding}>{adding ? "Adding…" : "Add service"}</button>
        {addErr && <span className="error" role="alert">{addErr}</span>}</p>
    </div>
  );
}
