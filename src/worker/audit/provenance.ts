import type { Finding } from "../types";

const DAY_MS = 86_400_000;

/** Stamps when a finding was observed and how much to trust it; never overwrites values already set. */
export function withProvenance(findings: Finding[], observedAt: string): Finding[] {
  return findings.map((f) => ({
    ...f,
    observed_at: f.observed_at ?? observedAt,
    confidence: f.confidence ?? (f.source === "rule" ? "high" : "medium"),
  }));
}

/** 0-100 time pressure from severity mix. An empty list is 0, not a penalty. */
export function urgencyOf(findings: Finding[]): number {
  let total = 0;
  for (const f of findings) total += f.severity === "critical" ? 30 : f.severity === "important" ? 12 : 3;
  return Math.min(100, total);
}

/** Missing observed_at falls back to the audit's date, never to now. */
export function isStale(f: Finding, auditCreatedAt: string, now: Date, days = 30): boolean {
  const at = Date.parse(f.observed_at ?? auditCreatedAt);
  return Number.isFinite(at) && now.getTime() - at > days * DAY_MS;
}
