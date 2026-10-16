import { useState, type ReactNode } from "react";
import { CATEGORY_ICON, SEVERITY_LABEL, severityCounts } from "../scoreView";
import { CATEGORY_LABEL, CATEGORY_ORDER, type Audit, type AuditCategory, type Finding, type Severity } from "../types";
import Icon, { type IconName } from "./Icon";
import { Badge, HealthBar, Severity as SeverityMark } from "./Score";
import { SOURCE_LABEL } from "../evidenceView";

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

function IssueRow({ f, itemKey, showCategory, isNew, picker, checked, onToggle, atLimit }: {
  f: Finding; itemKey: string; showCategory: boolean; isNew: boolean; picker: boolean; checked: boolean; onToggle?: (key: string) => void; atLimit: boolean;
}) {
  return (
    <li className="issue">
      {picker && <input className="cb" type="checkbox" aria-label="Mention this in the email" checked={checked} onChange={() => onToggle?.(itemKey)} />}
      <div className="sev-col">
        <SeverityMark severity={f.severity} />
        {isNew && <Badge tone="critical">New</Badge>}
        {showCategory && <span className="cat-tag"><Icon name={CATEGORY_ICON[f.category] as IconName} size={13} />{CATEGORY_LABEL[f.category]}</span>}
      </div>
      <div className="body">
        <p className="what">{f.evidence}</p>
        {f.recommendation && <p className="fix"><b>Fix</b>{f.recommendation}</p>}
      </div>
      {!picker && (
        <div className="side">
          <Badge tone="outline" title={f.source === "ai" ? "From the AI design review" : "A deterministic check of the page"}>{SOURCE_LABEL[f.source]}</Badge>
          {onToggle && (
            <label className="use-email" title={!checked && atLimit ? "Up to 5 issues can be picked" : "Build the email on this issue"}>
              <input className="cb" type="checkbox" checked={checked} disabled={!checked && atLimit} onChange={() => onToggle(itemKey)} />Use in email
            </label>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Every finding, one card per group, worst first. Grouped by category (with that category's score) or by severity; filterable by severity.
 * `picker` turns it into the compact email picker (checkbox first, no source column). Otherwise `selected`/`onToggle` drive the
 * "Use in email" boxes, which feed the Email draft tab. `added` marks findings new since the last audit.
 */
export function FindingsList({ findings, scores = {}, added, picker, selected, onToggle, pickLimit = 5, trailing, afterToolbar }: {
  findings: Finding[]; scores?: Audit["category_scores"]; added?: Finding[]; picker?: boolean;
  selected?: Set<string>; onToggle?: (key: string) => void; pickLimit?: number;
  /** Shown at the right end of the toolbar (the audit date, "Score looks wrong?"). */
  trailing?: ReactNode; afterToolbar?: ReactNode;
}) {
  const [filter, setFilter] = useState<"all" | Severity>("all");
  const [groupBy, setGroupBy] = useState<"category" | "severity">("category");
  const newKeys = new Set((added ?? []).map(findingKey));
  const items = findings.map((f, i) => ({ f, key: `${f.code}:${i}` })).filter(({ f }) => filter === "all" || f.severity === filter);
  const counts = severityCounts(findings);
  if (!findings.length) return <p className="muted">No issues found.</p>;
  const atLimit = (selected?.size ?? 0) >= pickLimit;

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
              <i className={`dot sev-${s}`} />{SEVERITY_LABEL[s]} <span className="n">{counts[s]}</span>
            </button>
          ))}
        </div>
        {!picker && (
          <label className="group-by">Group by
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as "category" | "severity")} aria-label="Group issues by">
              <option value="category">Category</option><option value="severity">Severity</option>
            </select><Icon name="chevron-down" size={14} />
          </label>
        )}
        <span className="grow" />
        {trailing}
      </div>
      {afterToolbar}
      {shown.map((g) => {
        const gScore = groupBy === "category" ? scores[g.id as AuditCategory] : undefined;
        const open = !!picker || filter !== "all" || g.items.some(({ f }) => f.severity === "critical") || groupBy === "severity";
        return (
          <details key={`${groupBy}:${filter}:${g.id}`} className="section-card issue-group" open={open}>
            <summary>
              {g.icon && <span className="g-icon"><Icon name={g.icon} size={16} /></span>}
              <span className="g-title"><b>{g.title}</b><small>{g.items.length} {g.items.length === 1 ? "issue" : "issues"}</small></span>
              {groupBy === "category" ? <CountDots findings={g.items.map((x) => x.f)} /> : <span className="g-counts" />}
              {gScore !== undefined && <span className="g-score">Score <HealthBar value={gScore} wide /><span className="num">{gScore}</span></span>}
              <Icon name="chevron-down" size={16} className="g-chev" />
            </summary>
            <ul className="issue-list">
              {g.items.map(({ f, key }) => (
                <IssueRow key={key} f={f} itemKey={key} showCategory={groupBy === "severity"} isNew={newKeys.has(findingKey(f))}
                  picker={!!picker} checked={selected?.has(key) ?? false} onToggle={onToggle} atLimit={atLimit} />
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
