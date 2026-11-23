import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, careApi } from "../../api";
import { dayLabel, hours } from "../../careReportPageView";
import { Card, Score } from "../ds";
import Icon from "../Icon";
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
    <div className="clx-edit-add">
      {!open && <button type="button" className="btn sm" onClick={() => { setOpen(true); setAdded(null); }}><Icon name="plus" size={14} />Add an edit request</button>}
      {open && (
        <form onSubmit={(e) => void submit(e)} className="clx-edit-form">
          <label htmlFor={`edit-${businessId}`} className="deal-field"><span>What does the client want changed?</span>
            <input id={`edit-${businessId}`} value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Change the phone number in the footer" />
            <small>It becomes a task on their Care project, with the edit checklist.</small>
          </label>
          <div className="ds-row">
            <button type="submit" className="btn primary sm" aria-disabled={busy || !title.trim()}>{busy ? "Adding…" : "Add request"}</button>
            <button type="button" className="btn sm" onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
          </div>
        </form>
      )}
      {added && <p className="clx-saved" role="status"><Icon name="check" size={14} />Added to this client’s Care tasks. <Link to={`/tasks/${encodeURIComponent(added)}`}>Open it</Link></p>}
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
  const tone = bar ? (bar.tone === "over" ? "critical" : bar.tone === "warn" ? "warning" : "signal") : "signal";
  return (
    <>
      {ledger && bar && (
        <Card icon="clock" title="Edit hours" note={periodLabel("monthly", ledger.month)}>
          <Score size="md" value={hours(ledger.usedMinutes)} unit={`of ${hours(ledger.allowanceMinutes)} used`} meter={{ value: bar.width, max: 100, tone }} />
          <p className={`clx-help${bar.tone === "over" ? " clx-bad" : ""}`} role="note" aria-label="Edit hours used this month">{bar.note || (ledger.usedMinutes === 0 ? "None used yet this month." : `${editHoursLine(ledger)}.`)} Extra time is quoted as a change order.</p>
          <AddEditRequest businessId={businessId} onAdded={load} />
        </Card>
      )}
      {(last || ledger) && last !== undefined && (
        <Card icon="file-text" title="Monthly report" flush>
          {last === null
            ? <div className="clx-calm"><span className="ds-tile neutral"><Icon name="file-text" size={15} /></span><span className="clx-setup-text"><b>No report yet</b><small>The first Care report is drafted at the start of next month, for you to approve.</small></span></div>
            : (
              <Link to="/care/reports" className="clx-proj">
                <span className={`ds-tile ${last.status === "sent" ? "positive" : "signal"}`}><Icon name="file-text" size={15} /></span>
                <span className="clx-setup-text">
                  <b>{periodLabel("monthly", last.period)}</b>
                  <small>{[last.sentOn ? `Sent ${dayLabel(last.sentOn) ?? last.sentOn}` : null, last.status === "sent" ? (last.views === 0 ? "not opened yet" : `opened ${last.views} ${last.views === 1 ? "time" : "times"}`) : null].filter(Boolean).join(" · ") || "All reports"}</small>
                </span>
                <span className={`badge2${statusTone(last.status) ? ` ${statusTone(last.status)}` : ""}`}><i className="dot" aria-hidden="true" />{statusChip(last.status)}</span>
                <Icon name="chevron-right" size={14} className="ds-chev" />
              </Link>
            )}
        </Card>
      )}
    </>
  );
}
