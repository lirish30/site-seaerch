import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import Icon, { type IconName } from "./Icon";

/** The building blocks the newer pages share with Home, so every page reads the same way: a row of headline numbers, cards with a titled header, and empty states that say what will show up and how to get it there. */

export interface Stat { label: string; value: ReactNode; sub?: ReactNode; tone?: "positive" | "warning" | "" }

/** The headline numbers at the top of a page: one card split into cells, like the lead page's scorecard. A small uppercase label, the number, one line saying what it means. */
export function StatRow({ stats, label = "Key numbers" }: { stats: Stat[]; label?: string }) {
  return (
    <section className="pb-strip" aria-label={label} style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
      {stats.map((s) => (
        <div key={s.label} className="pb-cell">
          <p className="kicker">{s.label}</p>
          <p className="pb-num">{s.value}</p>
          {s.sub !== undefined && <div className={`pb-sub ${s.tone ?? ""}`}>{s.sub}</div>}
        </div>
      ))}
    </section>
  );
}

/** A card with Home's header row: icon, title, and a note or link on the right. */
export function Card({ icon, title, note, children, className = "", flush = false, id }: { icon?: IconName; title: ReactNode; note?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string }) {
  return (
    <section className={`hm-card pb-card ${className}`} id={id}>
      <header className="hm-card-head">
        {icon && <Icon name={icon} size={16} />}
        <h2>{title}</h2>
        {note !== undefined && <span className="hm-head-note small">{note}</span>}
      </header>
      <div className={flush ? "pb-flush" : "hm-card-body"}>{children}</div>
    </section>
  );
}

export interface Step { title: string; text: ReactNode; to?: string; done?: boolean }

/** An empty page that teaches: what this page is for, what fills it, and the next thing to do. Optional numbered steps show how the page comes alive. */
export function EmptyState({ icon, title, children, action, steps }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode; steps?: Step[] }) {
  return (
    <section className="hm-card pb-empty" role="status">
      <div className="hm-state">
        <span className="hm-state-icon"><Icon name={icon} size={18} /></span>
        <p className="hm-state-title">{title}</p>
        {children && <p>{children}</p>}
        {action}
      </div>
      {steps && steps.length > 0 && (
        <ol className="pb-steps">
          {steps.map((s, i) => (
            <li key={s.title} className={s.done ? "done" : ""}>
              <span className="pb-step-n" aria-hidden="true">{s.done ? <Icon name="check" size={14} /> : i + 1}</span>
              <div>
                <b>{s.to ? <Link to={s.to}>{s.title}</Link> : s.title}</b>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** A thin labelled meter: "12 of 20", with the fill in ink, amber when near the limit and red when over. */
export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tone = max > 0 && value > max ? "over" : pct >= 85 ? "near" : "";
  return <span className={`pb-meter ${tone}`} role="img" aria-label={label ?? `${value} of ${max}`}><i style={{ width: `${pct}%` }} /></span>;
}
