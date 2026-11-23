import { Card, Chip, Empty, LinkRow, type Tone as DsTone } from "../ds";
import Icon from "../Icon";
import { moneyLabel, projectStatusLabel, renewalLabel } from "../../clientView";
import { statusLabel as changeOrderStatus } from "../../changeOrderView";
import { projectIsLive } from "../../../worker/db/projects";
import type { Tone } from "../../projectView";
import { shortDate } from "../../billingView";
import type { ClientRecord } from "../../../worker/clients/record";

const TONE: Record<Tone, DsTone> = { neutral: "outline", good: "positive", warn: "warning", muted: "neutral" };
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Everything else that belongs to this client, as short lists that link out: projects, invoices, documents, change orders, open tasks and the next renewal. */
export default function LinkedPanel({ client, today }: { client: ClientRecord; today: string }) {
  const id = client.business.id;
  const live = client.projects.filter((p) => p.status === "active" || p.status === "paused" || (p.status === "done" && projectIsLive(p)));
  const openTasks = live.reduce((n, p) => n + p.openTasks, 0);
  const documents = client.documents;
  const orders = client.changeOrders;

  return (
    <div className="ds-col clx-linked">
      <Card icon="briefcase" title="Projects" note={`${openTasks} open ${openTasks === 1 ? "task" : "tasks"}`} flush>
        {client.projects.length === 0 && <Empty icon="briefcase" title="No projects yet">A project starts when a proposal is signed. Its tasks and steps show up here.</Empty>}
        {client.projects.map((p) => {
          const state = projectStatusLabel(p);
          return (
            <LinkRow key={p.id} to={`/projects/${encodeURIComponent(p.id)}`} icon="briefcase" title={p.name} sub={`${p.openTasks} open · ${p.doneTasks} done`}
              right={<span className="ds-row">{p.test && <Chip tone="info">Test</Chip>}<Chip tone={TONE[state.tone]} dot>{state.label}</Chip></span>} />
          );
        })}
      </Card>

      <Card icon="card" title="Invoices" flush className="clx-money">
        <LinkRow to={`/billing?businessId=${encodeURIComponent(id)}`} icon="card" title={client.invoices.openCents > 0 ? `${moneyLabel(client.invoices.openCents)} open` : "Nothing open"}
          sub={`${client.invoices.overdueCount === 0 ? "None overdue" : `${client.invoices.overdueCount} overdue`} · ${moneyLabel(client.invoices.paidCents)} paid so far`}
          right={client.invoices.overdueCount > 0 ? <Chip tone="warning" dot>Overdue</Chip> : undefined} />
        <LinkRow to={`/billing?businessId=${encodeURIComponent(id)}`} icon="calendar" title={renewalLabel(client.nextRenewalOn, today)}
          sub={client.nextRenewalOn ? `Term ends ${shortDate(client.nextRenewalOn, true)}` : "No plan with a fixed term"} />
      </Card>

      <Card icon="file-text" title="Documents" note={documents.length || undefined} flush>
        {documents.length === 0 && <Empty icon="file-text" title="No proposals or agreements yet">Proposals and agreements sent from a deal show up here with their status.</Empty>}
        {documents.map((d) => (
          <LinkRow key={d.id} to={`/deals/${encodeURIComponent(d.dealId)}`} icon="file-text" title={`${d.reference} v${d.version}`}
            sub={d.signedAt ? `Signed ${shortDate(d.signedAt.slice(0, 10), true)}` : d.sentAt ? `Sent ${shortDate(d.sentAt.slice(0, 10), true)}` : "Not sent"}
            right={<span className="ds-row">{d.test && <Chip tone="info">Test</Chip>}<Chip tone="outline">{upper(d.status)}</Chip></span>} />
        ))}
      </Card>

      <Card icon="pen" title="Change orders" note={orders.length || undefined} flush>
        {orders.length === 0 && <div className="clx-calm"><span className="ds-tile neutral"><Icon name="pen" size={15} /></span><span className="clx-setup-text"><b>No change orders</b><small>Extra work you quote on a project shows here once it is drafted.</small></span></div>}
        {orders.map((c) => (
          <LinkRow key={c.id} to={`/projects/${encodeURIComponent(c.projectId)}?tab=change-orders`} icon="pen" title={`${c.reference}: ${c.title}`} sub={moneyLabel(c.priceCents)}
            right={<span className="ds-row">{c.test && <Chip tone="info">Test</Chip>}<Chip tone="outline">{changeOrderStatus(c.status, c.paidAt !== null)}</Chip></span>} />
        ))}
      </Card>
    </div>
  );
}
