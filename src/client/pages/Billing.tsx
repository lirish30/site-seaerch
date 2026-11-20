import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { NOTHING_SENT, TONE_CLASS, useNames, useOwnerClock, type BillingSummary, type HoldRow, type SubscriptionRow } from "../billingData";
import {
  cancelSubscriptionText, earlyExitText, END_ACTIONS, groupInvoices, holdLine, isClosedInvoice, liftConfirmText, shortDate, subscriptionLine, subscriptionNext, subscriptionStatusLabel,
} from "../billingView";
import Icon from "../components/Icon";
import InvoiceItem from "../components/InvoiceItem";
import { dollars } from "../packagesView";
import type { Package } from "../packagesView";
import { workError } from "../workData";
import type { InvoiceRow } from "../../worker/db/invoices";

type Tab = "invoices" | "subscriptions" | "holds";
const TABS: [Tab, string][] = [["invoices", "Invoices"], ["subscriptions", "Subscriptions"], ["holds", "Holds"]];
const isTab = (s: string | null): s is Tab => TABS.some(([k]) => k === s);

type Names = ReturnType<typeof useNames>;

/** A line of the strip under the title. */
const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "warn" }) => (
  <div className={`bl-stat${tone ? ` ${tone}` : ""}`}><span className="bl-stat-label">{label}</span><b className="bl-stat-num">{value}</b></div>
);

/** One subscription: what it is, where it stands, what happens next, and the buttons that apply (Start billing, the end-of-term choice, Cancel). Nothing goes to the client without your approval. */
function SubscriptionItem({ s, plan, today, names, onChanged }: { s: SubscriptionRow; plan: string; today: string; names: Names; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const next = subscriptionNext(s);
  const status = subscriptionStatusLabel(s.status);
  const project = names.project(s.projectId);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setError(""); setNotice("");
    try { const done = await fn(); await onChanged(); if (done) setNotice(done); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  const start = () => run(async () => { await api.post(`/billing/subscriptions/${s.id}/start`); return NOTHING_SENT; });
  const setEnd = (endAction: SubscriptionRow["endAction"]) => run(async () => { await api.patch(`/billing/subscriptions/${s.id}`, { endAction }); });
  const cancel = () => {
    if (!window.confirm(cancelSubscriptionText(plan, next.running))) return;
    void run(async () => {
      try { await api.post(`/billing/subscriptions/${s.id}/cancel`, {}); return "Cancelled."; }
      catch (e) {
        // A balance for leaving early comes back as a 409 with its amount; cancelling goes ahead only when it is confirmed here.
        const cents = e instanceof ApiError && e.status === 409 ? (e.body as { earlyExitCents?: unknown } | undefined)?.earlyExitCents : undefined;
        if (typeof cents !== "number") throw e;
        if (!window.confirm(earlyExitText(cents))) return;
        await api.post(`/billing/subscriptions/${s.id}/cancel`, { confirmEarlyExit: true });
        return `Cancelled. The ${dollars(cents)} balance is drafted as an invoice, waiting for your approval on the Invoices tab.`;
      }
    });
  };

  return (
    <li className="co-item" aria-label={plan}>
      <div className="co-head">
        <b className="co-title">{plan}</b>
        {s.test && <span className="badge2 info"><i className="dot" />Test</span>}
        <span className={`badge2 ${TONE_CLASS[status.tone]}`}><i className="dot" />{status.text}</span>
      </div>
      <p className="muted small bl-meta"><Link to={`/leads/${s.businessId}`}>{names.client(s.businessId)}</Link>{project && <> · <Link to={`/projects/${project.id}`}>{project.name}</Link></>}</p>
      <p className="small">{subscriptionLine(s, today)}</p>
      <p className="small">{next.text}</p>
      {s.termMonths !== null && next.canCancel && (
        <label className="deal-field bl-end"><span>At the end of the term</span>
          <select value={s.endAction} disabled={busy} onChange={(e) => void setEnd(e.target.value as SubscriptionRow["endAction"])}>
            {END_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
      )}
      {error && <p className="warn small" role="alert">{error}</p>}
      {notice && <p className="small" role="status">{notice}{notice === NOTHING_SENT && <> <Link to="/today">Open Home</Link></>}</p>}
      {(next.canStart || next.canCancel) && (
        <div className="wk-task-actions">
          {next.canStart && <button type="button" className="btn primary" disabled={busy} onClick={() => void start()}>{next.buttonText}</button>}
          {next.canCancel && <button type="button" className="btn" disabled={busy} onClick={cancel}>Cancel subscription</button>}
        </div>
      )}
    </li>
  );
}

/** One held client: since when, the overdue invoice behind it, and Lift hold (after a confirm that says the client has not paid). */
function HoldItem({ h, invoice, today, tz, onChanged }: { h: HoldRow; invoice: InvoiceRow | undefined; today: string; tz: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lift = async () => {
    const what = invoice ? `“${invoice.description}”` : "its invoice";
    if (!window.confirm(liftConfirmText(h.businessName, what, invoice?.amountCents ?? 0))) return;
    setBusy(true); setError("");
    try { await api.post(`/billing/holds/${h.id}/lift`); await onChanged(); }
    catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };
  return (
    <li className="co-item" aria-label={h.businessName}>
      <div className="co-head"><b className="co-title"><Link to={`/leads/${h.businessId}`}>{h.businessName}</Link></b><span className="badge2 warning"><i className="dot" />On hold</span></div>
      <p className="small">{holdLine(h, today, tz)}</p>
      <p className="muted small">{invoice ? <>{invoice.description}, {dollars(invoice.amountCents)}{invoice.dueOn ? `, due ${shortDate(invoice.dueOn)}` : ""}, still unpaid. </> : null}Only your tasks and Claude’s are stopped. The client’s site and its hosting are untouched.</p>
      {error && <p className="warn small" role="alert">{error}</p>}
      <div className="wk-task-actions"><button type="button" className="btn" disabled={busy} onClick={() => void lift()}>Lift hold</button></div>
    </li>
  );
}

/** Billing: the money in one place. A summary strip, then Invoices (drafts and overdue first), Subscriptions and Holds. `?businessId=` narrows every tab to one client (Home links here). */
export default function Billing() {
  const [params, setParams] = useSearchParams();
  const wanted = params.get("tab");
  const tab: Tab = isTab(wanted) ? wanted : "invoices";
  const businessId = params.get("businessId");
  const { today, tz } = useOwnerClock();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [subs, setSubs] = useState<SubscriptionRow[] | null>(null);
  const [holds, setHolds] = useState<HoldRow[] | null>(null);
  const [plans, setPlans] = useState<Map<string, string>>(new Map());
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = businessId ? `?businessId=${encodeURIComponent(businessId)}` : "";
      const [s, i, sb, h] = await Promise.all([
        api.get<BillingSummary>("/billing/summary"), api.get<{ invoices: InvoiceRow[] }>(`/billing/invoices${q}`),
        api.get<{ subscriptions: SubscriptionRow[] }>("/billing/subscriptions"), api.get<{ holds: HoldRow[] }>("/billing/holds"),
      ]);
      setSummary(s); setInvoices(i.invoices); setSubs(sb.subscriptions); setHolds(h.holds); setFailed(false);
    } catch { setFailed(true); }
  }, [businessId]);
  useEffect(() => { setInvoices(null); void load(); }, [load]);
  useEffect(() => {
    let live = true;
    api.get<Package[]>("/packages").then((all) => { if (live) setPlans(new Map(all.map((p) => [p.key, p.name]))); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const mineSubs = (subs ?? []).filter((s) => !businessId || s.businessId === businessId);
  const mineHolds = (holds ?? []).filter((h) => !businessId || h.businessId === businessId);
  const names = useNames([...(invoices ?? []).map((i) => i.businessId), ...mineSubs.map((s) => s.businessId)]);
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === "invoices") n.delete("tab"); else n.set("tab", t); return n; }, { replace: true });
  const clearClient = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("businessId"); return n; }, { replace: true });

  const groups = groupInvoices(invoices ?? [], today);
  const closed = (invoices ?? []).filter(isClosedInvoice);
  const counts: Record<Tab, number | null> = { invoices: groups.needsYou.length, subscriptions: subs ? mineSubs.length : null, holds: holds ? mineHolds.length : null };
  const item = (inv: InvoiceRow) => (
    <InvoiceItem key={inv.id} inv={inv} today={today} client={{ id: inv.businessId, name: names.client(inv.businessId) }} project={names.project(inv.projectId)} onChanged={load} />
  );

  return (
    <div className="wk">
      <header className="page-header">
        <div>
          <h1>Billing</h1>
          <p>Invoices, subscriptions and holds. Nothing is sent to a client until you approve it.</p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn" onClick={() => void load()}><Icon name="refresh" size={16} />Refresh</button>
          <Link to="/settings/billing" className="btn">Billing settings</Link>
        </div>
      </header>
      <div className="wk-body">
        {failed && <p className="error" role="alert">Couldn’t load billing. <button type="button" className="btn" onClick={() => void load()}>Try again</button></p>}
        {summary && (
          <div className="bl-sum" role="group" aria-label="Billing summary, all clients">
            <Stat label="Monthly recurring" value={dollars(summary.mrrCents)} />
            <Stat label="Open" value={dollars(summary.openCents)} />
            <Stat label="Overdue" value={dollars(summary.overdueCents)} tone={summary.overdueCents > 0 ? "warn" : undefined} />
            <Stat label="Clients on hold" value={String(summary.heldClients)} tone={summary.heldClients > 0 ? "warn" : undefined} />
          </div>
        )}
        {businessId && (
          <p className="small" role="status">Showing {names.client(businessId)} only. <button type="button" className="btn-plain" onClick={clearClient}>Show every client</button></p>
        )}
        <div className="seg-pills wk-tabs" role="group" aria-label="Billing sections">
          {TABS.map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}{counts[key] ? ` (${counts[key]})` : ""}</button>)}
        </div>

        {tab === "invoices" && (
          <section aria-label="Invoices">
            {invoices === null && !failed && <p className="muted">Loading…</p>}
            {invoices !== null && invoices.length === 0 && <p className="muted">No invoices yet. A deposit, a milestone or a change order makes one, and it waits here as a draft.</p>}
            {groups.needsYou.length > 0 && <><h3>Needs you ({groups.needsYou.length})</h3><ul className="co-list">{groups.needsYou.map(item)}</ul></>}
            {groups.open.length > 0 && <><h3>Waiting on the client ({groups.open.length})</h3><ul className="co-list">{groups.open.map(item)}</ul></>}
            {groups.paid.length > 0 && <details className="bl-more"><summary>Paid ({groups.paid.length})</summary><ul className="co-list">{groups.paid.map(item)}</ul></details>}
            {closed.length > 0 && <details className="bl-more"><summary>Voided or written off ({closed.length})</summary><ul className="co-list">{closed.map(item)}</ul></details>}
          </section>
        )}

        {tab === "subscriptions" && (
          <section aria-label="Subscriptions">
            {subs === null && !failed && <p className="muted">Loading…</p>}
            {subs !== null && mineSubs.length === 0 && <p className="muted">No subscriptions. One is planned when a signed proposal sells a subscription.</p>}
            <ul className="co-list">{mineSubs.map((s) => <SubscriptionItem key={s.id} s={s} plan={plans.get(s.packageKey) ?? s.packageKey} today={today} names={names} onChanged={load} />)}</ul>
          </section>
        )}

        {tab === "holds" && (
          <section aria-label="Holds">
            <p className="muted small">A hold stops your tasks and Claude’s for a client whose invoice stays unpaid past the pause day set under Billing settings. It lifts by itself when the invoice is paid or voided.</p>
            {holds === null && !failed && <p className="muted">Loading…</p>}
            {holds !== null && mineHolds.length === 0 && <p className="muted">No client is on hold.</p>}
            <ul className="co-list">{mineHolds.map((h) => <HoldItem key={h.id} h={h} invoice={(invoices ?? []).find((i) => i.id === h.invoiceId)} today={today} tz={tz} onChanged={load} />)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}
