import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { actionItemLines, canSummarizeAgain, changeOrderLines, countsLine, followupState, meetingRow } from "../meetingsView";
import { workError } from "../workData";
import Icon from "./Icon";
import type { MeetingDetailResponse, MeetingListItem } from "../../worker/routes/meetings";

const BADGE: Record<MeetingListItem["status"], string> = { summarized: "positive", received: "outline", failed: "warning" };
const TILE: Record<MeetingListItem["status"], string> = { summarized: "info", received: "neutral", failed: "warning" };

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
  const canAsk = canSummarizeAgain(m);
  const items = s ? actionItemLines(s) : [];
  const orders = s ? changeOrderLines(s) : [];

  return (
    <div className="cl-mt-body clx-lead-mt-body">
      {s ? <p className="clx-lead-mt-sum">{s.summary}</p> : <p className="muted small">{m.summarizing ? "Claude is writing the summary." : "There is no summary yet."}</p>}
      {s && s.decisions.length > 0 && <><p className="clx-lead-over">Decided</p><ul className="cl-mt-list">{s.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
      {items.length > 0 && <><p className="clx-lead-over">Next steps</p><ul className="cl-mt-list">{items.map((l, i) => <li key={i}>{l}</li>)}</ul></>}
      {orders.length > 0 && <><p className="clx-lead-over">Possible change orders</p><ul className="cl-mt-list">{orders.map((l, i) => <li key={i}>{l}</li>)}</ul></>}
      <p className="clx-lead-mt-follow"><Icon name="send" size={13} />Follow-up email: {followupState(m)}</p>
      {m.notes && <><p className="clx-lead-over">Meetily’s notes</p><p className="cl-mt-notes">{m.notes}</p></>}
      {canAsk && <button type="button" className="btn sm" disabled={busy} onClick={() => void again()}><Icon name="sparkles" size={14} />{busy ? "Asking…" : "Summarize again"}</button>}
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

  const count = Array.isArray(meetings) ? meetings.length : 0;
  return (
    <section className="ds-card clx-lead-mt" aria-label="Meetings">
      <header className="ds-card-head"><Icon name="calendar" size={16} /><h2>Meetings</h2>{count > 0 && <span className="ds-card-note">{count} recorded</span>}</header>
      {meetings === null && <p className="clx-lead-mt-pad muted small">Loading…</p>}
      {meetings === false && <p className="clx-lead-mt-pad error small" role="alert">Couldn’t load the meetings. <button type="button" className="btn-plain" onClick={() => { setMeetings(null); load(); }}>Try again</button></p>}
      {Array.isArray(meetings) && meetings.length === 0 && (
        <div className="clx-lead-mt-empty">
          <span className="ds-tile neutral"><Icon name="calendar" size={16} /></span>
          <span><b>No meetings recorded yet</b><small>When you record a call in Meetily and it matches a booked call or a calendar event, Claude writes up what was decided and drafts the follow-up here.</small></span>
        </div>
      )}
      {Array.isArray(meetings) && meetings.length > 0 && (
        <ul className="cl-mt clx-lead-mt-list">
          {meetings.map((m) => {
            const row = meetingRow(m);
            const counts = countsLine(m);
            const isOpen = open === m.id;
            return (
              <li key={m.id} className="cl-mt-item">
                <button type="button" className="clx-lead-mt-row" aria-expanded={isOpen} aria-controls={`mt-${m.id}`} onClick={() => setOpen(isOpen ? null : m.id)}>
                  <span className={`ds-tile ${TILE[m.status]}`} aria-hidden="true"><Icon name="calendar" size={16} /></span>
                  <span className="clx-lead-mt-text">
                    <span className="clx-lead-mt-title"><b>{row.title}</b><span className={`ds-chip ${BADGE[m.status]}`}><i className="ds-dot" aria-hidden="true" />{row.status}</span></span>
                    <small>{[row.when, counts].filter(Boolean).join(" · ")}</small>
                    {row.headline && <span className="clx-lead-mt-head">{row.headline}</span>}
                  </span>
                  <Icon name="chevron-down" size={14} className={`clx-lead-mt-chev${isOpen ? " open" : ""}`} />
                </button>
                {isOpen && <div id={`mt-${m.id}`}><MeetingBody id={m.id} onChanged={load} /></div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
