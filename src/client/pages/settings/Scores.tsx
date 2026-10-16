import type { ReactNode } from "react";
import Icon, { type IconName } from "../../components/Icon";
import { LeadScore, Severity } from "../../components/Score";
import SettingsPage from "../../components/SettingsPage";
import { NO_FIT } from "../../fitView";
import { healthBands, healthWeights, leadRuleRows, lowPriorityNote, severityRows, TIER_CHIPS, urgencyRows } from "../../scoreRules";
import { SCORE_HELP } from "../../scoreView";

/** A card with the icon tile, title and one-line meaning from the Figma, then its rules. */
function Rules({ icon, title, sub, aside, children }: { icon: IconName; title: string; sub: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="hs-card">
      <header>
        <span className="hs-tile"><Icon name={icon} size={17} /></span>
        <div className="hs-title"><h2>{title}</h2><p>{sub}</p></div>
        {aside}
      </header>
      <div className="hs-body">{children}</div>
    </section>
  );
}

const RuleRows = ({ rows }: { rows: { chip: string; text: string }[] }) => (
  <>{rows.map((r) => <div key={r.chip} className="hs-rule"><code>{r.chip}</code><span>{r.text}</span></div>)}</>
);

/**
 * Settings > How scores work. Read-only: every number comes from the same constants the scorer uses (src/client/scoreRules.ts),
 * and test/score-rules.test.ts checks them against the real scorer, so this page cannot drift from the code.
 */
export default function Scores() {
  const weights = healthWeights();
  return (
    <SettingsPage title="How scores work" width={900} sub="Every number in Siteline, in plain English. Weights live in the code and are shown here read-only.">
      <div className="bx hs">
        <Rules icon="zap" title="Lead score" sub={`${SCORE_HELP.lead} Was called “Opportunity”.`}
          aside={<div className="hs-tiers">{TIER_CHIPS.map((t) => <LeadScore key={t.tier} score={null} legend={t.chip} label={t.word} tier={t.tier} />)}</div>}>
          <RuleRows rows={leadRuleRows()} />
          <p className="hs-note"><Icon name="info" size={14} />{lowPriorityNote()}</p>
        </Rules>

        <Rules icon="gauge" title="Site health" sub="How good their website is today, 0–100. Higher is a better site.">
          <div className="hs-weights" aria-hidden="true">{weights.map((w) => <i key={w.key} style={{ flexGrow: w.pct }} />)}</div>
          <ul className="hs-legend">{weights.map((w) => <li key={w.key}><i />{w.label} {w.pct}%</li>)}</ul>
          <p className="hs-text soft">Each area starts at 100 and loses points per problem. Missing areas are dropped and the rest re-weighted. Design comes from the AI screenshot review.</p>
          <ul className="hs-bands">{healthBands().map((b) => (
            <li key={b.word}><span className="bar"><i style={{ width: `${b.sample}%` }} /></span>{b.word} · {b.range}</li>
          ))}</ul>
        </Rules>

        <Rules icon="target" title="Fit" sub="How well a lead matches who you want to work with.">
          <p className="hs-text">For each active fit profile: criteria matched ÷ criteria set. The best profile wins. Shown as “{NO_FIT}” when no profile has criteria, never 0. Site health is never part of fit.</p>
        </Rules>

        <Rules icon="clock" title="Urgency" sub="How much time pressure the problems add up to. Lead page only.">
          <RuleRows rows={urgencyRows()} />
        </Rules>

        <Rules icon="alert" title="Problem severity" sub="How each finding is ranked, and how it reads on the public report.">
          {severityRows().map((r) => (
            <div key={r.severity} className="hs-sev"><span className="s"><Severity severity={r.severity} /></span><code>{r.range}</code><span>On the report: “{r.report}”</span></div>
          ))}
        </Rules>
      </div>
    </SettingsPage>
  );
}
