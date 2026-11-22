import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import ReportVideo from "../components/ReportVideo";
import TrafficSection from "../components/TrafficSection";
import { publicCareReport } from "../api";
import { dayLabel, editsLine, renewalLine, siteDetails, trafficView, type PublicReport } from "../careReportPageView";
import { isReportToken } from "../reportView";

type Load = "loading" | "ok" | "gone" | "error";

/** A page that is only a message: link gone, load failed. */
function Notice({ icon, title, children }: { icon: "link" | "alert"; title: string; children?: React.ReactNode }) {
  return (
    <main className="rp mr">
      <div className="rp-wrap rp-wrap-narrow">
        <section className="rp-card rp-notice">
          <span className="rp-notice-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
          <h1>{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <main className="rp mr" aria-busy="true">
      <div className="rp-wrap mr-wrap">
        <div className="rp-card" role="status" aria-label="Loading your report">
          <span className="rp-sk" style={{ height: 28, width: "60%" }} />
          <span className="rp-sk" style={{ height: 120, borderRadius: 12 }} />
        </div>
      </div>
    </main>
  );
}

const EDIT_NOTE = { ok: null, warn: "Close to this month's edit hours.", over: "Past this month's edit hours." } as const;

// Public page: no session and no Shell. Every word from us or from the report (the summary, the recommendation, a domain) is shown as React text, which escapes it, and the page loads no
// script but the app's own. The summary and what we suggest come first; the figures follow.
export default function CareReportPage() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicReport | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Your site report";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, []);

  useEffect(() => {
    if (!token) { setLoad("gone"); return; }
    let cancelled = false;
    setLoad("loading");
    void publicCareReport(token).then((r) => {
      if (cancelled) return;
      if (r.status === 404) setLoad("gone");
      else if (r.page) { setPage(r.page); setLoad("ok"); }
      else setLoad("error");
    });
    return () => { cancelled = true; };
  }, [token, attempt]);

  if (load === "loading") return <Skeleton />;
  if (load === "error") return (
    <Notice icon="alert" title="Couldn't load this page">
      <p>Something went wrong on our side, or your connection dropped. Please try again.</p>
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
    </Notice>
  );
  if (load === "gone" || !page) return <Notice icon="link" title="This link isn't available"><p>It may have expired or been turned off. Reply to the email you got and we'll sort it out.</p></Notice>;

  const edits = editsLine(page.edits);
  const sent = dayLabel(page.sentOn);
  const traffic = trafficView(page.traffic);
  const barPercent = page.edits && page.edits.allowanceMinutes > 0 ? Math.min(100, Math.round((page.edits.usedMinutes / page.edits.allowanceMinutes) * 100)) : 0;

  return (
    <main className="rp mr">
      <div className="rp-wrap mr-wrap">
        {page.clientName && <header className="rp-bar"><span className="rp-bar-name">For {page.clientName}</span></header>}

        <article className="rp-card mr-lead">
          <div className="rp-head">
            <span className="rp-eyebrow">Care report</span>
            <h1>{page.label}</h1>
            {sent && <p className="rp-based">Sent {sent}</p>}
          </div>
          {page.video && token && <ReportVideo src={`/api/public/m/${token}/video.mp4`} />}
          {page.summary && <p className="mr-text">{page.summary}</p>}
          {page.recommendation && (
            <section className="mr-suggest" aria-labelledby="mr-suggest-h">
              <h2 id="mr-suggest-h">What we suggest</h2>
              <p className="mr-text">{page.recommendation}</p>
            </section>
          )}
        </article>

        {page.sites.length > 0 && (
          <section className="mr-section" aria-labelledby="mr-sites-h">
            <h2 id="mr-sites-h" className="mr-h">{page.sites.length === 1 ? "Your site" : "Your sites"}</h2>
            {page.sites.map((s, i) => (
              <article key={`${s.domain}-${i}`} className="rp-card mr-site">
                <h3>{s.domain}</h3>
                <dl className="mr-rows">
                  {siteDetails(s).map((row) => (
                    <div key={row.label} className="mr-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>
                  ))}
                </dl>
              </article>
            ))}
          </section>
        )}

        {traffic && <TrafficSection view={traffic} />}

        {edits && page.edits && (
          <section className="mr-section" aria-labelledby="mr-edits-h">
            <h2 id="mr-edits-h" className="mr-h">Edit hours</h2>
            <div className="rp-card mr-edits">
              <p className="mr-edits-line">{edits}</p>
              {page.edits.allowanceMinutes > 0 && <div className={`ob-bar mr-bar mr-bar-${page.edits.state}`} aria-hidden="true"><span style={{ width: `${barPercent}%` }} /></div>}
              {EDIT_NOTE[page.edits.state] && <p className="mr-note">{EDIT_NOTE[page.edits.state]}</p>}
              <p className="mr-note">{page.edits.requestsDone === 1 ? "1 edit request done" : `${page.edits.requestsDone} edit requests done`} this month.</p>
            </div>
          </section>
        )}

        <section className="mr-section" aria-labelledby="mr-next-h">
          <h2 id="mr-next-h" className="mr-h">Coming up</h2>
          <div className="rp-card mr-next">
            {page.renewals.length === 0 && <p className="mr-note">Nothing is due soon.</p>}
            {page.renewals.length > 0 && (
              <ul className="mr-renewals">
                {page.renewals.map((r, i) => {
                  const line = renewalLine(r);
                  return <li key={`${r.what}-${r.on}-${i}`}><span className="mr-renewal-title">{line.title}</span><span className="mr-renewal-date">{line.date}</span></li>;
                })}
              </ul>
            )}
          </div>
        </section>

        <p className="mr-foot">Reply to the email this came with if you have a question.</p>
      </div>
    </main>
  );
}
