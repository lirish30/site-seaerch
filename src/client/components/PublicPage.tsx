import { useEffect, type ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

/**
 * The shared frame of the pages a client opens from an email (onboarding, change order, subscribe, call booking, Care and Local SEO reports, strategy memo):
 * the top bar, the message-only page, the loading page and the "reply to the email" footer. Styles: `screens/public-os.css` (`pbx-`). Everything is React text.
 */

export type Tone = "neutral" | "signal" | "positive" | "warning" | "critical" | "info";

/** Sets the tab title and keeps the page out of search engines while it is open, then puts both back. */
export function useNoIndex(title: string) {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, [title]);
}

const SL_NAME = "Siteline";
const SL_SITE = "sitelineweb.com";

/**
 * The page's top bar: the mark, what this page is (or who sent it), and on the right who it is for and its state.
 * `sl` is the Siteline masthead the client reports wear (wordmark with a mint dot, the site in mono); the page name is then the header's label, not shown, because the title block says it.
 */
export function PubBar({ name, right, sl = false }: { name: string; right?: ReactNode; sl?: boolean }) {
  if (sl) {
    return (
      <header className="pbx-bar sl-bar" aria-label={name}>
        <div className="pbx-bar-in">
          <span className="sl-mark">{SL_NAME}<i aria-hidden="true" /></span>
          <span className="pbx-grow" />
          {right}
          <span className="sl-contact">{SL_SITE}</span>
        </div>
      </header>
    );
  }
  return (
    <header className="pbx-bar">
      <div className="pbx-bar-in">
        <span className="pbx-mark" aria-hidden="true"><i /></span>
        <b>{name}</b>
        <span className="pbx-grow" />
        {right}
      </div>
    </header>
  );
}

/** A tinted square with an icon in it. */
export function Tile({ icon, tone = "neutral", size = 36 }: { icon: IconName; tone?: Tone; size?: number }) {
  return <span className={`pbx-tile ${tone}`} style={{ width: size, height: size }} aria-hidden="true"><Icon name={icon} size={size >= 36 ? 18 : 16} /></span>;
}

/** A page that is only a message: link gone, load failed, closed, booked. */
export function PubNotice({ kind, icon, tone = "neutral", title, children, sl = false }: { kind: string; icon: IconName; tone?: Tone; title: string; children?: ReactNode; sl?: boolean }) {
  return (
    <main className={`ds-page pbx${sl ? " rp-sl" : ""}`}>
      <PubBar name={kind} sl={sl} />
      <div className="pbx-narrow">
        <section className="pbx-card pbx-notice">
          <Tile icon={icon} tone={tone} size={44} />
          <h1>{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

/** The usual "couldn't load" and "link gone" pages, worded the same everywhere. */
export function PubError({ kind, what, onRetry, sl = false }: { kind: string; what: string; onRetry: () => void; sl?: boolean }) {
  return (
    <PubNotice kind={kind} icon="alert" tone="warning" sl={sl} title={`Couldn't load ${what}`}>
      <p>Something went wrong on our side, or your connection dropped. Please try again.</p>
      <button type="button" className="btn primary" onClick={onRetry}><Icon name="refresh" size={16} />Try again</button>
    </PubNotice>
  );
}

export function PubGone({ kind, title = "This link isn't available", children, sl = false }: { kind: string; title?: string; children?: ReactNode; sl?: boolean }) {
  return (
    <PubNotice kind={kind} icon="link" title={title} sl={sl}>
      {children ?? <p>It may have expired or been turned off. Reply to the email you got and we'll sort it out.</p>}
    </PubNotice>
  );
}

/** The loading page: the bar and grey blocks the shape of what is coming. `two` draws the main column and a side card. */
export function PubSkeleton({ kind, label, two = false, sl = false }: { kind: string; label: string; two?: boolean; sl?: boolean }) {
  return (
    <main className={`ds-page pbx${sl ? " rp-sl" : ""}`} aria-busy="true">
      <PubBar name={kind} sl={sl} />
      <div className={two ? "pbx-grid" : "pbx-wrap"} role="status" aria-label={label}>
        <div className="pbx-col"><span className="pbx-sk" style={{ height: 210 }} /><span className="pbx-sk" style={{ height: 300 }} /></div>
        {two && <span className="pbx-sk" style={{ height: 420 }} />}
      </div>
    </main>
  );
}

/** The last block of a client page: how to ask a question. There is no contact on these pages but the email they came with. */
export function PubContact({ text = "Reply to the email this came with. It comes straight to us." }: { text?: string }) {
  return (
    <section className="pbx-contact" aria-label="Questions">
      <Tile icon="mail" tone="neutral" size={36} />
      <div><b>Questions?</b><p>{text}</p></div>
    </section>
  );
}

/** The foot of a Siteline-themed page: a short rule, then who it was prepared for. Every word is React text. */
export function PubFooter({ client }: { client?: string | null }) {
  return (
    <footer className="sl-foot">
      <p>© {new Date().getFullYear()} {SL_NAME}{client ? ` · Prepared for ${client}` : ""} · Confidential</p>
      <p>{SL_SITE}</p>
    </footer>
  );
}

/** A small grey footnote with an info mark, for what a number means or where it came from. */
export function PubNote({ children }: { children: ReactNode }) {
  return <p className="pbx-note"><Icon name="info" size={14} /><span>{children}</span></p>;
}

/** A labelled bar: what it measures on the left, the figure on the right, the fill toned. */
export function Meter({ label, value, percent, tone = "neutral" }: { label: string; value: string; percent: number; tone?: Tone }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="pbx-meter">
      <div className="pbx-meter-top"><span>{label}</span><b>{value}</b></div>
      <div className={`pbx-meter-bar ${tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}><span style={{ width: `${p}%` }} /></div>
    </div>
  );
}

/** Label and value rows inside a card. */
export function Facts({ rows }: { rows: { label: string; value: string; tone?: Tone }[] }) {
  return (
    <dl className="pbx-facts">
      {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd className={r.tone ?? ""}>{r.tone && r.tone !== "neutral" && <i className="pbx-dot" aria-hidden="true" />}{r.value}</dd></div>)}
    </dl>
  );
}
