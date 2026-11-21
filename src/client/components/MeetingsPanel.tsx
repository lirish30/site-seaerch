import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { actionItemLines, changeOrderLines, countsLine, followupState, meetingRow } from "../meetingsView";
import { workError } from "../workData";
import type { MeetingDetailResponse, MeetingListItem } from "../../worker/routes/meetings";

const BADGE: Record<MeetingListItem["status"], string> = { summarized: "positive", received: "outline", failed: "warning" };

/** One meeting's summary, decisions, next steps, possible change orders and follow-up state. Loaded when it is first opened. */
function MeetingBody({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [data, setData] = useState<MeetingDetailResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(() => {
    api.get<MeetingDetailResponse>(`/meetings/${encodeURIComponent(id)}`).then((d) => { setData(d); setFailed(false); }).catch(() => setFailed(true));
  }, [id]);
  useEffect(load, [load]);

  async function again() {
    setBusy(true); setError(""); setNotice("");
    try { await api.post(`/meetings/${encodeURIComponent(id)}/summarize`); setNotice("Queued. The summary shows here when Claude has written it."); load(); onChanged(); }
    catch (e) { setError(workError(e, "Could not queue the summary.")); }
    finally { setBusy(false); }
  }

  if (failed && !data) return <p className="error small" role="alert">Couldn’t load this meeting. <button type="button" className="btn-plain" onClick={load}>Try again</button></p>;
  if (!data) return <p className="muted small">Loading…</p>;
  const m = data.meeting;
  const s = m.summary;
  const canAsk = m.status === "failed" || (m.status === "received" && !m.summarizing);
  const items = s ? actionItemLines(s) : [];
  const orders = s ? changeOrderLines(s) : [];

  return (
    <div className="cl-mt-body">
      {s ? <p className="wk-text">{s.summary}</p> : <p className="muted small">{m.summarizing ? "Claude is writing the summary." : "There is no summary yet."}</p>}
      {s && s.decisions.length > 0 && <><p className="wk-sub">Decided</p><ul className="cl-mt-list">{s.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
      {items.length > 0 && <><p className="wk-sub">Next steps</p><ul className="cl-mt-list">{items.map((l, i) => <li key={i}>{l}</li>)}</ul></>}
      {orders.length > 0 && <><p className="wk-sub">Possible change orders</p><ul className="cl-mt-list">{orders.map((l, i) => <li key={i}>{l}</li>)}</ul></>}
      <p className="small"><b>Follow-up email:</b> {followupState(m)}</p>
      {m.notes && <><p className="wk-sub">Meetily’s notes</p><p className="wk-text cl-mt-notes">{m.notes}</p></>}
      {canAsk && <button type="button" className="btn" disabled={busy} onClick={() => void again()}>{busy ? "Asking…" : "Summarize again"}</button>}
      {notice && <p className="muted small" role="status">{notice}</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}

/** A client's meetings, newest first: the one-line summary of each, and its full write-up when opened. Nothing here sends anything: the follow-up and any change-order drafts wait in Home as approvals. */
export default function MeetingsPanel({ businessId }: { businessId: string }) {
  const [meetings, setMeetings] = useState<MeetingListItem[] | null | false>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    let live = true;
    api.get<{ meetings: MeetingListItem[] }>(`/meetings?businessId=${encodeURIComponent(businessId)}`).then((r) => { if (live) setMeetings(r.meetings); }).catch(() => { if (live) setMeetings((prev) => prev || false); });
    return () => { live = false; };
  }, [businessId]);
  useEffect(() => { setMeetings(null); setOpen(null); return load(); }, [load]);

  return (
    <section className="cl-card" aria-label="Meetings">
      <h2>Meetings</h2>
      {meetings === null && <p className="muted small">Loading…</p>}
      {meetings === false && <p className="error small" role="alert">Couldn’t load the meetings. <button type="button" className="btn-plain" onClick={() => { setMeetings(null); load(); }}>Try again</button></p>}
      {Array.isArray(meetings) && meetings.length === 0 && <p className="muted small">No meetings recorded yet. Meetily recordings that match a booked call or a calendar event show up here.</p>}
      {Array.isArray(meetings) && meetings.length > 0 && (
        <ul className="cl-mt">
          {meetings.map((m) => {
            const row = meetingRow(m);
            const counts = countsLine(m);
            const isOpen = open === m.id;
            return (
              <li key={m.id} className="cl-mt-item">
                <div className="cl-mt-head">
                  <b className="cl-mt-title">{row.title}</b>
                  <span className={`badge2 ${BADGE[m.status]}`}><i className="dot" />{row.status}</span>
                </div>
                <p className="muted small cl-mt-when">{row.when}</p>
                <p className="small">{row.headline}</p>
                {counts && <p className="muted small">{counts}</p>}
                <button type="button" className="btn-plain" aria-expanded={isOpen} aria-controls={`mt-${m.id}`} onClick={() => setOpen(isOpen ? null : m.id)}>{isOpen ? "Hide details" : "Show details"}</button>
                {isOpen && <div id={`mt-${m.id}`}><MeetingBody id={m.id} onChanged={load} /></div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
