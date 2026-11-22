import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Icon from "../components/Icon";
import { clientsLine } from "../capacityView";
import { agingRows, barWidths, costPct, daysLate, fmtUsd, freedomLine, hoursLabel, monthLabel, targetCentsFrom, usdToCents } from "../moneyView";
import { workError } from "../workData";
import type { MoneyDashboard } from "../../worker/money/dashboard";

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "warn" }) => (
  <div className={`bl-stat${tone ? ` ${tone}` : ""}`}><span className="bl-stat-label">{label}</span><b className="bl-stat-num">{value}</b></div>
);

/** How many live clients you carry against the limit from Settings > Work. It only reports. */
function ClientsLine({ clients }: { clients: MoneyDashboard["clients"] }) {
  const { text, full } = clientsLine(clients);
  return <p className={`small${full ? " mn-warn" : ""}`}>Live clients: <b>{text}</b>{full ? ", at your limit" : ""}. <Link to="/settings/work">Change the limit</Link>.</p>;
}

/** A bar whose width is a percent of its track. The figure beside it is the real number, so the bar only shows proportion. */
const Bar = ({ pct, tone }: { pct: number; tone?: "warn" }) => <div className="mn-track" aria-hidden="true"><div className={`mn-fill${tone ? ` ${tone}` : ""}`} style={{ width: `${pct}%` }} /></div>;

/** Freedom number: MRR against the monthly target, and the target itself, saved in Settings (`money_config`). */
function Freedom({ d, onSaved }: { d: MoneyDashboard; onSaved: () => Promise<void> }) {
  const f = d.freedom;
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shown = text ?? String(f.targetCents / 100);
  const cents = targetCentsFrom(shown);
  const save = async () => {
    if (cents === null) return;
    setBusy(true); setError("");
    try { await api.put("/settings", { money_config: JSON.stringify({ freedomMrrCents: cents }) }); setText(null); await onSaved(); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="mn-card" aria-labelledby="mn-freedom">
      <h2 id="mn-freedom">Freedom number</h2>
      <p className="mn-big">{freedomLine(f)}</p>
      <Bar pct={Math.min(100, f.pct ?? 0)} />
      {f.targetCents > 0 && <p className="muted small">{f.gapCents > 0 ? `${fmtUsd(f.gapCents)} a month still to go.` : "You are at or past the target."}</p>}
      <div className="mn-target">
        <label className="deal-field"><span>Monthly target (USD)</span>
          <input className="in" inputMode="decimal" autoComplete="off" value={shown} aria-invalid={cents === null} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="button" className="btn primary" disabled={busy || cents === null || text === null || cents === f.targetCents} onClick={() => void save()}>Save target</button>
      </div>
      {cents === null && <p className="warn small" role="alert">Enter a number of dollars from 0 to 100,000.</p>}
      {error && <p className="warn small" role="alert">{error}</p>}
    </section>
  );
}

/** Money: one read-only page of the numbers that matter, each in plain words. No ledger and no tax figures. */
export default function Money() {
  const [d, setD] = useState<MoneyDashboard | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try { setD(await api.get<MoneyDashboard>("/money")); setFailed(false); }
    catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const revenueBars = d ? barWidths(d.revenue.months.map((m) => m.cents)) : [];
  const aging = d ? agingRows(d.ar) : [];
  const agingBars = d ? barWidths(d.ar.buckets.map((b) => b.cents)) : [];

  return (
    <div className="wk">
      <header className="page-header">
        <div>
          <h1>Money</h1>
          <p>What is coming in, what is owed and what each project earned. Test clients are left out.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
          <Link to="/billing" className="btn">Billing</Link>
        </div>
      </header>
      <div className="wk-body mn-body">
        {failed && <p className="error" role="alert">Couldn’t load the money page. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {!d && !failed && <p className="muted">Loading…</p>}
        {d && (
          <>
            <Freedom d={d} onSaved={load} />

            <section className="mn-card" aria-labelledby="mn-mrr">
              <h2 id="mn-mrr">MRR and churn</h2>
              <div className="mn-stats">
                <Stat label="Monthly recurring" value={fmtUsd(d.mrr.cents)} />
                <Stat label="Subscriptions" value={String(d.mrr.subscriptions)} />
                <Stat label="Lost in 30 days" value={fmtUsd(d.mrr.churnedLast30Cents)} tone={d.mrr.churnedLast30Cents > 0 ? "warn" : undefined} />
                <Stat label="Churn rate" value={d.mrr.churnRatePct === null ? "None yet" : `${d.mrr.churnRatePct}%`} />
              </div>
              <ClientsLine clients={d.clients} />
            </section>

            <section className="mn-card" aria-labelledby="mn-revenue">
              <h2 id="mn-revenue">Revenue</h2>
              <p className="small">Cash received this month: <b>{fmtUsd(d.revenue.monthCents)}</b>. Counted in {d.zone.replace(/_/g, " ")} time.</p>
              <ul className="mn-rows">
                {d.revenue.months.map((m, i) => (
                  <li key={m.month} className="mn-row">
                    <span className="mn-label">{monthLabel(m.month)}</span>
                    <Bar pct={revenueBars[i]} />
                    <b className="mn-amt">{fmtUsd(m.cents)}</b>
                  </li>
                ))}
              </ul>
            </section>

            <section className="mn-card" aria-labelledby="mn-owed">
              <h2 id="mn-owed">Money owed</h2>
              <p className="small">Open invoices: <b>{fmtUsd(d.ar.openCents)}</b></p>
              <ul className="mn-rows">
                {aging.map((a, i) => (
                  <li key={a.label} className="mn-row">
                    <span className="mn-label">{a.label}{a.count > 0 ? ` (${a.count})` : ""}</span>
                    <Bar pct={agingBars[i]} tone={i > 0 ? "warn" : undefined} />
                    <b className="mn-amt">{a.amount}</b>
                  </li>
                ))}
              </ul>
              {d.ar.oldest.length > 0 && (
                <>
                  <h3>Oldest unpaid invoices</h3>
                  <ul className="mn-list">
                    {d.ar.oldest.map((o) => (
                      <li key={o.invoiceId}>
                        <Link to={`/leads/${o.businessId}`}>{o.businessName || "A client"}</Link>
                        <span className="mn-meta">{fmtUsd(o.amountCents)}, {daysLate(o.daysOverdue)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="mn-card" aria-labelledby="mn-booked">
              <h2 id="mn-booked">Booked, not billed</h2>
              <p className="small">Sold but not yet invoiced or paid: <b>{fmtUsd(d.bookedNotBilled.cents)}</b></p>
              {d.bookedNotBilled.rows.length === 0 ? <p className="muted small">Nothing is waiting to be billed.</p> : (
                <ul className="mn-list">
                  {d.bookedNotBilled.rows.map((r) => (
                    <li key={r.businessId}><Link to={`/leads/${r.businessId}`}>{r.businessName}</Link><span className="mn-meta">{fmtUsd(r.cents)}</span></li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mn-card" aria-labelledby="mn-profit">
              <h2 id="mn-profit">Profit per project</h2>
              <p className="muted small">Payments less your time at your cost rate (Settings, Work).</p>
              {d.profit.length === 0 ? <p className="muted small">No sold projects yet.</p> : (
                <ul className="mn-list">
                  {d.profit.map((p) => (
                    <li key={p.projectId} className="mn-profit">
                      <span><Link to={`/projects/${p.projectId}`}>{p.name}</Link> <span className="muted">for {p.businessName}</span></span>
                      <span className="mn-meta">
                        Sold {fmtUsd(p.soldCents)}, paid {fmtUsd(p.paidCents)}, {hoursLabel(p.minutes)} of work. Profit on what is paid: <b>{fmtUsd(p.marginPaidCents)}</b>
                        {p.effectiveHourlyCents !== null ? `, ${fmtUsd(p.effectiveHourlyCents)} an hour` : ""}.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mn-card" aria-labelledby="mn-ltv">
              <h2 id="mn-ltv">Lifetime value</h2>
              <p className="muted small">The ten clients who have paid you the most. Cash actually received, no projection.</p>
              {d.ltv.length === 0 ? <p className="muted small">No payments yet.</p> : (
                <ul className="mn-list">
                  {d.ltv.map((c) => (
                    <li key={c.businessId}><Link to={`/leads/${c.businessId}`}>{c.name}</Link><span className="mn-meta">{fmtUsd(c.paidCents)} paid, {fmtUsd(c.mrrCents)} a month now</span></li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mn-card" aria-labelledby="mn-costs">
              <h2 id="mn-costs">Running costs against the cap</h2>
              <p className="small">
                <b>{fmtUsd(usdToCents(d.costs.spentUsd))}</b> of {fmtUsd(usdToCents(d.costs.limitUsd))} this month
                {d.costs.level === "capped" ? ", the cap is reached" : d.costs.level === "warn" ? ", close to the cap" : ""}.
              </p>
              <Bar pct={costPct(d.costs.spentUsd, d.costs.limitUsd)} tone={d.costs.level === "ok" ? undefined : "warn"} />
              {d.costs.services.length > 0 && (
                <ul className="mn-list">
                  {d.costs.services.map((s) => (
                    <li key={s.service}><span>{s.service}</span><span className="mn-meta">{fmtUsd(usdToCents(s.spentUsd))}{s.capUsd !== null ? ` of ${fmtUsd(usdToCents(s.capUsd))}` : ""}</span></li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
