import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import Icon, { type IconName } from "./Icon";

/**
 * The Agency OS design system, built from the Figma file (pSYn1a7EtoDH2bkonZ7Nfj, Screens rows at y=8400 and y=10000).
 * Every newer page is assembled from these, so a record, a list and a board all read the same way. Styles: ds.css.
 */

export type Tone = "neutral" | "outline" | "positive" | "warning" | "critical" | "info" | "signal";

/** Initials in a soft Signal tile: 28 in lists, 44 in a record's header. */
export function Avatar({ name, size = 28 }: { name: string; size?: 28 | 36 | 44 }) {
  const words = name.replace(/[^\p{L}\p{N}\s&]/gu, " ").split(/\s+/).filter((w) => w && w !== "&");
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  return <span className={`ds-avatar s${size}`} aria-hidden="true">{initials}</span>;
}

/** A status or type chip. `dot` adds the status dot (status chips have one; type and price chips do not). */
export function Chip({ tone = "neutral", dot = false, children, title }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string }) {
  return <span className={`ds-chip ${tone}`} title={title}>{dot && <i className="ds-dot" aria-hidden="true" />}{children}</span>;
}

export interface Crumb { label: string; to?: string }

/**
 * A page's header. List pages: title, one summary line, actions. Record pages add the breadcrumb row (with "3 of 7" and
 * prev/next), an avatar, chips beside the title and a meta line of icon + text facts. `tabs` sit under it, inside the border.
 */
export function PageHeader({ crumbs, pager, avatar, title, chips, meta, sub, actions, tabs }: {
  crumbs?: Crumb[];
  pager?: { label: string; prev?: () => void; next?: () => void };
  avatar?: string;
  title: ReactNode;
  chips?: ReactNode;
  meta?: { icon: IconName; text: ReactNode }[];
  sub?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}) {
  return (
    <header className={`ds-head${tabs ? " has-tabs" : ""}`}>
      {(crumbs || pager) && (
        <nav className="ds-crumbs" aria-label="Breadcrumb">
          {crumbs && crumbs.length > 0 && <Icon name="chevron-left" size={14} />}
          {crumbs?.map((c, i) => (
            <span key={i} className="ds-crumb">
              {i > 0 && <span className="ds-crumb-sep" aria-hidden="true">/</span>}
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
            </span>
          ))}
          <span className="ds-grow" />
          {pager && (
            <span className="ds-pager">
              <span>{pager.label}</span>
              <button type="button" className="ds-icon-btn" aria-label="Previous" disabled={!pager.prev} onClick={pager.prev}><Icon name="chevron-left" size={16} /></button>
              <button type="button" className="ds-icon-btn" aria-label="Next" disabled={!pager.next} onClick={pager.next}><Icon name="chevron-right" size={16} /></button>
            </span>
          )}
        </nav>
      )}
      <div className="ds-head-row">
        {avatar && <Avatar name={avatar} size={44} />}
        <div className="ds-head-main">
          <div className="ds-title-row"><h1>{title}</h1>{chips}</div>
          {meta && meta.length > 0 && (
            <p className="ds-meta">{meta.map((m, i) => <span key={i}><Icon name={m.icon} size={14} />{m.text}</span>)}</p>
          )}
          {sub && <p className="ds-sub">{sub}</p>}
        </div>
        {actions && <div className="ds-actions">{actions}</div>}
      </div>
      {tabs}
    </header>
  );
}

/** Underline tabs under a record's header, each with an optional count. */
export function Tabs<K extends string>({ tabs, value, onChange, label = "Sections" }: { tabs: { key: K; label: string; count?: ReactNode }[]; value: K; onChange: (k: K) => void; label?: string }) {
  return (
    <div className="ds-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}{t.count !== undefined && t.count !== null && t.count !== "" && <span className="ds-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** The grey segmented control (All 7 · Care 4 · …). */
export function Seg<K extends string>({ options, value, onChange, label }: { options: { key: K; label: string; count?: number }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="ds-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}{o.count !== undefined && <span>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A card with an icon header: title on the left, a quiet note or a small action on the right. `flush` drops the body padding for rows and tables. */
export function Card({ icon, title, note, action, children, flush = false, className = "", id }: {
  icon?: IconName; title: ReactNode; note?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string;
}) {
  return (
    <section className={`ds-card ${className}`} id={id}>
      <header className="ds-card-head">
        {icon && <Icon name={icon} size={16} />}
        <h2>{title}</h2>
        {note !== undefined && <span className="ds-card-note">{note}</span>}
        {action}
      </header>
      <div className={flush ? "ds-card-flush" : "ds-card-body"}>{children}</div>
    </section>
  );
}

/** A label / value list (the About card): grey label column, ink value column, a hairline between rows. */
export function Facts({ rows, footnote }: { rows: { label: string; value: ReactNode }[]; footnote?: ReactNode }) {
  return (
    <>
      <dl className="ds-facts">{rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
      {footnote && <p className="ds-footnote">{footnote}</p>}
    </>
  );
}

/** A row that opens another record: icon, title, one grey line, chevron. The whole row is the link. */
export function LinkRow({ to, icon, title, sub, right }: { to: string; icon: IconName; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <Link to={to} className="ds-link-row">
      <Icon name={icon} size={16} />
      <span className="ds-link-text"><b>{title}</b>{sub && <small>{sub}</small>}</span>
      {right}
      <Icon name="chevron-right" size={14} className="ds-chev" />
    </Link>
  );
}

/** The big number with its unit (82 of 100 · healthy), a meter and check/cross reasons: the Health and Edit time cards. */
export function Score({ value, unit, size = "xl", meter, reasons }: {
  value: ReactNode; unit?: ReactNode; size?: "xl" | "md"; meter?: { value: number; max: number; tone?: Tone }; reasons?: { ok: boolean | null; text: ReactNode }[];
}) {
  return (
    <div className="ds-score">
      <p className={`ds-big ${size}`}>{value}{unit && <small>{unit}</small>}</p>
      {meter && <Meter {...meter} />}
      {reasons && reasons.length > 0 && (
        <ul className="ds-reasons">
          {reasons.map((r, i) => (
            <li key={i} className={r.ok === true ? "ok" : r.ok === false ? "bad" : ""}>
              <Icon name={r.ok === false ? "alert" : r.ok === null ? "info" : "check"} size={14} />{r.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A 6px meter. The tone colours the fill: positive green, signal orange, warning amber, critical red, neutral ink. */
export function Meter({ value, max, tone = "neutral", label, width }: { value: number; max: number; tone?: Tone; label?: string; width?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return <span className={`ds-meter ${tone}`} style={width ? { width } : undefined} role="img" aria-label={label ?? `${Math.round(pct)}%`}><i style={{ width: `${pct}%` }} /></span>;
}

export interface TimelineEvent { key: string; icon: IconName; tone?: Tone; title: ReactNode; sub?: ReactNode; when?: ReactNode; action?: ReactNode; to?: string }

/** Events in groups (TODAY / THIS MONTH / EARLIER): an icon tile, a title, one grey line, the time, an optional action. */
export function Timeline({ groups, empty }: { groups: { label: string; events: TimelineEvent[] }[]; empty?: ReactNode }) {
  const shown = groups.filter((g) => g.events.length > 0);
  if (shown.length === 0) return <div className="ds-timeline"><p className="ds-empty-line">{empty ?? "Nothing yet."}</p></div>;
  return (
    <div className="ds-timeline">
      {shown.map((g) => (
        <div key={g.label} role="group" aria-label={g.label}>
          <p className="ds-group">{g.label}</p>
          {g.events.map((e) => {
            const body = (
              <>
                <span className={`ds-tile ${e.tone ?? "neutral"}`}><Icon name={e.icon} size={16} /></span>
                <span className="ds-event-text"><b>{e.title}</b>{e.sub && <small>{e.sub}</small>}</span>
                {e.when && <time>{e.when}</time>}
                {e.action}
              </>
            );
            return e.to ? <Link key={e.key} to={e.to} className="ds-event link">{body}</Link> : <div key={e.key} className="ds-event">{body}</div>;
          })}
        </div>
      ))}
    </div>
  );
}

/** A stat card: icon + label, the number, one line saying what it means (coloured by tone). */
export function Stat({ icon, label, value, sub, tone }: { icon: IconName; label: string; value: ReactNode; sub?: ReactNode; tone?: "positive" | "warning" | "critical" }) {
  return (
    <div className="ds-stat">
      <p className="ds-stat-label"><Icon name={icon} size={16} />{label}</p>
      <p className="ds-stat-value">{value}</p>
      {sub !== undefined && <p className={`ds-stat-sub${tone ? ` ${tone}` : ""}`}>{sub}</p>}
    </div>
  );
}
export const Stats = ({ children, label = "Key numbers" }: { children: ReactNode; label?: string }) => <section className="ds-stats" aria-label={label}>{children}</section>;

/**
 * The one thing to do on this page, said plainly, with its button. Warning for money or deadlines (Invoices overdue),
 * signal for something running now (the timer), info for a heads-up, positive for "all clear".
 */
export function Banner({ tone = "warning", icon, title, children, action }: { tone?: "warning" | "signal" | "info" | "positive" | "critical"; icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`ds-banner ${tone}`} role={tone === "critical" || tone === "warning" ? "alert" : "status"}>
      <Icon name={icon ?? (tone === "positive" ? "check" : tone === "info" ? "info" : tone === "signal" ? "zap" : "alert")} size={16} />
      <div className="ds-banner-text"><b>{title}</b>{children && <p>{children}</p>}</div>
      {action}
    </div>
  );
}

/** The quiet footnote under a table or board (ⓘ Health blends payment history…). */
export const Note = ({ children }: { children: ReactNode }) => <p className="ds-note"><Icon name="info" size={14} /><span>{children}</span></p>;

/** An empty card that teaches: what shows here, how it gets here, and the button that starts it. */
export function Empty({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ds-empty" role="status">
      <span className="ds-tile neutral big"><Icon name={icon} size={18} /></span>
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
