import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { batchesApi } from "../api";
import { useOwnerClock } from "../billingData";
import { checklistText, donePercent, dueText, isLate, progressLine, statusTone, statusWords, workThroughHref } from "../batchesView";
import { latestOnly } from "../clientView";
import { GradeChip } from "../components/client/GradePanel";
import Icon from "../components/Icon";
import { EmptyState, StatRow } from "../components/PageBits";
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
      <div className="pb-page">
        {failed && <p className="error" role="alert">Couldn’t load the batches{groups ? ". What you see may be out of date" : ""}. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {groups === null && !failed && <p className="muted">Loading…</p>}
        {groups !== null && groups.length === 0 && (
          <EmptyState icon="list" title="Nothing due in a batch right now"
            steps={[
              { title: "A client goes live", text: "Care, Local SEO and other monthly plans each come with recurring jobs.", to: "/clients" },
              { title: "Jobs are made on schedule", text: "Each SOP step with a cadence makes one task per client per week or month.", to: "/settings/sops" },
              { title: "Do them in one sitting", text: "The same job for every client lands here as one card, best grade first." },
            ]}>
            Batches group the same recurring job across all your clients, so you do it once in a row instead of client by client.
          </EmptyState>
        )}
        {groups !== null && groups.length > 0 && (() => {
          const tasks = groups.reduce((n, g) => n + g.tasks.length, 0);
          const left = groups.reduce((n, g) => n + g.open, 0);
          const late = groups.filter((g) => isLate(g, today)).length;
          const held = groups.reduce((n, g) => n + g.tasks.filter((t) => t.held).length, 0);
          return <StatRow stats={[
            { label: "Jobs due", value: groups.length, sub: `${tasks} client task${tasks === 1 ? "" : "s"} in all` },
            { label: "Left to do", value: left, sub: left ? `${Math.round(((tasks - left) / Math.max(1, tasks)) * 100)}% done` : "All done", tone: left ? "" : "positive" },
            { label: "Late", value: late, sub: late ? "Past the due day: start with these" : "Nothing past due", tone: late ? "warning" : "positive" },
            { label: "On hold", value: held, sub: held ? "Unpaid clients, skipped until paid" : "Everyone is paid up" },
          ]} />;
        })()}
        {groups !== null && groups.length > 0 && <ul className="cr-board">{groups.map((g) => <Card key={`${g.templateKey}:${g.period}`} g={g} today={today} />)}</ul>}
      </div>
    </div>
  );
}
