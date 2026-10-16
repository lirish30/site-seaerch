import { CONFIDENCE_LABEL, SOURCE_LABEL, ageLabel } from "../evidenceView";
import type { Finding } from "../types";
import { Badge } from "./Score";

/** Where a finding came from (a rule check or the AI review), how far to trust it and how old the observation is. */
export default function EvidenceBadge({ finding, auditCreatedAt, stale }: { finding: Finding; auditCreatedAt: string; stale: boolean }) {
  const age = ageLabel(finding.observed_at, auditCreatedAt, new Date());
  const ageText = age === "observed today" ? null : age.replace(/^observed /, "");
  const trust = [finding.confidence ? CONFIDENCE_LABEL[finding.confidence] : null, ageText].filter(Boolean).join(" · ");
  return (
    <>
      <Badge tone="outline" title={finding.source === "ai" ? "From the AI design review" : "A deterministic check of the page"}>{SOURCE_LABEL[finding.source]}</Badge>
      {trust && <span>{trust}</span>}
      {stale && <span className="stale-note">older than 30 days, worth re-checking</span>}
    </>
  );
}
