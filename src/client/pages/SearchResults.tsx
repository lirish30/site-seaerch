import { useMemo } from "react";
import { Link } from "react-router-dom";
import Icon from "../components/Icon";
import { Badge, LeadScore, SiteHealth } from "../components/Score";
import { rowStatuses, sortResults, type RowStatus } from "../searchView";
import type { LeadRow } from "../types";

const host = (u: string | null) => (u ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function StatusCell({ status, error }: { status: RowStatus; error: string | null }) {
  if (status === "audited") return <Badge tone="positive" dot>Audited</Badge>;
  if (status === "failed") return <span title={error ?? undefined}><Badge tone="critical" dot>Couldn’t audit</Badge></span>;
  if (status === "auditing") return <span className="sp-auditing"><Icon name="refresh" size={13} className="sp-spin" />Auditing…</span>;
  if (status === "queued") return <span className="sp-queued">Queued</span>;
  return <span className="sp-queued">Not audited</span>;
}

/** The search's leads as they arrive: audited ones by lead score, the rest as grey placeholders until their audit lands. */
export default function SearchResults({ rows, running }: { rows: LeadRow[]; running: boolean }) {
  const sorted = useMemo(() => sortResults(rows), [rows]);
  const statuses = useMemo(() => rowStatuses(sorted, running), [sorted, running]);
  if (rows.length === 0) {
    return <div className="sp-none">{running ? "Businesses appear here as soon as Google Maps returns them." : "This search has no results."}</div>;
  }
  return (
    <div className="sp-scroll"><div className="sp-table" role="table" aria-label="Search results">
      <div className="sp-row sp-head" role="row">
        <span role="columnheader">Business</span><span role="columnheader">Lead score</span><span role="columnheader">Site health</span>
        <span role="columnheader">Biggest problem</span><span role="columnheader">Status</span>
      </div>
      {sorted.map((r, i) => {
        const b = r.business, status = statuses[i], pending = status !== "audited" && status !== "failed";
        const site = host(b.website_url);
        return (
          <div key={b.id} className="sp-row" role="row">
            <span role="cell" className="sp-biz">
              <Link to={`/leads/${b.id}`} className="sp-name" title={b.name}>{b.name}</Link>
              <span className="sp-sub" title={b.website_url ?? ""}>{site || "No website · Google Maps only"}</span>
            </span>
            <span role="cell">{pending || status === "failed" ? <i className="sp-skel s60" /> : <LeadScore score={r.score} />}</span>
            <span role="cell">{pending || status === "failed" ? <i className="sp-skel s90" /> : <SiteHealth health={r.health} noSite={!b.website_url} partial={r.partial} />}</span>
            <span role="cell" className="sp-problem" title={r.topFinding ?? b.last_error ?? ""}>
              {pending ? <i className="sp-skel s200" /> : status === "failed" ? <span className="sp-err">{b.last_error}</span> : r.topFinding ?? <span className="sp-dash">—</span>}
            </span>
            <span role="cell"><StatusCell status={status} error={b.last_error} /></span>
          </div>
        );
      })}
    </div></div>
  );
}
