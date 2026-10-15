import { useState } from "react";
import { CATEGORY_ICON, SEVERITY_LABEL, severityCounts } from "../scoreView";
import { CATEGORY_LABEL, CATEGORY_ORDER, type Audit, type AuditCategory, type Finding, type Severity } from "../types";
import EvidenceBadge from "./EvidenceBadge";
import Icon, { type IconName } from "./Icon";
import { Badge, HealthBar, Severity as SeverityMark } from "./Score";

const SEVERITIES: Severity[] = ["critical", "important", "nice"];

/** Matches an issue to the audit-changes lists, which carry findings without a stable id. */
export const findingKey = (f: Pick<Finding, "code" | "evidence">) => `${f.code}|${f.evidence}`;

function CountDots({ findings }: { findings: Finding[] }) {
  const c = severityCounts(findings);
  return (
    <span className="g-counts">
      {SEVERITIES.filter((s) => c[s] > 0).map((s) => <span key={s}><i className={`sev-${s}`} />{c[s]} {s === "nice" ? "nice to have" : s}</span>)}
    </span>
  );
}

function IssueRow({ f, itemKey, showCategory, isNew, auditCreatedAt, selectable, checked, onToggle }: {
  f: Finding; itemKey: string; showCategory: boolean; isNew: boolean; auditCreatedAt?: string; selectable?: boolean; checked: boolean; onToggle?: (key: string) => void;
}) {
  return (
    <li className="issue">
      {selectable && <input type="checkbox" aria-label="Mention this in the email" checked={checked} onChange={() => onToggle?.(itemKey)} />}
      <div className="sev-col">
        <SeverityMark severity={f.severity} />
        {isNew && <Badge tone="outline">New</Badge>}
        {showCategory && <span className="cat"><Icon name={CATEGORY_ICON[f.category] as IconName} size={13} />{CATEGORY_LABEL[f.category]}</span>}
      </div>
      <div>
        <p className="what">{f.evidence}</p>
        {f.recommendation && <p className="fix"><b>Fix</b>{f.recommendation}</p>}
      </div>
      {!selectable && auditCreatedAt && <div className="src"><EvidenceBadge finding={f} auditCreatedAt={auditCreatedAt} stale={!!f.stale} /></div>}
      {!selectable && !auditCreatedAt && f.source === "ai" && <div className="src"><Badge tone="outline" title="From the AI design review">AI review</Badge></div>}
    </li>
  );
}

/**
 * Every finding, one card per group, worst first. Grouped by category (with that category's score) or by severity; filterable by severity.
 * `selectable` turns it into the email picker (checkboxes, no source column). `added` marks findings new since the last audit.
 */
export function FindingsList({ findings, scores = {}, added, auditCreatedAt, selectable, selected, onToggle }: {
  findings: Finding[]; scores?: Audit["category_scores"]; added?: Finding[]; auditCreatedAt?: string;
  selectable?: boolean; selected?: Set<string>; onToggle?: (key: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | Severity>("all");
  const [groupBy, setGroupBy] = useState<"category" | "severity">("category");
  const newKeys = new Set((added ?? []).map(findingKey));
  const items = findings.map((f, i) => ({ f, key: `${f.code}:${i}` })).filter(({ f }) => filter === "all" || f.severity === filter);
  const counts = severityCounts(findings);
  if (!findings.length) return <p className="muted">No issues found.</p>;

  type Group = { id: string; title: string; icon: IconName | null; items: typeof items };
  const groups: Group[] = groupBy === "category"
    ? [...CATEGORY_ORDER, "site" as const].map((c) => ({ id: c, title: CATEGORY_LABEL[c], icon: CATEGORY_ICON[c] as IconName, items: items.filter(({ f }) => f.category === c) }))
    : SEVERITIES.map((s) => ({ id: s, title: SEVERITY_LABEL[s], icon: null, items: items.filter(({ f }) => f.severity === s) }));
  const shown = groups.filter((g) => g.items.length).sort((a, b) => {
    if (groupBy === "severity") return 0;
    const ca = severityCounts(a.items.map((x) => x.f)), cb = severityCounts(b.items.map((x) => x.f));
    const sa = scores[a.id as AuditCategory] ?? 101, sb = scores[b.id as AuditCategory] ?? 101;
    return cb.critical - ca.critical || cb.important - ca.important || sa - sb;
  });

  return (
    <div className="findings">
      <div className="issues-bar">
        <div className="seg-pills" role="group" aria-label="Filter by severity">
          <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span className="n">{findings.length}</span></button>
          {SEVERITIES.map((s) => (
            <button key={s} aria-pressed={filter === s} onClick={() => setFilter(s)}>
              {s !== "nice" ? <i className={`dot sev-${s}`} /> : <i className="dot" />}{SEVERITY_LABEL[s]} <span className="n">{counts[s]}</span>
            </button>
          ))}
        </div>
        {!selectable && (
          <label className="group-by">Group by
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as "category" | "severity")} aria-label="Group issues by">
              <option value="category">Category</option><option value="severity">Severity</option>
            </select><Icon name="chevron-down" size={14} />
          </label>
        )}
      </div>
      {shown.map((g) => {
        const gScore = groupBy === "category" ? scores[g.id as AuditCategory] : undefined;
        const open = selectable || filter !== "all" || g.items.some(({ f }) => f.severity === "critical") || groupBy === "severity";
        return (
          <details key={`${groupBy}:${filter}:${g.id}`} className="section-card issue-group" open={open}>
            <summary>
              {g.icon && <span className="g-icon"><Icon name={g.icon} size={16} /></span>}
              <span className="g-title"><b>{g.title}</b><small>{g.items.length} {g.items.length === 1 ? "issue" : "issues"}</small></span>
              {groupBy === "category" && <CountDots findings={g.items.map((x) => x.f)} />}
              {groupBy === "severity" && <span className="g-counts" />}
              {gScore !== undefined && <span className="g-score">Score <HealthBar value={gScore} wide /><span className="num">{gScore}</span></span>}
              <Icon name="chevron-down" size={16} className="g-chev" />
            </summary>
            <ul className="issue-list">
              {g.items.map(({ f, key }) => (
                <IssueRow key={key} f={f} itemKey={key} showCategory={groupBy === "severity"} isNew={newKeys.has(findingKey(f))} auditCreatedAt={auditCreatedAt}
                  selectable={selectable} checked={selected?.has(key) ?? false} onToggle={onToggle} />
              ))}
            </ul>
          </details>
        );
      })}
      {!shown.length && <p className="muted">No issues at this severity.</p>}
    </div>
  );
}

export function Screenshots({ leadId, audit }: { leadId: string; audit: Audit }) {
  const shots = (["desktop", "mobile"] as const).filter((k) => audit.screenshots[k]);
  if (!shots.length) return null;
  // Cache-bust per audit so a re-audit shows the new capture.
  const v = encodeURIComponent(audit.id);
  return (
    <div className="shots">
      {shots.map((k) => (
        <a key={k} href={`/api/leads/${leadId}/screenshot/${k}?v=${v}`} target="_blank" rel="noreferrer" className={`shot shot-${k}`}>
          <img src={`/api/leads/${leadId}/screenshot/${k}?v=${v}`} alt={`${k} screenshot of the homepage`} loading="lazy" />
          <span>{k === "desktop" ? "Desktop" : "Phone"}</span>
        </a>
      ))}
    </div>
  );
}
