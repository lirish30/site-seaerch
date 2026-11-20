import { Link } from "react-router-dom";
import { moneyLabel, projectStatusLabel, renewalLabel } from "../../clientView";
import { statusLabel as changeOrderStatus } from "../../changeOrderView";
import type { Tone } from "../../projectView";
import { shortDate } from "../../billingView";
import type { ClientRecord } from "../../../worker/clients/record";

const TONE: Record<Tone, string> = { neutral: "outline", good: "positive", warn: "warning", muted: "" };
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Everything else that belongs to this client, as short lists that link out: projects, invoices, documents, change orders, open tasks and the next renewal. */
export default function LinkedPanel({ client, today }: { client: ClientRecord; today: string }) {
  const id = client.business.id;
  const live = client.projects.filter((p) => p.status === "active" || p.status === "paused" || (p.status === "done" && p.kind === "care_onboarding"));
  const openTasks = live.reduce((n, p) => n + p.openTasks, 0);
  const documents = client.documents;
  const orders = client.changeOrders;

  return (
    <div className="cl-linked">
      <section className="cl-card" aria-label="Projects">
        <h2>Projects</h2>
        {client.projects.length === 0 && <p className="muted small">No projects yet.</p>}
        <ul className="cl-list">
          {client.projects.map((p) => {
            const state = projectStatusLabel(p);
            return (
              <li key={p.id}>
                <Link to={`/projects/${encodeURIComponent(p.id)}`}>{p.name}</Link>
                <span className={`badge2 ${TONE[state.tone]}`}><i className="dot" />{state.label}</span>
                {p.test && <span className="badge2 info"><i className="dot" />Test</span>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="cl-card" aria-label="Open tasks">
        <h2>Tasks open</h2>
        <p className="cl-big">{openTasks}</p>
        <p className="muted small">{live.length === 0 ? "No live project." : `Across ${live.length} live ${live.length === 1 ? "project" : "projects"}.`}</p>
      </section>

      <section className="cl-card" aria-label="Invoices">
        <h2>Invoices</h2>
        <dl className="co-facts">
          <dt>Open</dt><dd>{moneyLabel(client.invoices.openCents)}</dd>
          <dt>Overdue</dt><dd className={client.invoices.overdueCount > 0 ? "warn" : undefined}>{client.invoices.overdueCount === 0 ? "None" : `${client.invoices.overdueCount} overdue`}</dd>
          <dt>Paid so far</dt><dd>{moneyLabel(client.invoices.paidCents)}</dd>
        </dl>
        <p className="small"><Link to={`/billing?businessId=${encodeURIComponent(id)}`}>Open this client’s billing</Link></p>
      </section>

      <section className="cl-card" aria-label="Next renewal">
        <h2>Next renewal</h2>
        <p>{renewalLabel(client.nextRenewalOn, today)}</p>
        {client.nextRenewalOn && <p className="muted small">Term ends {shortDate(client.nextRenewalOn, true)}</p>}
      </section>

      <section className="cl-card" aria-label="Documents">
        <h2>Documents</h2>
        {documents.length === 0 && <p className="muted small">No proposals or agreements yet.</p>}
        <ul className="cl-list">
          {documents.map((d) => (
            <li key={d.id}>
              <Link to={`/deals/${encodeURIComponent(d.dealId)}`}>{d.reference} v{d.version}</Link>
              <span className="badge2 outline">{upper(d.status)}</span>{d.test && <span className="badge2 info"><i className="dot" />Test</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="cl-card" aria-label="Change orders">
        <h2>Change orders</h2>
        {orders.length === 0 && <p className="muted small">None.</p>}
        <ul className="cl-list">
          {orders.map((c) => (
            <li key={c.id}>
              <Link to={`/projects/${encodeURIComponent(c.projectId)}?tab=change-orders`}>{c.reference}: {c.title}</Link>
              <span className="badge2 outline">{changeOrderStatus(c.status, c.paidAt !== null)}</span>{c.test && <span className="badge2 info"><i className="dot" />Test</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
