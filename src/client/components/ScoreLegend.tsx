import { useState } from "react";
import { HealthBar, LeadScore } from "./Score";
import Icon from "./Icon";
import { HOT_AT, SCORE_HELP, WARM_AT } from "../scoreView";

/**
 * The plain-English key above the leads table: what each of the three numbers means.
 * The ⓘ opens "How scores work"; the same link also sits at the end of the row when the panel is wide enough to hold it.
 */
export default function ScoreLegend() {
  const [open, setOpen] = useState(false);
  return (
    <section className="score-legend" aria-label="What the scores mean">
      <div className="legend-row">
        <button type="button" className="legend-info" aria-label="How scores work" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="info" size={16} /></button>
        <div className="legend-item g1">
          <span className="pills">
            <LeadScore score={null} legend={`${HOT_AT}+`} label="Hot" tier="hot" />
            <LeadScore score={null} legend={`${WARM_AT}+`} label="Warm" tier="warm" />
            <LeadScore score={null} legend={`<${WARM_AT}`} label="Cool" tier="cool" />
          </span>
          <span className="txt"><b>Lead score</b><span>{SCORE_HELP.lead}</span></span>
        </div>
        <div className="legend-item g2">
          <HealthBar value={35} />
          <span className="txt"><b>Site health</b><span>{SCORE_HELP.health}</span></span>
        </div>
        <div className="legend-item g3">
          <span className="fit-sample">80</span>
          <span className="txt"><b>Fit</b><span>{SCORE_HELP.fit}</span></span>
        </div>
        <button type="button" className="legend-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>How scores work<Icon name="arrow-right" size={12} /></button>
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
