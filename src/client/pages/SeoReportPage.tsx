import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Facts, PubBar, PubContact, PubError, PubGone, PubNote, PubSkeleton, Tile, useNoIndex } from "../components/PublicPage";
import ReportVideo from "../components/ReportVideo";
import TrafficSection from "../components/TrafficSection";
import { publicSeoReport } from "../api";
import { dayLabel } from "../careReportPageView";
import { isReportToken } from "../reportView";
import { trafficView } from "../trafficView";
import { seoGlance, seoReportPageView, type PublicSeoReport } from "../seoReportPageView";

type Load = "loading" | "ok" | "gone" | "error";

const KIND = "Local SEO report";

/** The band a cell text is in, for its colour. The words in the cell say the same, so the colour is never the only signal. */
const band = (text: string) => (text === "1-3" ? "top" : text === "4-10" ? "mid" : text === "11-20" ? "low" : text === "not checked" ? "off" : "none");
const cellWords = (text: string) => (text === "not in the top 20" ? "Not in top 20" : text === "not checked" ? "Not checked" : text);

// Public page: no session and no Shell. Every word that came from a person or from Claude (the summary, the recommendation, the priorities, the search terms, the content titles, the searches and page paths Google counted) is shown as React text, which
// escapes it, and the page loads no script but the app's own. The summary and what we suggest come first; the figures follow. Nothing on it looks forward: a rank is only what our own check saw.
export default function SeoReportPage() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicSeoReport | null>(null);
  const [attempt, setAttempt] = useState(0);
  useNoIndex("Your Local SEO report");

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

  if (load === "loading") return <PubSkeleton kind={KIND} label="Loading your report" />;
  if (load === "error") return <PubError kind={KIND} what="your report" onRetry={() => setAttempt((n) => n + 1)} />;
  if (load === "gone" || !page) return <PubGone kind={KIND} />;

  const v = seoReportPageView(page, { summary: page.summary, recommendation: page.recommendation, priorities: page.priorities });
  const sent = dayLabel(page.sentOn);
  // Search Console's average position is Google's own figure, not our rank check: it is only ever shown here, named as Google Search's.
  const traffic = trafficView(page.traffic, { positionLabel: "Average position in Google Search" });
  const glance = seoGlance(page);

  return (
    <main className="ds-page pbx">
      <PubBar name={KIND} right={<>
        {page.clientName && <span className="pbx-bar-meta hide-sm">For {page.clientName}</span>}
        {sent && <span className="ds-chip outline">Sent {sent}</span>}
      </>} />
      <div className="pbx-wrap">
        <article className="pbx-card pbx-intro">
          <p className="pbx-eyebrow">Local SEO report{page.clientName ? ` for ${page.clientName}` : ""}</p>
          <h1>{page.label}</h1>
          <p className="pbx-lede">Where you showed on Google this month, what we published and what we will work on next.</p>
          <div className="pbx-strip">
            <b>{glance.headline}</b>
            {glance.chips.length > 0 && <span className="pbx-chips">{glance.chips.map((c) => <span key={c.text} className={`ds-chip ${c.tone}`}><i className="ds-dot" />{c.text}</span>)}</span>}
          </div>
          {page.video && token && <ReportVideo src={`/api/public/l/${token}/video.mp4`} />}
          {v.summary && <p className="pbx-text">{v.summary}</p>}
          {v.recommendation && (
            <section className="pbx-callout" aria-label="What we suggest">
              <span>What we suggest</span>
              <p className="pbx-text">{v.recommendation}</p>
            </section>
          )}
          {v.priorities.length > 0 && (
            <section aria-labelledby="sr-next-h" className="pbx-col" style={{ gap: 10 }}>
              <p className="pbx-label" id="sr-next-h">Next month, we will work on</p>
              <ol className="pbx-prio">{v.priorities.map((p, i) => <li key={i}><span>{i + 1}</span><span>{p}</span></li>)}</ol>
            </section>
          )}
        </article>

        <div className="pbx-section-h"><h2 id="sr-where-h">Where you showed on Google</h2>{v.rankLine && <span>{v.rankLine[0].toUpperCase() + v.rankLine.slice(1)}</span>}</div>
        {!v.hasGrids && <article className="pbx-card tight"><div className="pbx-card-head"><Tile icon="target" /><div><h2>No rank check this month</h2><small>{v.gridNote}</small></div></div></article>}
        {v.hasGrids && v.terms.length === 0 && <article className="pbx-card tight"><div className="pbx-card-head"><Tile icon="target" /><div><h2>No search terms yet</h2><small>No search terms are being checked yet. Once we agree on them with you, each one gets a grid here.</small></div></div></article>}
        {v.terms.map((t, i) => (
          <article key={`${t.heading}-${i}`} className="pbx-card tight" aria-label={t.heading}>
            <div className="pbx-card-head"><Tile icon="pin" tone="signal" /><div><h2>{t.heading}</h2><small>Searched from nine points around the business</small></div></div>
            <div className="pbx-term">
              <table className="pbx-grid9">
                <caption className="pbx-sr">Where {t.heading} showed at nine points around the business, north-west first</caption>
                <tbody>{t.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} className={`pbx-cell ${band(cell)}`}>{cellWords(cell)}</td>)}</tr>)}</tbody>
              </table>
              <div className="pbx-term-side">
                <b>{t.summaryLine}</b>
                {t.movement && <p className="pbx-sub">{t.movement}</p>}
              </div>
            </div>
          </article>
        ))}
        {v.terms.length > 0 && (
          <div className="pbx-col" style={{ gap: 8 }}>
            <ul className="pbx-legend" aria-label="What the colours mean">
              <li><i className="top" />1-3, the top three</li><li><i className="mid" />4-10</li><li><i className="low" />11-20</li><li><i className="none" />Not in the top 20</li><li><i className="off" />Not checked</li>
            </ul>
            <PubNote>{v.gridNote}</PubNote>
          </div>
        )}

        <article className="pbx-card tight">
          <div className="pbx-card-head"><Tile icon="star" tone="warning" /><div><h2>Your Google profile</h2><small>Your rating and reviews on Google</small></div></div>
          <Facts rows={v.profile} />
        </article>

        <article className="pbx-card flush">
          <div className="pbx-card-head"><Tile icon="file-text" tone="info" /><div><h2>What we published</h2><small>{v.content.line}</small></div><span className="pbx-count">{v.content.titles.length}</span></div>
          {v.content.titles.length > 0
            ? <ul className="pbx-rows">{v.content.titles.map((c, i) => <li key={i}><span className="pbx-row-text"><b>{c.title}</b></span><span className="ds-chip neutral">{c.kind}</span></li>)}</ul>
            : <div className="pbx-body"><p className="pbx-sub">New pages, blog posts and Google posts we put live for you will be listed here.</p></div>}
        </article>

        {v.citations.length > 0 && (
          <article className="pbx-card tight">
            <div className="pbx-card-head"><Tile icon="list" tone="neutral" /><div><h2>Directory listings</h2><small>Your name, address and phone on other sites</small></div></div>
            <div className="pbx-stats">
              {v.citations.map((c) => <div key={c.label} className={`pbx-stat ${c.label === "Confirmed" ? "positive" : c.label === "Need fixing" && c.value !== "0" ? "warning" : ""}`}><span>{c.label}</span><b>{c.value}</b></div>)}
            </div>
          </article>
        )}

        {traffic && <TrafficSection view={traffic} />}

        <PubContact />
      </div>
    </main>
  );
}
