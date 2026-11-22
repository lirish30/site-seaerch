import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import ReportVideo from "../components/ReportVideo";
import TrafficSection from "../components/TrafficSection";
import { publicSeoReport } from "../api";
import { dayLabel } from "../careReportPageView";
import { isReportToken } from "../reportView";
import { trafficView } from "../trafficView";
import { seoReportPageView, type PublicSeoReport } from "../seoReportPageView";

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

/** The band a cell text is in, for its colour. The words in the cell say the same, so the colour is never the only signal. */
const band = (text: string) => (text === "1-3" ? "top" : text === "4-10" ? "mid" : text === "11-20" ? "low" : text === "not checked" ? "off" : "none");

// Public page: no session and no Shell. Every word that came from a person or from Claude (the summary, the recommendation, the priorities, the search terms, the content titles, the searches and page paths Google counted) is shown as React text, which
// escapes it, and the page loads no script but the app's own. The summary and what we suggest come first; the figures follow. Nothing on it looks forward: a rank is only what our own check saw.
export default function SeoReportPage() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicSeoReport | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Your Local SEO report";
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
    void publicSeoReport(token).then((r) => {
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

  const v = seoReportPageView(page, { summary: page.summary, recommendation: page.recommendation, priorities: page.priorities });
  const sent = dayLabel(page.sentOn);
  // Search Console's average position is Google's own figure, not our rank check: it is only ever shown here, named as Google Search's.
  const traffic = trafficView(page.traffic, { positionLabel: "Average position in Google Search" });

  return (
    <main className="rp mr sr">
      <div className="rp-wrap mr-wrap">
        {page.clientName && <header className="sr-for"><span className="rp-bar-name">For {page.clientName}</span></header>}

        <article className="rp-card mr-lead">
          <div className="rp-head">
            <span className="rp-eyebrow">Local SEO report</span>
            <h1>{page.label}</h1>
            {sent && <p className="rp-based">Sent {sent}</p>}
          </div>
          {page.video && token && <ReportVideo src={`/api/public/l/${token}/video.mp4`} />}
          {v.summary && <p className="mr-text">{v.summary}</p>}
          {v.recommendation && (
            <section className="mr-suggest" aria-labelledby="sr-suggest-h">
              <h2 id="sr-suggest-h">What we suggest</h2>
              <p className="mr-text">{v.recommendation}</p>
            </section>
          )}
          {v.priorities.length > 0 && (
            <section className="mr-suggest" aria-labelledby="sr-next-h">
              <h2 id="sr-next-h">Next month, we will work on</h2>
              <ol className="sr-priorities">
                {v.priorities.map((p, i) => <li key={i} className="mr-text">{p}</li>)}
              </ol>
            </section>
          )}
        </article>

        <section className="mr-section" aria-labelledby="sr-where-h">
          <h2 id="sr-where-h" className="mr-h">Where you showed on Google{v.rankLine ? `, ${v.rankLine}` : ""}</h2>
          <p className="mr-note">{v.gridNote}</p>
          {v.hasGrids && v.terms.length === 0 && <div className="rp-card"><p className="mr-note">No search terms are being checked yet.</p></div>}
          {v.terms.map((t, i) => (
            <article key={`${t.heading}-${i}`} className="rp-card mr-site">
              <h3>{t.heading}</h3>
              <table className="sr-grid">
                <caption className="sr-sr">Where {t.heading} showed at nine points around the business, north-west first</caption>
                <tbody>
                  {t.rows.map((row, r) => (
                    <tr key={r}>{row.map((cell, c) => <td key={c} className={`sr-cell sr-${band(cell)}`}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              <p className="mr-text sr-line">{t.summaryLine}</p>
              {t.movement && <p className="mr-note">{t.movement}</p>}
            </article>
          ))}
          {v.terms.length > 0 && <p className="mr-note">The numbers in a cell are the places the business showed in Google's results from that point: 1-3 is the top three.</p>}
        </section>

        <section className="mr-section" aria-labelledby="sr-profile-h">
          <h2 id="sr-profile-h" className="mr-h">Your Google profile</h2>
          <div className="rp-card mr-site">
            <dl className="mr-rows">
              {v.profile.map((row) => <div key={row.label} className="mr-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
            </dl>
          </div>
        </section>

        {traffic && <TrafficSection view={traffic} />}

        <section className="mr-section" aria-labelledby="sr-content-h">
          <h2 id="sr-content-h" className="mr-h">What we published</h2>
          <div className="rp-card mr-site">
            <p className="mr-text">{v.content.line}</p>
            {v.content.titles.length > 0 && (
              <ul className="mr-renewals">
                {v.content.titles.map((c, i) => <li key={i}><span className="mr-renewal-title">{c.title}</span><span className="mr-renewal-date">{c.kind}</span></li>)}
              </ul>
            )}
          </div>
        </section>

        {v.citations.length > 0 && (
          <section className="mr-section" aria-labelledby="sr-dir-h">
            <h2 id="sr-dir-h" className="mr-h">Directory listings</h2>
            <div className="rp-card mr-site">
              <dl className="mr-rows">
                {v.citations.map((row) => <div key={row.label} className="mr-row"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
              </dl>
            </div>
          </section>
        )}

        <p className="mr-foot">Reply to the email this came with if you have a question.</p>
      </div>
    </main>
  );
}
