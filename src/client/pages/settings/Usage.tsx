import { useEffect, useState } from "react";
import { api } from "../../api";
import SettingsPage, { Card } from "../../components/SettingsPage";
import { parseSpendLimit } from "../../spend";
import { useSettingsDoc } from "../../settingsData";
import { chartBars, monthName, spendPercent, usageRows, usageTotal, usd } from "../../settingsView";

interface History { months: { month: string; est_cost_usd: number }[] }

/** Settings > Usage & limits: the monthly spend limit, this month's spend by service, and the last six months. */
export default function Usage() {
  const doc = useSettingsDoc();
  const [history, setHistory] = useState<History | null>(null);
  const [historyErr, setHistoryErr] = useState(false);
  const [running, setRunning] = useState(0);
  useEffect(() => {
    let live = true;
    api.get<History>("/settings/usage-history").then((h) => { if (live) setHistory(h); }).catch(() => { if (live) setHistoryErr(true); });
    // Searches still running are counted at their estimated cost when the limit is checked, so the bar shows them too.
    api.get<{ inFlightUsd: number }>("/searches/estimate?maxResults=1").then((e) => { if (live) setRunning(e.inFlightUsd ?? 0); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const rows = usageRows(doc.usage);
  const total = usageTotal(rows);
  const raw = doc.value("monthly_spend_limit_usd");
  const limit = parseSpendLimit(raw);
  // While the field holds something unusable the bar keeps using the saved limit.
  const shownLimit = limit ?? parseSpendLimit(String(doc.saved?.monthly_spend_limit_usd ?? "")) ?? 0;
  const pct = spendPercent(total.cost, shownLimit);
  const usedW = shownLimit > 0 ? Math.min(100, (total.cost / shownLimit) * 100) : total.cost > 0 ? 100 : 0;
  const runW = shownLimit > 0 ? Math.min(100 - usedW, (running / shownLimit) * 100) : 0;
  const month = new Date().toISOString().slice(0, 7);
  const bars = history ? chartBars(history.months) : [];
  const limitErr = doc.errors.monthly_spend_limit_usd ?? (raw.trim() !== "" && limit === null ? "Enter a limit between 0 and 10000." : "");

  return (
    <SettingsPage title="Usage & limits" width={720} doc={doc} sub="What searches, audits and drafts cost, and the ceiling you set.">
      <div className="bx us">
        <Card title="Monthly spend limit" sub="Searches and radars that would go over it are blocked until next month.">
          <div className="us-limit">
            <div className="bx-f us-in">
              <label className="fl" htmlFor="us-limit">Limit (USD)</label>
              <input id="us-limit" className="in" inputMode="decimal" autoComplete="off" value={raw} aria-invalid={!!limitErr}
                aria-describedby={limitErr ? "us-limit-err" : undefined} onChange={(e) => doc.set("monthly_spend_limit_usd", e.target.value)} />
            </div>
            <div className="us-meter">
              <div className="us-line">
                <span>{usd(total.cost)} used{running > 0 && ` · ${usd(running)} running`}</span>
                <b aria-label={`${pct} percent of the limit`}>{pct}%</b>
              </div>
              <div className="us-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-label="Spend this month against the limit">
                <i className="used" style={{ width: `${usedW}%` }} />
                <i className="run" style={{ width: `${runW}%` }} />
              </div>
            </div>
          </div>
          {limitErr && <p id="us-limit-err" className="bx-err" role="alert">{limitErr}</p>}
          {pct >= 100 && !limitErr && shownLimit >= 0 && <p className="bx-muted">You’re at your limit, so new searches and re-audits wait until next month or until you raise it.</p>}
        </Card>

        <Card title={`${monthName(month)} by service`}>
          <div className="us-table" role="table" aria-label={`${monthName(month)} usage by service`}>
            <div className="us-row head" role="row"><span role="columnheader">Service</span><span role="columnheader" className="r">Calls</span><span role="columnheader" className="r">Cost</span></div>
            {rows.map((r) => (
              <div key={r.service} className="us-row" role="row">
                <span role="cell">{r.label}</span><span role="cell" className="r">{r.calls.toLocaleString("en-US")}</span><span role="cell" className="r mono">{usd(r.cost)}</span>
              </div>
            ))}
            <div className="us-row total" role="row">
              <span role="cell">Total</span><span role="cell" className="r">{total.calls.toLocaleString("en-US")}</span><span role="cell" className="r mono">{usd(total.cost)}</span>
            </div>
          </div>
        </Card>

        <Card title="Last 6 months">
          {historyErr ? <p className="bx-err" role="alert">Couldn’t load the monthly totals.</p>
            : !history ? <p className="bx-muted">Loading…</p>
            : (
              <div className="us-chart" role="img" aria-label={`Estimated spend per month: ${bars.map((b) => `${b.label} ${b.value}`).join(", ")}`}>
                {bars.map((b, i) => (
                  <div key={b.month} className={`us-col${i === bars.length - 1 ? " now" : ""}`}>
                    <span className="v">{b.value}</span><i style={{ height: b.height }} /><span className="m">{b.label}</span>
                  </div>
                ))}
              </div>
            )}
        </Card>
      </div>
    </SettingsPage>
  );
}
