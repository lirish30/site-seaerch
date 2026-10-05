import { useEffect, useState } from "react";
import { elapsedSeconds, estimateRemainingSeconds, formatClock, formatEta, searchStage, type Stage } from "../eta";
import type { Search } from "../types";

const STEPS: { key: Exclude<Stage, "failed">; label: string }[] = [
  { key: "fetching", label: "Finding listings" },
  { key: "auditing", label: "Auditing sites" },
  { key: "done", label: "Done" },
];

/** Ticks once a second while `active`, so elapsed time keeps moving between polls. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export default function SearchProgress({ search, compact = false }: { search: Search; compact?: boolean }) {
  const stage = searchStage(search);
  const running = stage === "fetching" || stage === "auditing";
  const now = useNow(running);
  const eta = estimateRemainingSeconds(search, now);
  const pct = search.found_count > 0 ? Math.min(100, Math.round((search.processed_count / search.found_count) * 100)) : 0;
  const status = stage === "fetching" ? "Searching Google Maps for listings…"
    : stage === "auditing" ? `${search.processed_count} of ${search.found_count} businesses audited`
    : stage === "done" ? (search.found_count === 0 ? "No businesses found" : `${search.found_count} businesses audited`)
    : "Search failed";

  return (
    <div className={`progress-card${compact ? " compact" : ""}`} role="status" aria-live="polite">
      <div className="progress-top">
        <span className="progress-status">
          {running && <span className="spinner" aria-hidden />}
          {status}
        </span>
        {running && (
          <span className="muted progress-time">
            {formatClock(elapsedSeconds(search.created_at, now))} elapsed{eta !== null && <> · {formatEta(eta)} left <span title="Estimate based on typical pacing">(est.)</span></>}
          </span>
        )}
      </div>
      <div className={`bar${stage === "fetching" ? " indeterminate" : ""}${running ? " live" : ""}${stage === "failed" ? " failed" : ""}`}
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={stage === "fetching" ? undefined : pct}>
        <span style={{ width: stage === "fetching" ? undefined : `${stage === "done" ? 100 : pct}%` }} />
      </div>
      {!compact && stage !== "failed" && (
        <ol className="steps">
          {STEPS.map((s, i) => {
            const idx = STEPS.findIndex((x) => x.key === stage);
            return <li key={s.key} className={i < idx || stage === "done" ? "complete" : i === idx ? "current" : ""}>{s.label}</li>;
          })}
        </ol>
      )}
    </div>
  );
}
