import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { NOTHING_SENT, useOwnerClock } from "../billingData";
import { invoiceChip, invoiceKindLabel } from "../billingView";
import { fmtUsd2 } from "../moneyView";
import { dollars } from "../packagesView";
import { workError } from "../workData";
import InvoiceItem from "./InvoiceItem";
import { Card, Chip, Empty, Note, type Tone } from "./ds";
import Icon from "./Icon";
import type { OwnerChangeOrder } from "../../worker/changeorders/service";
import type { InvoiceRow } from "../../worker/db/invoices";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** One quiet line under an invoice's title: what kind it is and where it stands (sent, paid, due). Never links: the page is already about this project and its client. */
function invoiceLine(inv: InvoiceRow): string {
  const parts = [invoiceKindLabel(inv.kind)];
  if (inv.paidAt) parts.push(`paid ${day(inv.paidAt)}`);
  else if (inv.sentAt) parts.push(`sent ${day(inv.sentAt)}${inv.dueOn ? `, due ${day(`${inv.dueOn}T12:00:00Z`)}` : ""}`);
  else if (inv.status === "draft") parts.push("draft, not sent");
  return parts.join(" · ");
}

/** The icon tile's colour follows the money: paid green, late or failed red, a draft or sent one calm. */
const tileTone = (tone: Tone): string => (tone === "positive" ? "positive" : tone === "critical" ? "critical" : tone === "warning" ? "warning" : "neutral");

/**
 * A project's billing: its invoices as rows (open one for its lines, its Stripe link and what you can do with it), "Bill unbilled hours" (the finished billable time not on
 * an invoice yet, drafted and put up for your approval), an Invoice button for each signed change order that is not paid, and the money in and still out at a glance.
 * Nothing here sends anything to the client: every invoice is a draft until you propose it and approve it.
 */
export default function ProjectBilling({ projectId, changeOrders }: { projectId: string; changeOrders: OwnerChangeOrder[] }) {
  const { today } = useOwnerClock();
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setInvoices((await api.get<{ invoices: InvoiceRow[] }>(`/billing/invoices?projectId=${encodeURIComponent(projectId)}`)).invoices); setFailed(false); }
    catch { setFailed(true); }
  }, [projectId]);
  useEffect(() => { setInvoices(null); void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(""); setNotice("");
    try { await fn(); await load(); setNotice(NOTHING_SENT); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(""); }
  };
  const hours = () => run("hours", async () => { await api.post(`/projects/${projectId}/invoices/hourly`); });
  const invoiceOrder = (id: string) => run(id, async () => { await api.post(`/change-orders/${id}/invoice`); });

  const toInvoice = changeOrders.filter((co) => co.status === "signed" && co.paidAt === null && !co.test);
  const list = invoices ?? [];
  const paid = list.filter((i) => i.status === "paid").reduce((n, i) => n + i.amountCents, 0);
  const out = list.filter((i) => i.status === "open" || i.status === "failed").reduce((n, i) => n + i.amountCents, 0);
  const drafts = list.filter((i) => i.status === "draft").length;

  return (
    <section className="wkx-billing" aria-label="Billing">
      <div className="ds-cols c2 wkx-project-cols">
        <div className="ds-col">
          {toInvoice.length > 0 && (
            <Card icon="pen" title="Change orders to invoice" note={`${toInvoice.length} signed, not paid`} flush>
              {toInvoice.map((co) => {
                const inv = list.find((i) => i.changeOrderId === co.id);
                return (
                  <div key={co.id} className="wkx-bill-row">
                    <span className="ds-tile neutral"><Icon name="pen" size={16} /></span>
                    <span className="ds-link-text"><b>{co.content.reference}: {co.content.title}</b>
                      <small>{inv ? (inv.status === "draft" ? "Its invoice is drafted below. Propose it to put it up for your approval." : inv.status === "void" ? "Its invoice was voided, so it is not made again." : "It has been invoiced.") : "Signed by the client. No invoice yet."}</small></span>
                    <span className="wkx-money">{dollars(co.content.priceCents)}</span>
                    {!inv && <button type="button" className="btn sm" disabled={busy !== "" || invoices === null} aria-label={`Invoice ${co.content.title}`} onClick={() => void invoiceOrder(co.id)}>{busy === co.id ? "Invoicing…" : "Invoice"}</button>}
                  </div>
                );
              })}
            </Card>
          )}
          <Card icon="file-text" title="Invoices" note={invoices ? `${invoices.length} on this project` : undefined} flush>
            {failed && invoices === null && <p className="error wkx-pad" role="alert">Couldn’t load the invoices. <button type="button" className="btn sm" onClick={() => void load()}>Try again</button></p>}
            {!failed && invoices === null && <p className="muted wkx-pad">Loading…</p>}
            {invoices !== null && invoices.length === 0 && <Empty icon="file-text" title="No invoices on this project yet">The deposit, milestone payments, billed hours and change orders for this project show here once they are drafted.</Empty>}
            {list.length > 0 && (
              <ul className="wkx-inv-list">
                {list.map((inv) => {
                  const chip = invoiceChip(inv, today);
                  const isOpen = open === inv.id;
                  const needs = inv.status === "draft" || inv.status === "open" || inv.status === "failed";
                  return (
                    <li key={inv.id} className={`wkx-inv${isOpen ? " open" : ""}`}>
                      <button type="button" className="wkx-inv-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : inv.id)}>
                        <span className={`ds-tile ${tileTone(chip.tone)}`}><Icon name={inv.status === "paid" ? "check" : inv.kind === "subscription" ? "refresh" : "file-text"} size={16} /></span>
                        <span className="ds-link-text"><b>{inv.description}</b><small>{invoiceLine(inv)}</small></span>
                        {inv.test && <Chip tone="info" dot>Test</Chip>}
                        {needs && !isOpen && <span className="wkx-inv-hint">{inv.status === "draft" ? "Needs proposing" : "Link to copy"}</span>}
                        <Chip tone={chip.tone} dot={chip.dot}>{chip.text}</Chip>
                        <span className="wkx-money wkx-inv-amt">{fmtUsd2(inv.amountCents)}</span>
                        <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={14} className="ds-chev" />
                      </button>
                      {isOpen && <ul className="wkx-inv-detail"><InvoiceItem inv={inv} today={today} onChanged={load} inTable /></ul>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Note><span>Every client’s invoices are on the <Link to="/billing">Billing page</Link>.</span></Note>
        </div>
        <div className="ds-col">
          {list.length > 0 && (
            <Card icon="card" title="Money on this project">
              <dl className="wkx-lines wkx-money-lines">
                <div><dt><i className="wkx-dot paid" aria-hidden="true" />Paid</dt><dd>{fmtUsd2(paid)}</dd></div>
                <div><dt><i className="wkx-dot owed" aria-hidden="true" />Sent, not paid yet</dt><dd>{fmtUsd2(out)}</dd></div>
                {drafts > 0 && <div><dt><i className="wkx-dot draft" aria-hidden="true" />Drafts to propose</dt><dd>{drafts}</dd></div>}
              </dl>
              <p className="wkx-card-foot">{out > 0 ? "Open an invoice to copy its Stripe link for the client." : drafts > 0 ? "A draft goes to your approvals when you propose it." : "Everything sent on this project is paid."}</p>
            </Card>
          )}
          <Card icon="clock" title="Bill unbilled hours">
            <p>Drafts one invoice for the finished billable time on this project that is not on an invoice yet. It goes up for your approval before anything is sent.</p>
            <button type="button" className="btn wkx-wide" disabled={busy !== ""} onClick={() => void hours()}>{busy === "hours" ? "Billing…" : "Bill unbilled hours"}</button>
            {error && <p className="warn small" role="alert">{error}</p>}
            {notice && <p className="small" role="status">{notice} <Link to="/approvals">Open Approvals</Link></p>}
          </Card>
        </div>
      </div>
    </section>
  );
}
