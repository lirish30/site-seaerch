import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, clientsApi } from "../api";
import { useOwnerClock } from "../billingData";
import { bandLabel, bandOfScore } from "../careView";
import { filterByGrade, GRADE_FILTERS, isGradeFilter, latestOnly, moneyLabel, sortClients, type ClientSort, type GradeFilter } from "../clientView";
import { filterByPlan, filterByView, healthTone, isListView, isPlanFilter, listSummary, nextThing, PLAN_LABEL, planOf, planOptions, planTone, VIEW_TITLE, type PlanFilter } from "../components/client/clientScreen";
import { GradeChip } from "../components/client/GradePanel";
import { Avatar, Chip, Empty, Meter, Note, PageHeader, Seg, Stat, Stats } from "../components/ds";
import Icon from "../components/Icon";
import type { ClientRow } from "../../worker/clients/record";
import type { MoneyDashboard } from "../../worker/money/dashboard";

const SORTS: [ClientSort, string][] = [["name", "Name"], ["mrr", "MRR"], ["access", "Access missing"]];
const isSort = (s: string | null): s is ClientSort => SORTS.some(([k]) => k === s);

/** The goal and room lines on the stat cards come from the Money page's figures; that read is optional and the list never waits for it. */
type Extras = Pick<MoneyDashboard, "freedom" | "clients">;

/** Every client in one table (Figma 63:4704): plan, what they pay, health, grade and the one next thing. Filter by plan, grade or the sidebar's views; sort by name, MRR or access missing; rehearsal clients stay out unless you ask. */
export default function Clients() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const wanted = params.get("sort");
  const sort: ClientSort = isSort(wanted) ? wanted : "name";
  const showTest = params.get("test") === "1";
  const wantedGrade = params.get("grade");
  const gradeFilter: GradeFilter = isGradeFilter(wantedGrade) ? wantedGrade : "all";
  const wantedPlan = params.get("plan");
  const plan: PlanFilter = isPlanFilter(wantedPlan) ? wantedPlan : "all";
  const wantedView = params.get("view");
  const view = isListView(wantedView) ? wantedView : null;
  const { today } = useOwnerClock();
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [extras, setExtras] = useState<Extras | null>(null);

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
  useEffect(() => { api.get<MoneyDashboard>("/money").then((d) => { if (d?.freedom && d?.clients) setExtras({ freedom: d.freedom, clients: d.clients }); }).catch(() => {}); }, []);

  const setParam = (key: string, value: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (value === null) n.delete(key); else n.set(key, value); return n; }, { replace: true });
  const all = rows ?? [];
  const shown = filterByPlan(filterByView(filterByGrade(sortClients(all, sort), gradeFilter), view), plan);
  const sum = listSummary(all);
  const atRisk = all.filter((r) => r.healthScore !== null && r.healthScore < 60).length;
  const owing = all.filter((r) => r.openInvoiceCents > 0 || r.held).length;
  const access = all.filter((r) => r.accessMissing > 0 && !(r.openInvoiceCents > 0 || r.held)).length;
  const attention = owing + access;
  const gap = extras && extras.freedom.targetCents > 0 ? extras.freedom.targetCents - sum.mrrCents : null;
  const heading = view ? VIEW_TITLE[view] : gradeFilter === "all" ? "Clients" : gradeFilter === "none" ? "Clients with no grade" : `${gradeFilter} clients`;

  return (
    <div className="ds-page clx">
      <PageHeader
        title={heading}
        sub={rows ? sum.line : "Everyone who is a client: what they pay, how healthy they are, and what is next."}
        actions={<Link to="/leads" className="btn primary"><Icon name="plus" size={16} />Add a client from a lead</Link>}
      />
      <div className="ds-body">
        {failed && <p className="error" role="alert">Couldn’t load the clients. <button type="button" className="btn sm" onClick={() => void load()}>Try again</button></p>}
        {rows && rows.length > 0 && (
          <Stats label="All clients">
            <Stat icon="trending" label="MRR" value={moneyLabel(sum.mrrCents)}
              sub={gap === null ? "What every live plan bills each month" : gap > 0 ? `${moneyLabel(gap)} to the ${moneyLabel(extras!.freedom.targetCents)} goal` : `Past the ${moneyLabel(extras!.freedom.targetCents)} goal`}
              tone={gap !== null && gap <= 0 ? "positive" : undefined} />
            <Stat icon="building" label="Clients" value={all.length}
              sub={extras && extras.clients.limit > 0 ? (extras.clients.limit > extras.clients.count ? `Room for ${extras.clients.limit - extras.clients.count} more at ${extras.clients.limit}` : `At your limit of ${extras.clients.limit}`) : `${all.reduce((n, r) => n + r.siteCount, 0)} sites between them`} />
            <Stat icon="gauge" label="Average health" value={sum.avgHealth ?? "–"}
              sub={sum.avgHealth === null ? "No client has a score yet" : atRisk > 0 ? `${atRisk} at risk (under 60)` : "Nobody is at risk"} tone={atRisk > 0 ? "critical" : sum.avgHealth !== null ? "positive" : undefined} />
            <Stat icon="alert" label="Needs attention" value={attention}
              sub={attention === 0 ? "Nothing owed, no access missing" : [owing > 0 && `${owing} ${owing === 1 ? "owes" : "owe"} money`, access > 0 && `${access} missing access`].filter(Boolean).join(" · ")}
              tone={owing > 0 ? "critical" : access > 0 ? "warning" : "positive"} />
          </Stats>
        )}

        {rows && rows.length > 0 && (
          <div className="ds-toolbar">
            <Seg label="Show clients on plan" options={planOptions(all)} value={plan} onChange={(k) => setParam("plan", k === "all" ? null : k)} />
            {view && <Chip tone="signal">{VIEW_TITLE[view]} <button type="button" className="clx-chip-x" aria-label={`Stop showing only ${VIEW_TITLE[view].toLowerCase()}`} onClick={() => setParam("view", null)}><Icon name="x" size={12} /></button></Chip>}
            <span className="ds-grow" />
            <label className="clx-toggle">
              <input type="checkbox" className="cb" checked={showTest} aria-label="Show test clients" onChange={(e) => setParam("test", e.target.checked ? "1" : null)} />
              <span>Show test clients</span>
            </label>
            <label className="clx-select"><span>Grade</span>
              <select aria-label="Show clients with grade" value={gradeFilter} onChange={(e) => setParam("grade", e.target.value === "all" ? null : e.target.value)}>
                {GRADE_FILTERS.map(([k, l]) => <option key={k} value={k}>{k === "all" ? "Any" : l}</option>)}
              </select>
            </label>
            <label className="clx-select"><span>Sort</span>
              <select aria-label="Sort clients by" value={sort} onChange={(e) => setParam("sort", e.target.value === "name" ? null : e.target.value)}>
                {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
        )}

        {rows === null && !failed && <p className="clx-muted">Loading…</p>}
        {rows !== null && rows.length === 0 && (
          <Empty icon="building" title="No clients yet" action={<Link to="/leads" className="btn primary">Open leads</Link>}>
            A lead becomes a client when you win it or start a project for it. Each client then shows here with its plan, health and what is next.
          </Empty>
        )}
        {rows !== null && rows.length > 0 && shown.length === 0 && (
          <Empty icon="filter" title="No clients match" action={<button type="button" className="btn" onClick={() => setParams(new URLSearchParams(showTest ? { test: "1" } : {}), { replace: true })}>Show all clients</button>}>
            Nobody fits these filters right now.
          </Empty>
        )}
        {shown.length > 0 && (
          <div className="ds-table-wrap">
            <table className="ds-table clx-table">
              <caption className="sr-only">Clients, sorted by {SORTS.find(([k]) => k === sort)?.[1].toLowerCase()}</caption>
              <thead>
                <tr>
                  <th scope="col">Client</th><th scope="col" className="clx-c-plan">Plan</th><th scope="col" className="num">MRR</th><th scope="col" className="clx-c-health">Health</th>
                  <th scope="col" className="clx-c-grade">Grade</th><th scope="col" className="clx-c-next">Next</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const href = `/clients/${encodeURIComponent(r.id)}`;
                  const p = planOf(r);
                  const next = nextThing(r, today);
                  return (
                    <tr key={r.id} data-href={href} onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button,input,select")) navigate(href); }}>
                      <th scope="row">
                        <div className="ds-who">
                          <Avatar name={r.name} />
                          <span>
                            <b><Link to={href} className="ds-row-link">{r.name}</Link></b>
                            <small>{r.siteCount === 0 ? "No site yet" : `${r.siteCount} ${r.siteCount === 1 ? "site" : "sites"}`}{r.careLabel ? ` · ${r.careLabel}` : ""}</small>
                          </span>
                          {r.test && <Chip tone="info">Test</Chip>}
                          {r.held && <Chip tone="warning" dot>On hold</Chip>}
                        </div>
                      </th>
                      <td className="clx-c-plan">{p === "none" ? <span className="clx-muted">No plan</span> : <Chip tone={planTone(p)}>{PLAN_LABEL[p]}</Chip>}</td>
                      <td className="num">{r.mrrCents > 0 ? moneyLabel(r.mrrCents) : <span className="clx-muted">–</span>}</td>
                      <td className="clx-c-health">
                        {r.healthScore === null
                          ? <span className="clx-muted">No score<span className="sr-only">: no Care plan and no watched site</span></span>
                          : <span className="clx-health"><Meter value={r.healthScore} max={100} tone={healthTone(r.healthScore)} width={64} label={`Health ${r.healthScore} of 100`} /><b>{r.healthScore}</b><span className="sr-only">, {bandLabel(bandOfScore(r.healthScore)).toLowerCase()}</span></span>}
                      </td>
                      <td className="clx-c-grade"><GradeChip grade={r.grade} compact /></td>
                      <td className="clx-c-next">{next ? <span className={`clx-next ${next.tone}`}>{next.text}</span> : <span className="clx-muted">Nothing due</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {shown.length > 0 && (
          <Note>Health starts at 100 and drops for a site that is down, an overdue invoice, billing on hold or missing access. The grade is yours to set; the app only suggests one (shown in outline).</Note>
        )}
      </div>
    </div>
  );
}
