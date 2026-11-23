import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Icon from "../components/Icon";
import { Banner, PageHeader } from "../components/ds";
import ActivityCard from "../components/home/ActivityCard";
import CallsCard from "../components/home/CallsCard";
import CapacityCard from "../components/home/CapacityCard";
import FreedomCard from "../components/home/FreedomCard";
import HelperCard from "../components/home/HelperCard";
import KpiCards from "../components/home/KpiCards";
import PipelineCard from "../components/home/PipelineCard";
import QueueCard from "../components/home/QueueCard";
import SpendCard from "../components/home/SpendCard";
import NeedsYou, { type NeedsFilter } from "../components/home/UpNext";
import WatchedCard from "../components/home/WatchedCard";
import { useHome } from "../components/home/useHome";
import { dayLine, greeting, homeBanner } from "../todayHome";
import { dueBadge } from "../todayView";

/**
 * Home (Figma 57:3846 "Home v2"): the greeting, four headline numbers, one "Needs you" list (approvals and the Up next queue),
 * calls and warm leads, activity; on the right the Freedom number, pipeline, Claude queue, hours and spend.
 */
export default function Today() {
  const h = useHome();
  const { hash, key } = useLocation();
  const now = new Date();
  const [filter, setFilter] = useState<NeedsFilter>("all");
  const pickFilter = useCallback((f: NeedsFilter) => setFilter(f), []);

  // The sidebar's Pipeline and Activity links are hashes: scroll the panel to that card, or back to the top for Your day.
  useEffect(() => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const el = hash ? document.getElementById(hash.slice(1)) : null;
    if (el) el.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    else document.querySelector(".panel")?.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  }, [hash, key]);

  const items = h.items.data, appr = h.approvals.data, s = h.summary.data;
  const waiting = items && appr ? items.length + appr.length : null;
  const late = items ? items.filter((i) => dueBadge(i, now)?.tone === "critical").length : 0;
  const banner = items && appr && s ? homeBanner({ lateFollowUps: late, approvals: appr.length, draftsReady: s.drafts.ready, draftsWaiting: s.drafts.waiting }) : null;
  const goNeeds = (f: NeedsFilter) => { setFilter(f); document.getElementById("needs")?.scrollIntoView({ block: "start", behavior: "smooth" }); };

  return (
    <div className="ds-page hox">
      <PageHeader
        title={greeting(h.money.data?.name ?? "", now)}
        sub={dayLine(waiting, now)}
        actions={<>
          <button type="button" className={`btn${h.loading ? " hox-spin" : ""}`} onClick={h.reload} disabled={h.loading} aria-busy={h.loading}><Icon name="refresh" size={16} />Refresh</button>
          {appr && appr.length > 0
            ? <button type="button" className="btn primary" onClick={() => goNeeds("approvals")}><Icon name="check" size={16} />Review {appr.length} waiting</button>
            : <Link to="/" className="btn primary"><Icon name="plus" size={16} />New search</Link>}
        </>}
      />
      <div className="ds-body">
        {banner && (
          <Banner tone={banner.tone} icon={banner.action === "outreach" ? "send" : "clock"} title={banner.title}
            action={banner.action === "outreach" ? <Link to="/outreach" className="btn sm primary">Open Outreach</Link>
              : <button type="button" className="btn sm primary" onClick={() => goNeeds("follow_up_due")}>Show follow-ups</button>}>
            {banner.body}
          </Banner>
        )}
        <KpiCards summary={h.summary} approvals={h.approvals} items={h.items} calls={h.calls} freedom={h.freedom} onRetry={h.reload} />
        <div className="hox-cols">
          <div className="ds-col">
            <NeedsYou items={h.items} leads={h.leads} summary={h.summary} approvals={h.approvals} approvalErrs={h.approvalErrs}
              busy={h.busy} scans={h.scans} errs={h.errs} filter={filter} onFilter={pickFilter}
              onDone={(i) => void h.act(i, "done")} onSnooze={(i, d) => void h.act(i, "snooze", d)} onFullScan={(i) => void h.fullScan(i)}
              onApprove={(a, p) => void h.approveOne(a, p)} onReject={(a, n) => void h.rejectOne(a, n)} onApproveAll={(g) => void h.approveAll(g)} onRetry={h.reload} />
            <CallsCard calls={h.calls} onRetry={h.reload} />
            <WatchedCard watched={h.watched} onRetry={h.reload} />
            <ActivityCard summary={h.summary} onRetry={h.reload} />
          </div>
          <div className="ds-col">
            <FreedomCard freedom={h.freedom} onRetry={h.reload} />
            <PipelineCard summary={h.summary} onRetry={h.reload} />
            <QueueCard queue={h.queue} onRetry={h.reload} />
            <CapacityCard capacity={h.capacity} onRetry={h.reload} />
            <SpendCard money={h.money} spend={h.spend} onRetry={h.reload} />
            <HelperCard helper={h.helper} onRetry={h.reload} />
          </div>
        </div>
      </div>
    </div>
  );
}
