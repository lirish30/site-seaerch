import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, careApi, clientsApi } from "../api";
import { useOwnerClock } from "../billingData";
import { shortDate } from "../billingView";
import { hours } from "../careReportPageView";
import { ledgerBar } from "../careReportsView";
import { addressProblem, carePastDue, latestOnly, moneyLabel, problemText, projectStatusLabel, renewalLabel, safeHref } from "../clientView";
import ActivityTab from "../components/ActivityTab";
import { Avatar, Banner, Card, Chip, Empty, Facts, LinkRow, PageHeader, Score, Seg, Tabs, Timeline, type Tone } from "../components/ds";
import Icon from "../components/Icon";
import MeetingsPanel from "../components/MeetingsPanel";
import CarePanel from "../components/client/CarePanel";
import { healthLines, healthTone, healthWord, recordBanner, timelineGroups, TIMELINE_KINDS, type TimelineKind } from "../components/client/clientScreen";
import GradePanel, { GradeChip } from "../components/client/GradePanel";
import ClientSeoPanel from "../components/client/ClientSeoPanel";
import LadderPanel from "../components/client/LadderPanel";
import LinkedPanel from "../components/client/LinkedPanel";
import SitePanel, { cmsLabel, tierLabel } from "../components/client/SitePanel";
import StrategyMemoSection from "../components/client/StrategyMemoSection";
import TrafficPanel from "../components/client/TrafficPanel";
import { hasSeoOnboarding, hasSeoPlan } from "../seoView";
import { workError } from "../workData";
import { projectIsLive } from "../../worker/db/projects";
import type { EditLedger } from "../../worker/care/ledger";
import type { ClientRecord } from "../../worker/clients/record";

type TabKey = "overview" | "sites" | "care" | "seo" | "traffic" | "followups" | "account";
const TAB_KEYS: TabKey[] = ["overview", "sites", "care", "seo", "traffic", "followups", "account"];
const isTab = (s: string | null): s is TabKey => TAB_KEYS.includes(s as TabKey);

const PACKAGE_NAME: Record<string, string> = {
  quick_fix: "Quick fix", starter_site: "Starter site", growth_site: "Growth site", website_subscription: "Website subscription", care: "Care", care_plus: "Care Plus", care_fallback: "Care",
  client_hosted_surcharge: "Client-hosted surcharge", local_seo: "Local SEO", local_seo_growth: "Local SEO Growth", reviews_addon: "Reviews add-on", hourly: "Hourly",
};
const ACCESS_LABEL: Record<string, string> = { hosting: "Hosting", dns: "DNS", registrar: "Registrar", admin: "Site admin", gbp: "Google Business Profile", analytics: "Analytics" };

/** A link only when the address is a plain http or https one; anything else is shown as text. */
function WebLink({ url }: { url: string | null }) {
  const href = safeHref(url);
  if (!url) return null;
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{url.replace(/^https?:\/\//i, "").replace(/\/$/, "")}</a> : <span>{url}</span>;
}

/** "Tigard, OR" out of "11800 SW Pacific Hwy, Tigard, OR 97223": the last two parts, without the zip. Null when the address has fewer than three parts. */
const townOf = (address: string | null): string | null => {
  const parts = (address ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? `${parts[parts.length - 2]}, ${parts[parts.length - 1].split(/\s+/)[0]}` : null;
};

/** A form to add a site by hand. The address is optional: a site with no domain yet is fine. */
function AddSite({ clientId, onAdded }: { clientId: string; onAdded: () => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const v = url.trim();
    const problem = addressProblem(v);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try { await clientsApi.addSite(clientId, v ? { url: v } : {}); setUrl(""); await onAdded(); }
    catch (err) { setError(err instanceof ApiError ? problemText(err, "Could not add the site.") : "Could not add the site."); }
    finally { setBusy(false); }
  }
  return (
    <Card icon="plus" title="Add a site" note="It comes with the six access lines">
      <form className="clx-inline-form" onSubmit={(e) => void add(e)} noValidate aria-label="Add a site">
        <label className="clx-field grow" htmlFor="cl-add-url"><span>Site address</span>
          <input id="cl-add-url" type="text" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="https://example.com (optional)" aria-label="Add a site: address of the new site"
            value={url} onChange={(e) => { setUrl(e.target.value); setError(""); }} />
        </label>
        <button type="submit" className="btn" disabled={busy}>{busy ? "Adding…" : "Add site"}</button>
      </form>
      {error && <p className="error small" role="alert">{error}</p>}
    </Card>
  );
}

/** The edit request box in the Edit time card: one line in, a Care task out (with the CARE-3 checklist). */
function EditRequestForm({ businessId, onAdded, onClose }: { businessId: string; onAdded: () => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setError("");
    try { const r = await careApi.addEditRequest(businessId, title); setTitle(""); await onAdded(); onClose(); window.dispatchEvent(new CustomEvent("clx-edit-added", { detail: r.taskId })); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Couldn’t add it just now. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="clx-edit-form">
      <label htmlFor={`clx-edit-${businessId}`} className="clx-field"><span>What does the client want changed?</span>
        <input id={`clx-edit-${businessId}`} value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Change the phone number in the footer" />
      </label>
      <div className="ds-row">
        <button type="submit" className="btn primary sm" aria-disabled={busy || !title.trim()}>{busy ? "Adding…" : "Add it"}</button>
        <button type="button" className="btn sm" onClick={onClose}>Cancel</button>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </form>
  );
}

/** The first day of the month after `YYYY-MM`, as "Dec 1". */
const resetsOn = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/**
 * One client (Figma 63:5152). The Overview tab is the record at a glance: About, the timeline, Health, edit time and everything linked. The heavier editors sit on their own tabs:
 * Sites & access, Care, Local SEO, Traffic, Notes & follow-ups and Grade & paperwork. The vault item names and owner notes here are for the owner alone; the timeline only ever says which line changed.
 */
export default function ClientPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabKey = isTab(tabParam) ? tabParam : "overview";
  const { today, tz } = useOwnerClock();
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [failed, setFailed] = useState<"" | "missing" | "error">("");
  const [userName, setUserName] = useState("");
  const [error, setError] = useState("");
  const [order, setOrder] = useState<{ id: string; name: string }[]>([]);
  const [ledger, setLedger] = useState<EditLedger | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [kind, setKind] = useState<TimelineKind>("all");
  // The component is reused when the route changes from one client to another, so an answer is applied only while it is the latest ask for the client in the address bar.
  const [guard] = useState(latestOnly);

  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await clientsApi.get(id);
      if (!guard.isLatest(ticket) || next.business.id !== id) return;
      setClient(next); setFailed("");
    } catch (e) {
      if (!guard.isLatest(ticket)) return;
      setFailed(e instanceof ApiError && e.status === 404 ? "missing" : "error");
    }
  }, [id, guard]);
  const loadLedger = useCallback(async () => { try { setLedger(await careApi.ledger(id)); } catch { setLedger(undefined); } }, [id]);
  useEffect(() => { setClient(null); setFailed(""); setError(""); setLedger(undefined); setEditing(false); setAdded(null); void load(); void loadLedger(); return () => guard.cancel(); }, [load, loadLedger, guard]);
  useEffect(() => { api.get<{ settings: { your_name?: string } }>("/settings").then((r) => setUserName(r.settings.your_name ?? "")).catch(() => {}); }, []);
  // The pager ("3 of 7") walks the client list by name; it is optional, so a failed read just hides it.
  useEffect(() => { clientsApi.list().then((rows) => setOrder(rows.map((r) => ({ id: r.id, name: r.name })))).catch(() => {}); }, []);
  useEffect(() => { const on = (e: Event) => setAdded((e as CustomEvent<string>).detail); window.addEventListener("clx-edit-added", on); return () => window.removeEventListener("clx-edit-added", on); }, []);

  const setTab = (k: TabKey) => setParams((p) => { const n = new URLSearchParams(p); if (k === "overview") n.delete("tab"); else n.set("tab", k); return n; }, { replace: true });

  if (failed === "missing") return <div className="ds-page clx"><div className="ds-body"><Empty icon="building" title="That client was not found" action={<Link to="/clients" className="btn">Back to clients</Link>}>It may still be a lead. A lead becomes a client when you win it or start a project for it.</Empty></div></div>;
  if (failed === "error" && !client) return <div className="ds-page clx"><div className="ds-body"><p className="error" role="alert">Couldn’t load this client. <button type="button" className="btn sm" onClick={() => void load()}>Try again</button> <Link to="/clients">Back to clients</Link></p></div></div>;
  if (!client || client.business.id !== id) return <div className="ds-page clx"><div className="ds-body"><p className="clx-muted">Loading…</p></div></div>;

  const { business: b } = client;
  const late = carePastDue(client.subscriptions);
  const people = [...client.people].sort((x, y) => Number(y.is_poc) - Number(x.is_poc));
  const poc = people[0] ?? null;
  const emailTo = people.find((p) => p.email) ?? null;
  const refresh = async () => { await Promise.all([load(), loadLedger()]); };
  const primarySite = client.sites.find((s) => s.site.seedKey === "primary") ?? client.sites[0] ?? null;
  const site = primarySite?.site ?? null;
  const missingAccess = client.sites.reduce((n, s) => n + s.access.filter((a) => a.status === "needed" || a.status === "requested").length, 0);
  const banner = recordBanner(client);
  const town = townOf(b.address);
  const domain = site?.domain ?? b.domain;
  const liveSubs = client.subscriptions.filter((s) => !s.test && (s.status === "active" || s.status === "past_due"));
  const idx = order.findIndex((o) => o.id === id);
  const go = (n: number) => () => navigate(`/clients/${encodeURIComponent(order[n].id)}`);
  const care = client.careLabel !== null;
  const liveProjects = client.projects.filter((p) => p.status === "active" || p.status === "paused" || (p.status === "done" && projectIsLive(p)));
  const openTasks = liveProjects.reduce((n, p) => n + p.openTasks, 0);
  const firstOpen = liveProjects.find((p) => p.openTasks > 0) ?? liveProjects[0] ?? null;
  const since = [...client.documents.map((d) => d.signedAt), ...client.projects.map((p) => p.startedAt)].filter((d): d is string => !!d).sort()[0] ?? null;
  const vault = (primarySite?.access ?? []).filter((a) => a.vaultItem);
  const bar = ledger ? ledgerBar(ledger) : null;
  const H = client.health;
  // The same rule as the list: a score only for a client with live Care or a watched site.
  const scored = client.careLabel !== null || client.sites.some((s) => s.monitoring.monitored);

  const startEdit = () => { setTab("overview"); setEditing(true); setAdded(null); };
  const actions: ReactNode = (
    <>
      {emailTo?.email && <a className="btn" href={`mailto:${emailTo.email}`}><Icon name="mail" size={16} />Email {emailTo.name.split(/\s+/)[0]}</a>}
      <Link to={`/billing?businessId=${encodeURIComponent(b.id)}`} className="btn"><Icon name="card" size={16} />Billing</Link>
      {care
        ? <button type="button" className="btn primary" onClick={startEdit}><Icon name="plus" size={16} />Add an edit request</button>
        : client.sites.length === 0
          ? <button type="button" className="btn primary" onClick={() => setTab("sites")}><Icon name="plus" size={16} />Add a site</button>
          : <button type="button" className="btn primary" onClick={() => setTab("followups")}><Icon name="pen" size={16} />Add a note</button>}
    </>
  );

  const chips = (
    <>
      {client.careLabel && <Chip tone="outline">{client.careLabel.replace(/ \$/, " · $").replace("/mo", " a month")}</Chip>}
      {!client.careLabel && client.mrrCents > 0 && <Chip tone="outline">{moneyLabel(client.mrrCents)} a month</Chip>}
      {scored && <Chip tone={healthTone(H.score)} dot>Health {H.score}</Chip>}
      <GradeChip grade={client.grade} />
      {client.held && <Chip tone="warning" dot>On hold</Chip>}
      {late && <Chip tone="warning" dot>Payment late</Chip>}
    </>
  );

  const meta: { icon: "building" | "globe" | "code" | "user"; text: ReactNode }[] = [];
  if (b.category || town) meta.push({ icon: "building", text: [b.category, town].filter(Boolean).join(" · ") });
  if (domain) meta.push({ icon: "globe", text: <WebLink url={safeHref(site?.url ?? b.website_url) ? (site?.url ?? b.website_url) : domain} /> });
  if (site && (site.cms !== "unknown" || site.hostingTier !== "unknown")) meta.push({ icon: "code", text: [site.cms !== "unknown" ? cmsLabel(site.cms) : null, site.hostProvider ?? (site.hostingTier !== "unknown" ? tierLabel(site.hostingTier) : null)].filter(Boolean).join(" · ") });

  type Fact = { label: string; value: ReactNode };
  const facts = ([
    poc && { label: poc.is_poc ? "Contact" : "Person", value: <>{poc.name}{poc.role && <span className="clx-muted"> · {poc.role}</span>}</> },
    people.length > 1 && { label: "Also", value: people.slice(1).map((p) => p.name + (p.role ? ` (${p.role})` : "")).join(", ") },
    (poc?.phone || b.phone) && { label: "Phone", value: <a href={`tel:${poc?.phone || b.phone}`}>{poc?.phone || b.phone}</a> },
    emailTo?.email && { label: "Email", value: <a href={`mailto:${emailTo.email}`}>{emailTo.email}</a> },
    b.address && { label: "Address", value: b.address },
    site && site.cms !== "unknown" && { label: "Platform", value: cmsLabel(site.cms) },
    site && (site.hostProvider || site.hostingTier !== "unknown") && { label: "Hosting", value: [site.hostProvider, site.hostingTier !== "unknown" ? tierLabel(site.hostingTier) : null].filter(Boolean).join(" · ") },
    site?.dnsProvider && { label: "DNS", value: site.dnsProvider },
    site?.registrar && { label: "Registrar", value: site.registrar },
    vault.length > 0 && { label: "Logins", value: <ul className="clx-vault">{vault.map((a) => <li key={a.key}><span className="clx-muted">{ACCESS_LABEL[a.key] ?? a.key}:</span> “{a.vaultItem}”</li>)}</ul> },
    liveSubs.length > 0 && { label: "Package", value: liveSubs.map((s) => `${PACKAGE_NAME[s.packageKey] ?? s.packageKey} · ${moneyLabel(s.monthlyCents)} a month`).join(", ") },
    since && { label: "Since", value: shortDate(since.slice(0, 10), true) },
    (client.nextRenewalOn || ledger) && { label: "Terms", value: [client.nextRenewalOn ? renewalLabel(client.nextRenewalOn, today) : null, ledger ? `${hours(ledger.allowanceMinutes)} of edits a month` : null].filter(Boolean).join(" · ") },
    b.notes && { label: "Notes", value: b.notes },
  ] as (Fact | false | null | undefined | "")[]).filter((r): r is Fact => !!r);

  const linked: ReactNode[] = [
    ...liveProjects.map((p) => <LinkRow key={p.id} to={`/projects/${encodeURIComponent(p.id)}`} icon="briefcase" title={p.name} sub={`${projectStatusLabel(p).label} · ${p.doneTasks} of ${p.doneTasks + p.openTasks} tasks done`} />),
    <LinkRow key="inv" to={`/billing?businessId=${encodeURIComponent(b.id)}`} icon="card" title="Invoices"
      sub={client.invoices.openCents > 0 ? `${moneyLabel(client.invoices.openCents)} open${client.invoices.overdueCount ? ` · ${client.invoices.overdueCount} overdue` : ""}` : `Nothing open · ${moneyLabel(client.invoices.paidCents)} paid so far`}
      right={client.invoices.overdueCount > 0 ? <Chip tone="warning" dot>Overdue</Chip> : undefined} />,
    ...client.documents.filter((d) => !d.test).slice(0, 3).map((d) => (
      <LinkRow key={d.id} to={`/deals/${encodeURIComponent(d.dealId)}`} icon="file-text" title={`${d.reference} v${d.version}`}
        sub={d.signedAt ? `Signed ${shortDate(d.signedAt.slice(0, 10), true)}` : d.sentAt ? `Sent ${shortDate(d.sentAt.slice(0, 10), true)}, not signed yet` : "Draft"} />
    )),
    openTasks > 0 && firstOpen && <LinkRow key="tasks" to={`/projects/${encodeURIComponent(firstOpen.id)}`} icon="list" title={`${openTasks} open ${openTasks === 1 ? "task" : "tasks"}`} sub={`Across ${liveProjects.length} live ${liveProjects.length === 1 ? "project" : "projects"}`} />,
    <LinkRow key="lead" to={`/leads/${encodeURIComponent(b.id)}`} icon="user" title="Lead record" sub="Their history from before they were a client" />,
  ].filter(Boolean);

  const tabs = (
    <Tabs<TabKey> label={`${b.name}: sections`} value={tab} onChange={setTab} tabs={[
      { key: "overview", label: "Overview" },
      { key: "sites", label: "Sites & access", count: missingAccess > 0 ? `${missingAccess} missing` : client.sites.length },
      { key: "care", label: "Care" },
      { key: "seo", label: "Local SEO" },
      { key: "traffic", label: "Traffic & strategy" },
      { key: "followups", label: "Notes & follow-ups" },
      { key: "account", label: "Grade & paperwork" },
    ]} />
  );

  return (
    <div className="ds-page clx">
      <PageHeader
        crumbs={[{ label: "Clients", to: "/clients" }, { label: b.name }]}
        pager={idx >= 0 && order.length > 1 ? { label: `${idx + 1} of ${order.length}`, prev: idx > 0 ? go(idx - 1) : undefined, next: idx < order.length - 1 ? go(idx + 1) : undefined } : undefined}
        avatar={b.name} title={b.name} chips={chips} meta={meta} actions={actions} tabs={tabs}
      />
      <div className="ds-body">
        {failed === "error" && <p className="error small" role="alert">Couldn’t refresh just now. What you see may be out of date. <button type="button" className="btn sm" onClick={() => void load()}>Try again</button></p>}
        {error && <p className="error" role="alert">{error}</p>}
        {banner && tab === "overview" && (
          <Banner tone={banner.tone} title={banner.title}
            action={banner.tab === "account" ? <Link to={`/billing?businessId=${encodeURIComponent(b.id)}`} className="btn sm">Open billing</Link> : <button type="button" className="btn sm" onClick={() => setTab(banner.tab)}>{banner.tab === "sites" ? "Open Sites & access" : "Open Care"}</button>}>
            {banner.text}
          </Banner>
        )}

        {tab === "overview" && (
          <div className="ds-cols c3 clx-record">
            <div className="ds-col">
              <Card icon="user" title="About">
                {facts.length > 0
                  ? <Facts rows={facts} footnote={vault.length > 0 ? "Only the password manager item name is stored here, never the password." : undefined} />
                  : <p>Nothing saved yet. Add a point of contact on the <Link to={`/leads/${encodeURIComponent(b.id)}`}>lead record</Link> and a site on Sites & access.</p>}
              </Card>
            </div>

            <div className="ds-col">
              <div className="ds-section-head clx-tl-head">
                <h2>Timeline</h2>
                <Seg label="Show in the timeline" options={TIMELINE_KINDS} value={kind} onChange={setKind} />
              </div>
              <Timeline groups={timelineGroups(client.activity, kind)}
                empty={client.activity.length === 0 ? "Nothing yet. Emails, meetings, invoices, site changes and notes about this client show up here." : "Nothing of this kind yet."} />
              <p className="clx-tl-foot"><button type="button" className="btn sm" onClick={() => setTab("followups")}><Icon name="pen" size={14} />Add a note or set a follow-up</button></p>
            </div>

            <div className="ds-col">
              <Card icon="gauge" title="Health" note={scored && !H.hasData ? "No checks yet" : undefined}>
                {!scored && <p>No score yet. A health score shows once this client has a Care plan or a site you watch. It starts at 100 and drops for downtime, late payment and missing access.</p>}
                {scored && <Score value={H.score} unit={`of 100 · ${healthWord(H.score)}`} meter={{ value: H.score, max: 100, tone: healthTone(H.score) }}
                  reasons={healthLines(client).map((l) => ({ ok: l.ok, text: l.text }))} />}
                <button type="button" className="btn-plain clx-more" onClick={() => setTab("care")}>See sites, uptime and incidents</button>
              </Card>

              {ledger && bar && (
                <Card icon="clock" title="Edit time this month" note={`Resets ${resetsOn(ledger.month)}`}>
                  <Score size="md" value={hours(ledger.usedMinutes)} unit={`of ${hours(ledger.allowanceMinutes)} used`}
                    meter={{ value: bar.width, max: 100, tone: (bar.tone === "over" ? "critical" : bar.tone === "warn" ? "warning" : "signal") as Tone }} />
                  <p className="clx-help">{bar.note || "Edit requests count against this. Extra time is quoted as a change order."}</p>
                  {editing
                    ? <EditRequestForm businessId={b.id} onAdded={loadLedger} onClose={() => setEditing(false)} />
                    : <p><button type="button" className="btn sm" onClick={() => { setEditing(true); setAdded(null); }}><Icon name="plus" size={14} />Add an edit request</button></p>}
                  {added && <p className="clx-help" role="status">Added to this client’s Care tasks. <Link to={`/tasks/${encodeURIComponent(added)}`}>Open it</Link></p>}
                </Card>
              )}

              <Card icon="link" title="Linked" flush>{linked}</Card>
            </div>
          </div>
        )}

        {tab === "sites" && (
          <div className="clx-stack">
            {client.sites.length === 0 && <Empty icon="globe" title="No site yet">Add one below. Each site comes with six access lines (hosting, DNS, registrar, site admin, Google Business Profile and analytics) to tick off as the client sends them.</Empty>}
            {client.sites.map(({ site: s, access, flags }) => <SitePanel key={s.id} clientId={b.id} site={s} access={access} flags={flags} onChanged={refresh} />)}
            <AddSite clientId={b.id} onAdded={refresh} />
          </div>
        )}

        {tab === "care" && (
          <CarePanel businessId={b.id} health={client.health} sites={client.sites.map(({ site: s, monitoring }) => ({ site: s, monitoring }))} zone={tz} onChanged={refresh} />
        )}

        {tab === "seo" && (
          <ClientSeoPanel businessId={b.id} clientName={b.name} clientAddress={b.address ?? ""} hasPlan={hasSeoPlan(client.subscriptions) || hasSeoOnboarding(client.projects)}
            sites={client.sites.flatMap(({ monitoring }) => (monitoring.domain ? [{ id: monitoring.siteId, domain: monitoring.domain }] : []))} />
        )}

        {tab === "traffic" && (
          <div className="clx-stack">
            {client.sites.length > 0
              ? <TrafficPanel businessId={b.id} clientName={b.name} today={today} access={Object.fromEntries(client.sites.map(({ site: s, access }) => [s.id, access.map((a) => ({ key: a.key, status: a.status }))]))} />
              : <Card icon="trending" title="Traffic"><Empty icon="globe" title="No site yet" action={<button type="button" className="btn" onClick={() => setTab("sites")}>Add a site</button>}>Traffic from Search Console and Analytics shows here once the client has a site.</Empty></Card>}
            <StrategyMemoSection businessId={b.id} tz={tz} />
          </div>
        )}

        {tab === "followups" && (
          <div className="ds-cols c2">
            <div className="ds-col">
              <Card icon="pen" title="Notes and follow-up" note={b.follow_up_at ? `Follow up ${shortDate(b.follow_up_at, true)}` : undefined}>
                <ActivityTab items={client.activity} userName={userName} followUp={b.follow_up_at}
                  onSetFollowUp={async (day) => { try { await api.patch(`/leads/${encodeURIComponent(b.id)}`, { followUpAt: day }); await load(); return true; } catch (e) { setError(workError(e)); return false; } }}
                  onAddNote={async (text) => { try { await api.post(`/leads/${encodeURIComponent(b.id)}/notes`, { text }); await load(); return true; } catch (e) { setError(workError(e)); return false; } }} />
              </Card>
            </div>
            <div className="ds-col">
              <div className="clx-legacy"><MeetingsPanel businessId={b.id} /></div>
              <LadderPanel businessId={b.id} today={today} />
            </div>
          </div>
        )}

        {tab === "account" && (
          <div className="ds-cols c2">
            <div className="ds-col"><LinkedPanel client={client} today={today} /></div>
            <div className="ds-col">
              <GradePanel businessId={b.id} grade={client.grade} onChanged={refresh} />
              <Card icon="user" title="People">
                {people.length === 0
                  ? <p>No people saved. Add a point of contact on the <Link to={`/leads/${encodeURIComponent(b.id)}`}>lead record</Link>.</p>
                  : <ul className="clx-people">{people.map((p) => (
                    <li key={p.id}>
                      <Avatar name={p.name} />
                      <span><b>{p.name}</b>{p.is_poc && <Chip tone="outline">Point of contact</Chip>}<small>{[p.role, p.phone, p.email].filter(Boolean).join(" · ")}</small></span>
                    </li>
                  ))}</ul>}
                {b.website_url && <p className="clx-help">Website: <WebLink url={b.website_url} /></p>}
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

