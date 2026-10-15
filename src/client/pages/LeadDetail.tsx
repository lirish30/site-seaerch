import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { safeHttpUrl } from "../links";
import { FindingsList, Screenshots } from "../components/AuditPanel";
import BestOfferCard from "../components/BestOfferCard";
import Icon, { type IconName } from "../components/Icon";
import { NicheChecklist, Scorecard, TopProblems } from "../components/LeadOverview";
import { Badge } from "../components/Score";
import { followUpLabel, followUpTone, STAGE_LABEL } from "../leadView";
import { initials, leadTier, TIER_LABEL } from "../scoreView";
import PeoplePanel from "../components/PeoplePanel";
import StarToggle from "../components/StarToggle";
import CroPanel from "../components/CroPanel";
import { shareState } from "../reportView";
import { REASONS, reasonLabel, suppressedMessage } from "../suppressionView";
import { isSpendLimit, SPEND_LIMIT_REACHED } from "../spend";
import EmailComposer, { type ComposerHandle } from "../components/EmailComposer";
import InlineError from "../components/InlineError";
import type { Draft } from "../emailView";
import { OFFER_LABEL, STATUSES, type Activity, type Audit, type AuditChanges, type BestOffer, type Business, type Contact, type FitResult, type LeadStatus, type LeadSuppression, type Person, type SuppressionReason } from "../types";

interface ShareReport { token: string; url: string; expiresAt: string; }
interface Data { business: Business; audit: Audit | null; contacts: Contact[]; draft: Draft | null; variants: Draft[]; toContact: Contact | null; people: Person[]; activity: Activity[]; changes: AuditChanges | null; urgency: number; best_offer: BestOffer | null; fit: FitResult; suppressed: LeadSuppression | null; }

const LINK_LABEL: Record<string, string> = {
  contact: "Contact page", careers: "Careers / jobs", menu: "Menu", services: "Services", about: "About", team: "Team",
  booking: "Booking", pricing: "Pricing", locations: "Locations", portfolio: "Portfolio", testimonials: "Reviews", blog: "Blog", shop: "Shop",
};

const PLATFORM_LABEL: Record<string, string> = { wordpress: "WordPress", godaddy: "GoDaddy", wix: "Wix", squarespace: "Squarespace", weebly: "Weebly", shopify: "Shopify", webflow: "Webflow" };

const LINK_ICON: Record<string, IconName> = {
  contact: "mail", careers: "briefcase", menu: "list", services: "list", about: "info", team: "users", booking: "calendar", pricing: "tag",
  locations: "pin", portfolio: "layout", testimonials: "star", blog: "file-text", shop: "tag",
};

const ACTIVITY_LABEL: Record<string, string> = {
  status: "Status", archived: "Archived", restored: "Restored", website: "Website changed", reaudit: "Re-audit",
  score_flagged: "Score flagged", export: "Exported", draft: "Draft", cro_audit: "CRO audit", suppressed: "Suppressed", import: "Imported", bulk: "Bulk change",
  today_done: "Marked done in Today", snoozed: "Snoozed in Today", starred: "Starred", unstarred: "Unstarred",
};

const TABS = ["overview", "issues", "plan", "email", "activity"] as const;
type Tab = (typeof TABS)[number];

/** "Since the Sep 2 audit: 2 new issues, 1 resolved, 9 unchanged", with the lists behind a toggle. */
function ChangesBar({ changes }: { changes: AuditChanges }) {
  const [open, setOpen] = useState(false);
  const list = (items: Audit["findings"]) => <ul>{items.map((f, i) => <li key={`${f.code}:${i}`}>{f.evidence}</li>)}</ul>;
  const none = changes.added.length === 0 && changes.resolved.length === 0;
  return (
    <>
      <div className="changes-bar" role="region" aria-label="Changes since last audit">
        <Icon name="refresh" size={14} />
        <b>Since the {new Date(changes.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })} audit</b>
        {none ? <span className="muted">No change in findings</span> : <>
          {changes.added.length > 0 && <Badge tone="critical" dot>{changes.added.length} new {changes.added.length === 1 ? "issue" : "issues"}</Badge>}
          {changes.resolved.length > 0 && <Badge tone="positive" dot>{changes.resolved.length} resolved</Badge>}
        </>}
        <span className="muted">{changes.unchangedCount} unchanged</span>
        <span className="grow" />
        {!none && <button className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Hide changes" : "Show changes"} <Icon name="chevron-down" size={14} className={open ? "flip" : undefined} /></button>}
      </div>
      {open && (
        <div className="changes-detail">
          {changes.added.length > 0 && <div className="added"><h4>New issues ({changes.added.length})</h4>{list(changes.added)}</div>}
          {changes.resolved.length > 0 && <div className="resolved"><h4>Resolved ({changes.resolved.length})</h4>{list(changes.resolved)}</div>}
        </div>
      )}
    </>
  );
}

/** A collapsible section of the properties panel. */
function PropSection({ icon, title, children, open = true, count }: { icon: IconName; title: string; children: React.ReactNode; open?: boolean; count?: number }) {
  return (
    <details className="prop-sec" open={open}>
      <summary><Icon name={icon} size={15} /><span className="grow">{title}{count !== undefined && <span className="muted"> · {count}</span>}</span><Icon name="chevron-down" size={14} className="chev" /></summary>
      <div className="prop-body">{children}</div>
    </details>
  );
}
const closeMenu = (e: React.MouseEvent<HTMLElement>) => e.currentTarget.closest("details")?.removeAttribute("open");

export default function LeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Data | null>(null);
  const [sp, setSp] = useSearchParams();
  const tab: Tab = TABS.includes(sp.get("tab") as Tab) ? (sp.get("tab") as Tab) : "overview";
  const setTab = (t: Tab) => setSp(t === "overview" ? {} : { tab: t }, { replace: true });
  const [busy, setBusy] = useState(""); const [msg, setMsg] = useState(""); const [exportError, setExportError] = useState("");
  const [notes, setNotes] = useState("");
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [starBusy, setStarBusy] = useState(false);
  const [attachPdf, setAttachPdf] = useState(true);
  const [exportLink, setExportLink] = useState<{ label: string; url: string }[]>([]);
  const [report, setReport] = useState<ShareReport | null>(null); const [otherActive, setOtherActive] = useState(0); const [shareMsg, setShareMsg] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  // Serialises saves and lets other actions wait for in-flight ones.
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const composer = useRef<ComposerHandle>(null);
  const savedNotes = useRef("");

  async function load() {
    const x = await api.get<Data>(`/leads/${id}`);
    savedNotes.current = x.business.notes ?? "";
    setD(x); setNotes(savedNotes.current);
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
  const toggleStar = async () => {
    if (starBusy) return;
    setStarBusy(true);
    try { if (await patchLead({ starred: !d!.business.starred_at })) await load(); } finally { setStarBusy(false); }
  };
  const setStatus = (s: LeadStatus) => patchLead({ leadStatus: s }).then(async (ok) => { if (ok) await load(); return ok; });
  async function exportTo(kind: "gmail" | "drive") {
    await composer.current?.save(); await flush(); setBusy(kind); setMsg(""); setExportLink([]); setExportError("");
    try {
      if (kind === "gmail") {
        const r = await api.post<{ url: string }>(`/leads/${id}/gmail-draft`, { attachReport: attachPdf });
        setExportLink([{ label: "Open Gmail draft", url: r.url }]); setMsg("Saved to your Gmail drafts. It hasn't been sent.");
      } else {
        const r = await api.post<{ docUrl: string; pdfUrl: string | null }>(`/leads/${id}/drive`);
        setExportLink([{ label: "Google Doc", url: r.docUrl }, ...(r.pdfUrl ? [{ label: "PDF in Drive", url: r.pdfUrl }] : [])]); setMsg("Saved to Google Drive.");
      }
      await load();
    } catch (e) { setExportError((e as Error).message); } finally { setBusy(""); }
  }
  async function reaudit(reason?: string) {
    await flush();
    try { await api.post(`/leads/${id}/reaudit`, reason ? { reason } : {}); setMsg("Re-audit started. Refresh in a minute or two."); await load(); }
    catch (e) { if (isSpendLimit(e)) setMsg(SPEND_LIMIT_REACHED); else fail(e); }
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
  async function suppress(reason: SuppressionReason) {
    if (!window.confirm(`Mark ${b.name} as ${reasonLabel(reason).toLowerCase()}? Searches will skip it, and its draft and export buttons will be turned off. You can undo this under Suppressions in Settings.`)) return;
    await flush(); setMsg("");
    try { await api.post(`/leads/${id}/suppress`, { reason }); await load(); setMsg(`Marked as ${reasonLabel(reason).toLowerCase()}.`); }
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
  const links = Object.entries(a?.site_links ?? {}).map(([k, u]) => [k, safeHttpUrl(u)] as const).filter((x): x is readonly [string, string] => !!x[1]);
  const otherContacts = d.contacts.filter((c) => !(c.type === "email" && c.person_name));

  const tier = a ? leadTier(a.score) : null;
  const followTone = followUpTone(b.follow_up_at);
  const poc = d.people.find((p) => p.is_poc);
  const writeEmail = () => setTab("email");
  const issueCount = a?.findings.length ?? 0;

  return (
    <div className="lead-page">
      <header className="lead-header">
        <div className="crumbs">
          <Link to="/leads"><Icon name="chevron-left" size={14} />All leads</Link>
          {tier && <><span>/</span><span className="here">{TIER_LABEL[tier]}</span></>}
        </div>
        <div className="title-row">
          <div className="avatar-lg" aria-hidden="true">{initials(b.name)}</div>
          <div className="title-main">
            <h1>{b.name}<StarToggle on={b.starred_at !== null} name={b.name} busy={starBusy} onClick={() => void toggleStar()} size={18} />{b.archived_at && <span className="tag">Archived</span>}</h1>
            <div className="meta-line">
              {b.category && <span><Icon name="briefcase" size={14} />{b.category}</span>}
              {b.address && <span><Icon name="pin" size={14} />{b.address}</span>}
              {b.rating !== null && <span><Icon name="star" size={14} />{b.rating}{b.review_count !== null && ` · ${b.review_count.toLocaleString("en-US")} reviews`}</span>}
              {a?.platform && a.platform !== "other" && <span><Icon name="code" size={14} />{PLATFORM_LABEL[a.platform] ?? a.platform}</span>}
              {a?.partial && <span title="Google's speed test didn't run">Partial audit</span>}
              {a?.site_status === "blocked" && <span title="The site's bot protection blocked our crawler">Site blocks crawlers</span>}
            </div>
          </div>
          <div className="title-actions">
            <button className="btn" onClick={() => reaudit()}><Icon name="refresh" size={16} />Re-audit</button>
            <details className="menu">
              <summary className="btn btn-icon" aria-label="More actions" title="More actions"><Icon name="more" size={16} /></summary>
              <div className="menu-list">
                {!d.suppressed && <>
                  <p className="menu-label">Mark as</p>
                  {REASONS.map((r) => <button key={r} onClick={(e) => { closeMenu(e); void suppress(r); }}>{reasonLabel(r)}</button>)}
                  <hr />
                </>}
                <button onClick={(e) => { closeMenu(e); void flagScore(); }} title="Tell us the audit got something wrong and re-run it">Score looks wrong</button>
                {b.archived_at ? <button onClick={(e) => { closeMenu(e); void archive(false); }}>Restore</button> : <button onClick={(e) => { closeMenu(e); void archive(true); }}>Archive</button>}
                <hr />
                <button className="danger" onClick={(e) => { closeMenu(e); void remove(); }}>Delete lead</button>
              </div>
            </details>
            <button className="btn primary" onClick={writeEmail}><Icon name="send" size={16} />Write email</button>
          </div>
        </div>
        <div className="link-row">
          {editingUrl !== null ? (
            <span className="row url-edit">
              <input value={editingUrl} onChange={(e) => setEditingUrl(e.target.value)} placeholder="example.com" aria-label="Website URL" autoFocus />
              <button className="primary" onClick={saveUrl}>Save & re-audit</button><button onClick={() => setEditingUrl(null)}>Cancel</button>
            </span>
          ) : <>
            {website ? <a className="chip-link" href={website} target="_blank" rel="noreferrer"><Icon name="globe" size={13} />{website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}<Icon name="arrow-up-right" size={12} /></a> : <span className="chip-link">No website</span>}
            <button className="link-btn" onClick={() => setEditingUrl(b.website_url ?? "")}>{website ? "Edit URL" : "Add URL"}</button>
          </>}
          {maps && <a className="chip-link" href={maps} target="_blank" rel="noreferrer"><Icon name="pin" size={13} />Google Maps<Icon name="arrow-up-right" size={12} /></a>}
          {b.phone && <a className="chip-link" href={`tel:${b.phone}`}><Icon name="phone" size={13} />{b.phone}</a>}
          {links.map(([k, u]) => <a key={k} className="chip-link" href={u} target="_blank" rel="noreferrer"><Icon name={LINK_ICON[k] ?? "link"} size={13} />{LINK_LABEL[k] ?? k}</a>)}
        </div>
        {d.suppressed && (
          <div className="suppressed-banner" role="alert">
            <span>{suppressedMessage(d.suppressed)}</span>
            <Link to="/settings">Manage suppressions</Link>
          </div>
        )}
        {(b.last_error || msg) && <div className="lead-notes">
          {b.last_error && <p className="error"><Icon name="alert" size={14} /> {b.last_error}</p>}
          {msg && <p className="muted" role="status">{msg}</p>}
        </div>}
      </header>

      <nav className="lead-tabs" role="tablist" aria-label="Lead sections">
        <button role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>Overview</button>
        <button role="tab" aria-selected={tab === "issues"} onClick={() => setTab("issues")}>Website issues{a && <span className="count">{issueCount}</span>}</button>
        <button role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>Conversion plan</button>
        <button role="tab" aria-selected={tab === "email"} onClick={() => setTab("email")}>Email draft{d.draft && <span className="count ready">Ready</span>}</button>
        <button role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity{d.activity.length > 0 && <span className="count">{d.activity.length}</span>}</button>
      </nav>

      <div className="lead-split">
        <div className="lead-content" role="tabpanel">
          {tab === "overview" && (a ? <>
            {a.mail_warning && <div className="notice" role="status"><span><Icon name="alert" size={14} /> {a.mail_warning}</span></div>}
            <Scorecard audit={a} business={b} fit={d.fit} urgency={d.urgency} />
            <div className="pitch-row">
              <BestOfferCard offer={d.best_offer} fallbackName={OFFER_LABEL[a.offer] ?? a.offer} onWriteEmail={writeEmail} canWrite={!d.suppressed} />
              <NicheChecklist audit={a} />
            </div>
            <TopProblems audit={a} onSeeAll={() => setTab("issues")} />
            {(a.screenshots.desktop || a.screenshots.mobile) && <section className="section-card needs"><h3>Screenshots</h3><Screenshots leadId={b.id} audit={a} /></section>}
            <p className="muted small">Audited {new Date(a.created_at).toLocaleString()}{a.pagespeed_mobile !== null && ` · Google mobile speed ${a.pagespeed_mobile}/100`}{a.seo_score != null && ` · Google SEO check ${a.seo_score}/100`}{a.accessibility_score != null && ` · Accessibility ${a.accessibility_score}/100`}</p>
          </> : <div className="section-card empty-state"><p>Audit in progress…</p><p className="muted small">Refresh in a minute or two.</p></div>)}

          {tab === "issues" && (a ? <>
            <div className="issues-bar">
              <span className="grow" />
              <span className="audited">Audited {new Date(a.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {b.scan_stage === "quick" ? "quick scan" : "full scan"}</span>
              <button className="link-btn" onClick={flagScore} title="Tell us the audit got something wrong and re-run it"><Icon name="alert" size={14} /> Score looks wrong?</button>
            </div>
            {d.changes && <ChangesBar changes={d.changes} />}
            <FindingsList findings={a.findings} scores={a.category_scores} added={d.changes?.added} auditCreatedAt={a.created_at} />
          </> : <div className="section-card empty-state"><p>Audit in progress…</p></div>)}

          {tab === "plan" && <CroPanel leadId={b.id} onError={setMsg} />}

          {tab === "email" && (
            <EmailComposer ref={composer} leadId={b.id} draft={d.draft} variants={d.variants ?? []} toContact={d.toContact} suppressed={!!d.suppressed}
              lowPriority={!!a && a.score < 25} findings={a?.findings ?? []} onChanged={load} onMessage={setMsg}
              onMarkContacted={async () => { const ok = await setStatus("contacted"); return ok; }} />
          )}

          {tab === "activity" && (
            <section className="section-card needs">
              <h3>Activity</h3>
              {d.activity.length ? (
                <ul className="timeline">{d.activity.map((x) => (
                  <li key={x.id}><span className="t-main">{ACTIVITY_LABEL[x.kind] ?? x.kind}{x.detail && `: ${x.detail}`}</span>
                    <time dateTime={x.created_at}>{new Date(x.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time></li>
                ))}</ul>
              ) : <p className="muted">Nothing yet. Status changes, exports and re-audits show up here.</p>}
            </section>
          )}
        </div>

        <aside className="lead-props" aria-label="Lead properties">
          <PropSection icon="kanban" title="Pipeline">
            <div className="prop-row">
              <label htmlFor="status">Stage</label>
              <select id="status" value={b.lead_status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
                {STATUSES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
              </select>
            </div>
            <div className="prop-row">
              <label htmlFor="follow">Follow up</label>
              <input id="follow" type="date" value={b.follow_up_at ?? ""} onChange={(e) => patchLead({ followUpAt: e.target.value || null })} />
            </div>
            {b.follow_up_at && <p className={`prop-hint ${followTone}`}>{followUpLabel(b.follow_up_at)}</p>}
            <div className="prop-row">
              <label htmlFor="deal">Deal value ($)</label>
              <input id="deal" type="number" min={0} step={100} defaultValue={b.deal_value ?? ""}
                onBlur={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v !== b.deal_value) patchLead({ dealValue: v }); }} />
            </div>
            <textarea id="notes" aria-label="Notes" placeholder="Add a note…" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
          </PropSection>

          <PropSection icon="user" title="Point of contact">
            <PeoplePanel leadId={b.id} people={d.people} contacts={d.contacts} onChange={() => load().catch(fail)} onError={setMsg} />
            {poc === undefined && d.toContact && <p className="prop-note">Suggested: {d.toContact.value}</p>}
          </PropSection>

          {a && <PropSection icon="send" title="Share & export">
            <div className="btn-row">
              <a className="btn" href={`/api/leads/${b.id}/report.html`} target="_blank" rel="noreferrer"><Icon name="eye" size={14} />Report</a>
              <a className="btn" href={`/api/leads/${b.id}/report.pdf`}><Icon name="file-text" size={14} />PDF</a>
              <button onClick={() => exportTo("gmail")} disabled={!d.draft || busy === "gmail" || !!d.suppressed} title={d.suppressed ? "Suppressed: exports are turned off" : d.draft ? "" : "Write a draft first"}><Icon name="mail" size={14} /> {busy === "gmail" ? "Saving…" : "Gmail draft"}</button>
              <button onClick={() => exportTo("drive")} disabled={busy === "drive" || !!d.suppressed} title={d.suppressed ? "Suppressed: exports are turned off" : ""}>{busy === "drive" ? "Saving…" : "Save to Drive"}</button>
            </div>
            <label className="check"><input type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} /> Attach the audit PDF to the Gmail draft</label>
            <InlineError message={exportError} />
            {exportLink.length > 0 && <p className="row">{exportLink.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a>)}</p>}
            {report ? (
              <div className="link-box"><Icon name="link" size={14} />
                <input ref={linkInput} readOnly aria-label="Report link" value={location.origin + report.url} onFocus={(e) => e.currentTarget.select()} />
                <button onClick={copyLink} aria-label="Copy link" title="Copy link"><Icon name="copy" size={14} /></button>
              </div>
            ) : <div className="btn-row"><button onClick={createReport} disabled={!!d.suppressed} title={d.suppressed ? "Suppressed: sharing is turned off" : ""}><Icon name="link" size={14} /> Create report link</button></div>}
            {report && <p className="prop-note">Link expires {new Date(report.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · nothing is ever sent from here</p>}
            {!report && <p className="prop-note">A public, read-only page of the findings. Expires after 30 days. Nothing is ever sent from here.</p>}
            {share.olderText && <p className="prop-note">{share.olderText}</p>}
            {share.canRevoke && <div className="btn-row"><button onClick={revokeReport}>{share.revokeLabel}</button></div>}
            {shareMsg && <p className="prop-note" role="status">{shareMsg}</p>}
          </PropSection>}

          <PropSection icon="phone" title="Contact details">
            {otherContacts.map((c) => {
              const src = safeHttpUrl(c.source_url);
              const v = c.type === "form" || c.type === "social" ? safeHttpUrl(c.value) : null;
              return (
                <div key={c.id} className="kv"><span className="k">{c.type}</span>
                  <span className="v">{v ? <a href={v} target="_blank" rel="noreferrer">{v.replace(/^https?:\/\/(www\.)?/, "")}</a> : c.value}
                    {src && c.type === "email" && <> · <a href={src} target="_blank" rel="noreferrer">source</a></>}</span></div>
              );
            })}
            {!otherContacts.length && <p className="muted small">None found</p>}
          </PropSection>

          <PropSection icon="clock" title="Activity" open={d.activity.length > 0}>
            {d.activity.length ? <>
              <ul className="act-list">{d.activity.slice(0, 3).map((x) => (
                <li key={x.id}><span>{ACTIVITY_LABEL[x.kind] ?? x.kind}{x.detail && `: ${x.detail}`}</span>
                  <time dateTime={x.created_at}>{new Date(x.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></li>
              ))}</ul>
              {d.activity.length > 3 && <button className="link-btn" onClick={() => setTab("activity")}>See all {d.activity.length}</button>}
            </> : <p className="muted small">Nothing yet</p>}
          </PropSection>
        </aside>
      </div>
    </div>
  );
}
