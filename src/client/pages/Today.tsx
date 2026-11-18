import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import Icon from "../components/Icon";
import ApprovalsCard from "../components/home/ApprovalsCard";
import ActivityCard from "../components/home/ActivityCard";
import HelperCard from "../components/home/HelperCard";
import KpiCards from "../components/home/KpiCards";
import PipelineCard from "../components/home/PipelineCard";
import QueueCard from "../components/home/QueueCard";
import SpendCard from "../components/home/SpendCard";
import UpNext from "../components/home/UpNext";
import { useHome } from "../components/home/useHome";
import { dayLine, greeting } from "../todayHome";

/** Home: the greeting, your key numbers, what to do next, the pipeline, this month's spend and the latest activity. */
export default function Today() {
  const h = useHome();
  const { hash, key } = useLocation();
  const now = new Date();

  // The sidebar's Pipeline and Activity links are hashes: scroll the panel to that card, or back to the top for Your day.
  useEffect(() => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const el = hash ? document.getElementById(hash.slice(1)) : null;
    if (el) el.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    else document.querySelector(".panel")?.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  }, [hash, key]);

  return (
    <div className="hm">
      <header className="page-header">
        <div>
          <h1>{greeting(h.money.data?.name ?? "", now)}</h1>
          <p>{dayLine(h.items.data ? h.items.data.length : null, now)}</p>
        </div>
        <div className="header-actions">
          <button type="button" className={`btn${h.loading ? " hm-spin" : ""}`} onClick={h.reload} disabled={h.loading} aria-busy={h.loading}><Icon name="refresh" size={16} />Refresh</button>
          <Link to="/" className="btn primary"><Icon name="plus" size={16} />New search</Link>
        </div>
      </header>
      <div className="hm-top">
        <KpiCards summary={h.summary} onRetry={h.reload} />
        <div className="hm-cols">
          <div className="hm-lead">
          <ApprovalsCard approvals={h.approvals} errs={h.approvalErrs} busy={h.busy} onApprove={(a, p) => void h.approveOne(a, p)}
            onReject={(a, n) => void h.rejectOne(a, n)} onApproveAll={(g) => void h.approveAll(g)} onRetry={h.reload} />
          <QueueCard queue={h.queue} onRetry={h.reload} />
          <HelperCard helper={h.helper} onRetry={h.reload} />
          <UpNext items={h.items} leads={h.leads} summary={h.summary} busy={h.busy} scans={h.scans} errs={h.errs}
            onDone={(i) => void h.act(i, "done")} onSnooze={(i, d) => void h.act(i, "snooze", d)} onFullScan={(i) => void h.fullScan(i)} onRetry={h.reload} />
          </div>
          <div className="hm-side">
            <PipelineCard summary={h.summary} onRetry={h.reload} />
            <SpendCard money={h.money} spend={h.spend} onRetry={h.reload} />
          </div>
        </div>
      </div>
      <div className="hm-below"><ActivityCard summary={h.summary} onRetry={h.reload} /></div>
    </div>
  );
}
