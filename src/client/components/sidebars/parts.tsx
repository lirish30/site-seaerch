import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import Icon, { type IconName } from "../Icon";

/** Whether the section sidebar is collapsed to its icon strip, and the switch for it (provided by Shell). */
export const SidebarCollapse = createContext<{ collapsed: boolean; toggle: () => void }>({ collapsed: false, toggle: () => {} });

export function SideItem({ to, icon, label, count, active }: { to: string; icon: IconName; label: string; count?: number | string; active: boolean }) {
  return (
    <Link to={to} className={`side-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={label}>
      <Icon name={icon} size={16} />
      <span className="label">{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </Link>
  );
}

/** A collapsible group heading ("Stages", "Saved filters"); the collapsed state is remembered per browser. */
export function SideGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
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

/** A group heading with no collapse control ("Purpose", "You"). */
export const SideLabel = ({ children }: { children: ReactNode }) => <p className="side-head static">{children}</p>;

/** The title row of a sidebar: the section name, an optional icon button, and the collapse toggle (the only part left when collapsed). */
export function SideTitle({ title, action }: { title: string; action?: ReactNode }) {
  const { collapsed, toggle } = useContext(SidebarCollapse);
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <div className="side-title">
      <h2>{title}</h2>
      <div className="side-actions">
        {action}
        <button type="button" className="icon-btn side-collapse" aria-label={label} aria-expanded={!collapsed} title={`${label} (⌘\\)`} onClick={toggle}><Icon name="sidebar" size={16} /></button>
      </div>
    </div>
  );
}
