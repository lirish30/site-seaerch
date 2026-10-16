import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import Icon, { type IconName } from "../Icon";

export function SideItem({ to, icon, label, count, active }: { to: string; icon: IconName; label: string; count?: number | string; active: boolean }) {
  return (
    <Link to={to} className={`side-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
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

/** The title row of a sidebar: the section name and an optional icon button on the right. */
export function SideTitle({ title, action }: { title: string; action?: ReactNode }) {
  return <div className="side-title"><h2>{title}</h2>{action}</div>;
}
