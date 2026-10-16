import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Icon, { LogoMark } from "../components/Icon";
import {
  basedOnText, emailLabel, expiryText, groupFindings, hasSender, isHttpsLogo, isReportToken, senderInitials, senderLine, senderTitle, summaryText,
  type ReportData,
} from "../reportView";

/** Sender's logo at 28px; falls back to the brand tile when there is none, it is not https, or it fails to load. */
function SenderLogo({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (isHttpsLogo(url) && !broken) return <img className="rp-logo" src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return <span className="rp-logo" aria-hidden="true"><LogoMark size={28} /></span>;
}

/** Full-page notice for the states that have no report to show (link gone, load failed). */
function Notice({ icon, title, children, action }: { icon: "link" | "alert"; title: string; children: string; action?: React.ReactNode }) {
  return (
    <main className="rp">
      <div className="rp-wrap rp-wrap-narrow">
        <section className="rp-card rp-notice" role={action ? "alert" : undefined}>
          <span className="rp-notice-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
          <h1>{title}</h1>
          <p>{children}</p>
          {action}
        </section>
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <main className="rp" aria-busy="true">
      <div className="rp-wrap">
        <div className="rp-bar"><span className="rp-sk rp-sk-logo" /><span className="rp-sk" style={{ width: 120, height: 14 }} /></div>
        <div className="rp-card" role="status" aria-label="Loading report">
          <div className="rp-head"><span className="rp-sk" style={{ width: 96, height: 12 }} /><span className="rp-sk" style={{ width: "80%", height: 28 }} /><span className="rp-sk" style={{ width: "60%", height: 14 }} /></div>
          <span className="rp-sk" style={{ height: 54, borderRadius: 12 }} />
          <span className="rp-sk" style={{ height: 150, borderRadius: 12 }} />
          <span className="rp-sk" style={{ height: 150, borderRadius: 12 }} />
        </div>
      </div>
    </main>
  );
}

// Public page: deliberately bypasses api.ts, whose 401 handling redirects to /login.
export default function Report() {
  const token = useParams()["*"]; // wildcard route, so truncated or extended links land here instead of the app shell
  const [r, setR] = useState<ReportData | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Website check";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, []);

  useEffect(() => {
    if (!isReportToken(token)) { setState("gone"); return; }
    let cancelled = false;
    setState("loading");
    fetch(`/api/public/report/${token}`, { credentials: "omit" })
      .then(async (res) => {
        if (res.status === 404) { if (!cancelled) setState("gone"); return; }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ReportData;
        if (!cancelled) { setR(data); setState("ok"); document.title = `Website check for ${data.businessName}`; }
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [token, attempt]);

  if (state === "loading") return <Skeleton />;
  if (state === "error") return (
    <Notice icon="alert" title="Couldn't load this report" action={<button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}>
      Something went wrong on our side, or your connection dropped. Please try again.
    </Notice>
  );
  if (state === "gone" || !r) return (
    <Notice icon="link" title="This link isn't available">
      It may have expired or been turned off. Ask whoever sent it to share a new link.
    </Notice>
  );

  const groups = groupFindings(r.findings);
  const { sender } = r;
  const title = senderTitle(sender);
  return (
    <main className="rp">
      <div className="rp-wrap">
        <header className="rp-bar">
          <SenderLogo url={sender.logoUrl} />
          {title && <span className="rp-bar-name">{title}</span>}
          <span className="rp-expiry">{expiryText(r.expiresAt)}</span>
        </header>
        <article className="rp-card">
          <div className="rp-head">
            <p className="rp-eyebrow">Website check</p>
            <h1>Quick website check for {r.businessName}</h1>
            <p className="rp-based">{basedOnText(r)}</p>
          </div>

          <div className="rp-summary">
            {groups.length ? <>
              <p className="rp-sum-title">{summaryText(r.counts)}</p>
              <div className="rp-sum-badges">
                {r.counts.high > 0 && <span className="badge2 critical"><i className="dot" />{r.counts.high} high</span>}
                {r.counts.medium > 0 && <span className="badge2 warning"><i className="dot" />{r.counts.medium} medium</span>}
                {r.counts.low > 0 && <span className="badge2"><i className="dot" />{r.counts.low} low</span>}
              </div>
            </> : <p className="rp-sum-title">We didn't spot any major issues.</p>}
          </div>

          {groups.map((g) => (
            <section key={g.severity} className={`rp-group rp-${g.severity}`} aria-labelledby={`rp-g-${g.severity}`}>
              <div className="rp-group-head">
                <h2 id={`rp-g-${g.severity}`}>{g.label}</h2>
                <span className="rp-count" aria-hidden="true">{g.items.length}</span>
              </div>
              <ul>{g.items.map((e, i) => <li key={i}><span className="rp-dot" aria-hidden="true" /><span>{e}</span></li>)}</ul>
            </section>
          ))}

          <div className="rp-notes">
            {r.partial && <p className="rp-note"><Icon name="info" size={14} /><span>Some speed checks couldn't be completed.</span></p>}
            <p className="rp-note"><Icon name="info" size={14} /><span>This is an automated check of publicly visible information and may not capture everything.</span></p>
          </div>

          {hasSender(sender) && (
            <section className="rp-sender" aria-label="Contact">
              <div className="rp-sender-who">
                <span className="rp-avatar" aria-hidden="true">{senderInitials(sender)}</span>
                <div className="rp-sender-text">
                  {sender.name && <p className="rp-sender-name">{sender.name}</p>}
                  {senderLine(sender) && <p className="rp-sender-line">{senderLine(sender)}</p>}
                </div>
              </div>
              {sender.email && <a className="btn primary" href={`mailto:${sender.email}`}><Icon name="mail" size={16} />{emailLabel(sender)}</a>}
            </section>
          )}
        </article>
      </div>
    </main>
  );
}
