import { useState } from "react";
import { HealthBar, LeadScore } from "./Score";
import Icon from "./Icon";
import { HOT_AT, SCORE_HELP, WARM_AT } from "../scoreView";

/** The plain-English key above the leads table: what each of the three numbers means. */
export default function ScoreLegend() {
  const [open, setOpen] = useState(false);
  return (
    <section className="score-legend" aria-label="What the scores mean">
      <div className="legend-row">
        <Icon name="info" size={16} className="legend-info" />
        <div className="legend-item">
          <span className="pills">
            <LeadScore score={null} legend={`${HOT_AT}+`} label="Hot" />
            <LeadScore score={null} legend={`${WARM_AT}+`} label="Warm" />
            <LeadScore score={null} legend={`<${WARM_AT}`} label="Cool" />
          </span>
          <span><strong>Lead score</strong><br />{SCORE_HELP.lead}</span>
        </div>
        <div className="legend-item">
          <HealthBar value={35} />
          <span><strong>Site health</strong><br />{SCORE_HELP.health}</span>
        </div>
        <div className="legend-item">
          <span className="mono fit-sample">80</span>
          <span><strong>Fit</strong><br />{SCORE_HELP.fit}</span>
        </div>
        <button type="button" className="link-btn legend-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>How scores work <Icon name={open ? "chevron-down" : "arrow-right"} size={12} /></button>
      </div>
      {open && (
        <div className="legend-detail">
          <p><strong>Lead score (0–100)</strong> adds up three things: how weak the website is, how many critical problems it has, and whether the business looks established (reviews and rating). {HOT_AT}+ is Hot, {WARM_AT}–{HOT_AT - 1} is Warm, under {WARM_AT} is Cool.</p>
          <p><strong>Site health (0–100)</strong> is the audit's score for the site itself. Under 40 is Poor, 40–69 is Fair, 70+ is Good. It has no color on purpose: a poor site is a reason to call, not a warning.</p>
          <p><strong>Fit</strong> is how well the business matches the fit profiles you set up in Settings. A dash means no profile has criteria yet.</p>
        </div>
      )}
    </section>
  );
}
