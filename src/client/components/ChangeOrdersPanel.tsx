import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { careRateHint, hoursText, linesOf, listProblem, parseDaysInput, parseHoursInput, pricePreview, signedRecord, statusLabel, statusTone, voidable } from "../changeOrderView";
import { dollars, parseDollars, type Package } from "../packagesView";
import { canTakeChangeOrder, type ChipTone, type Tone } from "../projectView";
import { Chip, Empty, Facts } from "./ds";
import Icon from "./Icon";
import { workError } from "../workData";
import type { OwnerChangeOrder } from "../../worker/changeorders/service";
import type { ProjectStatus } from "../../worker/db/projects";

const TONE: Record<Tone, ChipTone> = { neutral: "outline", good: "positive", warn: "warning", muted: "neutral" };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** The standard hourly rate and the Care client's rate, from the package catalog (the change-order rate defaults to the first). */
interface Rates { hourlyCents: number; careCents: number | null }

function Card({ co, onChanged }: { co: OwnerChangeOrder; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const paid = co.paidAt !== null;
  const c = co.content;
  const record = signedRecord(co);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await onChanged(); if (done) setNotice(done); }
    catch (e) { setError(workError(e)); await onChanged().catch(() => {}); }
    finally { setBusy(false); }
  };
  const send = () => run(async () => { await api.post(`/change-orders/${co.id}/send`); }, "Waiting for your approval. Nothing is mailed to the client until you approve it.");
  const voidIt = () => run(async () => { await api.post(`/change-orders/${co.id}/void`, { reason: reason.trim() }); setVoiding(false); setReason(""); });
  const markPaid = () => {
    if (!window.confirm(`Press this only after the money is in your account. Marking "${c.title}" paid unlocks its work, and it cannot be undone. Has the ${dollars(c.priceCents)} arrived?`)) return;
    void run(async () => { await api.post(`/change-orders/${co.id}/mark-paid`, { confirm: true }); }, "Marked paid. Its tasks are unlocked.");
  };
  const copy = async () => {
    if (!co.link) return;
    try { await navigator.clipboard.writeText(co.link); setNotice("Link copied."); setError(""); } catch { setError("Could not copy: select the link and copy it by hand."); }
  };

  return (
    <li className="ds-card wkx-co" aria-label={c.title}>
      <header className="ds-card-head">
        <Icon name="pen" size={16} />
        <h2>{c.title}</h2>
        {co.test && <Chip tone="info">Test</Chip>}
        <Chip tone={TONE[statusTone(co.status, paid)]} dot>{statusLabel(co.status, paid)}</Chip>
      </header>
      <div className="ds-card-body">
      <Facts rows={[
        { label: "Reference", value: c.reference },
        { label: "Price", value: dollars(c.priceCents) },
        { label: "Hours", value: `${hoursText(c.hours)} at ${dollars(c.rateCents)} an hour` },
        ...(c.scheduleImpactDays !== null ? [{ label: "Schedule", value: c.scheduleImpactDays === 0 ? "No change to the schedule" : `Adds ${c.scheduleImpactDays} ${c.scheduleImpactDays === 1 ? "day" : "days"}` }] : []),
      ]} />
      {c.summary && <><p className="wkx-label">What is changing</p><p className="wk-text">{c.summary}</p></>}
      {c.reason && <><p className="wkx-label">Why it is outside the scope</p><p className="wk-text">{c.reason}</p></>}
      {c.deliverables.length > 0 && <><p className="wkx-label">Becomes tasks</p><ul className="co-ul">{c.deliverables.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
      {c.notIncluded.length > 0 && <><p className="wkx-label">Not included</p><ul className="co-ul">{c.notIncluded.map((d, i) => <li key={i}>{d}</li>)}</ul></>}

      {record && (
        <div className="co-signed" role="group" aria-label="Signed record">
          <p>Signed by <b>{record.name}</b> on {when(record.signedAt)}.</p>
          <p className="muted small">Record hash <span className="co-record">{record.hashPrefix}…</span>
            {paid && co.paidAt ? ` · Paid ${when(co.paidAt)}${co.paidVia === "manual" ? " (outside Stripe)" : ""}` : ""}</p>
        </div>
      )}
      {co.status === "declined" && co.declinedReason && <p className="small">The client declined: {co.declinedReason}</p>}
      {co.status === "void" && co.voidReason && <p className="muted small">Voided: {co.voidReason}</p>}

      {(co.status === "sent" || co.status === "viewed") && (
        co.link ? (
          <div className="co-link">
            <input readOnly aria-label="The client's link to this change order" value={co.link} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn" onClick={() => void copy()}>Copy link</button>
          </div>
        ) : <p className="muted small">The client link base is not set, so there is no link to copy.</p>
      )}

      {error && <p className="warn small" role="alert">{error}</p>}
      {notice && <p className="small" role="status">{notice}{notice.startsWith("Waiting for your approval") && <> <Link to="/">Open the approvals inbox</Link></>}</p>}

      <div className="wkx-actions">
        {co.status === "draft" && <button type="button" className="btn primary" disabled={busy} onClick={() => void send()}>Send for approval</button>}
        {co.status === "signed" && !paid && <button type="button" className="btn primary" disabled={busy} onClick={markPaid}>Mark paid (outside Stripe)</button>}
        {voidable(co.status) && <button type="button" className="btn" disabled={busy} aria-expanded={voiding} onClick={() => setVoiding((v) => !v)}>Void</button>}
      </div>
      {co.status === "signed" && !paid && <p className="muted small">Its tasks stay locked until the money is in. Press “Mark paid” only after you have been paid.</p>}
      {voiding && (
        <form className="ds-form wkx-void" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) void voidIt(); }}>
          <label className="deal-field wide"><span>Why void it?</span><input value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} /><small>3 to 300 characters. It is kept in the history.</small></label>
          <div className="ds-form-actions">
            <button type="submit" className="btn primary" disabled={busy || reason.trim().length < 3}>Void this change order</button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setVoiding(false); setReason(""); }}>Cancel</button>
          </div>
        </form>
      )}
      </div>
    </li>
  );
}

function NewForm({ projectId, rates, onDone, onCancel }: { projectId: string; rates: Rates | null; onDone: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  const [hoursRaw, setHoursText] = useState("");
  const [rateText, setRateText] = useState("");
  const [priceText, setPriceText] = useState("");
  const [daysText, setDaysText] = useState("");
  const [notIncluded, setNotIncluded] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const hours = parseHoursInput(hoursRaw);
  const rateTyped = rateText.trim() !== "";
  const rateCents = rateTyped ? parseDollars(rateText) : rates?.hourlyCents ?? null;
  const price = priceText.trim() === "" ? null : parseDollars(priceText);
  const days = parseDaysInput(daysText);
  const preview = hours !== null && rateCents !== null && price !== undefined ? pricePreview(hours, rateCents, price) : null;
  const hint = rates ? careRateHint(rates.careCents, rates.hourlyCents) : null;
  const problem = !title.trim() ? "Give it a title."
    : hours === null ? "Hours go in quarter hours, like 1, 2.5 or 0.25."
    : rateTyped && rateCents === null ? "Enter the rate in dollars, like 95."
    : priceText.trim() !== "" && price === null ? "Enter the price in dollars, like 300."
    : days === undefined ? "Schedule impact is a whole number of days from 0 to 180, or blank."
    : listProblem("what is not included", linesOf(notIncluded)) ?? listProblem("what gets delivered", linesOf(deliverables));

  const create = async () => {
    if (problem || hours === null || days === undefined) return;
    setBusy(true); setError("");
    try {
      await api.post(`/projects/${projectId}/change-orders`, {
        title: title.trim(), hours, summary: summary.trim(), reason: reason.trim(), deliverables: linesOf(deliverables), notIncluded: linesOf(notIncluded), scheduleImpactDays: days,
        ...(rateTyped && rateCents !== null ? { rateCents } : {}), ...(price !== null && price !== undefined ? { priceCents: price } : {}),
      });
      await onDone();
    } catch (e) { setError(workError(e)); }
    finally { setBusy(false); }
  };

  return (
    <form className="ds-form wkx-co-form" aria-label="New change order" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="deal-field wide"><span>Title</span><input value={title} maxLength={120} placeholder="Like: Add a financing page" onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="deal-field wide"><span>What is changing</span><textarea rows={3} value={summary} maxLength={1500} placeholder="What the client asked for, in their words if you can" onChange={(e) => setSummary(e.target.value)} /><small>{summary.length} of 1,500 characters</small></label>
      <label className="deal-field wide"><span>Why it is outside the scope</span><textarea rows={2} value={reason} maxLength={600} placeholder="Like: not in the Growth Site page list" onChange={(e) => setReason(e.target.value)} /><small>{reason.length} of 600 characters</small></label>
      <div className="wide wkx-co-price">
        <p className="wkx-label">Price</p>
        <div className="wkx-co-nums">
          <label className="deal-field"><span>Hours</span><input inputMode="decimal" value={hoursRaw} placeholder="2.5" aria-invalid={hoursRaw.trim() !== "" && hours === null} onChange={(e) => setHoursText(e.target.value)} /><small>In quarter hours</small></label>
          <label className="deal-field"><span>Rate per hour</span>
            <span className="wkx-money-in"><i>$</i><input inputMode="decimal" value={rateText} placeholder={rates ? String(rates.hourlyCents / 100) : "95"} aria-invalid={rateTyped && rateCents === null} onChange={(e) => setRateText(e.target.value)} /></span><small>{rates ? `Usually ${dollars(rates.hourlyCents)}` : "Your standard rate"}</small></label>
          <label className="deal-field"><span>Your own price</span><span className="wkx-money-in"><i>$</i><input inputMode="decimal" value={priceText} placeholder="Optional" aria-invalid={priceText.trim() !== "" && price === null} onChange={(e) => setPriceText(e.target.value)} /></span><small>Leave blank for hours × rate</small></label>
          <label className="deal-field"><span>Days added</span><input inputMode="numeric" value={daysText} placeholder="0" aria-invalid={days === undefined} onChange={(e) => setDaysText(e.target.value)} /><small>To the schedule</small></label>
        </div>
        {(preview || hint) && <p className="wkx-co-preview" role="status">{preview && <b>{preview.line}</b>}{hint && <span>{hint}</span>}</p>}
      </div>
      <label className="deal-field"><span>What gets delivered</span><textarea rows={4} value={deliverables} placeholder={"Write the financing page\nBuild the financing page"} onChange={(e) => setDeliverables(e.target.value)} /><small>One per line. Each becomes a task, locked until the order is signed and paid.</small></label>
      <label className="deal-field"><span>What is not included</span><textarea rows={4} value={notIncluded} placeholder="Lender integration" onChange={(e) => setNotIncluded(e.target.value)} /><small>One per line.</small></label>
      {error && <p className="warn small wide" role="alert">{error}</p>}
      {problem && (title.trim() || hoursRaw.trim()) && <p className="warn small wide" role="alert">{problem}</p>}
      <div className="ds-form-actions">
        <button type="submit" className="btn primary" disabled={busy || !!problem}>{busy ? "Saving…" : "Save the draft"}</button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <span className="ds-help wkx-push">Saving makes a draft only. Nothing reaches the client until you send it and approve it.</span>
      </div>
    </form>
  );
}

/**
 * A project's change orders: each one's state, what it says, and what you can do with it (send it for approval, copy the client's link, void it, mark it paid when the money has
 * arrived outside Stripe). New ones start as drafts; nothing is sent from here without your approval. All the text shown is text, whoever wrote it.
 */
export default function ChangeOrdersPanel({ projectId, changeOrders, projectStatus, onChanged }: { projectId: string; changeOrders: OwnerChangeOrder[]; projectStatus: ProjectStatus; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [rates, setRates] = useState<Rates | null>(null);
  useEffect(() => {
    let live = true;
    api.get<Package[]>("/packages").then((all) => {
      const hourly = all.find((p) => p.key === "hourly");
      if (live && hourly) setRates({ hourlyCents: hourly.priceCents, careCents: hourly.altPriceCents });
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const open = canTakeChangeOrder(projectStatus);

  return (
    <section className="wkx-co-panel" aria-label="Change orders">
      {changeOrders.length > 0 && (
        <div className="ds-section-head">
          <h2>{changeOrders.length} change {changeOrders.length === 1 ? "order" : "orders"}</h2>
          {open && !adding && <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />New change order</button>}
        </div>
      )}
      {!open && <p className="muted small">This project is {projectStatus}, so it cannot take a new change order.</p>}
      {adding && <div className="ds-card"><header className="ds-card-head"><Icon name="plus" size={16} /><h2>New change order</h2><span className="ds-card-note">Saved as a draft</span></header><div className="ds-card-body"><NewForm projectId={projectId} rates={rates} onCancel={() => setAdding(false)} onDone={async () => { setAdding(false); await onChanged(); }} /></div></div>}
      {changeOrders.length === 0 && !adding && (
        <div className="ds-card"><Empty icon="pen" title="No change orders on this project" action={open ? <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />New change order</button> : undefined}>
          When the client asks for something outside the scope, write it up here. It is priced, signed by the client and paid before its tasks unlock.</Empty></div>
      )}
      <ul className="wkx-co-list">{changeOrders.map((co) => <Card key={co.id} co={co} onChanged={onChanged} />)}</ul>
    </section>
  );
}
