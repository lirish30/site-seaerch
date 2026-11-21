import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { clientsApi } from "../api";
import { useOwnerClock } from "../billingData";
import { latestOnly, moneyLabel, renewalLabel, sortClients, type ClientSort } from "../clientView";
import Icon from "../components/Icon";
import type { ClientRow } from "../../worker/clients/record";

const SORTS: [ClientSort, string][] = [["name", "Name"], ["mrr", "MRR"], ["access", "Access missing"]];
const isSort = (s: string | null): s is ClientSort => SORTS.some(([k]) => k === s);

/** Every client in one list: what they pay, how many sites, what access is still missing, what they owe and when the term ends. Sort by name, MRR or access missing; rehearsal clients stay out unless you ask. */
export default function Clients() {
  const [params, setParams] = useSearchParams();
  const wanted = params.get("sort");
  const sort: ClientSort = isSort(wanted) ? wanted : "name";
  const showTest = params.get("test") === "1";
  const { today } = useOwnerClock();
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Toggling "Show test clients" quickly must not let the slower, earlier answer replace the later one.
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await clientsApi.list(showTest);
      if (guard.isLatest(ticket)) { setRows(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [showTest, guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);

  const setParam = (key: string, value: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (value === null) n.delete(key); else n.set(key, value); return n; }, { replace: true });
  const sorted = sortClients(rows ?? [], sort);
  const mrr = (rows ?? []).reduce((n, r) => n + r.mrrCents, 0);
  const missing = (rows ?? []).reduce((n, r) => n + r.accessMissing, 0);
  const owed = (rows ?? []).reduce((n, r) => n + r.openInvoiceCents, 0);

  return (
    <div className="cl">
      <header className="page-header">
        <div>
          <h1>Clients</h1>
          <p>Everyone who is a client: sites, access, what they pay and when the term ends.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="cl-body">
        {failed && <p className="error" role="alert">Couldn’t load the clients. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {rows && (
          <div className="bl-sum cl-sum" role="group" aria-label="All clients">
            <div className="bl-stat"><span className="bl-stat-label">Clients</span><b className="bl-stat-num">{rows.length}</b></div>
            <div className="bl-stat"><span className="bl-stat-label">Monthly recurring</span><b className="bl-stat-num">{moneyLabel(mrr)}</b></div>
            <div className={`bl-stat${missing > 0 ? " warn" : ""}`}><span className="bl-stat-label">Access missing</span><b className="bl-stat-num">{missing}</b></div>
            <div className={`bl-stat${owed > 0 ? " warn" : ""}`}><span className="bl-stat-label">Open invoices</span><b className="bl-stat-num">{moneyLabel(owed)}</b></div>
          </div>
        )}

        <div className="cl-tools">
          <div className="seg-pills" role="group" aria-label="Sort clients by">
            {SORTS.map(([key, label]) => <button key={key} type="button" aria-pressed={sort === key} onClick={() => setParam("sort", key === "name" ? null : key)}>{label}</button>)}
          </div>
          <label className="cl-toggle">
            <input type="checkbox" className="cb" checked={showTest} aria-label="Show test clients" onChange={(e) => setParam("test", e.target.checked ? "1" : null)} />
            <span>Show test clients</span>
          </label>
        </div>

        {rows === null && !failed && <p className="muted">Loading…</p>}
        {rows !== null && rows.length === 0 && <p className="muted">No clients yet. A lead becomes a client when you win it or start a project for it.</p>}
        {sorted.length > 0 && (
          <table className="cl-table">
            <caption className="sr-only">Clients, sorted by {SORTS.find(([k]) => k === sort)?.[1].toLowerCase()}</caption>
            <thead>
              <tr>
                <th scope="col">Client</th><th scope="col">Care</th><th scope="col" className="num">Health</th><th scope="col" className="num">MRR</th><th scope="col" className="num">Sites</th>
                <th scope="col" className="num">Access missing</th><th scope="col" className="num">Open invoices</th><th scope="col">Renewal</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <th scope="row" className="cl-name" data-label="Client">
                    <Link to={`/clients/${encodeURIComponent(r.id)}`}>{r.name}</Link>
                    {r.test && <span className="badge2 info"><i className="dot" />Test</span>}
                    {r.held && <span className="badge2 warning"><i className="dot" />On hold</span>}
                  </th>
                  <td data-label="Care">{r.careLabel ?? <span className="muted">None</span>}</td>
                  <td className="num" data-label="Health">{r.healthScore === null ? <span className="muted">–<span className="sr-only">No health score</span></span> : r.healthScore}</td>
                  <td className="num" data-label="MRR">{moneyLabel(r.mrrCents, { monthly: true })}</td>
                  <td className="num" data-label="Sites">{r.siteCount}</td>
                  <td className="num" data-label="Access missing">{r.accessMissing > 0 ? <span className="badge2 warning"><i className="dot" />{r.accessMissing} missing</span> : <span className="muted">None</span>}</td>
                  <td className="num" data-label="Open invoices">{r.openInvoiceCents > 0 ? <span className="warn">{moneyLabel(r.openInvoiceCents)}</span> : <span className="muted">None</span>}</td>
                  <td data-label="Renewal">{renewalLabel(r.nextRenewalOn, today)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
