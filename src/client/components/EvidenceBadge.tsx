import { CONFIDENCE_LABEL, SOURCE_LABEL, ageLabel } from "../evidenceView";
import type { Finding } from "../types";

/** Where a finding came from, how old the observation is, and how far to trust it. */
export default function EvidenceBadge({ finding, auditCreatedAt, stale }: { finding: Finding; auditCreatedAt: string; stale: boolean }) {
  return (
    <span className="evidence">
      <span className="tag" title={finding.source === "ai" ? "From the AI design review" : "A deterministic check of the page"}>{SOURCE_LABEL[finding.source]}</span>
      <span className="muted small">{ageLabel(finding.observed_at, auditCreatedAt, new Date())}</span>
      {finding.confidence && <span className={`tag conf-${finding.confidence}`}>{CONFIDENCE_LABEL[finding.confidence]}</span>}
      {stale && <span className="stale-note small">older than 30 days, worth re-checking</span>}
    </span>
  );
}
