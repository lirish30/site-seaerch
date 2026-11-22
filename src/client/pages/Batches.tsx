import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { batchesApi } from "../api";
import { useOwnerClock } from "../billingData";
import { checklistText, donePercent, dueText, isLate, isOpenTask, minutesText, progressLine, statusTone, statusWords, workThroughHref } from "../batchesView";
import { latestOnly } from "../clientView";
import { GradeChip } from "../components/client/GradePanel";
import { Avatar, Banner, Chip, Empty, Meter, Note, PageHeader } from "../components/ds";
import Icon from "../components/Icon";
import type { BatchGroup } from "../../worker/batches/groups";

const CADENCE: Record<BatchGroup["cadence"], string> = { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", annual: "Yearly" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One recurring job for one period: due date, progress, each client's task as a row (grade A first), and "Work through" to open the first one still to do. The work itself happens on each task. */
function BatchCard({ g, today }: { g: BatchGroup; today: string }) {
  const href = workThroughHref(g);
  const late = isLate(g, today);
  const total = g.open + g.done;
  return (
    <section className="ds-card wkx-batch" aria-label={`${g.name}: ${g.label}`}>
      <header className="ds-card-head wkx-batch-head">
        <span className="ds-tile signal"><Icon name="refresh" size={16} /></span>
        <span className="wkx-batch-title"><h2>{g.name}</h2><small>{CADENCE[g.cadence]} · {g.label}</small></span>
        {late ? <Chip tone="critical" dot>Late · was due {dueText(g.dueOn)}</Chip> : <Chip tone={g.open === 0 ? "positive" : "neutral"} dot={g.open === 0}>{g.open === 0 ? "All done" : `Due ${dueText(g.dueOn)}`}</Chip>}
      </header>
      <div className="wkx-batch-progress">
        <Meter value={g.done} max={Math.max(1, total)} tone={g.open === 0 ? "positive" : "signal"} label={progressLine(g)} />
        <span><b>{donePercent(g)}%</b> {progressLine(g)}</span>
      </div>
      <table className="ds-table wkx-batch-table">
        <thead><tr><th scope="col">Client</th><th scope="col">Status</th><th scope="col">Checklist</th><th scope="col" className="num">Estimate</th></tr></thead>
        <tbody>
          {g.tasks.map((t) => {
            const steps = checklistText(t);
            const tone = statusTone(t.status) || "neutral";
            return (
              <tr key={t.taskId} className={isOpenTask(t) ? "" : "wkx-batch-closed"}>
                <th scope="row">
                  <span className="ds-who">
                    <Avatar name={t.client} />
                    <span className="wkx-batch-who"><Link to={`/tasks/${encodeURIComponent(t.taskId)}`}>{t.client}</Link>
                      {t.grade && <GradeChip grade={{ grade: t.grade, suggested: t.grade }} compact />}
                      {t.held && <Chip tone="warning" dot>On hold · unpaid</Chip>}</span>
                  </span>
                </th>
                <td><Chip tone={tone} dot>{statusWords(t.status)}</Chip></td>
                <td>{steps ?? <span className="wkx-dim">No checklist</span>}</td>
                <td className="num">{t.estMinutes > 0 ? minutesText(t.estMinutes) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <footer className="wkx-batch-foot">
        {href ? <Link className="btn primary" to={href}><Icon name="arrow-right" size={16} />Work through</Link>
          : g.open > 0 ? <span className="wkx-dim">What is left belongs to clients on hold. It starts once they pay.</span>
          : <span className="wkx-dim"><Icon name="check" size={14} /> Every client is done for {g.label}.</span>}
        {href && <span className="wkx-dim">Opens the first client still to do. Mark it done and come back for the next.</span>}
      </footer>
    </section>
  );
}

/** Batches: this week's and this month's recurring jobs across every live client, so one job is done for all of them in a row. Held clients show with a flag; test clients are left out. */
export default function Batches() {
  const { today } = useOwnerClock();
  const [groups, setGroups] = useState<BatchGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [guard] = useState(latestOnly);
  const load = useCallback(async () => {
    const ticket = guard.next();
    try {
      const next = await batchesApi.list();
      if (guard.isLatest(ticket)) { setGroups(next); setFailed(false); }
    } catch { if (guard.isLatest(ticket)) setFailed(true); }
  }, [guard]);
  useEffect(() => { void load(); return () => guard.cancel(); }, [load, guard]);

  const tasks = (groups ?? []).reduce((n, g) => n + g.tasks.length, 0);
  const left = (groups ?? []).reduce((n, g) => n + g.open, 0);
  const minutes = (groups ?? []).reduce((n, g) => n + g.estMinutes, 0);
  const lateGroups = (groups ?? []).filter((g) => isLate(g, today));
  const firstLate = lateGroups.map((g) => workThroughHref(g)).find((h) => h) ?? null;
  const sub = groups === null ? (failed ? "" : "Loading…") : groups.length === 0 ? "The same recurring job for every client, done in one sitting"
    : [`${plural(groups.length, "job")} due`, left ? `${plural(left, "client task")} left, about ${minutesText(minutes)}` : `all ${plural(tasks, "client task")} done`].join(" · ");

  return (
    <div className="ds-page wkx">
      <PageHeader title="Batches" sub={sub}
        actions={<button type="button" className="ds-icon-btn wkx-icon-32" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>} />
      <div className="ds-body">
        {failed && <p className="error" role="alert">Couldn’t load the batches{groups ? ". What you see may be out of date" : ""}. <button type="button" className="btn sm" onClick={() => void load()}>Try again</button></p>}
        {lateGroups.length > 0 && (
          <Banner tone="warning" title={lateGroups.length === 1 ? `${lateGroups[0].name} is past its due day` : `${lateGroups.length} batches are past their due day`}
            action={firstLate ? <Link to={firstLate} className="btn primary sm">Start with the late one</Link> : undefined}>
            Clients expect these on schedule. Start here, then do the rest.
          </Banner>
        )}
        {groups !== null && groups.length === 0 && (
          <div className="ds-card">
            <Empty icon="list" title="Nothing due in a batch right now" action={<Link to="/settings/sops" className="btn">Open the SOPs</Link>}>
              When a client is on Care, Local SEO or another monthly plan, each SOP step with a weekly or monthly cadence makes one task per client. The same job for every client lands here as one card, best grade first.
            </Empty>
          </div>
        )}
        {groups !== null && groups.length > 0 && (
          <>
            <div className="wkx-batches">{groups.map((g) => <BatchCard key={`${g.templateKey}:${g.period}`} g={g} today={today} />)}</div>
            <Note>Clients with the best grade come first. A client on hold (an unpaid invoice) is skipped by Work through until they pay. Test clients are left out.</Note>
          </>
        )}
      </div>
    </div>
  );
}
