import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { actionRequest, bookingActions, kindLabel, type BookingAction } from "../callsView";

interface Props { booking: { id: string; kind: "discovery" | "recommendation"; startAt: string; dealId: string | null }; onChanged: () => void }

const LABEL: Record<BookingAction, string> = { cancel: "Cancel", no_show: "No-show", done: "Mark done" };

/**
 * What Logan can do with a confirmed booking: Cancel one still to come; for one that started, say it was a no-show or mark it done. A discovery call is
 * marked done from its deal (Call done moves the deal), so "Mark done" there is a link to it; a recommendation meeting is marked held in place.
 */
export default function BookingActions({ booking, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actions = bookingActions(booking.startAt, new Date());

  async function run(action: BookingAction) {
    const req = actionRequest(action, booking);
    if (!req) return;
    if (action === "cancel" && !window.confirm(`Cancel this ${kindLabel(booking.kind).toLowerCase()}? It comes off your calendar and the time opens up again.`)) return;
    setBusy(true); setError("");
    try { await api.post(req.path, req.body); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  return (
    <span className="bk-actions">
      {actions.map((a) => (a === "done" && booking.kind === "discovery"
        ? (booking.dealId ? <Link key={a} className="btn-ghost-sm" to={`/deals/${booking.dealId}`}>{LABEL[a]}</Link> : null)
        : <button key={a} type="button" className="btn-ghost-sm" disabled={busy} onClick={() => void run(a)}>{LABEL[a]}</button>))}
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}
