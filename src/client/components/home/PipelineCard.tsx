import { Link } from "react-router-dom";
import { Card } from "../ds";
import { moneyShort, moneyWhole, pipelineRows, type TodaySummary } from "../../todayHome";
import type { Part } from "./useHome";

/**
 * Pipeline: the three lead numbers (hot leads, drafts ready, won this month) over a bar per stage. Each stage links to that stage's lead list.
 * The sidebar's Pipeline link lands here.
 */
export default function PipelineCard({ summary, onRetry }: { summary: Part<TodaySummary>; onRetry: () => void }) {
  const s = summary.data;
  const { rows, total } = pipelineRows(s?.pipeline ?? { new: 0, reviewed: 0, contacted: 0, replied: 0, won: 0, lost: 0, skip: 0 });
  const max = Math.max(1, ...rows.map((r) => r.count));
  // The three lead numbers that used to be Home's KPI row, kept short enough for a 100px cell.
  const minis = s ? [
    { label: "Hot leads", value: String(s.hot.total), sub: s.hot.newThisWeek > 0 ? `+${s.hot.newThisWeek} this week` : "none new", tone: s.hot.newThisWeek > 0 ? "positive" : "" },
    { label: "Drafts ready", value: String(s.drafts.ready), sub: s.drafts.waiting > 0 ? `${s.drafts.waiting} waiting 2+ d` : "none waiting", tone: s.drafts.waiting > 0 ? "warning" : "" },
    { label: "Won this month", value: moneyShort(s.won.valueThisMonth), sub: `${s.won.thisMonth} ${s.won.thisMonth === 1 ? "deal" : "deals"}`, tone: s.won.thisMonth > 0 ? "positive" : "" },
  ] : null;
  return (
    <Card icon="kanban" title="Pipeline" id="pipeline" className="hox-card" note={s ? `${moneyWhole(s.won.openValue)} open` : undefined}>
      {!s && summary.error ? (
        <div className="hox-alert inline" role="alert"><span>{summary.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <>
          <div className="hox-minis">
            {(minis ?? [null, null, null]).map((m, i) => (
              <div key={i} className="hox-mini">
                <span>{m ? m.label.replace("Drafts ready to send", "Drafts ready") : " "}</span>
                <b>{m ? m.value : <i className="hox-skel" style={{ width: 32, height: 18 }} />}</b>
                <small className={m?.tone ?? ""} title={m?.sub}>{m ? m.sub : " "}</small>
              </div>
            ))}
          </div>
          <ul className="hox-stages" aria-label="Leads by stage">
            {rows.map((r) => (
              <li key={r.key}>
                <Link to={`/leads?status=${r.key}`}>
                  <span className="hox-stage-name"><i style={{ background: r.color }} />{r.label}</span>
                  <span className="hox-stage-bar" aria-hidden="true"><i style={{ width: `${(100 * r.count) / max}%`, background: r.color }} /></span>
                  <b>{s ? r.count : "–"}</b>
                </Link>
              </li>
            ))}
          </ul>
          {s && <p className="hox-caption">{total === 0 ? "No leads in your pipeline yet. Run a search to fill it." : `${s.totalLeads.toLocaleString("en-US")} leads in all. Click a stage to see them.`}</p>}
        </>
      )}
    </Card>
  );
}
