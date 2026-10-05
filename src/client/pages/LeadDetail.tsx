import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { safeHttpUrl } from "../links";
import HealthGauge from "../components/HealthGauge";
import { CategoryBars, FindingsList, Screenshots } from "../components/AuditPanel";
import PeoplePanel from "../components/PeoplePanel";
import CroPanel from "../components/CroPanel";
import { shareState } from "../reportView";
import type { CroItem, CroResponse } from "../cro";
import { NICHE_LABEL, OFFER_LABEL, STATUSES, type Activity, type Audit, type Business, type Contact, type LeadStatus, type Person } from "../types";

interface Draft { id: string; subject: string; body: string; recipient_reason: string; edited: boolean; created_at: string; steering_note: string | null; }
interface ShareReport { token: string; url: string; expiresAt: string; }
interface Data { business: Business; audit: Audit | null; contacts: Contact[]; draft: Draft | null; toContact: Contact | null; people: Person[]; activity: Activity[]; }

const LINK_LABEL: Record<string, string> = {
  contact: "Contact page", careers: "Careers / jobs", menu: "Menu", services: "Services", about: "About", team: "Team",
  booking: "Booking", pricing: "Pricing", locations: "Locations", portfolio: "Portfolio", testimonials: "Reviews", blog: "Blog", shop: "Shop",
};
const TONE_OPTIONS: [string, string][] = [["", "Default tone (from Settings)"], ["friendly_local", "Friendly local"], ["consultative", "Consultative expert"], ["direct", "Direct & short"], ["formal", "Formal"]];

const ACTIVITY_LABEL: Record<string, string> = {
  status: "Status", archived: "Archived", restored: "Restored", website: "Website changed", reaudit: "Re-audit",
  score_flagged: "Score flagged", export: "Exported", draft: "Draft", cro_audit: "CRO audit",
};

export default function LeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Data | null>(null);
  const [tab, setTab] = useState<"audit" | "cro" | "email">("audit");
  const [subject, setSubject] = useState(""); const [body, setBody] = useState("");
  const [steer, setSteer] = useState(""); const [busy, setBusy] = useState(""); const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const [croItems, setCroItems] = useState<CroItem[]>([]);
  const [croFocus, setCroFocus] = useState<Set<string>>(new Set());
  const [tone, setTone] = useState("");
  const [versions, setVersions] = useState<Draft[] | null>(null);
  const [attachPdf, setAttachPdf] = useState(true);
  const [exportLink, setExportLink] = useState<{ label: string; url: string }[]>([]);
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
  useEffect(() => {
    if (tab !== "email") return;
    api.get<Draft[]>(`/leads/${id}/drafts`).then(setVersions).catch(() => setVersions([]));
    api.get<CroResponse>(`/leads/${id}/cro-audit`).then((r) => {
      const usable = r.audit?.status === "done" ? r.items.filter((i) => i.included) : [];
      setCroItems(usable);
      setCroFocus((p) => new Set([...p].filter((k) => usable.some((i) => i.id === k)))); // drop picks from an older audit
    }).catch(() => { setCroItems([]); setCroFocus(new Set()); });
  }, [tab, id, d?.draft?.id]);
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
  const a = d.audit;
  const website = safeHttpUrl(b.website_url);
  const maps = safeHttpUrl(b.maps_url);
  const fail = (e: unknown) => setMsg((e as Error).message);

  function queue(fn: () => Promise<void>): Promise<void> {
    const run = pending.current.then(fn).catch(fail);
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
  async function patchLead(body: Record<string, unknown>): Promise<boolean> {
    await flush();
    try {
      const nb = await api.patch<Business>(`/leads/${id}`, body);
      setD((p) => (p ? { ...p, business: nb } : p));
      return true;
    } catch (e) { fail(e); return false; }
  }
  const setStatus = (s: LeadStatus) => patchLead({ leadStatus: s }).then(async (ok) => { if (ok) await load(); return ok; });
  async function copy(): Promise<boolean> {
    await saveDraft(); await flush();
    if (subject !== savedDraft.current.subject || body !== savedDraft.current.body) return false; // save failed; msg already set
    try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); setMsg("Copied"); return true; }
    catch (e) { fail(e); return false; }
  }
  async function copyAndMark() { if (await copy() && await setStatus("contacted")) setMsg("Copied and marked contacted"); }
  async function regenerate() {
    await flush(); setBusy("regen"); setMsg("");
    // Finding keys are "code:index" into the audit's findings.
    const focusIdx = [...focus].map((k) => Number(k.split(":").pop())).filter(Number.isInteger);
    try {
      await api.post(`/leads/${id}/regenerate`, { steeringNote: steer, focus: focusIdx, croFocus: [...croFocus], tone: tone || null });
      const picked = focusIdx.length + croFocus.size;
      setSteer(""); await load(); setMsg(picked ? `New draft focused on ${picked} chosen issue(s).` : "New draft written.");
    } catch (e) { fail(e); } finally { setBusy(""); }
  }
  async function exportTo(kind: "gmail" | "drive") {
    await saveDraft(); await flush(); setBusy(kind); setMsg(""); setExportLink([]);
    try {
      if (kind === "gmail") {
        const r = await api.post<{ url: string }>(`/leads/${id}/gmail-draft`, { attachReport: attachPdf });
        setExportLink([{ label: "Open Gmail draft", url: r.url }]); setMsg("Saved to your Gmail drafts. It hasn't been sent.");
      } else {
        const r = await api.post<{ docUrl: string; pdfUrl: string | null }>(`/leads/${id}/drive`);
        setExportLink([{ label: "Google Doc", url: r.docUrl }, ...(r.pdfUrl ? [{ label: "PDF in Drive", url: r.pdfUrl }] : [])]); setMsg("Saved to Google Drive.");
      }
      await load();
    } catch (e) { fail(e); } finally { setBusy(""); }
  }
  function loadVersion(v: Draft) { setSubject(v.subject); setBody(v.body); setMsg("Loaded an earlier version into the editor. Click outside the editor to save it."); }
  const toggleFocus = (k: string) => setFocus((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else if (n.size < 5) n.add(k); return n; });
  async function reaudit(reason?: string) {
    await flush();
    try { await api.post(`/leads/${id}/reaudit`, reason ? { reason } : {}); setMsg("Re-audit started. Refresh in a minute or two."); await load(); }
    catch (e) { fail(e); }
  }
  async function flagScore() {
    const reason = window.prompt("What looks wrong? (e.g. \"the site loads fine\", \"they do have a contact form\"). We'll note it and re-audit.");
    if (reason?.trim()) await reaudit(reason.trim());
  }
  async function archive(archived: boolean) {
    await flush();
    try { await api.post(`/leads/${id}/archive`, { archived }); await load(); setMsg(archived ? "Archived. It's hidden from your lead lists." : "Restored."); }
    catch (e) { fail(e); }
  }
  async function remove() {
    if (!window.confirm(`Permanently delete ${b.name} and its audit, drafts and notes? This can't be undone.`)) return;
    try { await api.del(`/leads/${id}`); nav("/leads"); } catch (e) { fail(e); }
  }
  async function saveUrl() {
    if (editingUrl === null) return;
    if (await patchLead({ websiteUrl: editingUrl.trim() || null })) { setEditingUrl(null); await reaudit(); }
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
  const links = Object.entries(a?.site_links ?? {}).map(([k, u]) => [k, safeHttpUrl(u)] as const).filter((x): x is readonly [string, string] => !!x[1]);
  const otherContacts = d.contacts.filter((c) => !(c.type === "email" && c.person_name));

  return (
    <div className="lead">
      <header className="lead-head card">
        <div className="lead-title">
          <h2>{b.name} {b.archived_at && <span className="tag">Archived</span>}</h2>
          <p className="muted">
            {[b.category, b.address].filter(Boolean).join(" · ")}
            {b.rating !== null && <> · ★ {b.rating}{b.review_count !== null && ` (${b.review_count} reviews)`}</>}
          </p>
          <div className="link-chips">
            {editingUrl !== null ? (
              <span className="row url-edit">
                <input value={editingUrl} onChange={(e) => setEditingUrl(e.target.value)} placeholder="example.com" aria-label="Website URL" autoFocus />
                <button className="primary" onClick={saveUrl}>Save & re-audit</button><button onClick={() => setEditingUrl(null)}>Cancel</button>
              </span>
            ) : <>
              {website ? <a className="chip-link" href={website} target="_blank" rel="noreferrer">Website ↗</a> : <span className="tag">No website</span>}
              <button className="link-btn" onClick={() => setEditingUrl(b.website_url ?? "")}>{website ? "Edit URL" : "Add URL"}</button>
            </>}
            {maps && <a className="chip-link" href={maps} target="_blank" rel="noreferrer">Google Maps ↗</a>}
            {b.phone && <a className="chip-link" href={`tel:${b.phone}`}>{b.phone}</a>}
            {links.map(([k, u]) => <a key={k} className={`chip-link${k === "careers" ? " hi" : ""}`} href={u} target="_blank" rel="noreferrer">{LINK_LABEL[k] ?? k} ↗</a>)}
          </div>
        </div>
        <div className="lead-actions">
          <button onClick={() => reaudit()}>Re-audit</button>
          <button onClick={flagScore} title="Tell us the audit got something wrong and re-run it">Score looks wrong</button>
          {b.archived_at ? <button onClick={() => archive(false)}>Restore</button> : <button onClick={() => archive(true)}>Archive</button>}
          <button className="danger" onClick={remove}>Delete</button>
        </div>
        {b.last_error && <p className="error">⚠ {b.last_error}</p>}
        {msg && <p className="muted" role="status">{msg}</p>}
      </header>

      <div className="lead-grid">
        <div className="lead-main">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "on" : ""} onClick={() => setTab("audit")}>Website audit</button>
            <button role="tab" aria-selected={tab === "cro"} className={tab === "cro" ? "on" : ""} onClick={() => setTab("cro")}>CRO audit</button>
            <button role="tab" aria-selected={tab === "email"} className={tab === "email" ? "on" : ""} onClick={() => setTab("email")}>Email draft</button>
          </div>

          {tab === "audit" && (a ? (
            <div className="card audit">
              <div className="audit-top">
                <HealthGauge score={a.health_score} />
                <div className="audit-summary">
                  <div className="row">
                    <span className="stat"><strong>{a.score}</strong> opportunity</span>
                    {a.niche && <span className="tag niche">{NICHE_LABEL[a.niche] ?? a.niche}</span>}
                    <span className="tag offer">Pitch: {OFFER_LABEL[a.offer] ?? a.offer}</span>
                    {a.partial && <span className="tag" title="Google's speed test didn't run">partial audit</span>}
                    {a.site_status === "blocked" && <span className="tag" title="The site's bot protection blocked our crawler">site blocks crawlers</span>}
                  </div>
                  {(a.seo_score != null || a.accessibility_score != null) && <p className="muted small">
                    {a.seo_score != null && <>Google SEO check {a.seo_score}/100</>}{a.seo_score != null && a.accessibility_score != null && " · "}
                    {a.accessibility_score != null && <>Accessibility {a.accessibility_score}/100</>}{a.platform && a.platform !== "other" && <> · Built with {a.platform}</>}</p>}
                  {a.ai_review?.value_proposition && <p className="value-prop">“{a.ai_review.value_proposition}”</p>}
                  <CategoryBars scores={a.category_scores} />
                </div>
              </div>
              {a.mail_warning && <div className="notice" role="status"><span>⚠ {a.mail_warning}</span></div>}
              <Screenshots leadId={b.id} audit={a} />
              {a.ai_review && a.ai_review.strengths.length > 0 && <>
                <h3>What's working</h3>
                <ul className="strengths">{a.ai_review.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
              </>}
              {a.ai_review && a.ai_review.niche_checklist.length > 0 && <>
                <h3>What a {NICHE_LABEL[a.ai_review.niche]?.toLowerCase() ?? "business"} site needs</h3>
                <ul className="checklist">{a.ai_review.niche_checklist.map((c) => <li key={c.item} className={c.present ? "yes" : "no"}>{c.present ? "✓" : "✗"} {c.item}</li>)}</ul>
              </>}
              <h3>All issues</h3>
              <FindingsList findings={a.findings} />
              <p className="muted small">Audited {new Date(a.created_at).toLocaleString()}{a.pagespeed_mobile !== null && ` · Google mobile speed ${a.pagespeed_mobile}/100`}</p>
            </div>
          ) : <div className="card"><p className="muted">Audit in progress…</p></div>)}

          {tab === "cro" && <CroPanel leadId={b.id} onError={setMsg} />}

          {tab === "email" && (
            <div className="card email-grid">
              <div>
                {d.draft ? <>
                  <p><strong>To:</strong> {d.toContact?.value ?? "—"} <span className="muted">({d.draft.recipient_reason})</span></p>
                  <label htmlFor="subj">Subject</label>
                  <input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={saveDraft} />
                  <label htmlFor="body">Body</label>
                  <textarea id="body" style={{ minHeight: 360 }} value={body} onChange={(e) => setBody(e.target.value)} onBlur={saveDraft} />
                  <p className="muted small">{body.trim().split(/\s+/).length} words</p>
                  <p className="row">
                    <button onClick={copy}>Copy email</button>
                    {mailto && <a href={mailto} onClick={saveDraft}><button>Open in mail app</button></a>}
                    <button className="primary" onClick={copyAndMark}>Copy & mark contacted</button>
                  </p>
                </> : <p className="muted">No draft yet{a && a.score < 25 ? " (low priority lead)" : ""}.</p>}
                {versions && versions.length > 1 && <>
                  <h3>Earlier versions</h3>
                  <ul className="versions">{versions.map((v) => (
                    <li key={v.id} className={v.id === d.draft?.id ? "current" : ""}>
                      <span>{new Date(v.created_at).toLocaleString()} · {v.subject}{v.steering_note && <span className="muted"> · “{v.steering_note}”</span>}</span>
                      {v.id !== d.draft?.id && <button className="link-btn" onClick={() => loadVersion(v)}>Use</button>}
                    </li>
                  ))}</ul>
                </>}
              </div>
              <div>
                <h3>Rewrite this email</h3>
                <label htmlFor="tone">Tone for this email</label>
                <select id="tone" value={tone} onChange={(e) => setTone(e.target.value)}>
                  {TONE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <label htmlFor="steer">Extra instruction (optional)</label>
                <input id="steer" placeholder="shorter / mention I'm local / offer a discount" value={steer} onChange={(e) => setSteer(e.target.value)} />
                {a && <>
                  <label>Issues to lead with <span className="muted small">(pick up to 5; none = the most important)</span></label>
                  <div className="picker-box"><FindingsList findings={a.findings} selectable selected={focus} onToggle={toggleFocus} /></div>
                </>}
                {croItems.length > 0 && <>
                  <label>CRO opportunities <span className="muted small">(from the CRO audit; pick up to 5)</span></label>
                  <div className="picker-box">{croItems.map((i) => (
                    <label key={i.id} className="row small check"><input type="checkbox" checked={croFocus.has(i.id)} disabled={!croFocus.has(i.id) && croFocus.size >= 5}
                      onChange={() => setCroFocus((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else if (n.size < 5) n.add(i.id); return n; })} />{i.title}</label>
                  ))}</div>
                </>}
                <p className="row" style={{ marginTop: 12 }}>
                  <button className="primary" onClick={regenerate} disabled={busy === "regen"}>{busy === "regen" ? "Writing…" : d.draft ? "Regenerate email" : "Generate email"}</button>
                  {focus.size + croFocus.size > 0 && <button className="link-btn" onClick={() => { setFocus(new Set()); setCroFocus(new Set()); }}>Clear {focus.size + croFocus.size} selected</button>}
                </p>
              </div>
            </div>
          )}
        </div>

        <aside className="lead-side">
          {a && <div className="card export">
            <h3>Export & share</h3>
            <div className="export-grid">
              <a href={`/api/leads/${b.id}/report.html`} target="_blank" rel="noreferrer"><button>View report</button></a>
              <a href={`/api/leads/${b.id}/report.pdf`}><button>Download PDF</button></a>
              <button onClick={() => exportTo("gmail")} disabled={!d.draft || busy === "gmail"} title={d.draft ? "" : "Write a draft first"}>{busy === "gmail" ? "Saving…" : "Gmail draft"}</button>
              <button onClick={() => exportTo("drive")} disabled={busy === "drive"}>{busy === "drive" ? "Saving…" : "Save to Drive"}</button>
            </div>
            <label className="check"><input type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} /> Attach the audit PDF to the Gmail draft</label>
            {exportLink.length > 0 && <p className="row">{exportLink.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a>)}</p>}
            <p className="muted small">Nothing is ever sent from here. Gmail gets a draft for you to review.</p>
            <h3>Share link</h3>
            <p className="muted small">A public, read-only page of this audit's findings. Expires after 30 days; revoke any time.</p>
            {report && <>
              <input ref={linkInput} readOnly aria-label="Report link" value={location.origin + report.url} onFocus={(e) => e.currentTarget.select()} />
              <p className="muted small">Expires {new Date(report.expiresAt).toLocaleDateString()}</p>
            </>}
            {share.olderText && <p className="muted small">{share.olderText}</p>}
            <p className="row">
              {report ? <button onClick={copyLink}>Copy link</button> : <button onClick={createReport}>Create report link</button>}
              {share.canRevoke && <button onClick={revokeReport}>{share.revokeLabel}</button>}
            </p>
            {shareMsg && <p className="muted small" role="status">{shareMsg}</p>}
          </div>}
          <div className="card">
            <h3>Pipeline</h3>
            <label htmlFor="status">Status</label>
            <select id="status" value={b.lead_status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
              {STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
            <div className="field-row">
              <div>
                <label htmlFor="follow">Follow up</label>
                <input id="follow" type="date" value={b.follow_up_at ?? ""} onChange={(e) => patchLead({ followUpAt: e.target.value || null })} />
              </div>
              <div>
                <label htmlFor="deal">Deal value ($)</label>
                <input id="deal" type="number" min={0} step={100} defaultValue={b.deal_value ?? ""}
                  onBlur={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v !== b.deal_value) patchLead({ dealValue: v }); }} />
              </div>
            </div>
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
          </div>

          <div className="card">
            <h3>People</h3>
            <PeoplePanel leadId={b.id} people={d.people} contacts={d.contacts} onChange={() => load().catch(fail)} onError={setMsg} />
          </div>

          <div className="card">
            <h3>Contact details</h3>
            <ul className="plain">{otherContacts.map((c) => {
              const src = safeHttpUrl(c.source_url);
              const v = c.type === "form" || c.type === "social" ? safeHttpUrl(c.value) : null;
              return (
                <li key={c.id}><span className="muted">{c.type}</span> {v ? <a href={v} target="_blank" rel="noreferrer">{v.replace(/^https?:\/\/(www\.)?/, "")}</a> : c.value}
                  {src && c.type === "email" && <> · <a href={src} target="_blank" rel="noreferrer">source</a></>}</li>
              );
            })}{!otherContacts.length && <li className="muted">None found</li>}</ul>
          </div>

          {d.activity.length > 0 && (
            <div className="card">
              <h3>Activity</h3>
              <ul className="activity">{d.activity.map((x) => (
                <li key={x.id}><span>{ACTIVITY_LABEL[x.kind] ?? x.kind}{x.detail && `: ${x.detail}`}</span>
                  <time className="muted" dateTime={x.created_at}>{new Date(x.created_at).toLocaleDateString()}</time></li>
              ))}</ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
