import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { REASONS, reasonLabel } from "../suppressionView";
import type { Suppression, SuppressionReason } from "../types";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export default function SuppressionsEditor() {
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [value, setValue] = useState(""); const [reason, setReason] = useState<SuppressionReason>("client"); const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false); const [addErr, setAddErr] = useState("");
  const [busyId, setBusyId] = useState(""); const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get<Suppression[]>("/suppressions").then((r) => { if (alive.current) setRows(r); })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load the suppression list.")); });
  }, []);

  async function add() {
    if (!value.trim()) { setAddErr("Enter a domain such as acme.com."); return; }
    setAdding(true); setAddErr("");
    try {
      const created = await api.post<Suppression>("/suppressions", { kind: "domain", value, reason, note: note.trim() || undefined });
      if (alive.current) { setRows((cur) => [created, ...(cur ?? [])]); setValue(""); setNote(""); }
    } catch (e) { if (alive.current) setAddErr(`Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setAdding(false); }
  }
  async function remove(s: Suppression) {
    if (!window.confirm(`Remove ${s.value} from the suppression list? It can be searched, drafted for and exported again.`)) return;
    setBusyId(s.id); setRowErr((p) => ({ ...p, [s.id]: "" }));
    try {
      await api.del(`/suppressions/${s.id}`);
      if (alive.current) setRows((cur) => cur && cur.filter((x) => x.id !== s.id));
    } catch (e) { if (alive.current) setRowErr((p) => ({ ...p, [s.id]: `Couldn't remove: ${errText(e, "request failed")}` })); }
    finally { if (alive.current) setBusyId(""); }
  }

  return (
    <div className="card suppressions">
      <h2>Suppressions</h2>
      <p className="muted small">Businesses you never want to search for, draft emails to, or export: existing clients, people who opted out, competitors, deals in progress. A search skips them, and a suppressed lead's draft and export buttons are turned off. You can also mark a lead from its own page.</p>
      {loadErr && <p className="error" role="alert">{loadErr}</p>}
      {!rows ? (loadErr ? null : <p className="muted">Loading…</p>) : <>
        {!rows.length && <p className="muted">Nothing suppressed yet.</p>}
        {rows.length > 0 && <ul className="plain supp-list">{rows.map((s) => (
          <li key={s.id}>
            <div className="supp-main">
              <strong>{s.value}</strong> <span className="tag">{reasonLabel(s.reason)}</span>
              {s.kind === "place_id" && <span className="muted small"> place ID</span>}
              {s.note && <span className="muted small"> · {s.note}</span>}
              {rowErr[s.id] && <p className="error small" role="alert">{rowErr[s.id]}</p>}
            </div>
            <button className="danger" disabled={busyId === s.id} onClick={() => remove(s)} aria-label={`Remove ${s.value}`}>{busyId === s.id ? "Removing…" : "Remove"}</button>
          </li>
        ))}</ul>}
        <h3>Add a domain</h3>
        <div className="field-row">
          <div><label htmlFor="supp-domain">Domain</label>
            <input id="supp-domain" value={value} placeholder="acme.com" onChange={(e) => { setValue(e.target.value); setAddErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !adding) add(); }} /></div>
          <div><label htmlFor="supp-reason">Reason</label>
            <select id="supp-reason" value={reason} onChange={(e) => setReason(e.target.value as SuppressionReason)}>
              {REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
            </select></div>
        </div>
        <label htmlFor="supp-note">Note (optional)</label>
        <input id="supp-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <p className="row"><button className="primary" onClick={add} disabled={adding}>{adding ? "Adding…" : "Add to list"}</button>
          {addErr && <span className="error" role="alert">{addErr}</span>}</p>
      </>}
    </div>
  );
}
