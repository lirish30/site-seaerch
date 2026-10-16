import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { shortName, useSearches } from "../../searchesData";
import { pipelineRows, radarNext, runningCard, type TodaySummary } from "../../todayHome";
import { LEADS_CHANGED } from "../Shell";
import Icon from "../Icon";
import type { TodayItem } from "../../types";
import { SideGroup, SideItem, SideTitle } from "./parts";

/** Home: your day, the pipeline and activity (both scroll the page to their card), what is running and which radars fire next. */
export default function HomeSidebar() {
  const { hash } = useLocation();
  const nav = useNavigate();
  const { searches, radars } = useSearches();
  const [day, setDay] = useState<number | undefined>();
  const [pipeline, setPipeline] = useState<number | undefined>();
  useEffect(() => {
    const load = () => {
      api.get<{ items: TodayItem[] }>("/today").then((r) => setDay(r.items.length)).catch(() => setDay(undefined));
      api.get<TodaySummary>("/today/summary").then((r) => setPipeline(pipelineRows(r.pipeline).total)).catch(() => setPipeline(undefined));
    };
    load();
    window.addEventListener(LEADS_CHANGED, load);
    return () => window.removeEventListener(LEADS_CHANGED, load);
  }, []);
  const running = (searches ?? []).filter((s) => s.status === "running");

  // Open All leads and put the cursor in its search box (the box mounts a moment after the route changes).
  const searchLeads = () => {
    nav("/leads");
    let tries = 0;
    const find = () => { const box = document.querySelector<HTMLInputElement>(".search-box input"); if (box) box.focus(); else if (++tries < 20) setTimeout(find, 50); };
    setTimeout(find, 0);
  };
  const now = Date.now();
  return (
    <>
      <SideTitle title="Home" action={<button type="button" className="icon-btn" aria-label="Search leads" title="Search leads" onClick={searchLeads}><Icon name="search" size={16} /></button>} />
      <SideItem to="/today" icon="home" label="Your day" count={day} active={hash === ""} />
      <SideItem to="/today#pipeline" icon="kanban" label="Pipeline" count={pipeline} active={hash === "#pipeline"} />
      <SideItem to="/today#activity" icon="clock" label="Activity" active={hash === "#activity"} />
      {running.length > 0 && (
        <SideGroup id="home-running" title="Running now">
          {running.map((s) => {
            const c = runningCard(s, now);
            return (
              <Link key={s.id} to={`/searches/${s.id}`} className="hm-run" title={c.title}>
                <b>{c.title}</b>
                <small>{c.status}</small>
                <span className={`hm-run-bar${c.finding ? " finding" : ""}`} role="progressbar" aria-label="Search progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.pct}><i style={{ width: `${c.pct}%` }} /></span>
              </Link>
            );
          })}
        </SideGroup>
      )}
      {(radars?.length ?? 0) > 0 && (
        <SideGroup id="home-radar" title="Radar">
          {radars!.slice(0, 5).map((r) => (
            <Link key={r.id} to="/radar" className="side-item"><Icon name="radar" size={16} /><span className="label">{shortName(r)}</span><span className="count">{radarNext(r, now)}</span></Link>
          ))}
        </SideGroup>
      )}
    </>
  );
}
