import { Fragment, useState } from "react";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import { elapsedSeconds, estimateRemainingSeconds, formatClock, formatEta, searchStage } from "../eta";
import { barPercent, failureReason, fullScanButtonText, fullScanTargets, isImport, runState, STATE_LABEL, tierCounts } from "../searchView";
import { isSpendLimit, SPEND_LIMIT_REACHED } from "../spend";
import type { LeadRow, Search } from "../types";
import { useNow } from "./SearchProgress";

type PillState = "done" | "current" | "pending" | "failed";
const PILLS = ["Finding listings", "Auditing sites", "Done"] as const;

/** Which of the three stage pills is complete, current, pending or (for a search that did not finish) the one it ended in. */
function pillStates(s: Search): PillState[] {
  const stage = searchStage(s), state = runState(s);
  if (stage === "done") return ["done", "done", "done"];
  const at = s.found_count === 0 ? 0 : 1; // the stage a running or ended search is in
  const states: PillState[] = PILLS.map((_, i) => (i < at ? "done" : i === at ? "current" : "pending"));
  if (state === "failed" || state === "stopped") states[at] = "failed";
  return states;
}

/** The stage pills, the big audited count with elapsed time and time left, the bar, and the Hot / Warm / Cool / No website / Couldn't audit boxes. */
export function ProgressCard({ search, rows, onRetry, retrying }: { search: Search; rows: LeadRow[]; onRetry?: () => void; retrying?: boolean }) {
  const state = runState(search);
  const running = state === "running";
  const ended = state === "failed" || state === "stopped";
  const now = useNow(running);
  const eta = estimateRemainingSeconds(search, now);
  const counts = tierCounts(rows);
  const pills = pillStates(search);
  const stage = searchStage(search);
  const nothing = search.found_count === 0; // no listings (yet): there is no count to show
  const big = nothing ? null : String(search.processed_count);
  const imported = isImport(search); // an import has no listing or audit stages, only the leads it created
  const label = imported ? `${search.found_count === 1 ? "lead" : "leads"} imported` : stage === "fetching" ? "Searching Google Maps for listings…"
    : nothing ? (ended ? "No businesses were found before it ended" : "No businesses found")
    : `of ${search.found_count} businesses audited${ended ? " before it ended" : ""}`;
  const boxes: { key: string; label: string; value: number; dot?: string }[] = [
    { key: "hot", label: running ? "Hot so far" : "Hot", value: counts.hot, dot: "hot" }, { key: "warm", label: "Warm", value: counts.warm, dot: "warm" },
    { key: "cool", label: "Cool", value: counts.cool, dot: "cool" }, { key: "nosite", label: "No website", value: counts.noWebsite },
    { key: "failed", label: "Couldn’t audit", value: counts.failed },
  ];
  return (
    <section className="sp-card" aria-label="Search progress">
      {!imported && <ol className="sp-pills">
        {PILLS.map((p, i) => (
          <Fragment key={p}>
            {i > 0 && <li className="sp-sep" aria-hidden="true"><Icon name="chevron-right" size={14} /></li>}
            <li className={`sp-pill ${pills[i]}`} aria-current={pills[i] === "current" ? "step" : undefined}>
              {pills[i] === "done" && <Icon name="check" size={13} />}
              {pills[i] === "current" && <Icon name="refresh" size={13} className="sp-spin" />}
              {pills[i] === "failed" && <Icon name="x" size={13} />}
              <span>{p}</span>
            </li>
          </Fragment>
        ))}
      </ol>}
      <div className="sp-count" role="status" aria-live="polite">
        {big !== null && <span className="sp-big">{big}</span>}<span className="sp-of">{label}</span>
        <span className="sp-grow" />
        {running && <span className="sp-time">{formatClock(elapsedSeconds(search.created_at, now))} elapsed{eta !== null && <> · {formatEta(eta)} left</>}</span>}
      </div>
      {!imported && (stage === "fetching" ? !ended : !nothing) && (
        <div className={`sp-bar${ended ? " ended" : stage === "done" ? " done" : ""}`} role="progressbar" aria-label="Businesses audited" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={stage === "fetching" ? undefined : barPercent(search)}><i style={{ width: `${barPercent(search)}%` }} /></div>
      )}
      {ended && (
        <div className={`sp-ended ${state}`} role="alert">
          <Icon name={state === "failed" ? "alert" : "ban"} size={16} />
          <div>
            <strong>{state === "failed" ? "Search failed" : STATE_LABEL[state]}</strong>
            <span>{state === "failed" ? failureReason(search) : "You stopped this search. Leads already being audited may still finish; no more were started."}</span>
          </div>
          {onRetry && <button type="button" className="btn" disabled={retrying} onClick={onRetry}><Icon name="refresh" size={16} />{retrying ? "Starting…" : "Run again"}</button>}
        </div>
      )}
      {!imported && stage === "done" && nothing && <p className="sp-hint">No businesses came back for this search. Try a wider area or a broader business type.</p>}
      {rows.length > 0 && (
        <div className="sp-stats">
          {boxes.map((b) => (
            <div key={b.key} className="sp-stat"><span className="sp-stat-label">{b.dot && <i className={`sp-dot ${b.dot}`} />}{b.label}</span><b>{b.value}</b></div>
          ))}
        </div>
      )}
    </section>
  );
}

/** "Full-scan the hot ones": runs the full scan (screenshots, PageSpeed, AI review, draft) on this search's hot quick-scanned leads, one at a time. */
export function FullScanNotice({ rows, running, onStarted }: { rows: LeadRow[]; running: boolean; onStarted: () => void }) {
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const targets = fullScanTargets(rows).filter((r) => !started.has(r.business.id));
  const run = async () => {
    setBusy(true); setErr("");
    const ok: string[] = [];
    let message = "";
    for (const r of targets) {
      try { await api.post(`/leads/${r.business.id}/full-scan`); ok.push(r.business.id); }
      catch (e) {
        message = isSpendLimit(e) ? SPEND_LIMIT_REACHED : e instanceof ApiError && e.message ? e.message : "Couldn't start the full scan.";
        break;
      }
    }
    setStarted((s) => new Set([...s, ...ok]));
    if (message) setErr(ok.length ? `Started ${ok.length}, then it stopped. ${message}` : message);
    setBusy(false);
    if (ok.length) onStarted();
  };
  return (
    <section className="sp-notice" aria-label="Quick scan">
      <Icon name="sparkles" size={18} className="sp-notice-ico" />
      <div className="sp-notice-text">
        <strong>Quick scan: crawled and scored only</strong>
        <span>{started.size > 0 && targets.length === 0 ? `Full scan started on ${started.size} hot ${started.size === 1 ? "lead" : "leads"}. They update here as each one finishes.`
          : targets.length > 0 ? "Full-scan the hot ones to add screenshots, a Google speed test, an AI review and an email draft."
          : running ? "Hot leads you can full-scan show up here as they are scored." : "No hot leads in this search still need a full scan."}</span>
        {err && <span className="sp-notice-err" role="alert">{err}</span>}
      </div>
      {targets.length > 0 && (
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}><Icon name="zap" size={16} />{busy ? "Starting…" : fullScanButtonText(targets.length)}</button>
      )}
    </section>
  );
}
