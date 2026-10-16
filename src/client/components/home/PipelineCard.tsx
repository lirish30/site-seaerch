import { Link } from "react-router-dom";
import Icon from "../Icon";
import { moneyWhole, pipelineRows, type TodaySummary } from "../../todayHome";
import type { Part } from "./useHome";

/** Leads per stage as a stacked bar and a list; each stage links to that stage's lead list. */
export default function PipelineCard({ summary, onRetry }: { summary: Part<TodaySummary>; onRetry: () => void }) {
  const s = summary.data;
  const { rows, total } = pipelineRows(s?.pipeline ?? { new: 0, reviewed: 0, contacted: 0, replied: 0, won: 0, lost: 0, skip: 0 });
  return (
    <section className="hm-card" id="pipeline" aria-labelledby="hm-pipeline-h">
      <header className="hm-card-head">
        <Icon name="kanban" size={16} />
        <h2 id="hm-pipeline-h">Pipeline</h2>
        {s && <span className="hm-head-note">{moneyWhole(s.won.openValue)} open</span>}
      </header>
      {!s && summary.error ? (
        <div className="hm-state sm" role="alert"><p>{summary.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <div className="hm-card-body">
          <div className="hm-stack" aria-hidden="true">
            {!s ? <i className="hm-skel" style={{ width: "100%", height: 10 }} /> : total === 0 ? <i className="hm-stack-empty" /> : rows.filter((r) => r.count > 0).map((r) => <i key={r.key} style={{ flexGrow: r.count, background: r.color }} />)}
          </div>
          {s && total === 0 && <p className="hm-empty-note">No leads in your pipeline yet.</p>}
          <ul className="hm-stages">
            {rows.map((r) => (
              <li key={r.key}>
                <Link to={`/leads?status=${r.key}`}><i className="hm-dot" style={{ background: r.color }} /><span>{r.label}</span><b>{s ? r.count : "–"}</b></Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
