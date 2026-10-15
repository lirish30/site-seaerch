import { Link } from "react-router-dom";
import { criterionLabel } from "../fitView";
import { CATEGORY_ICON, healthWord, leadTier, scoreBreakdown, SEVERITY_LABEL, severityCounts, tierSummary, urgencyWord } from "../scoreView";
import { topFindings } from "../evidenceView";
import { CATEGORY_LABEL, CATEGORY_ORDER, NICHE_LABEL, type Audit, type Business, type FitProfile, type FitResult, type Platform } from "../types";
import EvidenceBadge from "./EvidenceBadge";
import Icon, { type IconName } from "./Icon";
import { Badge, HealthBar, Severity as SeverityMark } from "./Score";

const HEALTH_TONE = { Poor: "critical", Fair: "warning", Good: "positive" } as const;
const TIER_BADGE = { hot: "Hot lead", warm: "Warm lead", cool: "Cool lead" } as const;
const PLATFORM_NAME: Record<Platform, string> = { wix: "Wix", squarespace: "Squarespace", godaddy: "GoDaddy", wordpress: "WordPress", weebly: "Weebly", shopify: "Shopify", webflow: "Webflow", other: "Other" };
const CRITERIA_ORDER = ["industry", "geo", "reviews", "rating", "platform"];

/** "Industry: plumber", "At least 100 reviews": what a fit criterion asks for, in words, from the profile that scored the lead. */
function criterionText(key: string, p: FitProfile | null): string {
  if (!p) return criterionLabel(key);
  switch (key) {
    case "industry": return `Industry: ${p.industries.join(" or ")}`;
    case "geo": return `Location: ${p.geos.join(" or ")}`;
    case "platform": return `Platform: ${p.platforms.map((x) => PLATFORM_NAME[x] ?? x).join(" or ")}`;
    case "reviews": return `At least ${p.min_reviews} reviews`;
    case "rating": return `Rating ${p.min_rating}★ or higher`;
    default: return criterionLabel(key);
  }
}

/** Overview: the lead score broken into its parts, site health by category, fit and urgency. Only the lead score is colored. */
export function Scorecard({ audit: a, business: b, fit, profile, urgency }: { audit: Audit; business: Business; fit: FitResult; profile: FitProfile | null; urgency: number }) {
  const tier = leadTier(a.score);
  const breakdown = scoreBreakdown({ score: a.score, health: a.health_score, findings: a.findings, siteStatus: a.site_status, reviewCount: b.review_count, rating: b.rating });
  const counts = severityCounts(a.findings);
  const word = a.health_score === null ? null : healthWord(a.health_score);
  const cats = CATEGORY_ORDER.filter((c) => a.category_scores[c] !== undefined);
  const criteria = [...fit.matched.map((k) => ({ k, ok: true })), ...fit.missing.map((k) => ({ k, ok: false }))]
    .sort((x, y) => CRITERIA_ORDER.indexOf(x.k) - CRITERIA_ORDER.indexOf(y.k));
  const uWord = urgencyWord(urgency);
  const pressure = counts.critical + counts.important === 0 ? "Nothing here is time-sensitive."
    : `${[counts.critical && `${counts.critical} critical`, counts.important && `${counts.important} important`].filter(Boolean).join(" and ")} ${counts.critical + counts.important === 1 ? "problem adds" : "problems add"} up to ${uWord === "High" ? "real" : uWord === "Medium" ? "some" : "little"} time pressure.`;
  const barParts = breakdown.parts.filter((p) => p.points > 0);

  return (
    <section className="scorecard" aria-label="Scores">
      <div className={`sc-col sc-lead tier-${tier}`}>
        <p className="kicker">Lead score</p>
        <div className="big-row"><span className="big">{a.score}</span><Badge tone={tier === "hot" ? "signal" : tier === "warm" ? "warning" : "neutral"} dot>{TIER_BADGE[tier]}</Badge><span className="of">of 100</span></div>
        <p className="sc-note">{tierSummary(tier, breakdown)}</p>
        <div className="breakdown-bar" role="img" aria-label={breakdown.parts.map((p) => `${p.label} ${p.points >= 0 ? "+" : ""}${p.points}`).join(", ")}>
          {barParts.map((p) => <span key={p.key} style={{ width: `calc(${p.points}% - 2px)` }} />)}
          {a.score < 100 && <span className="rest" />}
        </div>
        <ul className="parts">
          {breakdown.parts.map((p) => (
            <li key={p.key} className="part">
              <i className="swatch" /><span className="pts">{p.points >= 0 ? "+" : "−"}{Math.abs(p.points)}</span>
              <span className="txt"><b>{p.label}</b><small>{p.detail}</small></span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sc-col">
        <p className="kicker">Site health</p>
        <div className="big-row">
          <span className="big">{a.health_score ?? "—"}</span>
          {word && <Badge tone={HEALTH_TONE[word]} dot>{word}</Badge>}
          {a.health_score !== null && <span className="of">of 100</span>}
        </div>
        <p className="sc-note sm">How good their site is today. Lower means more for you to fix.</p>
        <ul className="cat-rows">
          {cats.map((c) => (
            <li key={c} className="cat-row">
              <Icon name={CATEGORY_ICON[c] as IconName} size={14} /><span className="name">{CATEGORY_LABEL[c]}</span>
              <HealthBar value={a.category_scores[c]!} wide /><span className="num">{a.category_scores[c]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sc-col">
        <p className="kicker">Fit</p>
        {fit.fit === null || !fit.profile ? (
          <p className="sc-note sm">No fit score yet. Add criteria to an active fit profile in <Link to="/settings">Settings</Link> to score leads against what you sell.</p>
        ) : (
          <>
            <div className="fit-line"><span className="big2">{fit.fit}</span><span className="sc-note sm">{fit.matched.length} of {criteria.length} for “{fit.profile.name}”</span></div>
            <ul className="crit-list">
              {criteria.map(({ k, ok }) => <li key={k} className={ok ? "yes" : "no"}><Icon name={ok ? "check" : "x"} size={14} />{criterionText(k, profile)}</li>)}
            </ul>
          </>
        )}
        <hr className="sc-rule" />
        <p className="kicker">Urgency</p>
        <div className="fit-line"><span className="big2">{urgency}</span><Badge tone={uWord === "High" ? "warning" : "neutral"} dot>{uWord}</Badge></div>
        <p className="sc-note sm">{pressure}</p>
      </div>
    </section>
  );
}

/** "What a home services site needs" with what is in place and what is working. Needs the AI review, so a quick scan gets a hint instead. */
export function NicheChecklist({ audit: a }: { audit: Audit }) {
  const r = a.ai_review;
  if (!r || !r.niche_checklist.length) {
    return (
      <section className="section-card needs">
        <h3>What this site needs</h3>
        <p className="sub-count">Not checked yet</p>
        <p className="muted small">Run a full scan to see which things a site like theirs should have, and which are missing.</p>
      </section>
    );
  }
  const have = r.niche_checklist.filter((c) => c.present).length;
  return (
    <section className="section-card needs" aria-label="Niche checklist">
      <h3>What a {NICHE_LABEL[r.niche]?.toLowerCase() ?? "local business"} site needs</h3>
      <p className="sub-count">{have} of {r.niche_checklist.length} in place</p>
      <ul>
        {r.niche_checklist.map((c) => (
          <li key={c.item} className={c.present ? "have" : undefined}><span className={`tick ${c.present ? "yes" : "no"}`}><Icon name={c.present ? "check" : "x"} size={12} /></span>{c.item}</li>
        ))}
      </ul>
      {(r.strengths.length > 0 || r.value_proposition) && (
        <div className="working">
          <p className="lbl">What’s working</p>
          {r.strengths.length > 0 && <p>{r.strengths.join(" ")}</p>}
          {r.value_proposition && <p className="value-prop">Their pitch: “{r.value_proposition}”</p>}
        </div>
      )}
    </section>
  );
}

/** The five problems most worth raising, worst first, with a link to the full list. */
export function TopProblems({ audit: a, onSeeAll }: { audit: Audit; onSeeAll: () => void }) {
  const counts = severityCounts(a.findings);
  const tone = { critical: "critical", important: "warning", nice: "neutral" } as const;
  return (
    <section className="section-card" aria-label="Top problems">
      <div className="problems-head">
        <h3>Top problems</h3>
        {(["critical", "important", "nice"] as const).filter((s) => counts[s] > 0).map((s) => <Badge key={s} tone={tone[s]} dot>{counts[s]} {s === "nice" ? SEVERITY_LABEL[s].toLowerCase() : s}</Badge>)}
        <span className="grow" />
        <button className="link-btn" onClick={onSeeAll}>See all {a.findings.length} <Icon name="arrow-right" size={14} /></button>
      </div>
      {topFindings(a.findings).map((f, i) => (
        <div key={`${f.code}:${i}`} className="problem">
          <div className="sev-col">
            <SeverityMark severity={f.severity} />
            <span className="cat"><Icon name={CATEGORY_ICON[f.category] as IconName} size={14} />{CATEGORY_LABEL[f.category]}</span>
          </div>
          <div>
            <p className="what">{f.evidence}</p>
            {f.recommendation && <p className="fix"><b>Fix</b>{f.recommendation}</p>}
          </div>
          <div className="src"><EvidenceBadge finding={f} auditCreatedAt={a.created_at} stale={!!f.stale} /></div>
        </div>
      ))}
      {!a.findings.length && <p className="empty-state">No issues found.</p>}
    </section>
  );
}
