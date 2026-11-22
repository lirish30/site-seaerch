import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { batchesApi } from "../api";
import { useOwnerClock } from "../billingData";
import { checklistText, donePercent, dueText, isLate, progressLine, statusTone, statusWords, workThroughHref } from "../batchesView";
import { latestOnly } from "../clientView";
import { GradeChip } from "../components/client/GradePanel";
import Icon from "../components/Icon";
import type { BatchGroup } from "../../worker/batches/groups";

/** One recurring job for one period: the progress, then each client's task (grade A first), and the button that opens the first one still to do. Read only: the work itself happens on each task. */
function Card({ g, today }: { g: BatchGroup; today: string }) {
  const href = workThroughHref(g);
  const late = isLate(g, today);
  return (
    <li className="cl-card cr-card bt-card">
      <div className="cr-card-head">
        <h2 className="cr-name">{g.name}: {g.label}</h2>
        <span className="cr-chips">
          <span className="badge2"><i className="dot" aria-hidden="true" />Due {dueText(g.dueOn)}</span>
          {late && <span className="badge2 critical"><i className="dot" aria-hidden="true" />Late</span>}
        </span>
      </div>
      <div className="rp-bar-wrap">
        <div className="rp-meter" role="img" aria-label={progressLine(g)}><i style={{ width: `${donePercent(g)}%` }} /></div>
        <p className="rp-bar-label">{progressLine(g)}</p>
      </div>
      <ul className="bt-tasks">
        {g.tasks.map((t) => {
          const steps = checklistText(t);
          const tone = statusTone(t.status);
          return (
            <li key={t.taskId} className={`bt-task${t.status === "done" || t.status === "skipped" ? " is-closed" : ""}`}>
              <span className="bt-client">
                <Link to={`/tasks/${encodeURIComponent(t.taskId)}`}>{t.client}</Link>
                {t.grade && <GradeChip grade={{ grade: t.grade, suggested: t.grade }} compact />}
                {t.held && <span className="badge2 warning"><i className="dot" aria-hidden="true" />On hold</span>}
              </span>
              <span className="bt-meta small">
                <span className={`badge2${tone ? ` ${tone}` : ""}`}><i className="dot" aria-hidden="true" />{statusWords(t.status)}</span>
                {steps && <span>{steps}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="rp-actions">
        {href ? <Link className="btn" to={href}>Work through</Link> : g.open > 0 && <p className="muted small">What is left belongs to clients on hold.</p>}
      </div>
    </li>
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

  return (
    <div className="cl cr">
      <header className="page-header">
        <div>
          <h1>Batches</h1>
          <p>The recurring jobs due now, one card each, so you can do the same job for every client in a row. Clients with the best grade come first.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
        </div>
      </header>
      <div className="cl-body">
        {failed && <p className="error" role="alert">Couldn’t load the batches{groups ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {groups === null && !failed && <p className="muted">Loading…</p>}
        {groups !== null && groups.length === 0 && <p className="muted">Nothing is due in a batch right now. A job shows here once a recurring task has been made for a live client.</p>}
        {groups !== null && groups.length > 0 && <ul className="cr-board">{groups.map((g) => <Card key={`${g.templateKey}:${g.period}`} g={g} today={today} />)}</ul>}
      </div>
    </div>
  );
}
