export type Severity = "high" | "medium" | "low";
export interface ReportFinding { severity: Severity; evidence: string; }
export interface ReportData {
  businessName: string; auditedAt: string; counts: Record<Severity, number>; findings: ReportFinding[]; partial: boolean;
  sender: { name: string; businessName: string; email: string; logoUrl: string }; expiresAt: string;
}

export const SEVERITY_LABELS: Record<Severity, string> = { high: "Worth fixing first", medium: "Worth a look", low: "Smaller things" };

/** Findings grouped high -> low (empty groups dropped), keeping the given order inside each group. */
export function groupFindings(findings: ReportFinding[]): { severity: Severity; label: string; items: string[] }[] {
  return (["high", "medium", "low"] as const)
    .map((severity) => ({ severity, label: SEVERITY_LABELS[severity], items: findings.filter((f) => f.severity === severity).map((f) => f.evidence) }))
    .filter((g) => g.items.length > 0);
}

export function summaryText(counts: Record<Severity, number>): string {
  const n = counts.high + counts.medium + counts.low;
  return n === 0 ? "" : `${n} ${n === 1 ? "thing" : "things"} worth a look`;
}

// Defence in depth: the server already blanks non-https logos, but the client never trusts that.
export const isHttpsLogo = (url: string) => url.startsWith("https://");
