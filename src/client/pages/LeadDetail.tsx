import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { safeHttpUrl } from "../links";
import { FindingsList, Screenshots } from "../components/AuditPanel";
import BestOfferCard from "../components/BestOfferCard";
import Icon, { type IconName } from "../components/Icon";
import { NicheChecklist, Scorecard, TopProblems } from "../components/LeadOverview";
import { Badge } from "../components/Score";
import { announceLeadsChanged } from "../components/Shell";
import { followUpLabel, followUpTone, STAGE_LABEL } from "../leadView";
import { initials, leadTier, TIER_LABEL } from "../scoreView";
import ActivityTab from "../components/ActivityTab";
import PeoplePanel from "../components/PeoplePanel";
import StarToggle from "../components/StarToggle";
import CroPanel from "../components/CroPanel";
import { shareState } from "../reportView";
import { REASONS, reasonLabel, suppressedMessage } from "../suppressionView";
import { isSpendLimit, SPEND_LIMIT_REACHED } from "../spend";
import EmailComposer, { type ComposerHandle } from "../components/EmailComposer";
import InlineError from "../components/InlineError";
import JobsPanel from "../components/JobsPanel";
import type { Draft } from "../emailView";
import type { CroResponse } from "../cro";
import { NICHE_LABEL, OFFER_LABEL, STATUSES, type Activity, type Audit, type AuditChanges, type BestOffer, type Business, type Contact, type FitProfile, type FitResult, type LeadStatus, type LeadSuppression, type Person, type SuppressionReason } from "../types";

interface ShareReport { token: string; url: string; expiresAt: string; }
interface Data { business: Business; audit: Audit | null; contacts: Contact[]; draft: Draft | null; variants: Draft[]; toContact: Contact | null; people: Person[]; activity: Activity[]; changes: AuditChanges | null; urgency: number; best_offer: BestOffer | null; fit: FitResult; suppressed: LeadSuppression | null; }

const LINK_LABEL: Record<string, string> = {
  contact: "Contact page", careers: "Careers / jobs", menu: "Menu", services: "Services", about: "About", team: "Team",
  booking: "Booking", pricing: "Pricing", locations: "Locations", portfolio: "Portfolio", testimonials: "Reviews", blog: "Blog", shop: "Shop",
};
const LINK_ICON: Record<string, IconName> = {
  contact: "mail", careers: "briefcase", menu: "list", services: "list", about: "info", team: "users", booking: "calendar", pricing: "tag",
  locations: "pin", portfolio: "layout", testimonials: "star", blog: "file-text", shop: "tag",
};
const PLATFORM_LABEL: Record<string, string> = { wordpress: "WordPress", godaddy: "GoDaddy", wix: "Wix", squarespace: "Squarespace", weebly: "Weebly", shopify: "Shopify", webflow: "Webflow" };
const SOCIAL_NAME: [RegExp, string][] = [[/facebook|fb\.com/, "Facebook"], [/instagram/, "Instagram"], [/linkedin/, "LinkedIn"], [/twitter|x\.com/, "X"], [/youtube/, "YouTube"], [/tiktok/, "TikTok"], [/yelp/, "Yelp"]];

const ACTIVITY_LABEL: Record<string, string> = {
  note: "Note",
  status: "Status", archived: "Archived", restored: "Restored", website: "Website changed", reaudit: "Re-audit",
  score_flagged: "Score flagged", export: "Exported", draft: "Draft", cro_audit: "CRO audit", suppressed: "Suppressed", import: "Imported", bulk: "Bulk change",
  today_done: "Marked done in Today", snoozed: "Snoozed in Today", starred: "Starred", unstarred: "Unstarred", job_found: "New role spotted",
};

const TABS = ["overview", "issues", "plan", "email", "activity"] as const;
type Tab = (typeof TABS)[number];
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "Since the Sep 2 audit  [2 new issues] [1 resolved]  9 unchanged", with the lists behind a toggle. */
function ChangesBar({ changes }: { changes: AuditChanges }) {
  const [open, setOpen] = useState(false);
  const list = (items: Audit["findings"]) => <ul>{items.map((f, i) => <li key={`${f.code}:${i}`}>{f.evidence}</li>)}</ul>;
  const none = changes.added.length === 0 && changes.resolved.length === 0;
  return (
    <>
      <div className="changes-bar" role="region" aria-label="Changes since last audit">
        <Icon name="refresh" size={15} />
        <b>Since the {dayLabel(changes.since)} audit</b>
        {none ? <span className="meta">No change in findings</span> : <>
          {changes.added.length > 0 && <Badge tone="critical" dot>{changes.added.length} new {changes.added.length === 1 ? "issue" : "issues"}</Badge>}
          {changes.resolved.length > 0 && <Badge tone="positive" dot>{changes.resolved.length} resolved</Badge>}
        </>}
        <span className="meta">{changes.unchangedCount} unchanged</span>
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
function PropSection({ icon, title, children, open = true }: { icon: IconName; title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="prop-sec" open={open}>
      <summary><Icon name={icon} size={15} /><span className="grow">{title}</span><Icon name="chevron-down" size={14} className="chev" /></summary>
      <div className="prop-body">{children}</div>
    </details>
  );
}
const closeMenu = (e: React.MouseEvent<HTMLElement>) => e.currentTarget.closest("details")?.removeAttribute("open");

/** The leads the user was looking at when they opened this one (saved by the list), so the page can offer previous / next. */
function listContext(id: string | undefined) {
  try {
    const ids: string[] = JSON.parse(sessionStorage.getItem("leads:order") ?? "[]");
    const at = ids.indexOf(id ?? "");
    return { ids, at, back: sessionStorage.getItem("leads:list") ?? "/leads" };
  } catch { return { ids: [] as string[], at: -1, back: "/leads" }; }
}

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
  // The default comes from Settings → Google; the menu checkbox overrides it for this lead.
  useEffect(() => { api.get<{ settings: Record<string, string | number> }>("/settings").then((r) => setAttachPdf(Number(r.settings.attach_audit_pdf ?? 1) !== 0)).catch(() => {}); }, []);
  const [exportLink, setExportLink] = useState<{ label: string; url: string }[]>([]);
  const [report, setReport] = useState<ShareReport | null>(null); const [otherActive, setOtherActive] = useState(0); const [shareMsg, setShareMsg] = useState("");
  const [profiles, setProfiles] = useState<FitProfile[]>([]);
  const [croCount, setCroCount] = useState<number | null>(null);
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const [managePeople, setManagePeople] = useState(false);
  const [dealText, setDealText] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  // Serialises saves and lets other actions wait for in-flight ones.
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const composer = useRef<ComposerHandle>(null);
  const savedNotes = useRef("");

  async function load() {
    const x = await api.get<Data>(`/leads/${id}`);
    savedNotes.current = x.business.notes ?? "";
    setD(x); setNotes(savedNotes.current);
    announceLeadsChanged();
  }
  useEffect(() => { setFocus(new Set()); setManagePeople(false); load().catch((e) => setMsg((e as Error).message)); }, [id]);
  useEffect(() => { api.get<{ settings: { your_name: string } }>("/settings").then((r) => setUserName(r.settings.your_name ?? "")).catch(() => {}); }, []);
  useEffect(() => { api.get<FitProfile[]>("/fit-profiles").then(setProfiles).catch(() => setProfiles([])); }, []);
  useEffect(() => {
    api.get<CroResponse>(`/leads/${id}/cro-audit`).then((r) => setCroCount(r.audit?.status === "done" ? r.items.filter((i) => i.included).length : null)).catch(() => setCroCount(null));
  }, [id, tab === "plan"]);
  const hasAudit = !!d?.audit;
  useEffect(() => {
    let cancelled = false;
    setReport(null); setOtherActive(0); setShareMsg("");
    if (hasAudit) api.get<{ report: ShareReport | null; otherActive: number }>(`/leads/${id}/report`)
      .then((r) => { if (!cancelled) { setReport(r.report); setOtherActive(r.otherActive); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [id, hasAudit, d?.audit?.created_at]);
  const ctx = useMemo(() => listContext(id), [id]);
  if (!d) return <p className="page-body">{msg || "Loading…"}</p>;
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
      announceLeadsChanged();
      return true;
    } catch (e) { fail(e); return false; }
  }
  const toggleStar = async () => {
    if (starBusy) return;
    setStarBusy(true);
    try { if (await patchLead({ starred: !d!.business.starred_at })) await load(); } finally { setStarBusy(false); }
  };
  const setStatus = (s: LeadStatus) => patchLead({ leadStatus: s }).then(async (ok) => { if (ok) await load(); return ok; });
  async function exportTo(kind: "gmail" | "drive", allowStaleRole = false) {
    await composer.current?.save(); await flush(); setBusy(kind); setMsg(""); setExportLink([]); setExportError("");
    try {
      if (kind === "gmail") {
        const r = await api.post<{ url: string }>(`/leads/${id}/gmail-draft`, { attachReport: attachPdf, allowStaleRole });
        setExportLink([{ label: "Open Gmail draft", url: r.url }]); setMsg("Saved to your Gmail drafts. It hasn't been sent.");
      } else {
        const r = await api.post<{ docUrl: string; pdfUrl: string | null }>(`/leads/${id}/drive`, { allowStaleRole });
        setExportLink([{ label: "Google Doc", url: r.docUrl }, ...(r.pdfUrl ? [{ label: "PDF in Drive", url: r.pdfUrl }] : [])]); setMsg("Saved to Google Drive.");
      }
      await load();
    } catch (e) {
      // The draft names a role that has closed (or stopped showing on their board): the owner decides, since they may have edited around it.
      if (e instanceof ApiError && e.code === "stale_role" && window.confirm(`${e.message}\n\nExport it anyway?`)) { setBusy(""); return exportTo(kind, true); }
      setExportError((e as Error).message);
    } finally { setBusy(""); }
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
    try { await api.del(`/leads/${id}`); announceLeadsChanged(); nav("/leads"); } catch (e) { fail(e); }
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
  const savedEmails = new Set(d.people.map((p) => (p.email ?? "").toLowerCase()).filter(Boolean));
  const foundPeople = d.contacts.filter((c) => c.type === "email" && c.person_name && !savedEmails.has(c.value.toLowerCase()));
  const poc = d.people.find((p) => p.is_poc) ?? d.people[0] ?? null;
  const profile = profiles.find((p) => p.id === d.fit.profile?.id) ?? null;

  const tier = a ? leadTier(a.score) : null;
  const followTone = followUpTone(b.follow_up_at);
  const writeEmail = () => setTab("email");
  const issueCount = a?.findings.length ?? 0;
  const niche = a?.niche ? NICHE_LABEL[a.niche] : null;
  const category = [b.category, niche && niche !== b.category ? niche : null].filter(Boolean).join(" · ");
  const go = (to: number) => { const t = ctx.ids[to]; if (t) nav(`/leads/${t}`); };
  const pickFocus = (key: string) => setFocus((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else if (n.size < 5) n.add(key); return n; });
  const socialName = (v: string) => SOCIAL_NAME.find(([re]) => re.test(v))?.[1] ?? "Social";
  const hostOf = (v: string) => v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

  return (
    <div className="lead-page">
      <header className="lead-header">
        <div className="crumbs">
          <Link to={ctx.back}><Icon name="chevron-left" size={14} />All leads</Link>
          {tier && <><span className="sep">/</span><span>{TIER_LABEL[tier]}</span></>}
          <span className="grow" />
          {ctx.at >= 0 && <>
            <span className="pos">{ctx.at + 1} of {ctx.ids.length}</span>
            <button className="nav-sq" aria-label="Previous lead" disabled={ctx.at <= 0} onClick={() => go(ctx.at - 1)}><Icon name="chevron-left" size={14} /></button>
            <button className="nav-sq" aria-label="Next lead" disabled={ctx.at >= ctx.ids.length - 1} onClick={() => go(ctx.at + 1)}><Icon name="chevron-right" size={14} /></button>
          </>}
        </div>
        <div className="title-row">
          <div className="avatar-lg" aria-hidden="true">{initials(b.name)}</div>
          <div className="title-main">
            <h1>{b.name}<StarToggle on={b.starred_at !== null} name={b.name} busy={starBusy} onClick={() => void toggleStar()} size={18} />{b.archived_at && <span className="tag">Archived</span>}</h1>
            <div className="meta-line">
              {category && <span><Icon name="briefcase" size={14} />{category}</span>}
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
              <summary className="btn icon-only" aria-label="More actions" title="More actions"><Icon name="more" size={16} /></summary>
              <div className="menu-list">
                <button onClick={(e) => { closeMenu(e); setEditingUrl(b.website_url ?? ""); }}>{website ? "Edit website URL" : "Add website URL"}</button>
                <button onClick={(e) => { closeMenu(e); void flagScore(); }} title="Tell us the audit got something wrong and re-run it">Score looks wrong</button>
                {!d.suppressed && <>
                  <hr />
                  <p className="menu-label">Mark as</p>
                  {REASONS.map((r) => <button key={r} onClick={(e) => { closeMenu(e); void suppress(r); }}>{reasonLabel(r)}</button>)}
                </>}
                <hr />
                {b.archived_at ? <button onClick={(e) => { closeMenu(e); void archive(false); }}>Restore</button> : <button onClick={(e) => { closeMenu(e); void archive(true); }}>Archive</button>}
                <button className="danger" onClick={(e) => { closeMenu(e); void remove(); }}>Delete lead</button>
              </div>
            </details>
            <button className="btn primary" onClick={writeEmail}><Icon name="send" size={16} />Write email</button>
          </div>
        </div>
        <div className="link-row">
          {editingUrl !== null ? (
            <span className="url-edit">
              <input value={editingUrl} onChange={(e) => setEditingUrl(e.target.value)} placeholder="example.com" aria-label="Website URL" autoFocus />
              <button className="btn primary sm" onClick={saveUrl}>Save & re-audit</button><button className="btn sm" onClick={() => setEditingUrl(null)}>Cancel</button>
            </span>
          ) : website
            ? <a className="chip-link" href={website} target="_blank" rel="noreferrer"><Icon name="globe" size={13} />{hostOf(website)}<Icon name="arrow-up-right" size={12} /></a>
            : <button className="chip-link" onClick={() => setEditingUrl("")}><Icon name="globe" size={13} />Add website</button>}
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
        <button role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>Conversion plan{croCount ? <span className="count">{croCount}</span> : null}</button>
        <button role="tab" aria-selected={tab === "email"} onClick={() => setTab("email")}>Email draft{d.draft && <span className="count ready">Ready</span>}</button>
        <button role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity{d.activity.length > 0 && <span className="count">{d.activity.length}</span>}</button>
      </nav>

      <div className="lead-split">
        <div className={`lead-content${tab === "issues" ? " tight" : ""}`} role="tabpanel">
          {tab === "overview" && (a ? <>
            {a.mail_warning && <div className="notice" role="status"><span><Icon name="alert" size={14} /> {a.mail_warning}</span></div>}
            <Scorecard audit={a} business={b} fit={d.fit} profile={profile} urgency={d.urgency} />
            <JobsPanel key={b.id} businessId={b.id} />
            <div className="pitch-row">
              <BestOfferCard offer={d.best_offer} fallbackName={OFFER_LABEL[a.offer] ?? a.offer} onWriteEmail={writeEmail} canWrite={!d.suppressed} />
              <NicheChecklist audit={a} />
            </div>
            <TopProblems audit={a} onSeeAll={() => setTab("issues")} />
            {(a.screenshots.desktop || a.screenshots.mobile) && <section className="section-card needs"><h3>Screenshots</h3><Screenshots leadId={b.id} audit={a} /></section>}
          </> : <>
            <JobsPanel key={b.id} businessId={b.id} />
            <div className="section-card empty-state"><p>Audit in progress…</p><p className="muted small">Refresh in a minute or two.</p></div>
          </>)}

          {tab === "issues" && (a
            ? <FindingsList findings={a.findings} scores={a.category_scores} added={d.changes?.added} selected={focus} onToggle={pickFocus}
                trailing={<>
                  <span className="audited" title={[`Audited ${new Date(a.created_at).toLocaleString()}`, a.pagespeed_mobile !== null && `Google mobile speed ${a.pagespeed_mobile}/100`, a.seo_score != null && `Google SEO check ${a.seo_score}/100`, a.accessibility_score != null && `Accessibility ${a.accessibility_score}/100`].filter(Boolean).join(" · ")}>Audited {dayLabel(a.created_at)} · {b.scan_stage === "quick" ? "quick scan" : "full scan"}</span>
                  <button className="btn-ghost-sm" onClick={flagScore} title="Tell us the audit got something wrong and re-run it"><Icon name="alert" size={16} />Score looks wrong?</button>
                </>}
                afterToolbar={d.changes ? <ChangesBar changes={d.changes} /> : null} />
            : <div className="section-card empty-state"><p>Audit in progress…</p></div>)}

          {tab === "plan" && <CroPanel leadId={b.id} onError={setMsg} />}

          {tab === "email" && (
            <EmailComposer ref={composer} leadId={b.id} draft={d.draft} variants={d.variants ?? []} toContact={d.toContact} suppressed={!!d.suppressed}
              lowPriority={!!a && a.score < 25} findings={a?.findings ?? []} onChanged={load} onMessage={setMsg}
              focus={focus} onFocusChange={setFocus} onGmailDraft={() => exportTo("gmail")} gmailBusy={busy === "gmail"}
              onMarkContacted={async () => { const ok = await setStatus("contacted"); return ok; }} />
          )}

          {tab === "activity" && (
            <ActivityTab items={d.activity} userName={userName} followUp={b.follow_up_at}
              onSetFollowUp={(day) => patchLead({ followUpAt: day })}
              onAddNote={async (text) => { try { await api.post(`/leads/${id}/notes`, { text }); await load(); return true; } catch (e) { fail(e); return false; } }} />
          )}
        </div>

        <aside className="lead-props" aria-label="Lead properties">
          <PropSection icon="kanban" title="Pipeline">
            <div className="prop-row">
              <label htmlFor="status">Stage</label>
              <span className="ctl">
                <select id="status" value={b.lead_status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
                  {STATUSES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                </select><Icon name="chevron-down" size={12} className="chev" />
              </span>
            </div>
            <div className="prop-row">
              <label htmlFor="follow">Follow up</label>
              <span className={`ctl ${followTone === "overdue" ? "late" : followTone === "today" ? "today" : ""}`}>
                <Icon name="calendar" size={13} />
                <span className="date-text" onClick={() => dateInput.current?.showPicker?.()}>{b.follow_up_at ? followUpLabel(b.follow_up_at) : "Set a date"}</span>
                <input id="follow" ref={dateInput} type="date" aria-label="Follow up date" value={b.follow_up_at ?? ""} onChange={(e) => patchLead({ followUpAt: e.target.value || null })} />
                <Icon name="chevron-down" size={12} className="chev" />
              </span>
            </div>
            <div className="prop-row">
              <label htmlFor="deal">Deal value</label>
              <span className="ctl">
                <input id="deal" inputMode="numeric" placeholder="$0"
                  value={dealText ?? (b.deal_value !== null ? `$${b.deal_value.toLocaleString("en-US")}` : "")}
                  onFocus={() => setDealText(b.deal_value !== null ? String(b.deal_value) : "")}
                  onChange={(e) => setDealText(e.target.value.replace(/[^\d]/g, ""))}
                  onBlur={() => { const v = dealText === null || dealText === "" ? null : Number(dealText); setDealText(null); if (v !== b.deal_value) void patchLead({ dealValue: v }); }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                <Icon name="chevron-down" size={12} className="chev" />
              </span>
            </div>
            <textarea id="notes" className="notes-box" aria-label="Notes" placeholder="Add a note…" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
          </PropSection>

          <PropSection icon="user" title="Point of contact">
            {poc ? (
              <>
                <div className="poc-head">
                  <span className="avatar-sm" aria-hidden="true">{initials(poc.name)}</span>
                  <span className="who">
                    <span className="nm">{poc.name}{poc.is_poc && <Badge tone="signal">POC</Badge>}</span>
                    {poc.role && <span className="role">{poc.role}</span>}
                  </span>
                </div>
                {poc.email && <a className="contact-link" href={`mailto:${poc.email}`}><Icon name="mail" size={14} /><span>{poc.email}</span></a>}
                {poc.phone && <a className="contact-link" href={`tel:${poc.phone}`}><Icon name="phone" size={14} /><span>{poc.phone}</span></a>}
                {poc.linkedin && safeHttpUrl(poc.linkedin) && <a className="contact-link" href={safeHttpUrl(poc.linkedin)!} target="_blank" rel="noreferrer"><Icon name="link" size={14} /><span>LinkedIn</span></a>}
              </>
            ) : <p className="muted small">{d.toContact ? `No point of contact yet. Suggested: ${d.toContact.value}` : "No point of contact yet."}</p>}
            {foundPeople.length > 0 && !managePeople && (
              <div className="found-box"><Icon name="sparkles" size={14} /><span className="grow">{foundPeople.length} more {foundPeople.length === 1 ? "person" : "people"} found on their site</span><button onClick={() => setManagePeople(true)}>Review</button></div>
            )}
            {managePeople
              ? <><PeoplePanel leadId={b.id} people={d.people} contacts={d.contacts} onChange={() => load().catch(fail)} onError={setMsg} /><button className="link-btn" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setManagePeople(false)}>Done</button></>
              : foundPeople.length === 0 && <button className="link-btn" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setManagePeople(true)}>{d.people.length ? "Manage people" : "Add a person"}</button>}
          </PropSection>

          {a && <PropSection icon="send" title="Share & export">
            <div className="btn-row nowrap">
              <a className="btn" href={`/api/leads/${b.id}/report.html`} target="_blank" rel="noreferrer"><Icon name="eye" size={16} />Report</a>
              <a className="btn" href={`/api/leads/${b.id}/report.pdf`}><Icon name="file-text" size={16} />PDF</a>
              <button className="btn" onClick={() => exportTo("gmail")} disabled={!d.draft || busy === "gmail" || !!d.suppressed} title={d.suppressed ? "Suppressed: exports are turned off" : d.draft ? "" : "Write a draft first"}><Icon name="mail" size={16} />{busy === "gmail" ? "Saving…" : "Gmail draft"}</button>
              <details className="menu share-more">
                <summary className="btn sm icon-only" aria-label="More export options" title="More export options"><Icon name="more" size={16} /></summary>
                <div className="menu-list">
                  <label className="menu-check"><input className="cb" type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} />Attach the audit PDF to Gmail drafts</label>
                  <button onClick={(e) => { closeMenu(e); void exportTo("drive"); }} disabled={busy === "drive" || !!d.suppressed} title={d.suppressed ? "Suppressed: exports are turned off" : ""}>{busy === "drive" ? "Saving to Drive…" : "Save to Google Drive"}</button>
                  {share.canRevoke && <button className="danger" onClick={(e) => { closeMenu(e); void revokeReport(); }}>{share.revokeLabel}</button>}
                </div>
              </details>
            </div>
            {report ? (
              <div className="link-box"><Icon name="link" size={14} />
                <input ref={linkInput} readOnly aria-label="Report link" value={location.host + report.url} onFocus={(e) => e.currentTarget.select()} />
                <button onClick={copyLink} aria-label="Copy link" title="Copy link"><Icon name="copy" size={14} /></button>
              </div>
            ) : <button className="link-box create" onClick={createReport} disabled={!!d.suppressed} title={d.suppressed ? "Suppressed: sharing is turned off" : "A public, read-only page of the findings"}><Icon name="link" size={14} /><span>Create a share link</span></button>}
            <p className="prop-note">{report ? `Link expires ${dayLabel(report.expiresAt)} · nothing is ever sent from here` : "Public, read-only, expires after 30 days · nothing is ever sent from here"}</p>
            <InlineError message={exportError} />
            {exportLink.length > 0 && <p className="row" style={{ margin: 0 }}>{exportLink.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a>)}</p>}
            {share.olderText && <p className="prop-note">{share.olderText}</p>}
            {shareMsg && <p className="prop-note" role="status">{shareMsg}</p>}
          </PropSection>}

          <PropSection icon="phone" title="Contact details">
            {otherContacts.map((c) => {
              const src = safeHttpUrl(c.source_url);
              const v = c.type === "form" || c.type === "social" ? safeHttpUrl(c.value) : null;
              const label = c.type === "social" ? socialName(c.value) : c.type === "form" ? "Form" : c.type[0].toUpperCase() + c.type.slice(1);
              return (
                <div key={c.id} className="kv"><span className="k">{label}</span>
                  <span className="v">{v ? <a href={v} target="_blank" rel="noreferrer" title={v}>{c.type === "form" ? new URL(v).pathname : hostOf(v)}</a> : c.type === "email" ? <a href={`mailto:${c.value}`} title={c.value}>{c.value}</a> : <span title={c.value}>{c.value}</span>}
                    {src && c.type === "email" && <a className="src-link" href={src} target="_blank" rel="noreferrer" title="The page this was found on" aria-label="The page this was found on"><Icon name="arrow-up-right" size={12} /></a>}</span></div>
              );
            })}
            {!otherContacts.length && <p className="muted small">None found</p>}
          </PropSection>

          <button className="prop-link" onClick={() => setTab("activity")}><Icon name="clock" size={15} /><span className="grow">Activity</span><Icon name="chevron-right" size={14} /></button>
          {d.activity.length > 0 && (
            <div className="prop-body" style={{ marginTop: -2 }}>
              <ul className="act-list">{d.activity.slice(0, 3).map((x) => (
                <li key={x.id}><span>{ACTIVITY_LABEL[x.kind] ?? x.kind}{x.detail && `: ${x.detail}`}</span>
                  <time dateTime={x.created_at}>{dayLabel(x.created_at)}</time></li>
              ))}</ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
