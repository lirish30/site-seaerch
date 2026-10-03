import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { safeHttpUrl } from "../links";
import { shareState } from "../reportView";
import { STATUSES, type Business, type LeadStatus } from "../types";

interface Finding { code: string; severity: string; points: number; evidence: string; }
interface Audit { score: number; offer: string; partial: boolean; site_status: string; findings: Finding[]; created_at: string; seo_score: number | null; accessibility_score: number | null; }
interface Contact { id: string; type: string; value: string; source_url: string | null; person_name: string | null; role: string | null; }
interface Draft { id: string; subject: string; body: string; recipient_reason: string; edited: boolean; }
interface ShareReport { token: string; url: string; expiresAt: string; }
interface Data { business: Business; audit: Audit | null; contacts: Contact[]; draft: Draft | null; toContact: Contact | null; }

export default function LeadDetail() {
  const { id } = useParams();
  const [d, setD] = useState<Data | null>(null);
  const [subject, setSubject] = useState(""); const [body, setBody] = useState("");
  const [steer, setSteer] = useState(""); const [busy, setBusy] = useState(""); const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");
  const [report, setReport] = useState<ShareReport | null>(null); const [otherActive, setOtherActive] = useState(0); const [shareMsg, setShareMsg] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  // Serialises saves and lets other actions wait for in-flight ones.
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const savedDraft = useRef({ subject: "", body: "" });
  const savedNotes = useRef("");

  async function load() {
    const x = await api.get<Data>(`/leads/${id}`);
    savedDraft.current = { subject: x.draft?.subject ?? "", body: x.draft?.body ?? "" };
    savedNotes.current = x.business.notes ?? "";
    setD(x); setSubject(savedDraft.current.subject); setBody(savedDraft.current.body); setNotes(savedNotes.current);
  }
  useEffect(() => { load().catch((e) => setMsg((e as Error).message)); }, [id]);
  const hasAudit = !!d?.audit;
  useEffect(() => {
    let cancelled = false;
    setReport(null); setOtherActive(0); setShareMsg("");
    if (hasAudit) api.get<{ report: ShareReport | null; otherActive: number }>(`/leads/${id}/report`)
      .then((r) => { if (!cancelled) { setReport(r.report); setOtherActive(r.otherActive); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [id, hasAudit, d?.audit?.created_at]);
  if (!d) return <p>{msg || "Loading…"}</p>;
  const b = d.business;
  const website = safeHttpUrl(b.website_url);
  const maps = safeHttpUrl(b.maps_url);

  function queue(fn: () => Promise<void>): Promise<void> {
    const run = pending.current.then(fn).catch((e) => setMsg((e as Error).message));
    pending.current = run;
    return run;
  }
  const flush = () => pending.current;
  const saveDraft = () => queue(async () => {
    if (!d!.draft || (subject === savedDraft.current.subject && body === savedDraft.current.body)) return;
    await api.patch(`/leads/${id}/draft`, { subject, body });
    savedDraft.current = { subject, body };
    setD((p) => (p && p.draft ? { ...p, draft: { ...p.draft, subject, body } } : p));
  });
  const saveNotes = () => queue(async () => {
    if (notes === savedNotes.current) return;
    const nb = await api.patch<Business>(`/leads/${id}`, { notes });
    savedNotes.current = notes;
    setD((p) => (p ? { ...p, business: nb } : p));
  });
  async function setStatus(s: LeadStatus): Promise<boolean> {
    await flush();
    try {
      const nb = await api.patch<Business>(`/leads/${id}`, { leadStatus: s });
      setD((p) => (p ? { ...p, business: nb } : p));
      return true;
    } catch (e) { setMsg((e as Error).message); return false; }
  }
  async function copy(): Promise<boolean> {
    await saveDraft(); await flush();
    if (subject !== savedDraft.current.subject || body !== savedDraft.current.body) return false; // save failed; msg already set
    try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); setMsg("Copied"); return true; }
    catch (e) { setMsg((e as Error).message); return false; }
  }
  async function copyAndMark() { if (await copy() && await setStatus("contacted")) setMsg("Copied and marked contacted"); }
  async function regenerate() {
    await flush(); setBusy("regen"); setMsg("");
    try { await api.post(`/leads/${id}/regenerate`, { steeringNote: steer }); setSteer(""); await load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  }
  async function reaudit() {
    await flush();
    try { await api.post(`/leads/${id}/reaudit`); setMsg("Re-audit started. Refresh in a minute."); }
    catch (e) { setMsg((e as Error).message); }
  }
  async function createReport() {
    setShareMsg("");
    try { setReport(await api.post<ShareReport>(`/leads/${id}/report`)); }
    catch (e) { setShareMsg((e as Error).message); }
  }
  async function revokeReport() {
    if (!confirm(otherActive > 0 ? "Revoke all report links for this business? Nobody with a link will be able to open it." : "Revoke this link? Anyone who has it will no longer be able to open the report.")) return;
    try { await api.del(`/leads/${id}/report`); setReport(null); setOtherActive(0); setShareMsg("Link revoked"); }
    catch (e) { setShareMsg((e as Error).message); }
  }
  async function copyLink() {
    if (!report) return;
    const link = location.origin + report.url;
    try { await navigator.clipboard.writeText(link); setShareMsg("Link copied"); }
    catch { linkInput.current?.select(); setShareMsg("Press Ctrl+C to copy the selected link"); }
  }
  const share = shareState(report, otherActive);
  const mailto = d.toContact ? `mailto:${d.toContact.value}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null;

  return (
    <div className="grid2">
      <div className="card">
        <h2>{b.name}</h2>
        <p className="muted">{b.category} · {b.address}</p>
        <p className="row">
          {website ? <a href={website} target="_blank" rel="noreferrer">Website</a> : <span className="badge">no website</span>}
          {maps && <a href={maps} target="_blank" rel="noreferrer">Google Maps</a>}
          {b.phone && <span>{b.phone}</span>}
        </p>
        {b.last_error && <p className="error">⚠ {b.last_error}</p>}
        {d.audit ? <>
          <h3>Score {d.audit.score} <span className="badge">{d.audit.offer}</span> {d.audit.partial && <span className="badge">partial audit</span>} {d.audit.site_status === "blocked" && <span className="badge" title="The site's bot protection blocked our crawler; only PageSpeed data was used">site blocks crawlers</span>}</h3>
          {(d.audit.seo_score != null || d.audit.accessibility_score != null) && <p className="muted">
            {d.audit.seo_score != null && <>SEO {d.audit.seo_score}/100</>}{d.audit.seo_score != null && d.audit.accessibility_score != null && " · "}
            {d.audit.accessibility_score != null && <>Accessibility {d.audit.accessibility_score}/100</>}</p>}
          <ul>{d.audit.findings.map((f) => <li key={f.code}><strong>+{f.points}</strong> {f.evidence}</li>)}</ul>
          <p className="muted">Audited {new Date(d.audit.created_at).toLocaleString()}</p>
          <h3>Share report</h3>
          {report && <>
            <input ref={linkInput} readOnly aria-label="Report link" value={location.origin + report.url} onFocus={(e) => e.currentTarget.select()} />
            <p className="muted">Expires {new Date(report.expiresAt).toLocaleDateString()}</p>
          </>}
          {share.olderText && <p className="muted">{share.olderText}</p>}
          <p className="row">
            {report ? <button onClick={copyLink}>Copy link</button> : <button onClick={createReport}>Create report link</button>}
            {share.canRevoke && <button onClick={revokeReport}>{share.revokeLabel}</button>}
          </p>
          {shareMsg && <p className="muted">{shareMsg}</p>}
        </> : <p className="muted">Audit in progress…</p>}
        <h3>Contacts</h3>
        <ul>{d.contacts.map((c) => {
          const src = safeHttpUrl(c.source_url);
          return (
            <li key={c.id}>{c.type}: {c.value}{c.person_name && ` (${c.person_name}${c.role ? `, ${c.role}` : ""})`}
              {src && <> · <a href={src} target="_blank" rel="noreferrer">source</a></>}</li>
          );
        })}{!d.contacts.length && <li className="muted">None found</li>}</ul>
        <label htmlFor="status">Status</label>
        <select id="status" value={b.lead_status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <label htmlFor="notes">Notes</label>
        <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
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
