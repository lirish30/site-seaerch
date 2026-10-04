import { useState } from "react";
import { CATEGORY_LABEL, CATEGORY_ORDER, type Audit, type AuditCategory, type Finding } from "../types";

const SEVERITY_LABEL = { critical: "Critical", important: "Important", nice: "Nice to have" } as const;

export function CategoryBars({ scores }: { scores: Audit["category_scores"] }) {
  const cats = CATEGORY_ORDER.filter((c) => scores[c] !== undefined);
  if (!cats.length) return null;
  return (
    <ul className="cat-bars">
      {cats.map((c) => (
        <li key={c} className={`cat-${c}`}>
          <span className="cat-name">{CATEGORY_LABEL[c]}</span>
          <span className="cat-track"><span style={{ width: `${scores[c]}%` }} /></span>
          <span className="cat-score">{scores[c]}</span>
        </li>
      ))}
    </ul>
  );
}

/** Every finding, grouped by category, with severity, evidence and the fix. */
export function FindingsList({ findings, selectable, selected, onToggle }: {
  findings: Finding[]; selectable?: boolean; selected?: Set<string>; onToggle?: (key: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | Finding["severity"]>("all");
  const shown = findings.map((f, i) => ({ f, key: `${f.code}:${i}` })).filter(({ f }) => filter === "all" || f.severity === filter);
  const groups = [...CATEGORY_ORDER, "site" as const].map((c) => ({ c, items: shown.filter(({ f }) => f.category === c) })).filter((g) => g.items.length);
  const count = (s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
  if (!findings.length) return <p className="muted">No issues found.</p>;
  return (
    <div className="findings">
      <div className="sev-filter" role="group" aria-label="Filter by severity">
        {(["all", "critical", "important", "nice"] as const).map((s) => (
          <button key={s} className={`pill sev-${s}${filter === s ? " on" : ""}`} onClick={() => setFilter(s)} aria-pressed={filter === s}>
            {s === "all" ? `All ${findings.length}` : `${SEVERITY_LABEL[s]} ${count(s)}`}
          </button>
        ))}
      </div>
      {groups.map(({ c, items }) => (
        <section key={c} className={`finding-group cat-${c}`}>
          <h4>{CATEGORY_LABEL[c as AuditCategory | "site"]} <span className="muted">{items.length}</span></h4>
          <ul>
            {items.map(({ f, key }) => (
              <li key={key} className={`finding sev-${f.severity}`}>
                {selectable && <input type="checkbox" aria-label="Mention this in the email" checked={selected?.has(key) ?? false} onChange={() => onToggle?.(key)} />}
                <div>
                  <p className="finding-evidence"><span className={`sev-dot sev-${f.severity}`} title={SEVERITY_LABEL[f.severity]} />{f.evidence}</p>
                  {f.recommendation && <p className="finding-fix">→ {f.recommendation}</p>}
                </div>
                {f.source === "ai" && <span className="tag" title="From the AI design review">AI</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
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
