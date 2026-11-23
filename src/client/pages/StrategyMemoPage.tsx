import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import { PubBar, PubContact, PubError, PubGone, PubSkeleton, Tile, useNoIndex } from "../components/PublicPage";
import TrafficSection from "../components/TrafficSection";
import { publicStrategyMemo } from "../api";
import { dayLabel } from "../careReportPageView";
import { isReportToken } from "../reportView";
import { trafficMonthLine } from "../strategyMemoView";
import { trafficView } from "../trafficView";
import type { PublicMemo } from "../../worker/strategy/public";

type Load = "loading" | "ok" | "gone" | "error";

const KIND = "Your plan";

// Public page: no session and no Shell. Every word that came from a person or from Claude (the client's name, the standing paragraph, the priorities, what we need) is shown as React text, which escapes it, and the
// page loads no script but the app's own. Nothing on it looks forward: the figures are what Google counted, and the page says so.
export default function StrategyMemoPage() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicMemo | null>(null);
  const [attempt, setAttempt] = useState(0);
  useNoIndex("Your plan");

  useEffect(() => {
    if (!token) { setLoad("gone"); return; }
    let cancelled = false;
    setLoad("loading");
    void publicStrategyMemo(token).then((r) => {
      if (cancelled) return;
      if (r.status === 404) setLoad("gone");
      else if (r.page) { setPage(r.page); setLoad("ok"); }
      else setLoad("error");
    });
    return () => { cancelled = true; };
  }, [token, attempt]);

  if (load === "loading") return <PubSkeleton kind={KIND} label="Loading your plan" />;
  if (load === "error") return <PubError kind={KIND} what="your plan" onRetry={() => setAttempt((n) => n + 1)} />;
  if (load === "gone" || !page) return <PubGone kind={KIND} />;

  const prepared = dayLabel(page.sentAt);
  const monthLine = trafficMonthLine(page.traffic?.period);
  const traffic = trafficView(page.traffic ? { search: page.traffic.search, visits: page.traffic.visits } : undefined, { positionLabel: "Average position in Google Search" });

  return (
    <main className="ds-page pbx">
      <PubBar name={KIND} right={<>
        {page.clientName && <span className="pbx-bar-meta hide-sm">For {page.clientName}</span>}
        {prepared && <span className="ds-chip outline">Prepared {prepared}</span>}
      </>} />
      <div className="pbx-wrap">
        <article className="pbx-card pbx-intro">
          <p className="pbx-eyebrow">Strategy memo{page.clientName ? ` for ${page.clientName}` : ""}</p>
          <h1>Where you stand and what we would do first</h1>
          <p className="pbx-text">{page.body.standing}</p>
          <div className="pbx-strip">
            <b>Three priorities, in order, and {page.body.needFromYou.length} things we need from you</b>
          </div>
        </article>

        <div className="pbx-section-h"><h2 id="sm-priorities-h">Three priorities</h2><span>In the order we would do them</span></div>
        {page.body.priorities.map((p, i) => (
          <article key={i} className={`pbx-card tight${i === 0 ? " edge signal" : ""}`} aria-label={p.title}>
            <div className="pbx-card-head">
              <span className="pbx-tile" style={{ width: 36, height: 36, ...(i === 0 ? { background: "var(--signal)", color: "#fff" } : {}) }} aria-hidden="true"><b style={{ font: "600 15px/1 var(--font-mono)" }}>{i + 1}</b></span>
              <div><h2>{p.title}</h2>{i === 0 && <small>Start here</small>}</div>
            </div>
            <p className="pbx-text">{p.why}</p>
            <div className="pbx-first"><Icon name="arrow-right" size={16} /><div><small>First step</small><p className="pbx-text">{p.firstStep}</p></div></div>
          </article>
        ))}

        <article className="pbx-card flush" aria-labelledby="sm-need-h">
          <div className="pbx-card-head"><Tile icon="inbox" tone="signal" /><div><h2 id="sm-need-h">What we need from you</h2><small>Reply to the email with any of these, whenever you can</small></div><span className="pbx-count">{page.body.needFromYou.length}</span></div>
          <ul className="pbx-rows">
            {page.body.needFromYou.map((need, i) => <li key={i}><span className="pbx-rank">{i + 1}</span><span className="pbx-row-text"><b>{need}</b></span></li>)}
          </ul>
        </article>

        {traffic && <TrafficSection view={traffic} intro={monthLine} />}

        <PubContact />
      </div>
    </main>
  );
}
