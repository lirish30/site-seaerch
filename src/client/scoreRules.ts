import { CATEGORY_WEIGHTS, SITE_STATUS_SCORE, THRESHOLDS } from "../worker/scoring/config";
import { SEVERITY_LABELS } from "./reportView";
import { HOT_AT, WARM_AT } from "./scoreView";
import { CATEGORY_ORDER } from "./types";

/**
 * The numbers the "How scores work" page prints. Where the worker exports them (category weights, no-website scores, the low-priority
 * cut-off) they are imported, so they cannot drift. The rest are inline in src/worker/scoring/scorer.ts and src/worker/audit/provenance.ts;
 * they are named here once and test/score-rules.test.ts runs the real scorer against them.
 */
export const LEAD_RULES = {
  /** points = (100 - site health) * weakSite */
  weakSite: 0.85,
  criticalEach: 5, criticalMax: 15,
  reviewsStrong: { reviews: 25, points: 10 }, reviewsSome: { reviews: 10, points: 5 },
  rating: { atLeast: 4.3, points: 5 },
  noWebsite: SITE_STATUS_SCORE.no_website, parkedOrUnreachable: SITE_STATUS_SCORE.parked,
  lowPriorityBelow: THRESHOLDS.lowPriorityBelow,
} as const;

export const HEALTH_RULES = { poorBelow: 40, goodAt: 70 } as const;

export const URGENCY_RULES = { critical: 30, important: 12, nice: 3, cap: 100 } as const;

/** A finding's points decide its severity (severityFor in scoring/config.ts). */
export const SEVERITY_RULES = { criticalAt: 30, importantAt: 12 } as const;

export const CATEGORY_NAME = { design: "Design", content: "Content", cro: "Conversion", mobile: "Mobile", speed: "Speed", technical: "Technical" } as const;

/** Site health weights in display order, as whole percents. */
export const healthWeights = () => CATEGORY_ORDER.map((c) => ({ key: c, label: CATEGORY_NAME[c as keyof typeof CATEGORY_NAME], pct: CATEGORY_WEIGHTS[c] }));

/** The lead score tiers as the legend chips show them. */
export const TIER_CHIPS = [
  { tier: "hot", chip: `${HOT_AT}+`, word: "Hot" },
  { tier: "warm", chip: `${WARM_AT}+`, word: "Warm" },
  { tier: "cool", chip: `<${WARM_AT}`, word: "Cool" },
] as const;

/** Lead score formula rows: the value chip and its plain-English meaning. */
export function leadRuleRows() {
  const r = LEAD_RULES;
  return [
    { chip: `(100 − health) × ${r.weakSite}`, text: "A weaker website means more for you to fix." },
    { chip: `+${r.criticalEach} each, max ${r.criticalMax}`, text: "For every critical problem found." },
    { chip: `+${r.reviewsStrong.points} / +${r.reviewsSome.points}`, text: `Established business: ${r.reviewsStrong.reviews}+ reviews, or ${r.reviewsSome.reviews}+ reviews.` },
    { chip: `+${r.rating.points}`, text: `Rated ${r.rating.atLeast}★ or higher.` },
    { chip: `= ${r.noWebsite} or ${r.parkedOrUnreachable}`, text: `No website at all scores ${r.noWebsite}. Parked or unreachable sites score ${r.parkedOrUnreachable}.` },
  ];
}

export const lowPriorityNote = () => `Under ${LEAD_RULES.lowPriorityBelow}, or no problem above “nice to have”, is low priority: no draft is written automatically.`;

export const urgencyRows = () => [
  { chip: `+${URGENCY_RULES.critical}`, text: "Each critical problem" },
  { chip: `+${URGENCY_RULES.important}`, text: "Each important problem" },
  { chip: `+${URGENCY_RULES.nice}`, text: `Each nice-to-have, capped at ${URGENCY_RULES.cap}` },
];

/** The three site-health bands for the legend; `sample` is the width of the little bar next to each. */
export const healthBands = () => [
  { word: "Poor", range: `under ${HEALTH_RULES.poorBelow}`, sample: 34 },
  { word: "Fair", range: `${HEALTH_RULES.poorBelow}–${HEALTH_RULES.goodAt - 1}`, sample: 61 },
  { word: "Good", range: `${HEALTH_RULES.goodAt}+`, sample: 88 },
];

export const severityRows = () => [
  { severity: "critical", range: `${SEVERITY_RULES.criticalAt}+ points`, report: SEVERITY_LABELS.high },
  { severity: "important", range: `${SEVERITY_RULES.importantAt}–${SEVERITY_RULES.criticalAt - 1} points`, report: SEVERITY_LABELS.medium },
  { severity: "nice", range: `under ${SEVERITY_RULES.importantAt}`, report: SEVERITY_LABELS.low },
] as const;
