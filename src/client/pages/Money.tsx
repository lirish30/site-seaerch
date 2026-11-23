import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { capacityRows, clientsLine, hoursText } from "../capacityView";
import {
  capShare, chartScale, clientsToGoal, costPct, daysLate, fmtUsd, fmtUsd2, freedomLine, hoursLabel, monthLabel, monthTitle, targetCentsFrom, usdToCents,
} from "../moneyView";
import { serviceLabel } from "../spendView";
import { Avatar, Banner, Card, Chip, Empty, Meter, PageHeader } from "../components/ds";
import Icon, { type IconName } from "../components/Icon";
import { workError } from "../workData";
import type { MoneyDashboard } from "../../worker/money/dashboard";
import type { Capacity } from "../../worker/capacity/compute";

/** A stat card in the ds-stat look, with room for a small control beside its label (the goal editor on MRR). */
function StatCard({ icon, label, value, sub, tone, extra }: { icon: IconName; label: string; value: string; sub: ReactNode; tone?: "positive" | "critical" | "warning"; extra?: ReactNode }) {
  return (
    <div className="ds-stat mnx-stat">
      <div className="ds-stat-label"><Icon name={icon} size={16} /><span className="ds-grow">{label}</span>{extra}</div>
      <p className="ds-stat-value">{value}</p>
      <p className={`ds-stat-sub${tone ? ` ${tone}` : ""}`}>{sub}</p>
    </div>
  );
}

/** The freedom number's editor: the monthly MRR goal, saved in Settings (`money_config`). Opens as a small popover from the MRR card. */
function GoalEditor({ d, onSaved }: { d: MoneyDashboard; onSaved: () => Promise<void> }) {
  const f = d.freedom;
  const ref = useRef<HTMLDetailsElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shown = text ?? String(f.targetCents / 100);
  const cents = targetCentsFrom(shown);
  const save = async () => {
    if (cents === null) return;
    setBusy(true); setError("");
    try {
      await api.put("/settings", { money_config: JSON.stringify({ freedomMrrCents: cents }) });
      setText(null); await onSaved();
      if (ref.current) ref.current.open = false;
    } catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  return (
    <details className="menu mnx-goal" ref={ref}>
      <summary className="btn sm" aria-label="Edit the monthly goal"><Icon name="pen" size={14} />{f.targetCents > 0 ? "Goal" : "Set goal"}</summary>
      <div className="menu-list mnx-goal-pop">
        <b>Freedom number</b>
        <p>The monthly recurring income you are aiming for. Now: {freedomLine(f)}.</p>
        <label className="mnx-field"><span>Monthly goal (USD)</span>
          <input className="in" inputMode="decimal" autoComplete="off" value={shown} aria-invalid={cents === null} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
        </label>
        {cents === null && <p className="mnx-warn" role="alert">Enter a number of dollars from 0 to 100,000.</p>}
        {error && <p className="mnx-warn" role="alert">{error}</p>}
        <button type="button" className="btn sm primary" disabled={busy || cents === null || text === null || cents === f.targetCents} onClick={() => void save()}>Save goal</button>
      </div>
    </details>
  );
}

/** Cash received in each of the last six months as bars: the current month in Signal, the goal as a dashed line. */
function MonthsChart({ d }: { d: MoneyDashboard }) {
  const months = d.revenue.months;
  const { bars, goalPct } = chartScale(months.map((m) => m.cents), d.freedom.targetCents);
  const last = months.length - 1;
  return (
    <div className="mnx-plot" role="img" aria-label={`Cash collected: ${months.map((m) => `${monthLabel(m.month)} ${fmtUsd(m.cents)}`).join(", ")}`}>
      {goalPct !== null && (
        <div className="mnx-goal-area" aria-hidden="true"><div className="mnx-goal-line" style={{ bottom: `calc(${goalPct}% * 0.78 + 22px)` }}><span>Goal · {fmtUsd(d.freedom.targetCents)} a month</span></div></div>
      )}
      {months.every((m) => m.cents === 0) && <p className="mnx-plot-empty">No payments in the last six months. Each month fills in as clients pay their invoices.</p>}
      {months.map((m, i) => (
        <div key={m.month} className={`mnx-col${i === last ? " now" : ""}`}>
          <span className="mnx-col-val">{fmtUsd(m.cents)}</span>
          <i className="mnx-bar" style={{ height: bars[i] > 0 ? `calc(${bars[i]}% * 0.78)` : "2px" }} />
          <span className="mnx-col-label">{monthLabel(m.month).split(" ")[0]}</span>
        </div>
      ))}
    </div>
  );
}

/** Money: the dashboard. Four numbers, cash by month against the goal, profit per project, then what is owed, capacity, lifetime value, booked work and running costs. Read-only, apart from the goal. */
export default function Money() {
  const [d, setD] = useState<MoneyDashboard | null>(null);
  const [cap, setCap] = useState<Capacity | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try { setD(await api.get<MoneyDashboard>("/money")); setFailed(false); }
    catch { setFailed(true); }
    api.get<Capacity>("/capacity").then((c) => setCap(c && Array.isArray(c.weeks) ? c : null)).catch(() => setCap(null));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const overdueCents = d ? d.ar.buckets.filter((b) => b.key !== "current").reduce((n, b) => n + b.cents, 0) : 0;
  const worst = d?.ar.oldest[0];
  const header = (
    <PageHeader
      title="Money"
      sub={d ? `${monthTitle(d.asOf, d.zone)} · counted in ${d.zone.replace(/_/g, " ")} time · test clients left out` : "What is coming in, what is owed and what each project earned."}
      actions={<>
        <button type="button" className="btn icon-only" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>
        <Link to="/settings/billing" className="btn"><Icon name="sliders" size={16} />Billing settings</Link>
        <Link to="/billing" className="btn primary"><Icon name="file-text" size={16} />See invoices</Link>
      </>}
    />
  );

  if (!d) {
    return (
      <div className="ds-page mnx">{header}
        <div className="ds-body">
          {failed
            ? <Banner tone="critical" title="Couldn't load the money page" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>Check your connection, then try again.</Banner>
            : <p className="mnx-muted">Loading…</p>}
        </div>
      </div>
    );
  }

  const f = d.freedom;
  const week = cap ? capacityRows(cap)[0] : null;
  const clients = clientsLine(d.clients);
  const more = clientsToGoal(d.mrr.cents, d.clients.count, f.gapCents);
  const bookedTop = d.bookedNotBilled.rows[0];
  const arMax = Math.max(1, d.ar.openCents);
  // A brand new account: nothing earned, owed, sold or paid yet. The page shows how money gets here instead of a wall of $0.
  const fresh = d.mrr.cents === 0 && d.ar.openCents === 0 && d.bookedNotBilled.cents === 0 && d.profit.length === 0 && d.ltv.length === 0 && d.revenue.months.every((m) => m.cents === 0);
  const lateTone = (key: string) => (key === "current" ? "neutral" : key === "d61_plus" ? "critical" : "signal") as "neutral" | "critical" | "signal";

  return (
    <div className="ds-page mnx">
      {header}
      <div className="ds-body">
        {worst && (
          <Banner tone="warning" title={`${worst.businessName || "A client"} is ${daysLate(worst.daysOverdue)} on ${fmtUsd(worst.amountCents)}`}
            action={<Link to={`/billing?businessId=${encodeURIComponent(worst.businessId)}`} className="btn sm">Open their invoices</Link>}>
            {d.ar.oldest.length > 1 ? `${d.ar.oldest.length - 1} more overdue. ` : ""}Reminders wait in Approvals; work pauses on the day set in Billing settings.
          </Banner>
        )}

        {fresh ? (
          <Card icon="trending" title="Nothing has come in yet" note="This page fills itself in" className="mnx-start">
            <ol className="mnx-how mnx-start-steps">
              <li><span className="ds-tile signal"><Icon name="target" size={14} /></span><span><b>Set your monthly goal</b><small>The recurring income you are aiming for. Every number here is measured against it.</small></span><GoalEditor d={d} onSaved={load} /></li>
              <li><span className="ds-tile neutral"><Icon name="file-text" size={14} /></span><span><b>Sign a proposal</b><small>Its deposit is drafted as an invoice, and any monthly plan becomes a subscription.</small></span><Link to="/sales" className="btn sm">Go to sales</Link></li>
              <li><span className="ds-tile neutral"><Icon name="check" size={14} /></span><span><b>Approve the invoice</b><small>Stripe mails it; paid ones mark themselves paid and show here by month.</small></span><Link to="/approvals" className="btn sm">Approvals</Link></li>
              <li><span className="ds-tile positive"><Icon name="gauge" size={14} /></span><span><b>Log time on the project</b><small>Profit per project is what it paid, less your hours at your cost rate.</small></span></li>
            </ol>
          </Card>
        ) : (
        <section className="ds-stats mnx-stats" aria-label="Key numbers">
            <StatCard icon="trending" label="MRR" value={fmtUsd(d.mrr.cents)}
              sub={f.targetCents > 0 ? `${f.pct}% of the ${fmtUsd(f.targetCents)} goal` : "No goal set yet"} tone={f.targetCents > 0 && f.gapCents === 0 ? "positive" : undefined}
              extra={<GoalEditor d={d} onSaved={load} />} />
            <StatCard icon="card" label="Collected this month" value={fmtUsd2(d.revenue.monthCents)}
              sub={overdueCents > 0 ? `${fmtUsd(overdueCents)} overdue` : d.ar.openCents > 0 ? `${fmtUsd(d.ar.openCents)} sent, not due yet` : "Nothing overdue"} tone={overdueCents > 0 ? "critical" : undefined} />
            <StatCard icon="clock" label="Booked, not billed" value={fmtUsd2(d.bookedNotBilled.cents)}
              sub={bookedTop ? `${d.bookedNotBilled.rows.length === 1 ? bookedTop.businessName || "One client" : `${d.bookedNotBilled.rows.length} clients, most from ${bookedTop.businessName || "one"}`}` : "Nothing sold is waiting to be billed"} />
            <StatCard icon="tag" label="Running costs" value={fmtUsd2(usdToCents(d.costs.spentUsd))}
              sub={d.costs.limitUsd > 0 ? `of the ${fmtUsd(usdToCents(d.costs.limitUsd))} monthly cap${d.costs.level === "capped" ? ", reached" : d.costs.level === "warn" ? ", close" : ""}` : "No monthly cap set"}
              tone={d.costs.level === "capped" ? "critical" : d.costs.level === "warn" ? "warning" : undefined} />
          </section>
        )}

        <div className="ds-cols c2 mnx-cols">
          <div className="ds-col">
            {!fresh && (
            <Card icon="trending" title="Cash collected by month" note="Last 6 months">
              <MonthsChart d={d} />
              <p className="mnx-foot">
                {d.mrr.subscriptions} live subscription{d.mrr.subscriptions === 1 ? "" : "s"} · {fmtUsd(d.mrr.churnedLast30Cents)} lost to cancellations in 30 days · churn {d.mrr.churnRatePct === null ? "none yet" : `${d.mrr.churnRatePct}%`}
              </p>
            </Card>
            )}

            {!fresh && (
            <Card icon="gauge" title="Profit per project" note="Paid in, less your time at your cost rate" flush>
              {d.profit.length === 0 ? (
                <Empty icon="briefcase" title="No sold projects yet">Each project shows here once a proposal for it is signed: what it paid, the hours logged on it and what is left over.</Empty>
              ) : (
                <div className="mnx-scroll">
                  <table className="ds-table mnx-table mnx-profit">
                    <thead><tr><th>Project</th><th className="num">Paid</th><th className="num">Time</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Per hour</th></tr></thead>
                    <tbody>
                      {d.profit.map((p) => {
                        const idle = p.paidCents === 0 && p.minutes === 0;
                        return (
                          <tr key={p.projectId}>
                            <td>
                              <Link className="mnx-proj" to={`/projects/${p.projectId}`}>
                                <span className={`ds-tile ${idle ? "neutral" : p.marginPaidCents < 0 ? "critical" : "positive"}`}><Icon name="briefcase" size={14} /></span>
                                <span className="mnx-cell-2"><b>{p.name}</b><small>{p.businessName}{p.soldCents > 0 ? ` · sold ${fmtUsd(p.soldCents)}` : ""}</small></span>
                              </Link>
                            </td>
                            {idle ? (
                              <td colSpan={5} className="mnx-idle"><Chip tone="outline">Nothing paid or logged yet</Chip><small>Profit shows once time is logged on it or an invoice for it is paid.</small></td>
                            ) : <>
                              <td className="num">{fmtUsd2(p.paidCents)}</td>
                              <td className="num">{hoursLabel(p.minutes)}</td>
                              <td className="num">{fmtUsd2(p.costCents)}</td>
                              <td className={`num${p.marginPaidCents < 0 ? " mnx-neg" : " mnx-pos"}`}>{fmtUsd2(p.marginPaidCents)}</td>
                              <td className="num mnx-dim">{p.effectiveHourlyCents !== null ? fmtUsd(Math.round(p.effectiveHourlyCents / 100) * 100) : "–"}</td>
                            </>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            )}

            <Card icon="tag" title="Running costs" note={d.costs.limitUsd > 0 ? `${fmtUsd2(usdToCents(d.costs.spentUsd))} of ${fmtUsd(usdToCents(d.costs.limitUsd))} this month` : "No monthly cap set"}
              action={<Link to="/settings/usage" className="btn sm">Change the caps</Link>}>
              <div className="mnx-row-meter">
                <span className="mnx-line"><span>All services, this month</span><b className={d.costs.level === "ok" ? "mnx-ok-text" : ""}>{capShare(d.costs.spentUsd, d.costs.limitUsd)}</b></span>
                <Meter value={costPct(d.costs.spentUsd, d.costs.limitUsd)} max={100} tone={d.costs.level === "ok" ? "positive" : d.costs.level === "capped" ? "critical" : "warning"} label={`${costPct(d.costs.spentUsd, d.costs.limitUsd)}% of the monthly cap used`} />
              </div>
              {d.costs.services.length === 0 ? <p className="mnx-small">No paid services used this month.</p> : (
                <ul className="mnx-svc">
                  {d.costs.services.map((s) => {
                    const pct = s.capUsd ? costPct(s.spentUsd, s.capUsd) : null;
                    return (
                      <li key={s.service}>
                        <span className={`ds-tile ${s.level === "capped" ? "critical" : s.level === "warn" ? "warning" : "neutral"}`}><Icon name={s.service === "places" ? "pin" : s.service === "pagespeed" ? "gauge" : "globe"} size={14} /></span>
                        <span className="mnx-cell-2"><b>{serviceLabel(s.service)}</b><small>{s.capUsd !== null ? `${capShare(s.spentUsd, s.capUsd).replace("the cap", "its")} ${fmtUsd(usdToCents(s.capUsd))} cap` : "No cap of its own"}</small></span>
                        {pct !== null && <Meter value={pct} max={100} width={72} tone={s.level === "capped" ? "critical" : s.level === "warn" ? "warning" : "positive"} label={`${serviceLabel(s.service)}: ${pct}% of its cap`} />}
                        <b className="mnx-mono">{fmtUsd2(usdToCents(s.spentUsd))}</b>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          <div className="ds-col">
            {!fresh && (
            <Card icon="alert" title="Money owed" note={d.ar.openCents > 0 ? `${fmtUsd(d.ar.openCents)} open` : undefined}>
              {d.ar.openCents === 0 ? (
                <div className="mnx-clear">
                  <span className="ds-tile positive"><Icon name="check" size={16} /></span>
                  <span className="mnx-cell-2"><b>Nobody owes you anything</b><small>Every invoice is paid.</small></span>
                  <Link to="/billing" className="btn sm">Invoices</Link>
                </div>
              ) : (
                <ul className="mnx-meters">
                  {d.ar.buckets.filter((b) => b.cents > 0 || b.key === "current").map((b) => (
                    <li key={b.key}>
                      <span className="mnx-line"><span>{b.key === "current" ? "Not due yet" : b.label}{b.count > 0 ? ` (${b.count})` : ""}</span><b className="mnx-mono">{fmtUsd(b.cents)}</b></span>
                      <Meter value={b.cents} max={arMax} tone={lateTone(b.key)} label={`${fmtUsd(b.cents)} ${b.label}`} />
                    </li>
                  ))}
                </ul>
              )}
              {d.ar.oldest.length > 0 ? (
                <ul className="mnx-oldest" aria-label="Oldest unpaid">
                  {d.ar.oldest.slice(0, 3).map((o) => (
                    <li key={o.invoiceId}>
                      <Link to={`/billing?businessId=${encodeURIComponent(o.businessId)}`} className="mnx-ltv-row">
                        <Avatar name={o.businessName || "Client"} />
                        <span className="mnx-cell-2"><b>{o.businessName || "A client"}</b><small className="mnx-late-text">{daysLate(o.daysOverdue)}</small></span>
                        <b className="mnx-mono">{fmtUsd(o.amountCents)}</b>
                        <Icon name="chevron-right" size={14} className="ds-chev" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : d.ar.openCents > 0 ? <p className="mnx-small">Nobody is late. Everything open is still inside its terms.</p> : null}
            </Card>
            )}

            <Card icon="building" title="Capacity" note={<Link to="/settings/work" className="mnx-note-link">Change limits</Link>}>
              <ul className="mnx-meters">
                <li>
                  <span className="mnx-line"><span>Clients</span><b className="mnx-mono">{d.clients.count} of {d.clients.limit}</b></span>
                  <Meter value={d.clients.count} max={d.clients.limit} tone={clients.full ? "warning" : "signal"} label={clients.text} />
                </li>
                {week && (
                  <li>
                    <span className="mnx-line"><span>Hours booked this week</span><b className="mnx-mono">{week.booked} of {week.limit}</b></span>
                    <Meter value={week.pct} max={100} tone={week.over ? "warning" : "info"} label={`${week.booked} of ${week.limit} hours booked this week`} />
                  </li>
                )}
              </ul>
              <p className="mnx-small">
                {clients.full ? "You are at your client limit. " : `Room for ${d.clients.limit - d.clients.count} more client${d.clients.limit - d.clients.count === 1 ? "" : "s"}. `}
                {more !== null ? `At today's mix, about ${more} more gets you to ${fmtUsd(f.targetCents)} a month.` : f.targetCents > 0 && f.gapCents === 0 ? "You are at or past your goal." : ""}
                {cap && cap.carryOverMinutes > 0 ? ` ${hoursText(cap.carryOverMinutes)} h carried over from last week.` : ""}
              </p>
            </Card>

            {!fresh && (
            <Card icon="star" title="Lifetime value so far" note={d.ltv.length > 0 ? `${fmtUsd(d.ltv.reduce((n, c) => n + c.paidCents, 0))} in all` : "Cash received"}>
              {d.ltv.length === 0 ? <p className="mnx-small">No payments yet. The clients who have paid you the most show here.</p> : (
                <ul className="mnx-ltv">
                  {d.ltv.map((c) => (
                    <li key={c.businessId}>
                      <Link to={`/leads/${c.businessId}`} className="mnx-ltv-row">
                        <Avatar name={c.name || "Client"} />
                        <span className="mnx-cell-2"><b>{c.name || "A client"}</b><small>{c.mrrCents > 0 ? `${fmtUsd(c.mrrCents)} a month now` : "No monthly plan now"}</small></span>
                        <b className="mnx-mono">{fmtUsd(c.paidCents)}</b>
                        <Icon name="chevron-right" size={14} className="ds-chev" />
                      </Link>
                      {d.ltv.length > 1 && <Meter value={c.paidCents} max={d.ltv[0].paidCents} tone="positive" label={`${fmtUsd(c.paidCents)} paid`} />}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            )}

            {d.bookedNotBilled.rows.length > 0 && (
              <Card icon="clock" title="Sold, not billed yet" note={fmtUsd(d.bookedNotBilled.cents)} flush>
                {d.bookedNotBilled.rows.map((r) => (
                  <Link key={r.businessId} to={`/billing?businessId=${encodeURIComponent(r.businessId)}`} className="ds-link-row">
                    <Avatar name={r.businessName || "Client"} />
                    <span className="ds-link-text"><b>{r.businessName || "A client"}</b><small>Signed, not invoiced or paid yet</small></span>
                    <b className="mnx-mono">{fmtUsd(r.cents)}</b>
                    <Icon name="chevron-right" size={14} className="ds-chev" />
                  </Link>
                ))}
              </Card>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
