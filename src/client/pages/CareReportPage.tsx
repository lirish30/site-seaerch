import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Facts, Meter, PubBar, PubContact, PubError, PubGone, PubNote, PubSkeleton, Tile, useNoIndex } from "../components/PublicPage";
import ReportVideo from "../components/ReportVideo";
import TrafficSection from "../components/TrafficSection";
import { publicCareReport } from "../api";
import { careGlance, dayLabel, editsLine, renewalLine, siteDetails, siteFactTone, trafficView, type PublicReport } from "../careReportPageView";
import { isReportToken } from "../reportView";

type Load = "loading" | "ok" | "gone" | "error";

const KIND = "Care report";
const EDIT_NOTE = { ok: null, warn: "Close to this month's edit hours.", over: "Past this month's edit hours." } as const;
const EDIT_TONE = { ok: "positive", warn: "warning", over: "critical" } as const;

// Public page: no session and no Shell. Every word from us or from the report (the summary, the recommendation, a domain) is shown as React text, which escapes it, and the page loads no
// script but the app's own. The summary and what we suggest come first; the figures follow.
export default function CareReportPage() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicReport | null>(null);
  const [attempt, setAttempt] = useState(0);
  useNoIndex("Your site report");

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

  if (load === "loading") return <PubSkeleton kind={KIND} label="Loading your report" />;
  if (load === "error") return <PubError kind={KIND} what="your report" onRetry={() => setAttempt((n) => n + 1)} />;
  if (load === "gone" || !page) return <PubGone kind={KIND} />;

  const edits = editsLine(page.edits);
  const sent = dayLabel(page.sentOn);
  const traffic = trafficView(page.traffic);
  const glance = careGlance(page);
  const barPercent = page.edits && page.edits.allowanceMinutes > 0 ? Math.min(100, Math.round((page.edits.usedMinutes / page.edits.allowanceMinutes) * 100)) : 0;

  return (
    <main className="ds-page pbx">
      <PubBar name={KIND} right={<>
        {page.clientName && <span className="pbx-bar-meta hide-sm">For {page.clientName}</span>}
        {sent && <span className="ds-chip outline">Sent {sent}</span>}
      </>} />
      <div className="pbx-wrap">
        <article className="pbx-card pbx-intro">
          <p className="pbx-eyebrow">Care report{page.clientName ? ` for ${page.clientName}` : ""}</p>
          <h1>{page.label}</h1>
          <p className="pbx-lede">What we checked, fixed and kept running on your site this month.</p>
          <div className="pbx-strip">
            <b>{glance.headline}</b>
            {glance.chips.length > 0 && <span className="pbx-chips">{glance.chips.map((c) => <span key={c.text} className={`ds-chip ${c.tone}`}><i className="ds-dot" />{c.text}</span>)}</span>}
          </div>
          {page.video && token && <ReportVideo src={`/api/public/m/${token}/video.mp4`} />}
          {page.summary && <p className="pbx-text">{page.summary}</p>}
          {page.recommendation && (
            <section className="pbx-callout" aria-label="What we suggest">
              <span>What we suggest</span>
              <p className="pbx-text">{page.recommendation}</p>
            </section>
          )}
        </article>

        {page.sites.length > 0 && <div className="pbx-section-h"><h2>{page.sites.length === 1 ? "Your site" : "Your sites"}</h2></div>}
        {page.sites.map((s, i) => {
          const rows = siteDetails(s).map((r) => ({ ...r, tone: siteFactTone(r) }));
          const healthy = rows.some((r) => r.label === "Downtime" && r.tone === "positive");
          const trouble = rows.some((r) => r.tone === "warning");
          return (
            <article key={`${s.domain}-${i}`} className="pbx-card tight">
              <div className="pbx-card-head">
                <Tile icon="globe" tone={trouble ? "warning" : healthy ? "positive" : "neutral"} />
                <div><h2>{s.domain}</h2><small>{trouble ? "Worth a look" : healthy ? "Up and running" : "What we measured"}</small></div>
              </div>
              {rows.length > 0 ? <Facts rows={rows} /> : <p className="pbx-sub">Nothing was measured for this site this month yet.</p>}
            </article>
          );
        })}

        {edits && page.edits && (
          <article className="pbx-card tight">
            <div className="pbx-card-head">
              <Tile icon="pen" tone="info" />
              <div><h2>Edit hours</h2><small>{page.edits.requestsDone === 1 ? "1 edit request done" : `${page.edits.requestsDone} edit requests done`} this month</small></div>
            </div>
            {page.edits.allowanceMinutes > 0
              ? <Meter label="Hours used this month" value={edits} percent={barPercent} tone={EDIT_TONE[page.edits.state]} />
              : <p className="pbx-sub">{edits} this month.</p>}
            {EDIT_NOTE[page.edits.state] && <p className="pbx-sub">{EDIT_NOTE[page.edits.state]}</p>}
          </article>
        )}

        <article className="pbx-card flush">
          <div className="pbx-card-head"><Tile icon="calendar" tone="neutral" /><div><h2>Coming up</h2><small>Renewals we keep an eye on for you</small></div></div>
          {page.renewals.length === 0
            ? <div className="pbx-body"><p className="pbx-sub">Nothing is due soon. We will list domain, certificate and plan renewals here when they get close.</p></div>
            : (
              <ul className="pbx-rows">
                {page.renewals.map((r, i) => {
                  const line = renewalLine(r);
                  return <li key={`${r.what}-${r.on}-${i}`}><span className="pbx-row-text"><b>{line.title}</b></span><span className="ds-chip outline">{line.date}</span></li>;
                })}
              </ul>
            )}
        </article>

        {traffic && <TrafficSection view={traffic} />}

        <PubContact />
        <PubNote>Figures come from our own checks of your site and, where shown, from Google. A month with nothing measured is left out, never shown as zero.</PubNote>
      </div>
    </main>
  );
}
