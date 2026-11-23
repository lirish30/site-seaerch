import { Fragment, useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { NOTHING_SENT, TONE_CLASS, useNames, useOwnerClock, type BillingSummary, type HoldRow, type SubscriptionRow } from "../billingData";
import {
  cancelSubscriptionText, daysOverdue, earlyExitText, END_ACTIONS, holdLine, invoiceChip, invoiceKindLabel, invoiceSeg, liftConfirmText, pauseOn, pendingReminder, readBillingTerms,
  reminderNote, remindersFrom, shortDate, subscriptionLine, subscriptionNext, subscriptionStatusLabel, type BillingTerms, type InvoiceSeg, type ReminderRecord,
} from "../billingView";
import { Avatar, Banner, Card, Chip, Empty, Note, PageHeader, Seg, type Tone } from "../components/ds";
import Icon from "../components/Icon";
import InvoiceItem from "../components/InvoiceItem";
import { fmtUsd2 } from "../moneyView";
import { dollars } from "../packagesView";
import type { Package } from "../packagesView";
import { workError } from "../workData";
import type { InvoiceRow } from "../../worker/db/invoices";

type Tab = "invoices" | "subscriptions" | "holds";
const isTab = (s: string | null): s is Tab => s === "invoices" || s === "subscriptions" || s === "holds";
type Filter = "all" | InvoiceSeg;

type Names = ReturnType<typeof useNames>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One subscription as a table row (and a message row under it): who, the plan and its terms, its state, what happens next with the end-of-term choice, and Start billing / Cancel. */
function SubscriptionRowView({ s, plan, today, names, onChanged }: { s: SubscriptionRow; plan: string; today: string; names: Names; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const next = subscriptionNext(s);
  const status = subscriptionStatusLabel(s.status);
  const project = names.project(s.projectId);
  const client = names.client(s.businessId);

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
        return `Cancelled. The ${dollars(cents)} balance is drafted as an invoice, waiting for your approval on the Invoices page.`;
      }
    });
  };

  return (
    <>
      <tr aria-label={`${plan} for ${client}`}>
        <td>
          <span className="ds-who">
            <Avatar name={client} />
            <span><b><Link className="mnx-plain" to={`/leads/${s.businessId}`}>{client}</Link></b>{project ? <small><Link className="mnx-plain" to={`/projects/${project.id}`}>{project.name}</Link></small> : <small>No project linked</small>}</span>
          </span>
        </td>
        <td>
          <span className="mnx-cell-2"><b>{plan}{s.test && <> <Chip tone="info">Test</Chip></>}</b><small>{subscriptionLine(s, today)}</small></span>
        </td>
        <td className="num">{fmtUsd2(s.monthlyCents)}</td>
        <td><Chip tone={TONE_CLASS[status.tone] as Tone} dot>{status.text}</Chip></td>
        <td>
          <span className="mnx-cell-2 wrap">
            <span>{next.text}</span>
            {s.termMonths !== null && next.canCancel && (
              <label className="mnx-end"><span>At the end of the term</span>
                <select className="in" value={s.endAction} disabled={busy} onChange={(e) => void setEnd(e.target.value as SubscriptionRow["endAction"])}>
                  {END_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </label>
            )}
          </span>
        </td>
        <td className="mnx-actions-cell">
          {next.canStart && <button type="button" className="btn sm primary" disabled={busy} onClick={() => void start()}>{next.buttonText}</button>}
          {next.canCancel && <button type="button" className="btn sm" disabled={busy} onClick={cancel}>Cancel subscription</button>}
        </td>
      </tr>
      {(error || notice) && (
        <tr className="mnx-msg-row"><td colSpan={6}>
          {error && <p className="mnx-warn" role="alert">{error}</p>}
          {notice && <p className="mnx-notice" role="status">{notice}{notice === NOTHING_SENT && <> <Link to="/approvals">Open Approvals</Link></>}</p>}
        </td></tr>
      )}
    </>
  );
}

/** One held client as a table row: since when, the unpaid invoice behind it, and Lift hold (after a confirm that says the client has not paid). */
function HoldRowView({ h, invoice, today, tz, onChanged }: { h: HoldRow; invoice: InvoiceRow | undefined; today: string; tz: string; onChanged: () => Promise<void> }) {
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
    <>
      <tr aria-label={h.businessName}>
        <td><span className="ds-who"><Avatar name={h.businessName} /><span><b><Link className="mnx-plain" to={`/leads/${h.businessId}`}>{h.businessName}</Link></b><small>Tasks paused</small></span></span></td>
        <td>{invoice ? <span className="mnx-cell-2"><b>{invoice.description}</b><small>{invoice.dueOn ? `Was due ${shortDate(invoice.dueOn)}, still unpaid` : "Still unpaid"}</small></span> : <span className="mnx-muted">Invoice not loaded</span>}</td>
        <td className="num">{invoice ? fmtUsd2(invoice.amountCents) : ""}</td>
        <td><Chip tone="warning" dot>On hold</Chip></td>
        <td>{holdLine(h, today, tz)}</td>
        <td className="mnx-actions-cell"><button type="button" className="btn sm" disabled={busy} onClick={() => void lift()}>Lift hold</button></td>
      </tr>
      {error && <tr className="mnx-msg-row"><td colSpan={6}><p className="mnx-warn" role="alert">{error}</p></td></tr>}
    </>
  );
}

/** One line of the "Where it stands" card: a tinted tile, what it is, how many, and the amount. */
function Tally({ tone, icon, label, sub, cents }: { tone: Tone; icon: "check" | "clock" | "alert" | "pen"; label: string; sub: string; cents: number }) {
  return (
    <li><span className={`ds-tile ${tone}`}><Icon name={icon} size={14} /></span><span className="mnx-cell-2"><b>{label}</b><small>{sub}</small></span><b className="mnx-mono">{fmtUsd2(cents)}</b></li>
  );
}

/** The most overdue invoice, said plainly: how late, the reminder waiting for you, and the day work pauses (or the hold already on). */
function OverdueBanner({ inv, client, today, terms, reminders, held, more, onOpen }: {
  inv: InvoiceRow; client: string; today: string; terms: BillingTerms; reminders: ReminderRecord[]; held: HoldRow | undefined; more: number; onOpen: () => void;
}) {
  const late = daysOverdue(inv, today);
  const waiting = pendingReminder(inv.id, reminders);
  const pause = pauseOn(inv, terms);
  const title = inv.status === "failed" ? `${client}'s payment failed` : `${client} is ${plural(late, "day")} overdue`;
  const parts = [
    `${inv.description}, ${dollars(inv.amountCents)}.`,
    waiting ? `Reminder ${waiting.step} is drafted and waiting in Approvals.` : "",
    held ? "Their tasks are on hold until it is paid." : pause && pause > today ? `Their tasks pause on ${shortDate(pause)}, ${terms.pauseAfterDays} days after the due date.` : pause ? "Their tasks pause once the hold check runs." : "",
    more > 0 ? `${plural(more, "more invoice")} overdue.` : "",
  ].filter(Boolean);
  return (
    <Banner tone="warning" title={title} action={waiting
      ? <Link to="/approvals" className="btn sm">Open reminder</Link>
      : <button type="button" className="btn sm" onClick={onOpen}>Open invoice</button>}>
      {parts.join(" ")}
    </Banner>
  );
}

/**
 * Billing: Invoices (a table with a Draft / Sent / Overdue / Paid filter, each row opening its actions), Subscriptions and Holds. The sidebar picks the view (`?tab=`), and `?businessId=` narrows
 * every view to one client (Home and the client record link here). Nothing is sent to a client until you approve it.
 */
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
  const [terms, setTerms] = useState<BillingTerms>(() => readBillingTerms(""));
  const [reminders, setReminders] = useState<ReminderRecord[]>([]);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(() => params.get("invoice")); // `?invoice=<id>` opens that row, so a link can point at one invoice

  const load = useCallback(async () => {
    try {
      const q = businessId ? `?businessId=${encodeURIComponent(businessId)}` : "";
      const [s, i, sb, h] = await Promise.all([
        api.get<BillingSummary>("/billing/summary"), api.get<{ invoices: InvoiceRow[] }>(`/billing/invoices${q}`),
        api.get<{ subscriptions: SubscriptionRow[] }>("/billing/subscriptions"), api.get<{ holds: HoldRow[] }>("/billing/holds"),
      ]);
      setSummary(s); setInvoices(i.invoices); setSubs(sb.subscriptions); setHolds(h.holds); setFailed(false);
    } catch { setFailed(true); }
    // The reminders column and the banner read the approvals list; a failure there only leaves the column on the schedule.
    api.get<{ items: { kind: string; status: string; payload: unknown }[] }>("/approvals").then((r) => setReminders(remindersFrom(Array.isArray(r.items) ? r.items : []))).catch(() => {});
  }, [businessId]);
  useEffect(() => { setInvoices(null); void load(); }, [load]);
  useEffect(() => {
    let live = true;
    api.get<Package[]>("/packages").then((all) => { if (live && Array.isArray(all)) setPlans(new Map(all.map((p) => [p.key, p.name]))); }).catch(() => {});
    api.get<{ settings: Record<string, string | number> }>("/settings").then((r) => { if (live) setTerms(readBillingTerms(String(r.settings?.billing_config ?? ""))); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const mineSubs = (subs ?? []).filter((s) => !businessId || s.businessId === businessId);
  const mineHolds = (holds ?? []).filter((h) => !businessId || h.businessId === businessId);
  const names = useNames([...(invoices ?? []).map((i) => i.businessId), ...mineSubs.map((s) => s.businessId), ...(businessId ? [businessId] : [])]);
  const clearClient = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("businessId"); return n; }, { replace: true });

  const all = invoices ?? [];
  const segOf = (i: InvoiceRow) => invoiceSeg(i, today);
  const count = (k: InvoiceSeg) => all.filter((i) => segOf(i) === k).length;
  const shown = filter === "all" ? all : all.filter((i) => segOf(i) === filter);
  const overdue = all.filter((i) => segOf(i) === "overdue").sort((a, b) => daysOverdue(b, today) - daysOverdue(a, today) || b.amountCents - a.amountCents);
  const month = today.slice(0, 7);
  const paidThisMonth = all.filter((i) => i.status === "paid" && (i.paidAt ?? "").slice(0, 7) === month).reduce((n, i) => n + i.amountCents, 0);
  const liveSubs = mineSubs.filter((x) => x.status === "active" || x.status === "past_due");
  // A filter with nothing in it is left out (an "Overdue 0" tab is noise), unless it is the one chosen.
  const segs: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: all.length },
    ...([["drafts", "Drafts"], ["sent", "Sent"], ["overdue", "Overdue"], ["paid", "Paid"], ["closed", "Voided"]] as const)
      .map(([key, label]) => ({ key, label, count: count(key) })).filter((x) => x.count > 0 || x.key === filter),
  ];
  const openInvoice = (id: string) => { setFilter("all"); setOpen(id); requestAnimationFrame(() => document.getElementById(`mnx-row-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })); };

  const actions = (
    <>
      <button type="button" className="btn icon-only" aria-label="Refresh" title="Refresh" onClick={() => void load()}><Icon name="refresh" size={16} /></button>
      <Link to="/settings/billing" className="btn"><Icon name="sliders" size={16} />Billing settings</Link>
    </>
  );
  const sum = summary;
  const overdueCents = businessId ? overdue.reduce((n, i) => n + i.amountCents, 0) : sum?.overdueCents ?? 0;
  const head = tab === "invoices"
    ? { title: "Invoices", sub: invoices === null ? "Loading…" : all.length === 0 ? "Nothing billed yet" : [
        plural(all.length, "invoice"),
        overdueCents > 0 && `${dollars(overdueCents)} overdue`,
        sum && !businessId && sum.openCents > 0 && `${dollars(sum.openCents)} waiting on clients`,
        count("drafts") > 0 && `${plural(count("drafts"), "draft")} to approve`,
        paidThisMonth > 0 ? `${dollars(paidThisMonth)} paid this month` : "nothing paid yet this month",
        overdueCents === 0 && count("sent") === 0 && count("drafts") === 0 && "all settled",
      ].filter(Boolean).join(" · ") }
    : tab === "subscriptions"
      ? { title: "Subscriptions", sub: subs === null ? "Loading…" : mineSubs.length === 0 ? "No monthly plans yet" : [plural(liveSubs.length, "live subscription"), mineSubs.length > liveSubs.length && `${mineSubs.length - liveSubs.length} not running`, sum && !businessId && sum.mrrCents > 0 && `${dollars(sum.mrrCents)} a month`].filter(Boolean).join(" · ") }
      : { title: "Holds", sub: holds === null ? "Loading…" : mineHolds.length ? `${plural(mineHolds.length, "client")} on hold · their tasks and Claude's are stopped until they pay` : "Nobody is on hold" };
  const paidAll = all.filter((i) => i.status === "paid").reduce((n, i) => n + i.amountCents, 0);
  const waitingCents = all.filter((i) => i.status === "open" || i.status === "failed").reduce((n, i) => n + i.amountCents, 0);
  const draftCents = all.filter((i) => i.status === "draft").reduce((n, i) => n + i.amountCents, 0);

  return (
    <div className="ds-page mnx">
      <PageHeader title={head.title} sub={head.sub} actions={actions} />
      <div className="ds-body">
        {failed && <Banner tone="critical" title="Couldn't load billing" action={<button type="button" className="btn sm" onClick={() => void load()}>Try again</button>}>Check your connection, then try again.</Banner>}
        {businessId && (
          <div className="mnx-scope" role="status">
            <Avatar name={names.client(businessId)} />
            <span>Showing <b>{names.client(businessId)}</b> only.</span>
            <button type="button" className="btn sm" onClick={clearClient}><Icon name="x" size={14} />Show every client</button>
          </div>
        )}

        {tab === "invoices" && (
          <>
            {overdue[0] && (
              <OverdueBanner inv={overdue[0]} client={names.client(overdue[0].businessId)} today={today} terms={terms} reminders={reminders}
                held={mineHolds.find((h) => h.invoiceId === overdue[0].id)} more={overdue.length - 1} onOpen={() => openInvoice(overdue[0].id)} />
            )}
            {invoices !== null && all.length === 0 && (
              <div className="ds-card"><Empty icon="file-text" title="No invoices yet">
                Invoices are made for you from the work: a signed proposal drafts its deposit, each milestone and change order drafts its own, and Bill unbilled hours on a project drafts the time. Drafts wait here for your OK, and paid ones mark themselves paid.
              </Empty></div>
            )}
            {invoices === null && !failed && <p className="mnx-muted">Loading invoices…</p>}
            {all.length > 0 && (
              <>
                <div className="ds-toolbar"><Seg label="Show invoices" options={segs} value={filter} onChange={(k) => { setFilter(k); setOpen(null); }} /></div>
                <div className="ds-table-wrap">
                  <table className="ds-table mnx-table mnx-inv-table">
                    <thead><tr><th>Client</th><th>What for</th><th className="num">Amount</th><th>Status</th><th>Due</th><th>Reminders</th><th aria-label="Open" /></tr></thead>
                    <tbody>
                      {shown.length === 0 && <tr><td colSpan={7} className="mnx-none">No {segs.find((s) => s.key === filter)?.label.toLowerCase()} invoices.</td></tr>}
                      {shown.map((inv) => {
                        const chip = invoiceChip(inv, today);
                        const isOpen = open === inv.id;
                        const late = segOf(inv) === "overdue";
                        const client = names.client(inv.businessId);
                        const toggle = () => setOpen(isOpen ? null : inv.id);
                        return (
                          <Fragment key={inv.id}>
                            <tr id={`mnx-row-${inv.id}`} className={`mnx-click${isOpen ? " is-open" : ""}`} onClick={toggle}>
                              <td>
                                <span className="ds-who">
                                  <Avatar name={client} />
                                  <span><b>{client}</b><small>{invoiceKindLabel(inv.kind)}{inv.test ? " · test" : ""}</small></span>
                                </span>
                              </td>
                              <td className="mnx-what">{inv.description}</td>
                              <td className="num">{fmtUsd2(inv.amountCents)}</td>
                              <td><Chip tone={chip.tone} dot={chip.dot}>{chip.text}</Chip></td>
                              <td className={late ? "mnx-late" : ""}>{shortDate(inv.dueOn) || "No date"}</td>
                              <td className="mnx-rem">{reminderNote(inv, today, terms, reminders)}</td>
                              <td className="mnx-chev-cell">
                                <button type="button" className="ds-icon-btn" aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Open"} ${inv.description}`} onClick={(e) => { e.stopPropagation(); toggle(); }}>
                                  <Icon name={isOpen ? "chevron-up" : "chevron-down"} size={14} />
                                </button>
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="mnx-detail-row"><td colSpan={7}>
                                <ul className="mnx-detail">
                                  <InvoiceItem inv={inv} today={today} client={{ id: inv.businessId, name: client }} project={names.project(inv.projectId)} onChanged={load} inTable />
                                </ul>
                              </td></tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Note>
                  Reminders are raised {terms.reminderOffsets.map((o) => (o < 0 ? `${-o} days before` : o === 0 ? "on the due date" : `${o} days after`)).join(", ")}. Each one waits in Approvals first. Work pauses {terms.pauseAfterDays} days after the due date.
                </Note>
                {all.length <= 8 && (
                  <div className="mnx-after">
                    <Card icon="card" title="Where it stands" note={businessId ? names.client(businessId) : "Every invoice above"}>
                      <ul className="mnx-tally">
                        {paidAll > 0 && <Tally tone="positive" icon="check" label="Paid" sub={plural(count("paid"), "invoice")} cents={paidAll} />}
                        {waitingCents - overdueCents > 0 && <Tally tone="info" icon="clock" label="Sent, waiting on the client" sub={plural(count("sent"), "invoice")} cents={waitingCents - overdueCents} />}
                        {overdueCents > 0 && <Tally tone="critical" icon="alert" label="Overdue" sub={plural(count("overdue"), "invoice")} cents={overdueCents} />}
                        {draftCents > 0 && <Tally tone="signal" icon="pen" label="Drafts for your OK" sub="Nothing sent yet" cents={draftCents} />}
                      </ul>
                      {waitingCents === 0 && draftCents === 0 && <p className="mnx-good"><Icon name="check" size={14} />Nobody owes you anything right now.</p>}
                    </Card>
                    <Card icon="info" title="Where invoices come from">
                      <ol className="mnx-how">
                        <li><span className="ds-tile neutral"><Icon name="file-text" size={14} /></span><span><b>A signed proposal</b><small>drafts its deposit, and each milestone drafts its own when it is reached.</small></span></li>
                        <li><span className="ds-tile neutral"><Icon name="clock" size={14} /></span><span><b>Change orders and extra hours</b><small>draft theirs from the project: Bill unbilled hours on its Billing tab.</small></span></li>
                        <li><span className="ds-tile signal"><Icon name="check" size={14} /></span><span><b>You approve, Stripe does the rest</b><small>It mails the client, takes the payment and marks it paid here.</small></span></li>
                      </ol>
                    </Card>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === "subscriptions" && (
          <>
            {subs === null && !failed && <p className="mnx-muted">Loading subscriptions…</p>}
            {subs !== null && mineSubs.length === 0 && (
              <div className="ds-card"><Empty icon="refresh" title="No subscriptions yet">
                A subscription is planned when a signed proposal sells a monthly plan. Start billing puts the Stripe link up for your approval; the client pays monthly from then on.
              </Empty></div>
            )}
            {mineSubs.length > 0 && (
              <div className="ds-table-wrap">
                <table className="ds-table mnx-table">
                  <thead><tr><th>Client</th><th>Plan and terms</th><th className="num">A month</th><th>Status</th><th>What happens next</th><th aria-label="Actions" /></tr></thead>
                  <tbody>{mineSubs.map((s) => <SubscriptionRowView key={s.id} s={s} plan={plans.get(s.packageKey) ?? s.packageKey} today={today} names={names} onChanged={load} />)}</tbody>
                </table>
              </div>
            )}
            {mineSubs.length > 0 && <Note>Nothing goes to a client until you approve it in Approvals. Cancelling a running subscription stops Stripe at the end of the period already paid for.</Note>}
            {mineSubs.length > 0 && mineSubs.length <= 6 && (
              <div className="mnx-after">
                <Card icon="trending" title="Monthly income from these" note={plural(liveSubs.length, "live one")}>
                  <ul className="mnx-tally">
                    {liveSubs.map((x) => <Tally key={x.id} tone={x.status === "past_due" ? "critical" : "positive"} icon={x.status === "past_due" ? "alert" : "check"} label={`${names.client(x.businessId)} · ${plans.get(x.packageKey) ?? x.packageKey}`} sub={x.status === "past_due" ? "Last charge failed" : "Charged monthly"} cents={x.monthlyCents} />)}
                    {liveSubs.length === 0 && <li className="mnx-muted">None running yet: press Start billing on a planned one.</li>}
                  </ul>
                  {liveSubs.length > 0 && <p className="mnx-sum"><span>About {dollars(liveSubs.reduce((n, x) => n + x.monthlyCents, 0) * 12)} a year at today's plans</span><b className="mnx-mono">{fmtUsd2(liveSubs.reduce((n, x) => n + x.monthlyCents, 0))}<small> a month</small></b></p>}
                </Card>
                <Card icon="info" title="How a subscription runs">
                  <ol className="mnx-how">
                    <li><span className="ds-tile neutral"><Icon name="file-text" size={14} /></span><span><b>Planned from a signed proposal</b><small>The monthly plan it sold waits here until it should start.</small></span></li>
                    <li><span className="ds-tile signal"><Icon name="send" size={14} /></span><span><b>Start billing</b><small>puts the client's Stripe link up for your approval in Approvals.</small></span></li>
                    <li><span className="ds-tile positive"><Icon name="refresh" size={14} /></span><span><b>Stripe charges each month</b><small>Each payment shows on Invoices; a failed one shows here as Past due.</small></span></li>
                  </ol>
                </Card>
              </div>
            )}
          </>
        )}

        {tab === "holds" && (
          <>
            {holds === null && !failed && <p className="mnx-muted">Loading holds…</p>}
            {holds !== null && mineHolds.length === 0 && (
              <Banner tone="positive" title="Nobody is on hold">Everyone is paid up, so every client's work is running. A client shows here only if an invoice stays unpaid past the pause day.</Banner>
            )}
            {mineHolds.length > 0 && (
              <div className="ds-table-wrap">
                <table className="ds-table mnx-table">
                  <thead><tr><th>Client</th><th>Unpaid invoice</th><th className="num">Amount</th><th>Status</th><th>Since</th><th aria-label="Actions" /></tr></thead>
                  <tbody>{mineHolds.map((h) => <HoldRowView key={h.id} h={h} invoice={all.find((i) => i.id === h.invoiceId)} today={today} tz={tz} onChanged={load} />)}</tbody>
                </table>
              </div>
            )}
            <Card icon="shield" title="How a hold works" note="Set in Billing settings">
              <ol className="mnx-steps mnx-hold-steps" aria-label="From due date to hold">
                <li className="done"><span className="mnx-step-dot" aria-hidden="true"><Icon name="calendar" size={12} /></span><span className="mnx-step-text"><b>Due date</b><small>The invoice falls due</small></span></li>
                <li className="now"><span className="mnx-step-dot" aria-hidden="true" /><span className="mnx-step-text"><b>Reminders</b><small>{terms.reminderOffsets.filter((o) => o > 0).map((o) => `Day ${o}`).join(", ") || "None after the due date"}, each approved by you</small></span></li>
                <li className="bad"><span className="mnx-step-dot" aria-hidden="true"><Icon name="ban" size={12} /></span><span className="mnx-step-text"><b>Day {terms.pauseAfterDays}: work pauses</b><small>Your tasks and Claude's stop. The site and hosting stay up.</small></span></li>
                <li className="done"><span className="mnx-step-dot" aria-hidden="true"><Icon name="check" size={12} /></span><span className="mnx-step-text"><b>Paid or voided</b><small>The hold lifts by itself</small></span></li>
              </ol>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
