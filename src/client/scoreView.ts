import type { AuditCategory, Finding, Severity } from "./types";

/** Lead score tiers. Only the lead score gets color; site health and fit stay neutral. */
export type LeadTier = "hot" | "warm" | "cool";
export const HOT_AT = 60;
export const WARM_AT = 25;
export const TIER_LABEL: Record<LeadTier, string> = { hot: "Hot", warm: "Warm", cool: "Cool" };
export const leadTier = (score: number): LeadTier => (score >= HOT_AT ? "hot" : score >= WARM_AT ? "warm" : "cool");

/** Site health words. Same cut-offs as the old gauge bands (<40, <70) so a lead keeps its meaning across the redesign. */
export type HealthWord = "Poor" | "Fair" | "Good";
export const healthWord = (score: number): HealthWord => (score < 40 ? "Poor" : score < 70 ? "Fair" : "Good");

/** Severity as a 3-bar signal: how many of the bars are lit. */
export const SEVERITY_BARS: Record<Severity, 1 | 2 | 3> = { critical: 3, important: 2, nice: 1 };
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", important: "Important", nice: "Nice to have" };

/** Urgency is 0-100 (30 per critical, 12 per important, 3 per nice). */
export const urgencyWord = (n: number): "High" | "Medium" | "Low" => (n >= 60 ? "High" : n >= 30 ? "Medium" : "Low");

/** One line of a score table: what it is called and what it means, shown in the legend and the "How scores work" help. */
export const SCORE_HELP = {
  lead: "How strong a prospect is. Higher is better.",
  health: "How good their site is now. Low = more to fix.",
  fit: "Match with your fit profiles.",
} as const;

export const CATEGORY_ICON: Record<AuditCategory | "site", string> = {
  design: "layout", content: "file-text", cro: "target", mobile: "smartphone", speed: "gauge", technical: "code", site: "globe",
};

export interface ScorePart { key: "weak" | "critical" | "established" | "nosite" | "other"; label: string; points: number; detail: string }
export interface ScoreBreakdown { parts: ScorePart[]; total: number }

const NO_SITE: Record<string, string> = {
  no_website: "No website listed on their Google profile",
  parked: "Their web address shows a placeholder page",
  unreachable: "Their website didn't load when we tried it",
};

/**
 * Splits the lead score into the parts the scorer adds up (src/worker/scoring/scorer.ts):
 *   (100 - site health) * 0.85  +  min(15, 5 per critical problem)  +  established business (reviews up to 10, rating 4.3+ is 5).
 * The stored score is always what is shown as the total; rounding (or the 100 cap) is folded in so the parts add up to it.
 */
export function scoreBreakdown(i: { score: number; health: number | null; findings: Pick<Finding, "severity">[]; siteStatus: string; reviewCount: number | null; rating: number | null }): ScoreBreakdown {
  if (i.siteStatus in NO_SITE) return { total: i.score, parts: [{ key: "nosite", label: "No usable website", points: i.score, detail: NO_SITE[i.siteStatus] }] };
  const parts: ScorePart[] = [];
  if (i.health !== null) {
    parts.push({ key: "weak", label: "Weak website", points: Math.round((100 - i.health) * 0.85), detail: `Site health is ${i.health} of 100` });
  }
  const critical = i.findings.filter((f) => f.severity === "critical").length;
  const crit = Math.min(15, critical * 5);
  parts.push({ key: "critical", label: "Critical problems", points: crit, detail: critical ? `${critical} found, 5 points each (max 15)` : "None found" });
  const rc = i.reviewCount ?? 0;
  const established = (rc >= 25 ? 10 : rc >= 10 ? 5 : 0) + ((i.rating ?? 0) >= 4.3 ? 5 : 0);
  const rated = i.rating !== null && i.rating >= 4.3;
  parts.push({
    key: "established", label: "Established business", points: established,
    detail: established === 0 ? "Few reviews so far" : `${rc.toLocaleString("en-US")} reviews${rated ? ` and a ${i.rating}★ rating` : ""}`,
  });
  const diff = i.score - parts.reduce((s, p) => s + p.points, 0);
  if (diff !== 0) {
    if (Math.abs(diff) === 1 && parts[0]?.key === "weak") parts[0].points += diff;
    else parts.push({ key: "other", label: diff < 0 ? "Capped at 100" : "Other adjustments", points: diff, detail: diff < 0 ? "Scores never go above 100" : "From an older audit's scoring" });
  }
  return { parts, total: i.score };
}

/** The one-sentence reading of a lead score on the lead page. */
export function tierSummary(tier: LeadTier, b: ScoreBreakdown): string {
  const established = (b.parts.find((p) => p.key === "established")?.points ?? 0) >= 10;
  const noSite = b.parts.some((p) => p.key === "nosite");
  if (tier === "hot") {
    if (noSite) return "Strong prospect: they don't have a working website, so there is a lot to sell.";
    return established ? "Strong prospect: an established, well-reviewed business whose website is holding it back." : "Strong prospect: the website has a lot to fix.";
  }
  if (tier === "warm") return "Worth a look: the website has room to improve, but it isn't a clear gap.";
  return "Weaker prospect: the site is in decent shape, so there is less to sell.";
}

/** Severity counts for a list of findings. */
export function severityCounts(findings: Pick<Finding, "severity">[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, important: 0, nice: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/** "PP" for "Perfect Plumbing Heating & Air": the first letters of the first two words. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
}
