import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import Icon, { type IconName } from "./Icon";
import { SETTINGS_PAGES } from "./sidebars/SettingsSidebar";
import type { SettingsDocState } from "../settingsData";

/**
 * The frame every Settings page shares: breadcrumb (Settings > group), title and subtitle (with an optional badge and header action),
 * the page body, and, when `doc` is passed, the sticky "Unsaved changes" bar with Discard and Save. `width` is the form column (default 720).
 */
export default function SettingsPage({ title, sub, badge, action, doc, width, children }: {
  title: string; sub?: ReactNode; badge?: ReactNode; action?: ReactNode; doc?: SettingsDocState; width?: number; children: ReactNode;
}) {
  const { pathname } = useLocation();
  const group = SETTINGS_PAGES.find((p) => pathname === `/settings/${p.slug}`)?.group;
  const showBar = !!doc && doc.loaded && (doc.dirty || doc.justSaved || !!doc.error);
  return (
    <div className="settings-page">
      <header className="st-head">
        <div className="st-head-text">
          {group && <nav className="st-crumbs" aria-label="Breadcrumb"><Link to="/settings">Settings</Link><Icon name="chevron-right" size={12} /><span>{group}</span></nav>}
          <div className="st-title"><h1>{title}</h1>{badge}</div>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </header>
      <div className="st-body">
        <div className="st-col" style={width ? { maxWidth: width } : undefined}>
          {doc && !doc.loaded ? (doc.error ? <Callout tone="critical" icon="alert">{doc.error}</Callout> : <p className="st-loading">Loading…</p>) : children}
        </div>
      </div>
      {doc && showBar && (
        <div className="st-bar" role="status">
          {doc.dirty || doc.error
            ? <><i className={`st-dot${doc.error ? " bad" : ""}`} /><span className={`st-msg${doc.error ? " bad" : ""}`}>{doc.error || "You have unsaved changes"}</span></>
            : <><Icon name="check" size={14} /><span className="st-msg ok">Saved</span></>}
          {doc.dirty && <>
            <button type="button" className="btn-plain" onClick={doc.discard} disabled={doc.saving}>Discard</button>
            <button type="button" className="btn primary" onClick={() => void doc.save()} disabled={doc.saving}>{doc.saving ? "Saving…" : "Save changes"}</button>
          </>}
        </div>
      )}
    </div>
  );
}

/** A labelled field row used by the Settings cards. `error` replaces the help text and turns the control red. */
export function Field({ label, help, error, htmlFor, children }: { label: string; help?: ReactNode; error?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={`st-field${error ? " invalid" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="help err" role="alert">{error}</p> : help && <p className="help">{help}</p>}
    </div>
  );
}

/** Fields side by side (two columns, one on a phone). */
export const Row = ({ children }: { children: ReactNode }) => <div className="st-row">{children}</div>;

/** A white card: a header (title, optional sub and action) over a padded body. Without a title it is just the body. */
export function Card({ title, sub, action, children }: { title?: string; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-card">
      {(title || action) && <header><div>{title && <h2>{title}</h2>}{sub && <p>{sub}</p>}</div>{action}</header>}
      <div className="st-card-body">{children}</div>
    </section>
  );
}

/** A soft tinted note inside a card or page: `info` (grey), `warn` (amber) or `critical`. */
export function Callout({ tone = "info", icon = "info", action, compact, children }: { tone?: "info" | "warn" | "critical"; icon?: IconName; action?: ReactNode; compact?: boolean; children: ReactNode }) {
  return <div className={`st-callout ${tone}${compact ? " compact" : ""}`} role={tone === "critical" ? "alert" : undefined}><Icon name={icon} size={tone === "info" ? 15 : 14} /><span>{children}</span>{action}</div>;
}

/** The pill switcher used for two or three exclusive choices (Default purpose, Length). */
export function Segmented<T extends string>({ label, value, options, onChange, large }: {
  label: string; value: T; options: { value: T; label: string; hint?: string; icon?: IconName }[]; onChange: (v: T) => void; large?: boolean;
}) {
  return (
    <div className={`st-seg${large ? " big" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={14} />}{o.label}{o.hint && <small>{o.hint}</small>}
        </button>
      ))}
    </div>
  );
}

/** A character counter ("132 / 300") for a limited textarea. */
export const Count = ({ n, max }: { n: number; max: number }) => <span className={`st-count${n > max ? " over" : ""}`}>{n} / {max}</span>;
