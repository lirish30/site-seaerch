import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { notifySettingsChanged } from "../settingsData";
import { REASON_TONE, shortDate, shortPlaceId } from "../settingsView";
import { REASONS, reasonLabel } from "../suppressionView";
import type { Suppression, SuppressionReason } from "../types";
import Icon from "./Icon";
import { Pill } from "./settingsBits";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The suppression list and its load error. */
export function useSuppressions(enabled = true) {
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    api.get<Suppression[]>("/suppressions").then((r) => { if (alive.current) setRows(r); })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load the suppression list.")); });
  }, [enabled]);
  return { rows, setRows, loadErr, alive };
}
export type SuppressionsState = ReturnType<typeof useSuppressions>;

/**
 * Add a domain with a reason and an optional note, then see everything that is never searched, drafted for or exported.
 * The page passes its own `sup` (the header counts the list); alone, the editor loads the list itself.
 */
export default function SuppressionsEditor({ sup: lifted }: { sup?: SuppressionsState }) {
  const own = useSuppressions(!lifted);
  const { rows, setRows, loadErr, alive } = lifted ?? own;
  const [value, setValue] = useState(""); const [reason, setReason] = useState<SuppressionReason>("client"); const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false); const [addErr, setAddErr] = useState("");
  const [busyId, setBusyId] = useState(""); const [rowErr, setRowErr] = useState("");

  async function add() {
    if (!value.trim()) { setAddErr("Enter a domain such as acme.com."); return; }
    setAdding(true); setAddErr("");
    try {
      const created = await api.post<Suppression>("/suppressions", { kind: "domain", value, reason, note: note.trim() || undefined });
      if (alive.current) { setRows((cur) => [created, ...(cur ?? [])]); setValue(""); setNote(""); notifySettingsChanged(); }
    } catch (e) { if (alive.current) setAddErr(`Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setAdding(false); }
  }
  async function remove(s: Suppression) {
    if (!window.confirm(`Remove ${s.value} from the suppression list? It can be searched, drafted for and exported again.`)) return;
    setBusyId(s.id); setRowErr("");
    try {
      await api.del(`/suppressions/${s.id}`);
      if (alive.current) { setRows((cur) => cur && cur.filter((x) => x.id !== s.id)); notifySettingsChanged(); }
    } catch (e) { if (alive.current) setRowErr(`Couldn't remove ${s.value}: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setBusyId(""); }
  }

  return (
    <div className="su">
      <form className="su-add" onSubmit={(e) => { e.preventDefault(); if (!adding) void add(); }}>
        <div className="bx-f su-grow"><label className="fl" htmlFor="supp-domain">Domain</label>
          <input id="supp-domain" className="in" value={value} placeholder="e.g. acme.com" onChange={(e) => { setValue(e.target.value); setAddErr(""); }} /></div>
        <div className="bx-f su-reason"><label className="fl" htmlFor="supp-reason">Reason</label>
          <select id="supp-reason" className="in" value={reason} onChange={(e) => setReason(e.target.value as SuppressionReason)}>
            {REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
          </select></div>
        <div className="bx-f su-grow"><label className="fl" htmlFor="supp-note">Note (optional)</label>
          <input id="supp-note" className="in" value={note} maxLength={500} placeholder="e.g. signed in March" onChange={(e) => setNote(e.target.value)} /></div>
        <button type="submit" className="btn primary" disabled={adding}><Icon name="plus" size={16} className="bx-plus" />{adding ? "Adding…" : "Add to list"}</button>
      </form>
      {addErr && <p className="bx-err" role="alert">{addErr}</p>}
      {loadErr && <p className="bx-err" role="alert">{loadErr}</p>}
      {rowErr && <p className="bx-err" role="alert">{rowErr}</p>}
      {!rows ? (loadErr ? null : <p className="bx-muted">Loading…</p>)
        : !rows.length ? <p className="bx-empty">Nothing suppressed yet. Add a client, competitor or opt-out above and it is skipped by searches, drafts and exports.</p>
        : (
          <div className="su-table" role="table" aria-label="Suppressed businesses">
            <div className="su-row head" role="row">
              <span role="columnheader">Domain</span><span role="columnheader">Reason</span><span role="columnheader">Note</span><span role="columnheader">Added</span><span role="columnheader" aria-label="Remove" />
            </div>
            {rows.map((s) => (
              <div key={s.id} className="su-row" role="row">
                <span className="dom" role="cell">{s.kind === "place_id" ? `Google place ID · ${shortPlaceId(s.value)}` : s.value}</span>
                <span role="cell"><Pill tone={REASON_TONE[s.reason]}>{reasonLabel(s.reason)}</Pill></span>
                <span className="note" role="cell">{s.note || "—"}</span>
                <span className="added" role="cell">{shortDate(s.created_at)}</span>
                <span role="cell"><button type="button" className="su-x" disabled={busyId === s.id} onClick={() => void remove(s)} aria-label={`Remove ${s.value}`}><Icon name="x" size={14} /></button></span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
