import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { sectionOf, sidebarOf, stageCounts, type Section } from "../navView";
import { parseView, serializeView, viewRows } from "../savedFilters";
import { initials } from "../scoreView";
import { isDraftReady } from "../leadFilters";
import { itemLink, TODAY_KIND_LABEL } from "../todayView";
import type { LeadRow, OutreachCounts, SavedFilter, TodayItem } from "../types";
import Icon, { LogoMark, type IconName } from "./Icon";
import { SideGroup, SideItem, SideTitle, SidebarCollapse } from "./sidebars/parts";
import FindSidebar from "./sidebars/FindSidebar";
import HomeSidebar from "./sidebars/HomeSidebar";
import SettingsSidebar from "./sidebars/SettingsSidebar";
import WorkSidebar from "./sidebars/WorkSidebar";
import { ClientsSidebar, MoneySidebar, SalesSidebar } from "./sidebars/SectionSidebars";
import TimerWidget from "./TimerWidget";

/** Anything that changes a lead (a bulk edit, a star, a stage) fires this so the sidebar's counts refresh. */
export const LEADS_CHANGED = "leads:changed";
export const announceLeadsChanged = () => window.dispatchEvent(new Event(LEADS_CHANGED));

/** The rail in three groups (Figma): your day, finding work, running it. A divider sits after the last item of each group. */
const RAIL: { section: Section; to: string; label: string; icon: IconName; divider?: boolean }[] = [
  { section: "home", to: "/today", label: "Home", icon: "home" },
  { section: "approvals", to: "/approvals", label: "Approvals", icon: "inbox", divider: true },
  { section: "leads", to: "/leads", label: "Leads", icon: "users" },
  { section: "find", to: "/", label: "Find", icon: "radar" },
  { section: "outreach", to: "/outreach", label: "Outreach", icon: "mail", divider: true },
  { section: "sales", to: "/pipeline", label: "Sales", icon: "kanban" },
  { section: "clients", to: "/clients", label: "Clients", icon: "building" },
  { section: "work", to: "/projects", label: "Work", icon: "briefcase" },
  { section: "money", to: "/money", label: "Money", icon: "card" },
];

const STAGES: { key: "new" | "reviewed" | "contacted" | "replied" | "won" | "lost"; label: string; icon: IconName }[] = [
  { key: "new", label: "New", icon: "inbox" }, { key: "reviewed", label: "Reviewed", icon: "eye" }, { key: "contacted", label: "Contacted", icon: "send" },
  { key: "replied", label: "Replied", icon: "mail" }, { key: "won", label: "Won", icon: "check" }, { key: "lost", label: "Lost", icon: "x" },
];

/** Everything the Leads sidebar counts. Loaded when the sidebar appears and again whenever a lead changes. */
function useSidebarData() {
  const [data, setData] = useState<{ rows: LeadRow[]; archived: number; promising: number; filters: SavedFilter[] } | null>(null);
  const load = useCallback(() => {
    Promise.all([
      api.get<LeadRow[]>("/leads?limit=500"), api.get<LeadRow[]>("/leads?limit=500&archived=1"),
      api.get<LeadRow[]>("/leads/promising").catch(() => [] as LeadRow[]), api.get<SavedFilter[]>("/leads/filters").catch(() => [] as SavedFilter[]),
    ]).then(([rows, arch, promising, filters]) => setData({ rows, archived: arch.length, promising: promising.length, filters })).catch(() => setData(null));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(LEADS_CHANGED, load);
    return () => window.removeEventListener(LEADS_CHANGED, load);
  }, [load]);
  return data;
}

function LeadsSidebar() {
  const { pathname, search } = useLocation();
  const d = useSidebarData();
  const counts = d ? stageCounts(d.rows) : null;
  const onLeads = pathname === "/leads";
  const v = parseView(search);
  const current = serializeView(v);
  const plain = onLeads && current === "";
  return (
    <>
      <SideTitle title="Leads" action={<Link to="/" className="icon-btn" aria-label="New search" title="New search"><Icon name="plus" size={16} /></Link>} />
      <SideItem to="/leads" icon="users" label="All leads" count={counts?.all} active={plain} />
      <SideItem to="/leads?starred=1" icon="star" label="Starred" count={counts?.starred} active={onLeads && current === "starred=1"} />
      <SideItem to="/promising" icon="sparkles" label="Needs full scan" count={d?.promising} active={pathname === "/promising"} />
      <SideItem to="/leads?drafts=1" icon="mail" label="Drafts ready" count={d ? d.rows.filter(isDraftReady).length : undefined} active={onLeads && current === "drafts=1"} />
      <SideGroup id="stages" title="Stages">
        {STAGES.map((s) => <SideItem key={s.key} to={`/leads?status=${s.key}`} icon={s.icon} label={s.label} count={counts?.byStatus[s.key]} active={onLeads && current === `status=${s.key}`} />)}
      </SideGroup>
      {(d?.filters.length ?? 0) > 0 && (
        <SideGroup id="saved" title="Saved filters">
          {d!.filters.map((f) => {
            const fv = parseView(f.query);
            return <SideItem key={f.id} to={`/leads${f.query ? `?${f.query}` : ""}`} icon="filter" label={f.name} count={fv.archived ? undefined : viewRows(d!.rows, fv).length} active={onLeads && current === serializeView(fv)} />;
          })}
        </SideGroup>
      )}
      <div className="side-spacer" />
      <SideItem to="/import" icon="upload" label="Import leads" active={pathname === "/import"} />
      <SideItem to="/leads?archived=1" icon="copy" label="Archived" count={d?.archived} active={onLeads && current === "archived=1"} />
      <div className="side-gap" aria-hidden="true" />
    </>
  );
}

function OutreachSidebar() {
  const { pathname, search } = useLocation();
  const p = new URLSearchParams(search);
  const onQueue = pathname === "/outreach";
  const view = p.get("view") ?? "drafts";
  const [counts, setCounts] = useState<OutreachCounts | null>(null);
  useEffect(() => {
    const load = () => api.get<{ counts: OutreachCounts }>("/outreach?counts=1").then((r) => setCounts(r.counts)).catch(() => setCounts(null));
    load();
    window.addEventListener(LEADS_CHANGED, load);
    return () => window.removeEventListener(LEADS_CHANGED, load);
  }, []);
  const drafts = onQueue && view === "drafts";
  return (
    <>
      <SideTitle title="Outreach" />
      <SideItem to="/outreach" icon="mail" label="Drafts ready" count={counts?.drafts} active={drafts} />
      <SideItem to="/outreach?view=followups" icon="clock" label="Follow-ups due" count={counts?.followups} active={onQueue && view === "followups"} />
      <SideItem to="/outreach?view=contacted" icon="send" label="Contacted" count={counts?.contacted} active={onQueue && view === "contacted"} />
      <SideItem to="/outreach?view=replied" icon="inbox" label="Replied" count={counts?.replied} active={onQueue && view === "replied"} />
      <SideItem to="/studio" icon="image" label="Studio posts" active={pathname === "/studio"} />
      <div className="side-spacer" />
      <SideItem to="/settings" icon="sliders" label="Email voice" active={false} />
      <SideItem to="/settings" icon="pen" label="Signature" active={false} />
      <div className="side-gap" aria-hidden="true" />
    </>
  );
}

/** Closes a popover on an outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return { open, setOpen, ref };
}

/** The bell: what needs doing today (the Home queue), as a short list. */
function Bell() {
  const { open, setOpen, ref } = usePopover();
  const [items, setItems] = useState<TodayItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.get<{ items: TodayItem[] }>("/today").then((r) => { if (!cancelled) setItems(r.items); }).catch(() => { if (!cancelled) setItems([]); });
    load();
    window.addEventListener(LEADS_CHANGED, load);
    return () => { cancelled = true; window.removeEventListener(LEADS_CHANGED, load); };
  }, []);
  const n = items?.length ?? 0;
  return (
    <div className="rail-pop" ref={ref} style={{ position: "relative" }}>
      <button type="button" className="rail-btn" aria-label={n ? `Today: ${n} to do` : "Today: nothing to do"} aria-expanded={open} title="Today" onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" size={18} />{n > 0 && <span className="dot-badge" />}
      </button>
      {open && (
        <div className="popover rail-left" role="dialog" aria-label="Today">
          <h4>Today</h4>
          {items && items.length > 0 ? items.slice(0, 6).map((i) => (
            <Link key={i.id} className="pop-item" to={i.kind === "billing_attention" || i.kind === "access_missing" || i.kind === "site_incident" || i.kind === "care_edit_hours" || i.kind === "seo_waiting" || i.kind === "ladder_due" ? itemLink(i)! : `/leads/${i.businessId}`} onClick={() => setOpen(false)}><span>{i.businessName}</span><small>{TODAY_KIND_LABEL[i.kind]}</small></Link>
          )) : <p className="pop-empty">Nothing needs you today.</p>}
          <hr />
          <Link className="pop-item" to="/today" onClick={() => setOpen(false)}>Open Home<Icon name="arrow-right" size={14} /></Link>
        </div>
      )}
    </div>
  );
}

/** The account button: who is signed in, Settings and Sign out. */
function Account() {
  const { open, setOpen, ref } = usePopover();
  const nav = useNavigate();
  const [name, setName] = useState("");
  useEffect(() => { api.get<{ settings: { your_name: string } }>("/settings").then((r) => setName(r.settings.your_name ?? "")).catch(() => {}); }, []);
  const out = async () => { try { await api.post("/logout"); } finally { nav("/login"); } };
  return (
    <div className="rail-pop" ref={ref} style={{ position: "relative" }}>
      <button type="button" className="avatar-btn" aria-label="Account" aria-expanded={open} title={name || "Account"} onClick={() => setOpen((o) => !o)}>{name ? initials(name) : "·"}</button>
      {open && (
        <div className="popover rail-left" role="menu" aria-label="Account">
          {name && <h4>{name}</h4>}
          <Link className="pop-item" to="/settings" role="menuitem" onClick={() => setOpen(false)}><Icon name="sliders" size={14} />Settings</Link>
          <button type="button" className="pop-item" role="menuitem" onClick={() => void out()}><Icon name="logout" size={14} />Sign out</button>
        </div>
      )}
    </div>
  );
}

const COLLAPSE_KEY = "shell:sidebar-collapsed";

/** The sidebar's collapsed state, remembered per browser; Cmd/Ctrl + \ flips it. */
function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } });
  const toggle = useCallback(() => setCollapsed((c) => { try { localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1"); } catch { /* storage unavailable */ } return !c; }), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); toggle(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle]);
  return { collapsed, toggle };
}

const SIDEBAR_LABEL = { leads: "Leads views", outreach: "Outreach", find: "Find", home: "Home", sales: "Sales", clients: "Clients", work: "Work", money: "Money", settings: "Settings" } as const;

/** How many approvals wait for you, for the count on the rail. Re-read when the page changes. */
function usePendingApprovals(pathname: string): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api.get<{ items: unknown[] }>("/approvals?status=pending").then((r) => { if (live) setN(Array.isArray(r.items) ? r.items.length : 0); }).catch(() => {});
    return () => { live = false; };
  }, [pathname]);
  return n;
}

/** Icon rail, the section's sidebar (where it has one) and the floating white content panel. */
export default function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  const sidebar = sidebarOf(pathname);
  const collapse = useSidebarCollapse();
  const pending = usePendingApprovals(pathname);
  return (
    <div className={`app${sidebar && collapse.collapsed ? " sb-collapsed" : ""}`}>
      <nav className="rail" aria-label="Sections">
        <Link to="/today" className="rail-logo" aria-label="Site Search home"><LogoMark /></Link>
        {RAIL.map((r) => (
          <Fragment key={r.section}>
            <NavLink to={r.to} className={`rail-btn${section === r.section ? " active" : ""}`} aria-label={r.section === "approvals" && pending ? `Approvals: ${pending} waiting` : r.label} title={r.label} aria-current={section === r.section ? "page" : undefined}>
              <Icon name={r.icon} size={18} />
              {r.section === "approvals" && pending > 0 && <span className="rail-count">{pending > 99 ? "99+" : pending}</span>}
            </NavLink>
            {r.divider && <span className="rail-div" aria-hidden="true" />}
          </Fragment>
        ))}
        <div className="rail-spacer" />
        <TimerWidget />
        <Bell />
        <NavLink to="/settings" className={`rail-btn${section === "settings" ? " active" : ""}`} aria-label="Settings" title="Settings" aria-current={section === "settings" ? "page" : undefined}>
          <Icon name="sliders" size={18} />
        </NavLink>
        <Account />
      </nav>
      {sidebar && (
        <SidebarCollapse.Provider value={collapse}>
          <div className="sb-wrap">
            <aside className="sidebar" aria-label={SIDEBAR_LABEL[sidebar]}>{{ leads: <LeadsSidebar />, outreach: <OutreachSidebar />, home: <HomeSidebar />, sales: <SalesSidebar />, clients: <ClientsSidebar />, work: <WorkSidebar />, money: <MoneySidebar />, settings: <SettingsSidebar />, find: <FindSidebar /> }[sidebar]}</aside>
            <button type="button" className="sb-edge" tabIndex={-1} aria-hidden="true" title={collapse.collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={collapse.toggle} />
          </div>
        </SidebarCollapse.Provider>
      )}
      <main className={`panel${pathname === "/outreach" ? " fixed" : ""}`}>{children}</main>
    </div>
  );
}

/** Pages still on the old design sit in a padded wrapper inside the new panel. */
export const Legacy = ({ children }: { children: ReactNode }) => <div className="page-body legacy">{children}</div>;
