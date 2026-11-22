import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { NOTHING_SENT, useOwnerClock } from "../billingData";
import { dollars } from "../packagesView";
import { workError } from "../workData";
import InvoiceItem from "./InvoiceItem";
import { Card, Empty, Note } from "./ds";
import type { OwnerChangeOrder } from "../../worker/changeorders/service";
import type { InvoiceRow } from "../../worker/db/invoices";

/**
 * A project's billing: its invoices, "Bill unbilled hours" (the finished billable time not on an invoice yet, drafted and put up for your approval) and an Invoice button for each signed change
 * order that is not paid. Nothing here sends anything to the client: every invoice is a draft until you propose it and approve it.
 */
export default function ProjectBilling({ projectId, changeOrders }: { projectId: string; changeOrders: OwnerChangeOrder[] }) {
  const { today } = useOwnerClock();
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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

  return (
    <section className="wkx-billing" aria-label="Billing">
      <div className="ds-cols c2">
        <div className="ds-col">
          {toInvoice.length > 0 && (
            <Card icon="pen" title="Change orders to invoice" note={`${toInvoice.length} signed, not paid`} flush>
              {toInvoice.map((co) => {
                const inv = (invoices ?? []).find((i) => i.changeOrderId === co.id);
                return (
                  <div key={co.id} className="wkx-bill-row">
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
            {invoices !== null && invoices.length > 0 && <ul className="co-list wkx-invoices">{invoices.map((inv) => <InvoiceItem key={inv.id} inv={inv} today={today} onChanged={load} />)}</ul>}
          </Card>
          <Note><span>See every client’s invoices on the <Link to="/billing">Billing page</Link>.</span></Note>
        </div>
        <div className="ds-col">
          <Card icon="clock" title="Bill unbilled hours">
            <p>Drafts one invoice for the finished billable time on this project that is not on an invoice yet. It goes up for your approval before anything is sent.</p>
            <button type="button" className="btn primary wkx-wide" disabled={busy !== ""} onClick={() => void hours()}>{busy === "hours" ? "Billing…" : "Bill unbilled hours"}</button>
            {error && <p className="warn small" role="alert">{error}</p>}
            {notice && <p className="small" role="status">{notice} <Link to="/today">Open Home</Link></p>}
          </Card>
        </div>
      </div>
    </section>
  );
}
