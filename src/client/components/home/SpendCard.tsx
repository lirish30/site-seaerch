import { Link } from "react-router-dom";
import { Card, Meter } from "../ds";
import { limitLabel, moneyCents, spendView } from "../../todayHome";
import { spendLine } from "../../approvalsView";
import type { Money, Part, Spend } from "./useHome";

/** This month's paid usage and fixed costs against the monthly limit from Settings. */
export default function SpendCard({ money, spend, onRetry }: { money: Part<Money>; spend: Part<Spend>; onRetry: () => void }) {
  const m = money.data, sp = spend.data, v = m && sp ? spendView(m.usage, m.limit, sp.fixedUsd) : null;
  const fixed = sp ? sp.fixedCosts.filter((f) => f.active) : [];
  const tone = sp?.level === "capped" ? "critical" : sp?.level === "warn" ? "warning" : "neutral";
  return (
    <Card icon="card" title="Spend this month" id="spend" className="hox-card"
      note={m ? <Link to="/settings/usage" className="hox-note-link" title="Usage and limits">Limit {limitLabel(m.limit)}</Link> : undefined}>
      {!m && money.error ? (
        <div className="hox-alert inline" role="alert"><span>{money.error}</span><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <>
          <p className="hox-big md">{v ? <>{moneyCents(v.total)}<small>of {limitLabel(m!.limit)}</small></> : <i className="hox-skel" style={{ width: 96, height: 24 }} />}</p>
          <Meter value={v?.pct ?? 0} max={100} tone={tone} label={`Spend: ${Math.round(v?.pct ?? 0)}% of the monthly limit`} />
          {sp && sp.level !== "ok" && <p className={`hox-caption ${tone}`} role="status">{spendLine(sp)}</p>}
          {!sp && spend.error && <p className="hox-caption critical" role="alert">{spend.error}</p>}
          <ul className="hox-lines mono">
            {(v?.rows ?? [{ label: "Google Maps listings", usd: null }, { label: "AI reviews & drafts", usd: null }, { label: "Browser checks", usd: null }]).map((r) => (
              <li key={r.label}><span>{r.label}</span><b>{r.usd === null ? "–" : moneyCents(r.usd)}</b></li>
            ))}
            {fixed.map((f) => <li key={f.id} className="fixed"><span>{f.name} <small>monthly</small></span><b>{moneyCents(f.monthly_usd)}</b></li>)}
          </ul>
        </>
      )}
    </Card>
  );
}
