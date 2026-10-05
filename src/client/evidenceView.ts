import type { Finding } from "./types";

const DAY_MS = 86_400_000;

export const SOURCE_LABEL: Record<Finding["source"], string> = { rule: "Rule check", ai: "AI review" };
export const CONFIDENCE_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;

/** "observed 3 days ago". A legacy finding has no observed_at, so it is as old as its audit, never "today" by default. */
export function ageLabel(observedAt: string | undefined, auditCreatedAt: string, now: Date): string {
  const at = Date.parse(observedAt ?? auditCreatedAt);
  if (!Number.isFinite(at)) return "observation date unknown";
  const days = Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
  return days === 0 ? "observed today" : `observed ${days} ${days === 1 ? "day" : "days"} ago`;
}

const SEVERITY_RANK = { critical: 0, important: 1, nice: 2 } as const;

/** The n findings most worth showing first: severity, then points, then original order. */
export function topFindings<T extends Pick<Finding, "severity" | "points">>(findings: T[], n = 5): T[] {
  return findings.map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || b.f.points - a.f.points || a.i - b.i)
    .slice(0, n).map(({ f }) => f);
}
