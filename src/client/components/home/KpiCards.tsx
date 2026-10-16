import Icon from "../Icon";
import { kpiCards, type TodaySummary } from "../../todayHome";
import type { Part } from "./useHome";

const LABELS = [["Hot leads", "zap"], ["Drafts ready to send", "mail"], ["In conversation", "users"], ["Won this month", "trending"]] as const;

/** The four headline numbers. While loading each card keeps its label and shows a placeholder bar, so nothing jumps when the numbers land. */
export default function KpiCards({ summary, onRetry }: { summary: Part<TodaySummary>; onRetry: () => void }) {
  const cards = summary.data ? kpiCards(summary.data) : null;
  return (
    <section className="hm-kpis" aria-label="Key numbers">
      {LABELS.map(([label, icon], i) => {
        const k = cards?.[i];
        return (
          <article key={label} className="hm-kpi">
            <h3><Icon name={icon} size={16} />{label}</h3>
            {k ? (
              <>
                <p className="hm-kpi-num">{k.value}</p>
                <p className={`hm-kpi-sub ${k.tone}`}>{k.sub}</p>
              </>
            ) : summary.error ? (
              <>
                <p className="hm-kpi-num dim" aria-hidden="true">—</p>
                <p className="hm-kpi-sub muted">{i === 0 ? <>Couldn't load. <button type="button" className="hm-link" onClick={onRetry}>Try again</button></> : " "}</p>
              </>
            ) : (
              <>
                <p className="hm-kpi-num" aria-hidden="true"><i className="hm-skel" style={{ width: 56, height: 32 }} /></p>
                <p className="hm-kpi-sub" aria-hidden="true"><i className="hm-skel" style={{ width: 96, height: 12 }} /></p>
                {i === 0 && <span className="sr-only" role="status">Loading your numbers</span>}
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
