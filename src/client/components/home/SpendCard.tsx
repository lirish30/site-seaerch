import { Link } from "react-router-dom";
import Icon from "../Icon";
import { limitLabel, moneyCents, spendView } from "../../todayHome";
import type { Money, Part } from "./useHome";

/** This month's paid usage against the monthly limit from Settings. */
export default function SpendCard({ money, onRetry }: { money: Part<Money>; onRetry: () => void }) {
  const m = money.data, v = m ? spendView(m.usage, m.limit) : null;
  return (
    <section className="hm-card" id="spend" aria-labelledby="hm-spend-h">
      <header className="hm-card-head">
        <Icon name="card" size={16} />
        <h2 id="hm-spend-h">Spend this month</h2>
        {m && <Link to="/settings/usage" className="hm-head-note small" title="Usage and limits">Limit {limitLabel(m.limit)}</Link>}
      </header>
      {!m && money.error ? (
        <div className="hm-state sm" role="alert"><p>{money.error}</p><button type="button" className="btn sm" onClick={onRetry}>Try again</button></div>
      ) : (
        <div className="hm-card-body spend">
          <p className="hm-spend-total">
            {v ? <><span>{moneyCents(v.total)}</span><small> of {limitLabel(m!.limit)}</small></> : <i className="hm-skel" style={{ width: 96, height: 24 }} />}
          </p>
          <div className={`hm-meter${v?.over ? " over" : ""}`} role="progressbar" aria-label="Spend against the monthly limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v?.pct ?? 0)}><i style={{ width: `${v?.pct ?? 0}%` }} /></div>
          <ul className="hm-spend-rows">
            {(v?.rows ?? [{ label: "Google Maps listings", usd: null }, { label: "AI reviews & drafts", usd: null }, { label: "Browser checks", usd: null }]).map((r) => (
              <li key={r.label}><span>{r.label}</span><b>{r.usd === null ? "–" : moneyCents(r.usd)}</b></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
