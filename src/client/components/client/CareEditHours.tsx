import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, careApi } from "../../api";
import { dayLabel } from "../../careReportPageView";
import { editHoursLine, ledgerBar, statusChip, statusTone, type LedgerBar as Bar, type ReportRow } from "../../careReportsView";
import type { EditLedger } from "../../../worker/care/ledger";
import { periodLabel } from "../../../worker/sop/cadence";

/** The edit-hours bar: green below 80% of the allowance, amber from there, red over it, and the figure and a note in words besides, so colour is never the only signal. */
export function LedgerBar({ bar, label }: { bar: Bar; label: string }) {
  return (
    <div className="rp-bar-wrap">
      <div className={`rp-meter ${bar.tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar.width} aria-valuetext={bar.label}>
        <i style={{ width: `${bar.width}%` }} />
      </div>
      <p className="small rp-bar-label">{bar.label}{bar.note && <> · <b className={bar.tone}>{bar.note}</b></>}</p>
    </div>
  );
}

/** The form that adds one edit request to the client's Care project (a task with the CARE-3 checklist). */
function AddEditRequest({ businessId, onAdded }: { businessId: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setError("");
    try { const r = await careApi.addEditRequest(businessId, title); setAdded(r.taskId); setTitle(""); setOpen(false); await onAdded(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Couldn’t add it just now. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <div className="rp-add">
      {!open && <button type="button" className="btn" onClick={() => { setOpen(true); setAdded(null); }}>Add an edit request</button>}
      {open && (
        <form onSubmit={(e) => void submit(e)} className="rp-add-form">
          <label htmlFor={`edit-${businessId}`} className="small">What does the client want changed?</label>
          <input id={`edit-${businessId}`} value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Change the phone number in the footer" />
          <div className="rp-actions">
            <button type="submit" className="btn primary" aria-disabled={busy || !title.trim()}>Add it</button>
            <button type="button" className="btn-plain" onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
          </div>
        </form>
      )}
      {added && <p className="small" role="status">Added to this client’s Care tasks. <Link to={`/tasks/${encodeURIComponent(added)}`}>Open it</Link></p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The Care panel's edit hours and last monthly report for one client. A client with no live Care plan has no ledger and no bar; a failed read shows nothing, because the rest of the panel
 * does not depend on it.
 */
export default function CareEditHours({ businessId }: { businessId: string }) {
  const [ledger, setLedger] = useState<EditLedger | null | undefined>(undefined);
  const [last, setLast] = useState<ReportRow | null | undefined>(undefined);
  const load = useCallback(async () => {
    try { setLedger(await careApi.ledger(businessId)); } catch { setLedger(undefined); }
    try { setLast((await careApi.clientReports(businessId))[0] ?? null); } catch { setLast(undefined); }
  }, [businessId]);
  useEffect(() => { setLedger(undefined); setLast(undefined); void load(); }, [load]);
  const bar = ledger ? ledgerBar(ledger) : null;
  return (
    <>
      {ledger && bar && (
        <>
          <h3 className="cr-sub">Edit hours</h3>
          <p className="small muted rp-bar-month">{periodLabel("monthly", ledger.month)}: {editHoursLine(ledger)}</p>
          <LedgerBar bar={bar} label="Edit hours used this month" />
          <AddEditRequest businessId={businessId} onAdded={load} />
        </>
      )}
      {(last || ledger) && last !== undefined && (
        <>
          <h3 className="cr-sub">Last report</h3>
          {last === null
            ? <p className="muted small">No monthly report yet.</p>
            : (
              <p className="small rp-last">
                <b>{periodLabel("monthly", last.period)}</b>{" "}
                <span className={`badge2${statusTone(last.status) ? ` ${statusTone(last.status)}` : ""}`}><i className="dot" aria-hidden="true" />{statusChip(last.status)}</span>
                {last.sentOn && <> sent {dayLabel(last.sentOn) ?? last.sentOn}</>}
                {last.status === "sent" && <> · {last.views === 0 ? "not opened yet" : `opened ${last.views} ${last.views === 1 ? "time" : "times"}`}</>}
                {" "}<Link to="/care/reports">All reports</Link>
              </p>
            )}
        </>
      )}
    </>
  );
}
