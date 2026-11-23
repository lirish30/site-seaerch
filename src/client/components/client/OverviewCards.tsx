import { Link } from "react-router-dom";
import { projectStatusLabel } from "../../clientView";
import { projectIsLive } from "../../../worker/db/projects";
import type { ClientRecord } from "../../../worker/clients/record";
import { Card, Chip, Empty, Meter, type Tone } from "../ds";
import Icon from "../Icon";
import { setupSteps, type SetupStep } from "./clientScreen";

const PROJECT_TONE: Record<string, Tone> = { neutral: "outline", good: "positive", warn: "warning", muted: "neutral" };

/** One setup line: a tinted tile (green when done), the step and one line of what it means. A line still to do is the button that opens where it is done. */
function SetupRow({ step, onTab }: { step: SetupStep; onTab: (tab: SetupStep["tab"]) => void }) {
  const body = (
    <>
      <span className={`ds-tile ${step.done ? "positive" : "warning"}`}><Icon name={step.done ? "check" : step.icon} size={15} /></span>
      <span className="clx-setup-text"><b>{step.title}</b><small>{step.sub}</small></span>
      {!step.done && <span className="clx-setup-go">{step.action}<Icon name="chevron-right" size={14} /></span>}
    </>
  );
  if (step.done) return <li className="clx-setup-row done">{body}</li>;
  return (
    <li>
      {step.to
        ? <Link to={step.to} className="clx-setup-row">{body}</Link>
        : <button type="button" className="clx-setup-row" onClick={() => onTab(step.tab)}>{body}</button>}
    </li>
  );
}

/**
 * The setup checklist on the Overview: what a new client still needs before the work runs by itself (a contact, the site details, the access, the uptime watch, the onboarding steps).
 * Everything comes from the record already loaded. It hides once every line is done.
 */
export function SetupCard({ client, onTab }: { client: ClientRecord; onTab: (tab: SetupStep["tab"]) => void }) {
  const steps = setupSteps(client);
  const done = steps.filter((s) => s.done).length;
  if (steps.length === 0 || done === steps.length) return null;
  return (
    <Card icon="list" title="Getting set up" note={`${done} of ${steps.length} done`} className="clx-setup" flush>
      <div className="clx-setup-meter">
        <Meter value={done} max={steps.length} tone={done === 0 ? "warning" : "signal"} label={`Setup: ${done} of ${steps.length} done`} />
      </div>
      <ul className="clx-setup-list">{steps.map((s) => <SetupRow key={s.key} step={s} onTab={onTab} />)}</ul>
    </Card>
  );
}

/** The client's projects with how far along each is: live ones first, then the finished ones. Each row opens the project. */
export function ProjectsCard({ client }: { client: ClientRecord }) {
  const shown = [...client.projects]
    .filter((p) => p.status !== "cancelled")
    .sort((a, b) => Number(projectIsLive(b)) - Number(projectIsLive(a)) || (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const open = shown.filter((p) => projectIsLive(p)).reduce((n, p) => n + p.openTasks, 0);
  return (
    <Card icon="briefcase" title="Projects" note={shown.length ? `${open} open ${open === 1 ? "task" : "tasks"}` : undefined} flush className="clx-projects">
      {shown.length === 0 && <Empty icon="briefcase" title="No projects yet">A project starts when a proposal is signed. Its steps and progress show here.</Empty>}
      {shown.map((p) => {
        const total = p.doneTasks + p.openTasks;
        const state = projectStatusLabel(p);
        const finished = p.status === "done" && total > 0 && p.openTasks === 0;
        return (
          <Link key={p.id} to={`/projects/${encodeURIComponent(p.id)}`} className="clx-proj">
            <span className={`ds-tile ${finished ? "positive" : p.status === "paused" ? "warning" : "signal"}`}><Icon name={finished ? "check" : "briefcase"} size={15} /></span>
            <span className="clx-proj-text">
              <b>{p.name}</b>
              <span className="clx-proj-meter">
                <Meter value={p.doneTasks} max={Math.max(total, 1)} tone={finished ? "positive" : "signal"} label={`${p.name}: ${p.doneTasks} of ${total} steps done`} />
                <small>{total === 0 ? "No steps yet" : `${p.doneTasks} of ${total} steps done`}</small>
              </span>
            </span>
            {p.test && <Chip tone="info">Test</Chip>}
            <Chip tone={PROJECT_TONE[state.tone]} dot>{state.label}</Chip>
            <Icon name="chevron-right" size={14} className="ds-chev" />
          </Link>
        );
      })}
    </Card>
  );
}
