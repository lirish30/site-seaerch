import { criteriaList, fitLabel, fitSummary } from "../fitView";
import type { FitResult } from "../types";

/** Fit number for a table row; the tooltip lists the winning profile's matched and missing criteria. `—` when there is no fit. */
export function FitChip({ fit }: { fit: FitResult }) {
  const tip = fitSummary(fit);
  return (
    <span className={`fit-chip${fit.fit === null ? " none" : ""}`} title={tip} aria-label={`Fit: ${fit.fit === null ? "not scored" : fit.fit}. ${tip.replace(/\n/g, ". ")}`}>
      {fitLabel(fit)}
    </span>
  );
}

/** Lead detail: the number next to which profile won and what it matched, so a 100 from a thin profile is understandable. */
export function FitExplanation({ fit }: { fit: FitResult }) {
  return (
    <section className="fit-explain" aria-label="Fit">
      <div className="row">
        <span className="stat"><strong>{fitLabel(fit)}</strong> fit</span>
        {fit.profile && <span className="muted small">against <strong>{fit.profile.name}</strong></span>}
      </div>
      {fit.fit === null || !fit.profile ? (
        <p className="muted small">No fit score. Add criteria to an active fit profile in Settings to score leads against what you sell.</p>
      ) : (
        <p className="small fit-lists">
          <span className="fit-yes">Matched: {criteriaList(fit.matched)}</span>
          <span className={fit.missing.length ? "fit-no" : "muted"}>Missing: {criteriaList(fit.missing)}</span>
        </p>
      )}
    </section>
  );
}
