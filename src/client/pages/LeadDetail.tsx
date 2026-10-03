import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { STATUSES, type Business, type LeadStatus } from "../types";

interface Finding { code: string; severity: string; points: number; evidence: string; }
interface Audit { score: number; offer: string; partial: boolean; site_status: string; findings: Finding[]; created_at: string; }
interface Contact { id: string; type: string; value: string; source_url: string | null; person_name: string | null; role: string | null; }
interface Draft { id: string; subject: string; body: string; recipient_reason: string; edited: boolean; }
interface Data { business: Business; audit: Audit | null; contacts: Contact[]; draft: Draft | null; toContact: Contact | null; }

export default function LeadDetail() {
  const { id } = useParams();
  const [d, setD] = useState<Data | null>(null);
  const [subject, setSubject] = useState(""); const [body, setBody] = useState("");
  const [steer, setSteer] = useState(""); const [busy, setBusy] = useState(""); const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");

  async function load() {
    const x = await api.get<Data>(`/leads/${id}`);
    setD(x); setSubject(x.draft?.subject ?? ""); setBody(x.draft?.body ?? ""); setNotes(x.business.notes ?? "");
  }
  useEffect(() => { load(); }, [id]);
  if (!d) return <p>Loading…</p>;
  const b = d.business;
  const dirty = d.draft && (subject !== d.draft.subject || body !== d.draft.body);

  async function saveDraft() { if (dirty) await api.patch(`/leads/${id}/draft`, { subject, body }); }
  async function setStatus(s: LeadStatus) { await api.patch(`/leads/${id}`, { leadStatus: s }); await load(); }
  async function copy() { await saveDraft(); await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); setMsg("Copied"); }
  async function copyAndMark() { await copy(); await setStatus("contacted"); setMsg("Copied and marked contacted"); }
  async function regenerate() {
    setBusy("regen"); setMsg("");
    try { await api.post(`/leads/${id}/regenerate`, { steeringNote: steer }); setSteer(""); await load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  }
  async function reaudit() { await api.post(`/leads/${id}/reaudit`); setMsg("Re-audit started. Refresh in a minute."); }
  const mailto = d.toContact ? `mailto:${d.toContact.value}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null;

  return (
    <div className="grid2">
      <div className="card">
        <h2>{b.name}</h2>
        <p className="muted">{b.category} · {b.address}</p>
        <p className="row">
          {b.website_url ? <a href={b.website_url} target="_blank" rel="noreferrer">Website</a> : <span className="badge">no website</span>}
          {b.maps_url && <a href={b.maps_url} target="_blank" rel="noreferrer">Google Maps</a>}
          {b.phone && <span>{b.phone}</span>}
        </p>
        {b.last_error && <p className="error">⚠ {b.last_error}</p>}
        {d.audit ? <>
          <h3>Score {d.audit.score} <span className="badge">{d.audit.offer}</span> {d.audit.partial && <span className="badge">partial audit</span>}</h3>
          <ul>{d.audit.findings.map((f) => <li key={f.code}><strong>+{f.points}</strong> {f.evidence}</li>)}</ul>
          <p className="muted">Audited {new Date(d.audit.created_at).toLocaleString()}</p>
        </> : <p className="muted">Audit in progress…</p>}
        <h3>Contacts</h3>
        <ul>{d.contacts.map((c) => (
          <li key={c.id}>{c.type}: {c.value}{c.person_name && ` (${c.person_name}${c.role ? `, ${c.role}` : ""})`}
            {c.source_url && <> · <a href={c.source_url} target="_blank" rel="noreferrer">source</a></>}</li>
        ))}{!d.contacts.length && <li className="muted">None found</li>}</ul>
        <label htmlFor="status">Status</label>
        <select id="status" value={b.lead_status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <label htmlFor="notes">Notes</label>
        <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => api.patch(`/leads/${id}`, { notes })} />
        <p className="row"><button onClick={reaudit}>Re-audit</button><button onClick={() => setStatus("skip")}>Skip</button></p>
      </div>

      <div className="card">
        <h2>Draft email</h2>
        {d.draft ? <>
          <p><strong>To:</strong> {d.toContact?.value ?? "—"} <span className="muted">({d.draft.recipient_reason})</span></p>
          <label htmlFor="subj">Subject</label>
          <input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={saveDraft} />
          <label htmlFor="body">Body</label>
          <textarea id="body" style={{ minHeight: 320 }} value={body} onChange={(e) => setBody(e.target.value)} onBlur={saveDraft} />
          <p className="muted">{body.trim().split(/\s+/).length} words</p>
          <p className="row">
            <button onClick={copy}>Copy email</button>
            {mailto && <a href={mailto} onClick={saveDraft}><button>Open in mail app</button></a>}
            <button className="primary" onClick={copyAndMark}>Copy & mark contacted</button>
          </p>
        </> : <p className="muted">No draft yet{d.audit && d.audit.score < 20 ? " (low priority lead)" : ""}.</p>}
        <label htmlFor="steer">Regenerate with a note (optional)</label>
        <div className="row">
          <input id="steer" style={{ flex: 1 }} placeholder="shorter / mention I'm local" value={steer} onChange={(e) => setSteer(e.target.value)} />
          <button onClick={regenerate} disabled={busy === "regen"}>{busy === "regen" ? "Writing…" : d.draft ? "Regenerate" : "Generate draft"}</button>
        </div>
        {msg && <p className="muted">{msg}</p>}
      </div>
    </div>
  );
}
