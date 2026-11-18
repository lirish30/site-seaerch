import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { DNC_KIND_LABEL, DNC_KINDS, DNC_REASONS, dncReasonLabel, dncValueHint } from "../dncView";
import { shortDate } from "../settingsView";
import type { DncKind, DncReason, DoNotContact } from "../types";
import Icon from "./Icon";
import { Pill } from "./settingsBits";

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The do-not-contact list: emails, domains and company names that outreach is refused for. Subdomains of a listed domain count. */
export default function DoNotContactEditor() {
  const [rows, setRows] = useState<DoNotContact[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [kind, setKind] = useState<DncKind>("domain"); const [value, setValue] = useState("");
  const [reason, setReason] = useState<DncReason>("client"); const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false); const [addErr, setAddErr] = useState("");
  const [busyId, setBusyId] = useState(""); const [rowErr, setRowErr] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    api.get<DoNotContact[]>("/do-not-contact").then((r) => { if (alive.current) setRows(r); })
      .catch((e) => { if (alive.current) setLoadErr(errText(e, "Couldn't load the do-not-contact list.")); });
  }, []);

  async function add() {
    if (!value.trim()) { setAddErr(`Enter ${dncValueHint(kind)}.`); return; }
    setAdding(true); setAddErr("");
    try {
      const created = await api.post<DoNotContact>("/do-not-contact", { kind, value, reason, note: note.trim() || undefined });
      if (alive.current) { setRows((cur) => [created, ...(cur ?? [])]); setValue(""); setNote(""); }
    } catch (e) { if (alive.current) setAddErr(`Couldn't add: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setAdding(false); }
  }
  async function remove(d: DoNotContact) {
    if (!window.confirm(`Remove ${d.value} from the do-not-contact list? Outreach to it will no longer be blocked.`)) return;
    setBusyId(d.id); setRowErr("");
    try {
      await api.del(`/do-not-contact/${d.id}`);
      if (alive.current) setRows((cur) => cur && cur.filter((x) => x.id !== d.id));
    } catch (e) { if (alive.current) setRowErr(`Couldn't remove ${d.value}: ${errText(e, "request failed")}`); }
    finally { if (alive.current) setBusyId(""); }
  }

  return (
    <div className="su">
      <form className="su-add" onSubmit={(e) => { e.preventDefault(); if (!adding) void add(); }}>
        <div className="bx-f su-reason"><label className="fl" htmlFor="dnc-kind">Type</label>
          <select id="dnc-kind" className="in" value={kind} onChange={(e) => { setKind(e.target.value as DncKind); setAddErr(""); }}>
            {DNC_KINDS.map((k) => <option key={k} value={k}>{DNC_KIND_LABEL[k]}</option>)}
          </select></div>
        <div className="bx-f su-grow"><label className="fl" htmlFor="dnc-value">Value</label>
          <input id="dnc-value" className="in" value={value} placeholder={dncValueHint(kind)} onChange={(e) => { setValue(e.target.value); setAddErr(""); }} /></div>
        <div className="bx-f su-reason"><label className="fl" htmlFor="dnc-reason">Reason</label>
          <select id="dnc-reason" className="in" value={reason} onChange={(e) => setReason(e.target.value as DncReason)}>
            {DNC_REASONS.map((r) => <option key={r} value={r}>{dncReasonLabel(r)}</option>)}
          </select></div>
        <div className="bx-f su-grow"><label className="fl" htmlFor="dnc-note">Note (optional)</label>
          <input id="dnc-note" className="in" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></div>
        <button type="submit" className="btn primary" disabled={adding}><Icon name="plus" size={16} className="bx-plus" />{adding ? "Adding…" : "Add to list"}</button>
      </form>
      {addErr && <p className="bx-err" role="alert">{addErr}</p>}
      {loadErr && <p className="bx-err" role="alert">{loadErr}</p>}
      {rowErr && <p className="bx-err" role="alert">{rowErr}</p>}
      {!rows ? (loadErr ? null : <p className="bx-muted">Loading…</p>)
        : !rows.length ? <p className="bx-empty">Nothing listed yet. Add an email, a domain or a company name above and outreach to it is blocked, with the reason shown on the approval.</p>
        : (
          <div className="su-table" role="table" aria-label="Do-not-contact list">
            <div className="su-row head" role="row">
              <span role="columnheader">Value</span><span role="columnheader">Reason</span><span role="columnheader">Note</span><span role="columnheader">Added</span><span role="columnheader" aria-label="Remove" />
            </div>
            {rows.map((d) => (
              <div key={d.id} className="su-row" role="row">
                <span className="dom" role="cell">{DNC_KIND_LABEL[d.kind]} · {d.value}</span>
                <span role="cell"><Pill>{dncReasonLabel(d.reason)}</Pill></span>
                <span className="note" role="cell">{d.note || "—"}</span>
                <span className="added" role="cell">{shortDate(d.created_at)}</span>
                <span role="cell"><button type="button" className="su-x" disabled={busyId === d.id} onClick={() => void remove(d)} aria-label={`Remove ${d.value}`}><Icon name="x" size={14} /></button></span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
