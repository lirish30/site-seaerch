import Icon from "../Icon";
import { Timeline } from "../ds";
import { activityGroups, ago, recentView, type TodaySummary } from "../../todayHome";
import type { Part } from "./useHome";

/** The latest events across all leads (stage changes, notes, drafts, scans), grouped Today / This week / Earlier. The sidebar's Activity link lands here. */
export default function ActivityCard({ summary, onRetry }: { summary: Part<TodaySummary>; onRetry: () => void }) {
  const recent = summary.data?.recent ?? null;
  return (
    <section className="hox-activity" id="activity" aria-labelledby="hox-activity-h">
      <div className="hox-section-head">
        <Icon name="clock" size={16} />
        <h2 id="hox-activity-h">Activity</h2>
        <span>Latest across all leads</span>
      </div>
      {!recent && summary.error ? (
        <div className="ds-card"><div className="hox-alert" role="alert"><span>{summary.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div></div>
      ) : !recent ? (
        <div className="ds-card hox-pad" aria-busy="true" aria-label="Loading activity"><i className="hox-skel" style={{ width: "40%", height: 14 }} /></div>
      ) : (
        <Timeline empty="Nothing yet. Notes, stage changes, drafts and scans across your leads show up here."
          groups={activityGroups(recent).map((g) => ({
            label: g.label,
            events: g.rows.map((a) => {
              const v = recentView(a);
              return { key: a.id, icon: v.icon, tone: v.tone, title: v.title, sub: v.detail ? `${a.businessName} · ${v.detail}` : a.businessName, when: ago(a.at), to: `/leads/${a.businessId}?tab=activity` };
            }),
          }))} />
      )}
    </section>
  );
}
