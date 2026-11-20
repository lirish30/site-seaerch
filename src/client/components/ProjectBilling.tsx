import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { NOTHING_SENT, useOwnerClock } from "../billingData";
import { dollars } from "../packagesView";
import { workError } from "../workData";
import InvoiceItem from "./InvoiceItem";
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
    <section className="co" aria-label="Billing">
      <div className="wk-task-actions">
        <button type="button" className="btn primary" disabled={busy !== ""} onClick={() => void hours()}>{busy === "hours" ? "Billing…" : "Bill unbilled hours"}</button>
      </div>
      <p className="muted small">Bill unbilled hours drafts one invoice for the finished billable time that is not on an invoice yet. It is put up for your approval before anything is sent.</p>
      {error && <p className="warn small" role="alert">{error}</p>}
      {notice && <p className="small" role="status">{notice} <Link to="/today">Open Home</Link></p>}

      {toInvoice.length > 0 && (
        <>
          <h3>Change orders to invoice</h3>
          <ul className="co-list">
            {toInvoice.map((co) => {
              const inv = (invoices ?? []).find((i) => i.changeOrderId === co.id);
              return (
                <li key={co.id} className="co-item">
                  <div className="co-head"><b className="co-title">{co.content.reference}: {co.content.title}</b><span className="small">{dollars(co.content.priceCents)}</span></div>
                  {inv ? <p className="muted small">{inv.status === "draft" ? "Its invoice is drafted below. Propose it to put it up for your approval." : inv.status === "void" ? "Its invoice was voided, so it is not made again." : "It has been invoiced."}</p> : (
                    <div className="wk-task-actions"><button type="button" className="btn" disabled={busy !== "" || invoices === null} aria-label={`Invoice ${co.content.title}`} onClick={() => void invoiceOrder(co.id)}>{busy === co.id ? "Invoicing…" : "Invoice"}</button></div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h3>Invoices</h3>
      {failed && invoices === null && <p className="error" role="alert">Couldn’t load the invoices. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
      {!failed && invoices === null && <p className="muted">Loading…</p>}
      {invoices !== null && invoices.length === 0 && <p className="muted">No invoices on this project yet.</p>}
      <ul className="co-list">{(invoices ?? []).map((inv) => <InvoiceItem key={inv.id} inv={inv} today={today} onChanged={load} />)}</ul>
      <p className="muted small">See every client’s invoices on the <Link to="/billing">Billing page</Link>.</p>
    </section>
  );
}
