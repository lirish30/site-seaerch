import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { sectionOf, sidebarOf, stageCounts, type Section } from "../navView";
import { parseView, serializeView, viewRows } from "../savedFilters";
import { initials } from "../scoreView";
import { isDraftReady } from "../leadFilters";
import { TODAY_KIND_LABEL } from "../todayView";
import type { LeadRow, SavedFilter, TodayItem } from "../types";
import Icon, { LogoMark, type IconName } from "./Icon";

/** Anything that changes a lead (a bulk edit, a star, a stage) fires this so the sidebar's counts refresh. */
export const LEADS_CHANGED = "leads:changed";
export const announceLeadsChanged = () => window.dispatchEvent(new Event(LEADS_CHANGED));

const RAIL: { section: Section; to: string; label: string; icon: IconName }[] = [
  { section: "home", to: "/today", label: "Home", icon: "home" },
  { section: "leads", to: "/leads", label: "Leads", icon: "users" },
  { section: "find", to: "/", label: "Find", icon: "radar" },
  { section: "outreach", to: "/outreach", label: "Outreach", icon: "mail" },
];

const STAGES: { key: "new" | "reviewed" | "contacted" | "replied" | "won" | "lost"; label: string; icon: IconName }[] = [
  { key: "new", label: "New", icon: "inbox" }, { key: "reviewed", label: "Reviewed", icon: "eye" }, { key: "contacted", label: "Contacted", icon: "send" },
  { key: "replied", label: "Replied", icon: "mail" }, { key: "won", label: "Won", icon: "check" }, { key: "lost", label: "Lost", icon: "x" },
];

function SideItem({ to, icon, label, count, active }: { to: string; icon: IconName; label: string; count?: number; active: boolean }) {
  return (
    <Link to={to} className={`side-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
      <Icon name={icon} size={16} />
      <span className="label">{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </Link>
  );
}

/** A collapsible group heading ("Stages", "Saved filters"); the collapsed state is remembered per browser. */
function SideGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const key = `sidebar:${id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== "closed"; } catch { return true; } });
  const toggle = () => setOpen((o) => { try { localStorage.setItem(key, o ? "closed" : "open"); } catch { /* storage unavailable */ } return !o; });
  return (
    <>
      <button type="button" className="side-head" aria-expanded={open} onClick={toggle}>{title}<Icon name="chevron-down" size={14} /></button>
      {open && children}
    </>
  );
}

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
      <div className="side-title"><h2>Leads</h2><Link to="/" className="icon-btn" aria-label="New search" title="New search"><Icon name="plus" size={16} /></Link></div>
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
    </>
  );
}

function FindSidebar() {
  const { pathname } = useLocation();
  return (
    <>
      <div className="side-title"><h2>Find</h2></div>
      <SideItem to="/" icon="search" label="New search" active={pathname === "/"} />
      <SideItem to="/radar" icon="radar" label="Radar" active={pathname === "/radar"} />
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
            <Link key={i.id} className="pop-item" to={`/leads/${i.businessId}`} onClick={() => setOpen(false)}><span>{i.businessName}</span><small>{TODAY_KIND_LABEL[i.kind]}</small></Link>
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

/** Icon rail, the section's sidebar (where it has one) and the floating white content panel. */
export default function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  const sidebar = sidebarOf(pathname);
  return (
    <div className="app">
      <nav className="rail" aria-label="Sections">
        <Link to="/today" className="rail-logo" aria-label="Site Search home"><LogoMark /></Link>
        {RAIL.map((r) => (
          <NavLink key={r.section} to={r.to} className={`rail-btn${section === r.section ? " active" : ""}`} aria-label={r.label} title={r.label} aria-current={section === r.section ? "page" : undefined}>
            <Icon name={r.icon} size={18} />
          </NavLink>
        ))}
        <div className="rail-spacer" />
        <Bell />
        <NavLink to="/settings" className={`rail-btn${section === "settings" ? " active" : ""}`} aria-label="Settings" title="Settings" aria-current={section === "settings" ? "page" : undefined}>
          <Icon name="sliders" size={18} />
        </NavLink>
        <Account />
      </nav>
      {sidebar && <aside className="sidebar" aria-label={sidebar === "leads" ? "Leads views" : "Find"}>{sidebar === "leads" ? <LeadsSidebar /> : <FindSidebar />}</aside>}
      <main className="panel">{children}</main>
    </div>
  );
}

/** Pages still on the old design sit in a padded wrapper inside the new panel. */
export const Legacy = ({ children }: { children: ReactNode }) => <div className="page-body legacy">{children}</div>;
