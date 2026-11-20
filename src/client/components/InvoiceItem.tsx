import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { NOTHING_SENT, TONE_CLASS, type WaitingApproval } from "../billingData";
import { invoiceKindLabel, invoiceStatusLabel } from "../billingView";
import { dollars } from "../packagesView";
import { workError } from "../workData";
import type { InvoiceRow } from "../../worker/db/invoices";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * One invoice: what it is for, how much, its state, the links to its client and project, and what you can do. A draft can be proposed (put up for your approval: nothing is sent to the
 * client until you approve it) or discarded. A sent one shows the Stripe link to copy, and can be voided. `client` and `project` are omitted where the page is already about them.
 */
export default function InvoiceItem({ inv, today, client, project, onChanged }: {
  inv: InvoiceRow; today: string; client?: { id: string; name: string }; project?: { id: string; name: string } | null; onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const status = invoiceStatusLabel(inv, today);

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

  return (
    <li className="co-item" aria-label={inv.description}>
      <div className="co-head">
        <b className="co-title">{inv.description}</b>
        {inv.test && <span className="badge2 info"><i className="dot" />Test</span>}
        <span className={`badge2 ${TONE_CLASS[status.tone]}`}><i className="dot" />{status.text}</span>
      </div>
      <p className="muted small bl-meta">
        {invoiceKindLabel(inv.kind)} · {dollars(inv.amountCents)}
        {client && <> · <Link to={`/leads/${client.id}`}>{client.name}</Link></>}
        {project && <> · <Link to={`/projects/${project.id}`}>{project.name}</Link></>}
      </p>
      {inv.lines.length > 1 && <ul className="co-ul">{inv.lines.map((l, i) => <li key={i}>{l.description}: {dollars(l.amountCents)}</li>)}</ul>}
      {inv.sentAt && <p className="muted small">Sent {when(inv.sentAt)}{inv.paidAt ? ` · paid ${when(inv.paidAt)}` : ""}</p>}
      {inv.mismatch && <p className="warn small" role="alert">Stripe reported a payment that did not match this invoice, so it is not marked paid: {inv.mismatch}</p>}

      {(inv.status === "open" || inv.status === "failed") && inv.hostedUrl && (
        <div className="co-link">
          <input readOnly aria-label="The client's Stripe link for this invoice" value={inv.hostedUrl} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn" onClick={() => void copy()}>Copy link</button>
        </div>
      )}
      {error && <p className="warn small" role="alert">{error}</p>}
      {notice && <p className="small" role="status">{notice}{notice === NOTHING_SENT && <> <Link to="/today">Open Home</Link></>}</p>}

      {(inv.status === "draft" || inv.status === "open" || inv.status === "failed") && (
        <div className="wk-task-actions">
          {inv.status === "draft" && <>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void propose()}>Propose</button>
            <button type="button" className="btn" disabled={busy} onClick={discard}>Discard</button>
          </>}
          {inv.status !== "draft" && <button type="button" className="btn" disabled={busy} onClick={voidIt}>Void</button>}
        </div>
      )}
    </li>
  );
}
