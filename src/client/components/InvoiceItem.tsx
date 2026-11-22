import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { NOTHING_SENT, type WaitingApproval } from "../billingData";
import { invoiceChip, invoiceKindLabel } from "../billingView";
import { fmtUsd2 } from "../moneyView";
import { dollars } from "../packagesView";
import { workError } from "../workData";
import { Chip } from "./ds";
import Icon from "./Icon";
import type { InvoiceRow } from "../../worker/db/invoices";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * One invoice: what it is for, how much, its state, the links to its client and project, and what you can do. A draft can be proposed (put up for your approval: nothing is sent to the
 * client until you approve it) or discarded. A sent one shows the Stripe link to copy, and can be voided. `client` and `project` are omitted where the page is already about them.
 * `inTable` drops the heading (the invoices table's row already shows it) so the item reads as that row's opened detail. Styles: screens/money.css (`mnx-inv`).
 */
export default function InvoiceItem({ inv, today, client, project, onChanged, inTable = false }: {
  inv: InvoiceRow; today: string; client?: { id: string; name: string }; project?: { id: string; name: string } | null; onChanged: () => Promise<void> | void; inTable?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const chip = invoiceChip(inv, today);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await onChanged(); if (done) setNotice(done); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  const propose = () => run(async () => { await api.post<{ approval: WaitingApproval | null }>(`/billing/invoices/${inv.id}/propose`); }, NOTHING_SENT);
  const discard = () => {
    if (!window.confirm(`Discard this draft invoice for ${dollars(inv.amountCents)}? It was never sent and nothing exists at Stripe. It cannot be brought back.`)) return;
    void run(async () => { await api.post(`/billing/invoices/${inv.id}/discard`); });
  };
  const voidIt = () => {
    if (!window.confirm(`Void "${inv.description}" (${dollars(inv.amountCents)})? Stripe cancels it, so the client can no longer pay it. Any hold for it lifts and its hours can be billed again. This cannot be undone.`)) return;
    void run(async () => { await api.post(`/billing/invoices/${inv.id}/void`); });
  };
  const copy = async () => {
    if (!inv.hostedUrl) return;
    try { await navigator.clipboard.writeText(inv.hostedUrl); setNotice("Link copied."); setError(""); } catch { setError("Could not copy: select the link and copy it by hand."); }
  };
  const canAct = inv.status === "draft" || inv.status === "open" || inv.status === "failed";

  return (
    <li className={`mnx-inv${inTable ? " in-table" : ""}`} aria-label={inv.description}>
      {!inTable && (
        <div className="mnx-inv-head">
          <span className="ds-tile neutral"><Icon name="file-text" size={16} /></span>
          <span className="mnx-inv-title">
            <b>{inv.description}</b>
            <small>
              {invoiceKindLabel(inv.kind)}
              {client && <> · <Link to={`/leads/${client.id}`}>{client.name}</Link></>}
              {project && <> · <Link to={`/projects/${project.id}`}>{project.name}</Link></>}
            </small>
          </span>
          {inv.test && <Chip tone="info" dot>Test</Chip>}
          <Chip tone={chip.tone} dot={chip.dot}>{chip.text}</Chip>
          <span className="mnx-mono mnx-inv-amt">{fmtUsd2(inv.amountCents)}</span>
        </div>
      )}
      {inTable && (
        <p className="mnx-inv-links">
          {invoiceKindLabel(inv.kind)}
          {client && <> · <Link to={`/leads/${client.id}`}>Open {client.name}</Link></>}
          {project && <> · <Link to={`/projects/${project.id}`}>Open {project.name}</Link></>}
        </p>
      )}
      {inv.lines.length > 1 && (
        <ul className="mnx-lines">{inv.lines.map((l, i) => <li key={i}><span>{l.description}</span><span className="mnx-mono">{fmtUsd2(l.amountCents)}</span></li>)}</ul>
      )}
      {inv.sentAt && <p className="mnx-inv-sub">Sent {when(inv.sentAt)}{inv.paidAt ? ` · paid ${when(inv.paidAt)}` : ""}</p>}
      {!inv.sentAt && inv.paidAt && <p className="mnx-inv-sub">Paid {when(inv.paidAt)}</p>}
      {inv.status === "draft" && <p className="mnx-inv-sub">A draft. Propose puts it up for your approval; nothing goes to the client until you approve it.</p>}
      {inv.mismatch && <p className="mnx-warn" role="alert">Stripe reported a payment that did not match this invoice, so it is not marked paid: {inv.mismatch}</p>}

      {(inv.status === "open" || inv.status === "failed") && inv.hostedUrl && (
        <div className="mnx-link">
          <input readOnly className="in" aria-label="The client's Stripe link for this invoice" value={inv.hostedUrl} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn sm" onClick={() => void copy()}><Icon name="copy" size={14} />Copy link</button>
        </div>
      )}
      {error && <p className="mnx-warn" role="alert">{error}</p>}
      {notice && <p className="mnx-notice" role="status">{notice}{notice === NOTHING_SENT && <> <Link to="/approvals">Open Approvals</Link></>}</p>}

      {canAct && (
        <div className="mnx-inv-actions">
          {inv.status === "draft" && <>
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => void propose()}><Icon name="send" size={14} />Propose for approval</button>
            <button type="button" className="btn sm" disabled={busy} onClick={discard}>Discard draft</button>
          </>}
          {inv.status !== "draft" && <button type="button" className="btn sm" disabled={busy} onClick={voidIt}><Icon name="ban" size={14} />Void invoice</button>}
        </div>
      )}
    </li>
  );
}
