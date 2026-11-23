import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, clientsApi } from "../api";
import { Avatar, Card, Chip, Empty, LinkRow, Meter, Note, PageHeader, Seg } from "../components/ds";
import Icon from "../components/Icon";
import { bucketCounts, groupByClient, KIND_ORDER, kindChip, listProgress, projectBucket, sinceLabel, statusChip, visibleProjects, type Bucket, type KindKey } from "../projectView";
import { projectIsLive } from "../../worker/db/projects";
import { PROJECTS_CHANGED, type MyTasks, type ProjectRow } from "../workData";
import type { Capacity } from "../../worker/capacity/compute";

const VIEWS: Record<Bucket, { title: string; empty: string; emptyText: string }> = {
  active: { title: "Projects", empty: "No active projects", emptyText: "A project starts by itself when a client pays the deposit. Its steps come from the SOP for the package they bought." },
  waiting: { title: "Waiting on client", empty: "Nobody is holding you up", emptyText: "A project lands here when the client goes quiet on onboarding. Claude steps wait until they write back." },
  paused: { title: "Paused projects", empty: "Nothing is paused", emptyText: "Pause a project from its page (the More menu) and it waits here until you resume it." },
  done: { title: "Done projects", empty: "Nothing is finished yet", emptyText: "Finished and cancelled projects land here, so you can look back at the time and profit." },
};
const isBucket = (s: string | null): s is Bucket => s === "active" || s === "waiting" || s === "paused" || s === "done";
type KindFilter = "all" | KindKey;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every project in a table grouped by client: what kind it is, how far along, its state and when it last moved. The view (Active, Waiting on client, Paused, Done) comes from the sidebar. */
export default function Projects() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const wanted = params.get("view");
  const lead = params.get("businessId");
  const view: Bucket = isBucket(wanted) ? wanted : "active";
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [next, setNext] = useState<Map<string, string>>(new Map());
  const [mineCount, setMineCount] = useState(0);
  const [plans, setPlans] = useState<Map<string, string>>(new Map());
  const [booked, setBooked] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<KindFilter>("all");

  const load = useCallback(() => {
    setFailed(false);
    api.get<{ projects: ProjectRow[] }>("/projects").then((r) => setRows(r.projects)).catch(() => { setRows(null); setFailed(true); });
    // The first step waiting on Logan in each project; a project with none is simply without the line.
    api.get<MyTasks>("/me/tasks").then((r) => { setNext(new Map(r.projects.filter((p) => p.tasks.length).map((p) => [p.projectId, p.tasks[0].title]))); setMineCount(r.projects.reduce((n, p) => n + p.tasks.length, 0)); }).catch(() => setNext(new Map()));
    // The client's plan for each group row (Care $129/mo), and the hours booked this week for the summary line.
    clientsApi.list(true).then((cs) => setPlans(new Map(cs.filter((c) => c.careLabel).map((c) => [c.id, c.careLabel as string])))).catch(() => setPlans(new Map()));
    api.get<{ capacity: Capacity | null }>("/today").then((r) => setBooked(r.capacity?.weeks[0]?.bookedMinutes ?? null)).catch(() => setBooked(null));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(PROJECTS_CHANGED, load);
    return () => window.removeEventListener(PROJECTS_CHANGED, load);
  }, [load]);
  useEffect(() => setKind("all"), [view, lead]);

  const inView = useMemo(() => visibleProjects(rows ?? [], { view, businessId: lead }), [rows, view, lead]);
  const kinds = useMemo(() => {
    const counts = new Map<KindKey, number>();
    for (const p of inView) { const k = kindChip(p).key; counts.set(k, (counts.get(k) ?? 0) + 1); }
    return KIND_ORDER.filter((k) => counts.has(k.key)).map((k) => ({ ...k, count: counts.get(k.key)! }));
  }, [inView]);
  const shown = kind === "all" ? inView : inView.filter((p) => kindChip(p).key === kind);
  const groups = groupByClient(shown);
  const now = new Date();

  const clientName = lead ? (rows ?? []).find((r) => r.businessId === lead)?.businessName : undefined;
  const v = lead ? { title: clientName ? `Projects for ${clientName}` : "This client's projects", empty: "This client has no projects", emptyText: "A project starts by itself when the client pays a deposit." } : VIEWS[view];
  const clients = new Set(inView.map((p) => p.businessId)).size;
  const summary = rows === null ? (failed ? "" : "Loading…") : [
    inView.length ? `${plural(inView.length, "project")} across ${plural(clients, "client")}` : "No projects in this list",
    booked !== null && !lead ? `${Math.round(booked / 6) / 10} hours booked this week` : null,
    !lead && mineCount ? `${plural(mineCount, "step")} waiting on you` : null,
  ].filter(Boolean).join(" · ");
  const counts = rows ? bucketCounts(rows) : null;

  return (
    <div className="ds-page wkx">
      <PageHeader title={v.title} sub={summary}
        actions={<>
          {lead && <Link to="/projects" className="btn">All projects</Link>}
          <Link to="/timesheet" className="btn"><Icon name="clock" size={16} />Timesheet</Link>
          <button type="button" className="ds-icon-btn wkx-icon-32" aria-label="Refresh" title="Refresh" onClick={load}><Icon name="refresh" size={16} /></button>
        </>} />
      <div className="ds-body wkx-list-body">
        {failed && <p className="error" role="alert">Couldn’t load the projects. <button type="button" className="btn sm" onClick={load}>Try again</button></p>}
        {rows !== null && inView.length > 0 && (
          <div className="ds-toolbar">
            <Seg label="Project type" value={kind} onChange={setKind} options={[{ key: "all" as KindFilter, label: "All", count: inView.length }, ...kinds]} />
            <span className="ds-grow" />
            {!lead && counts && view === "active" && counts.waiting > 0 && <Link to="/projects?view=waiting" className="wkx-quiet-link">{plural(counts.waiting, "project")} waiting on clients<Icon name="chevron-right" size={14} /></Link>}
          </div>
        )}
        {rows !== null && inView.length === 0 && (
          <div className="ds-card"><Empty icon={view === "done" ? "check" : view === "paused" ? "ban" : view === "waiting" ? "clock" : "briefcase"} title={v.empty}
            action={view === "active" && !lead ? <Link to="/pipeline" className="btn">Open the pipeline</Link> : <Link to="/projects" className="btn">See active projects</Link>}>{v.emptyText}</Empty></div>
        )}
        {groups.length > 0 && (
          <div className="ds-table-wrap">
            <table className="ds-table wkx-projects">
              <thead>
                <tr><th scope="col">Project</th><th scope="col">Type</th><th scope="col">Progress</th><th scope="col">Status</th><th scope="col">Last activity</th></tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.businessId} name={g.name} businessId={g.businessId} plan={plans.get(g.businessId) ?? null}>
                    {g.rows.map((p) => {
                      const k = kindChip(p);
                      const s = statusChip(p);
                      const prog = listProgress(p);
                      const mine = next.get(p.id);
                      const href = `/projects/${p.id}`;
                      return (
                        <tr key={p.id} data-href={href} onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) navigate(href); }}>
                          <th scope="row" className="wkx-proj-cell">
                            <span className="wkx-proj-line"><Link to={href} className="wkx-proj-name">{p.name}</Link>{p.test && <Chip tone="info">Test</Chip>}</span>
                            {projectIsLive(p) && mine && <small className="wkx-next"><Icon name="arrow-right" size={12} />Next for you: {mine}</small>}
                          </th>
                          <td><Chip tone={k.tone}>{k.label}</Chip></td>
                          <td><span className="wkx-prog"><Meter value={prog.done} max={prog.total} tone={prog.total && prog.done === prog.total ? "positive" : "signal"} width={70} label={`${prog.pct}% done`} /><span>{prog.done} of {prog.total} {prog.total === 1 ? "step" : "steps"}</span></span></td>
                          <td><Chip tone={s.tone} dot>{s.label}</Chip></td>
                          <td className="wkx-when">{sinceLabel(p.updatedAt, now)}</td>
                        </tr>
                      );
                    })}
                  </GroupRows>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {groups.length > 0 && <Note>Every project starts from the SOP for its package. Each step says who does it: you, Claude, or Claude drafts and you approve.</Note>}
        {rows !== null && view === "active" && !lead && inView.length <= 3 && <QuietList done={(rows ?? []).filter((r) => projectBucket(r) === "done")} now={now} />}
      </div>
    </div>
  );
}

function GroupRows({ name, businessId, plan, children }: { name: string; businessId: string; plan: string | null; children: ReactNode }) {
  return (
    <>
      <tr className="ds-group-row wkx-group">
        <td colSpan={5}>
          <span className="wkx-group-who">
            <Avatar name={name} />
            <Link to={`/clients/${businessId}`}>{name}</Link>
            {plan && <small>{plan}</small>}
          </span>
        </td>
      </tr>
      {children}
    </>
  );
}

/**
 * With only a few projects running, the list would float above a blank page. Under it go the projects that finished most recently (so they stay one click away)
 * and the three things that happen on every project, so someone new knows what the rows mean.
 */
function QuietList({ done, now }: { done: ProjectRow[]; now: Date }) {
  const recent = [...done].sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)).slice(0, 3);
  return (
    <div className="wkx-quiet-grid">
      <Card icon="check" title="Finished recently" note={done.length > 3 ? <Link to="/projects?view=done" className="wkx-quiet-link">All {done.length}<Icon name="chevron-right" size={14} /></Link> : undefined} flush>
        {recent.length === 0 ? <p className="wkx-pad wkx-quiet">Finished projects land here and under Done, with their time and profit.</p>
          : recent.map((p) => <LinkRow key={p.id} to={`/projects/${p.id}`} icon="check" title={p.name} sub={`${p.businessName} · finished ${sinceLabel(p.completedAt ?? p.updatedAt, now).replace(/^(Just|Yesterday)/, (w) => w.toLowerCase())}`} right={<Chip tone="positive" dot>Done</Chip>} />)}
      </Card>
      <Card icon="info" title="How a project runs">
        <ol className="wkx-how">
          <li><span className="ds-tile signal"><Icon name="card" size={16} /></span><span><b>It starts when the client pays</b><small>The deposit or first Care payment opens the project from its package’s SOP.</small></span></li>
          <li><span className="ds-tile info"><Icon name="list" size={16} /></span><span><b>Each step says who does it</b><small>You, Claude, or Claude drafts and you approve. Claude’s work comes to your approvals.</small></span></li>
          <li><span className="ds-tile positive"><Icon name="check" size={16} /></span><span><b>It closes when the last step is done</b><small>Then it moves to Done with its time and profit kept.</small></span></li>
        </ol>
      </Card>
    </div>
  );
}
