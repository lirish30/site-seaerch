import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Icon from "../components/Icon";
import TrafficSection from "../components/TrafficSection";
import { publicStrategyMemo } from "../api";
import { dayLabel } from "../careReportPageView";
import { isReportToken } from "../reportView";
import { trafficMonthLine } from "../strategyMemoView";
import { trafficView } from "../trafficView";
import type { PublicMemo } from "../../worker/strategy/public";

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
        <div className="rp-card" role="status" aria-label="Loading your plan">
          <span className="rp-sk" style={{ height: 28, width: "60%" }} />
          <span className="rp-sk" style={{ height: 120, borderRadius: 12 }} />
        </div>
      </div>
    </main>
  );
}

// Public page: no session and no Shell. Every word that came from a person or from Claude (the client's name, the standing paragraph, the priorities, what we need) is shown as React text, which escapes it, and the
// page loads no script but the app's own. Nothing on it looks forward: the figures are what Google counted, and the page says so.
export default function StrategyMemoPage() {
  const rest = useParams()["*"];
  const token = isReportToken(rest) ? rest : undefined;
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<PublicMemo | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Your plan";
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
    void publicStrategyMemo(token).then((r) => {
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

  const prepared = dayLabel(page.sentAt);
  const monthLine = trafficMonthLine(page.traffic?.period);
  const traffic = trafficView(page.traffic ? { search: page.traffic.search, visits: page.traffic.visits } : undefined, { positionLabel: "Average position in Google Search" });

  return (
    <main className="rp mr sr">
      <div className="rp-wrap mr-wrap">
        {page.clientName && <header className="sr-for"><span className="rp-bar-name">For {page.clientName}</span></header>}

        <article className="rp-card mr-lead">
          <div className="rp-head">
            <span className="rp-eyebrow">Your plan</span>
            <h1>Where you stand and what we would do first</h1>
            {prepared && <p className="rp-based">Prepared {prepared}</p>}
          </div>
          <p className="mr-text">{page.body.standing}</p>
        </article>

        <section className="mr-section" aria-labelledby="sm-priorities-h">
          <h2 id="sm-priorities-h" className="mr-h">Three priorities</h2>
          {page.body.priorities.map((p, i) => (
            <article key={i} className="rp-card mr-site">
              <h3>{i + 1}. {p.title}</h3>
              <p className="mr-text">{p.why}</p>
              <p className="mr-note">First step</p>
              <p className="mr-text">{p.firstStep}</p>
            </article>
          ))}
        </section>

        <section className="mr-section" aria-labelledby="sm-need-h">
          <h2 id="sm-need-h" className="mr-h">What we need from you</h2>
          <div className="rp-card mr-site">
            <ul className="sr-priorities">
              {page.body.needFromYou.map((need, i) => <li key={i} className="mr-text">{need}</li>)}
            </ul>
          </div>
        </section>

        {traffic && monthLine && <p className="mr-note">{monthLine}</p>}
        {traffic && <TrafficSection view={traffic} />}

        <p className="mr-foot">Reply to the email this came with if you have a question.</p>
      </div>
    </main>
  );
}
