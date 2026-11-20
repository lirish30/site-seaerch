import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { careRateHint, hoursText, linesOf, listProblem, parseDaysInput, parseHoursInput, pricePreview, signedRecord, statusLabel, statusTone, voidable } from "../changeOrderView";
import { dollars, parseDollars, type Package } from "../packagesView";
import type { Tone } from "../projectView";
import { workError } from "../workData";
import type { OwnerChangeOrder } from "../../worker/changeorders/service";
import type { ProjectStatus } from "../../worker/db/projects";

const TONE: Record<Tone, string> = { neutral: "outline", good: "positive", warn: "warning", muted: "" };
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
    <li className="co-item" aria-label={c.title}>
      <div className="co-head">
        <b className="co-title">{c.title}</b>
        {co.test && <span className="badge2 info"><i className="dot" />Test</span>}
        <span className={`badge2 ${TONE[statusTone(co.status, paid)]}`}><i className="dot" />{statusLabel(co.status, paid)}</span>
      </div>
      <p className="muted small">{c.reference}</p>
      <dl className="co-facts">
        <dt>Price</dt><dd>{dollars(c.priceCents)}</dd>
        <dt>Hours</dt><dd>{hoursText(c.hours)} at {dollars(c.rateCents)} an hour</dd>
        {c.scheduleImpactDays !== null && <><dt>Schedule</dt><dd>{c.scheduleImpactDays === 0 ? "No change to the schedule" : `Adds ${c.scheduleImpactDays} ${c.scheduleImpactDays === 1 ? "day" : "days"}`}</dd></>}
      </dl>
      {c.summary && <><p className="wk-sub">What is changing</p><p className="wk-text">{c.summary}</p></>}
      {c.reason && <><p className="wk-sub">Why it is outside the scope</p><p className="wk-text">{c.reason}</p></>}
      {c.deliverables.length > 0 && <><p className="wk-sub">Becomes tasks</p><ul className="co-ul">{c.deliverables.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
      {c.notIncluded.length > 0 && <><p className="wk-sub">Not included</p><ul className="co-ul">{c.notIncluded.map((d, i) => <li key={i}>{d}</li>)}</ul></>}

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

      <div className="wk-task-actions">
        {co.status === "draft" && <button type="button" className="btn primary" disabled={busy} onClick={() => void send()}>Send for approval</button>}
        {co.status === "signed" && !paid && <button type="button" className="btn primary" disabled={busy} onClick={markPaid}>Mark paid (outside Stripe)</button>}
        {voidable(co.status) && <button type="button" className="btn" disabled={busy} aria-expanded={voiding} onClick={() => setVoiding((v) => !v)}>Void</button>}
      </div>
      {co.status === "signed" && !paid && <p className="muted small">Its tasks stay locked until the money is in. Press “Mark paid” only after you have been paid.</p>}
      {voiding && (
        <div className="wk-inline">
          <label className="deal-field"><span>Why void it? (3 to 300 characters, kept in the history)</span><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
          <button type="button" className="btn primary" disabled={busy || reason.trim().length < 3} onClick={() => void voidIt()}>Void this change order</button>
        </div>
      )}
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
    <form className="co-form" aria-label="New change order" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="deal-field"><span>Title</span><input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="deal-field"><span>What is changing <small>{summary.length} / 1500</small></span><textarea rows={3} value={summary} maxLength={1500} onChange={(e) => setSummary(e.target.value)} /></label>
      <label className="deal-field"><span>Why it is outside the scope <small>{reason.length} / 600</small></span><textarea rows={2} value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="sp-grid">
        <label className="deal-field"><span>Hours (in quarter hours)</span><input inputMode="decimal" value={hoursRaw} aria-invalid={hoursRaw.trim() !== "" && hours === null} onChange={(e) => setHoursText(e.target.value)} /></label>
        <label className="deal-field"><span>Rate per hour (USD){rates ? `, usually ${dollars(rates.hourlyCents)}` : ""}</span>
          <input inputMode="decimal" value={rateText} placeholder={rates ? String(rates.hourlyCents / 100) : "The standard hourly rate"} aria-invalid={rateTyped && rateCents === null} onChange={(e) => setRateText(e.target.value)} /></label>
        <label className="deal-field"><span>Your own price, if not hours × rate (USD)</span><input inputMode="decimal" value={priceText} aria-invalid={priceText.trim() !== "" && price === null} onChange={(e) => setPriceText(e.target.value)} /></label>
        <label className="deal-field"><span>Days it adds to the schedule</span><input inputMode="numeric" value={daysText} aria-invalid={days === undefined} onChange={(e) => setDaysText(e.target.value)} /></label>
      </div>
      {hint && <p className="muted small">{hint}</p>}
      {preview && <p className="co-preview" role="status">{preview.line}</p>}
      <label className="deal-field"><span>What is not included (one per line)</span><textarea rows={3} value={notIncluded} onChange={(e) => setNotIncluded(e.target.value)} /></label>
      <label className="deal-field"><span>What gets delivered (one per line; each becomes a task, locked until the order is signed and paid)</span><textarea rows={3} value={deliverables} onChange={(e) => setDeliverables(e.target.value)} /></label>
      {error && <p className="warn small" role="alert">{error}</p>}
      <div className="wk-task-actions">
        <button type="submit" className="btn primary" disabled={busy || !!problem}>{busy ? "Saving…" : "Save the draft"}</button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {problem && (title.trim() || hoursRaw.trim()) && <p className="warn small" role="alert">{problem}</p>}
      <p className="muted small">Saving makes a draft only. Nothing reaches the client until you send it for approval and approve it.</p>
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
  const open = projectStatus === "active" || projectStatus === "paused";

  return (
    <section className="co" aria-label="Change orders">
      <div className="wk-task-actions">
        {open && !adding && <button type="button" className="btn primary" onClick={() => setAdding(true)}>New change order</button>}
        {!open && <p className="muted small">This project is {projectStatus}, so it cannot take a new change order.</p>}
      </div>
      {adding && <NewForm projectId={projectId} rates={rates} onCancel={() => setAdding(false)} onDone={async () => { setAdding(false); await onChanged(); }} />}
      {changeOrders.length === 0 && !adding && <p className="muted">No change orders on this project.</p>}
      <ul className="co-list">{changeOrders.map((co) => <Card key={co.id} co={co} onChanged={onChanged} />)}</ul>
    </section>
  );
}
