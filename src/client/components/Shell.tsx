import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import { sectionOf, sidebarOf, stageCounts, type Section } from "../navView";
import { STATUSES, type LeadRow } from "../types";
import Icon, { LogoMark, type IconName } from "./Icon";

const RAIL: { section: Section; to: string; label: string; icon: IconName; soon?: boolean }[] = [
  { section: "home", to: "/today", label: "Home", icon: "home" },
  { section: "leads", to: "/leads", label: "Leads", icon: "users" },
  { section: "find", to: "/", label: "Find", icon: "radar" },
  { section: "outreach", to: "/outreach", label: "Outreach", icon: "mail", soon: true },
  { section: "settings", to: "/settings", label: "Settings", icon: "sliders" },
];

const STAGE_LABEL: Record<string, string> = { new: "New", reviewed: "Reviewed", contacted: "Contacted", replied: "Replied", won: "Won", lost: "Lost", skip: "Skipped" };
const STAGE_ICON: Record<string, IconName> = { new: "inbox", reviewed: "eye", contacted: "send", replied: "mail", won: "check", lost: "x", skip: "x" };

function SideItem({ to, icon, label, count, active }: { to: string; icon: IconName; label: string; count?: number; active: boolean }) {
  return (
    <Link to={to} className={`side-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
      <Icon name={icon} size={16} />
      <span className="label">{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </Link>
  );
}

const SideHead = ({ children }: { children: ReactNode }) => <p className="side-head">{children}</p>;

function LeadsSidebar() {
  const { pathname, search } = useLocation();
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  // Counts come from one list request when the sidebar appears and again when moving between lead views, so a bulk change shows up on the next click.
  useEffect(() => {
    let cancelled = false;
    api.get<LeadRow[]>("/leads?limit=500").then((r) => { if (!cancelled) setRows(r); }).catch(() => { if (!cancelled) setRows(null); });
    return () => { cancelled = true; };
  }, [pathname, search]);
  const counts = rows ? stageCounts(rows) : null;
  const p = new URLSearchParams(search);
  const onLeads = pathname === "/leads";
  const status = onLeads ? p.get("status") : null;
  const plain = onLeads && !status && !p.get("starred") && !p.get("archived");
  return (
    <>
      <div className="side-title"><h2>Leads</h2><Link to="/" className="icon-btn" aria-label="New search" title="New search"><Icon name="plus" size={16} /></Link></div>
      <SideItem to="/leads" icon="users" label="All leads" count={counts?.all} active={plain} />
      <SideItem to="/leads?starred=1" icon="star" label="Starred" count={counts?.starred} active={onLeads && p.get("starred") === "1"} />
      <SideItem to="/promising" icon="sparkles" label="Needs full scan" active={pathname === "/promising"} />
      <SideHead>Stages</SideHead>
      {STATUSES.map((s) => (
        <SideItem key={s} to={`/leads?status=${s}`} icon={STAGE_ICON[s]} label={STAGE_LABEL[s]} count={counts?.byStatus[s]} active={status === s} />
      ))}
      <div className="side-spacer" />
      <SideItem to="/import" icon="upload" label="Import leads" active={pathname === "/import"} />
      <SideItem to="/leads?archived=1" icon="copy" label="Archived" active={onLeads && p.get("archived") === "1"} />
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

/** Icon rail, the section's sidebar (where it has one) and the floating white content panel. */
export default function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  const sidebar = sidebarOf(pathname);
  return (
    <div className="app">
      <nav className="rail" aria-label="Sections">
        <Link to="/today" className="rail-logo" aria-label="Site Search home"><LogoMark /></Link>
        <div className="rail-list">
          {RAIL.map((r) => r.soon ? (
            <span key={r.section} className="rail-btn soon" role="link" aria-disabled="true" aria-label={`${r.label} (coming soon)`} title={`${r.label}: coming soon`}><Icon name={r.icon} size={18} /></span>
          ) : (
            <NavLink key={r.section} to={r.to} className={`rail-btn${section === r.section ? " active" : ""}`} aria-label={r.label} title={r.label}
              aria-current={section === r.section ? "page" : undefined}>
              <Icon name={r.icon} size={18} />
            </NavLink>
          ))}
        </div>
      </nav>
      {sidebar && <aside className="sidebar" aria-label={sidebar === "leads" ? "Leads views" : "Find"}>{sidebar === "leads" ? <LeadsSidebar /> : <FindSidebar />}</aside>}
      <main className="panel">{children}</main>
    </div>
  );
}

/** Pages still on the old design sit in a padded wrapper inside the new panel. */
export const Legacy = ({ children }: { children: ReactNode }) => <div className="page-body legacy">{children}</div>;
