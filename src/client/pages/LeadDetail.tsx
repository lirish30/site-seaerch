import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { safeHttpUrl } from "../links";
import HealthGauge from "../components/HealthGauge";
import { CategoryBars, FindingsList, Screenshots } from "../components/AuditPanel";
import PeoplePanel from "../components/PeoplePanel";
import { NICHE_LABEL, OFFER_LABEL, STATUSES, type Activity, type Audit, type Business, type Contact, type LeadStatus, type Person } from "../types";

interface Draft { id: string; subject: string; body: string; recipient_reason: string; edited: boolean; created_at: string; steering_note: string | null; }
interface Data { business: Business; audit: Audit | null; contacts: Contact[]; draft: Draft | null; toContact: Contact | null; people: Person[]; activity: Activity[]; }

const LINK_LABEL: Record<string, string> = {
  contact: "Contact page", careers: "Careers / jobs", menu: "Menu", services: "Services", about: "About", team: "Team",
  booking: "Booking", pricing: "Pricing", locations: "Locations", portfolio: "Portfolio", testimonials: "Reviews", blog: "Blog", shop: "Shop",
};
const TONE_OPTIONS: [string, string][] = [["", "Default tone (from Settings)"], ["friendly_local", "Friendly local"], ["consultative", "Consultative expert"], ["direct", "Direct & short"], ["formal", "Formal"]];

const ACTIVITY_LABEL: Record<string, string> = {
  status: "Status", archived: "Archived", restored: "Restored", website: "Website changed", reaudit: "Re-audit",
  score_flagged: "Score flagged", export: "Exported", draft: "Draft",
};

export default function LeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Data | null>(null);
  const [tab, setTab] = useState<"audit" | "email">("audit");
  const [subject, setSubject] = useState(""); const [body, setBody] = useState("");
  const [steer, setSteer] = useState(""); const [busy, setBusy] = useState(""); const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const [tone, setTone] = useState("");
  const [versions, setVersions] = useState<Draft[] | null>(null);
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
  }, [tab, id, d?.draft?.id]);
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
      await api.post(`/leads/${id}/regenerate`, { steeringNote: steer, focus: focusIdx, tone: tone || null });
      setSteer(""); await load(); setMsg(focusIdx.length ? `New draft focused on ${focusIdx.length} chosen issue(s).` : "New draft written.");
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
                  {a.ai_review?.value_proposition && <p className="value-prop">“{a.ai_review.value_proposition}”</p>}
                  <CategoryBars scores={a.category_scores} />
                </div>
              </div>
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
                <p className="row" style={{ marginTop: 12 }}>
                  <button className="primary" onClick={regenerate} disabled={busy === "regen"}>{busy === "regen" ? "Writing…" : d.draft ? "Regenerate email" : "Generate email"}</button>
                  {focus.size > 0 && <button className="link-btn" onClick={() => setFocus(new Set())}>Clear {focus.size} selected</button>}
                </p>
              </div>
            </div>
          )}
        </div>

        <aside className="lead-side">
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
