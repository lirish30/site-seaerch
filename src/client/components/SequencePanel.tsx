import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { ENROLLMENT_LABEL, ENROLLMENT_TONE, isLiveStatus, messageLabel, stepStatusText, stepTitle, type SequenceData } from "../sequenceView";
import { sinceLabel } from "../settingsView";
import Icon from "./Icon";
import InlineError from "./InlineError";
import { Badge } from "./Score";
import StartSequence from "./StartSequence";

interface Props {
  leadId: string; leadName: string;
  /** Turns "Start sequence…" off (a suppressed lead, no draft). */
  startDisabled?: boolean; startWhy?: string;
  beforeStart?: () => Promise<boolean>;
  /** Change this to reload the panel (the composer started a sequence). */
  refreshKey?: number;
  /** Called after a sequence was started or stopped here. */
  onChanged?: () => void;
}

/**
 * A lead's sequence: where it stands, each step with its state, the emails that went out and came in, and Stop. When the lead is not in a
 * live sequence it offers "Start sequence…" instead. Nothing here sends mail: a start only proposes Email 1 for approval on Home.
 */
export default function SequencePanel({ leadId, leadName, startDisabled, startWhy, beforeStart, refreshKey = 0, onChanged }: Props) {
  const [data, setData] = useState<SequenceData | null>(null);
  const [error, setError] = useState(""); const [stopping, setStopping] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.get<SequenceData>(`/leads/${leadId}/sequence`);
      if (alive.current) { setData(r); setError(""); }
    } catch (e) { if (alive.current) setError(e instanceof ApiError ? e.message : "Couldn't load the sequence."); }
  }, [leadId]);
  useEffect(() => { setData(null); void load(); }, [load, refreshKey]);

  async function stop() {
    if (!window.confirm(`Stop the sequence for ${leadName}? Any email waiting for your OK is rejected and nothing more is proposed. You can start it again later.`)) return;
    setStopping(true); setError("");
    try { await api.post(`/leads/${leadId}/sequence/stop`); await load(); onChanged?.(); }
    catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message || "Couldn't stop the sequence."); }
    finally { if (alive.current) setStopping(false); }
  }
  async function started() { await load(); onChanged?.(); }

  if (!data) return error ? <InlineError message={error} /> : <p className="muted small">Loading…</p>;
  const e = data.enrollment, live = !!e && isLiveStatus(e.status), now = new Date();
  return (
    <div className="seq-panel">
      {e ? (
        <>
          <div className="seq-head">
            <b>{e.campaign_name ?? "Sequence"}</b>
            <Badge tone={ENROLLMENT_TONE[e.status]} dot>{ENROLLMENT_LABEL[e.status]}</Badge>
          </div>
          <p className="prop-note">To {e.to_email} · started {sinceLabel(e.started_at, now)}{e.stopped_reason && !live ? ` · ${e.stopped_reason}` : ""}</p>
          {e.last_error && live && <p className="error small"><Icon name="alert" size={14} /> {e.last_error}</p>}
          <ol className="seq-steps" aria-label="Steps">
            {data.steps.map((v) => (
              <li key={v.step.id} className={`seq-step ${v.state}`}>
                <span className="seq-name">{stepTitle(data.steps, v.step.idx)}</span>
                <span className="seq-state">{stepStatusText(v, now)}</span>
              </li>
            ))}
          </ol>
          {live && <button type="button" className="btn danger sm seq-stop" onClick={() => void stop()} disabled={stopping}><Icon name="ban" size={14} />{stopping ? "Stopping…" : "Stop sequence"}</button>}
        </>
      ) : <p className="muted small">Not in a sequence.</p>}
      {!live && <StartSequence leadId={leadId} disabled={startDisabled} why={startWhy} beforeStart={beforeStart} onStarted={() => void started()} />}
      <InlineError message={error} />
      {data.messages.length > 0 && (
        <div className="seq-msgs">
          <h4>Emails</h4>
          <ul aria-label="Emails">
            {data.messages.map((m) => (
              <li key={m.id} className={`seq-msg ${m.direction}`}>
                <span className="seq-dir"><Icon name={m.direction === "out" ? "arrow-up-right" : "arrow-right"} size={13} />{messageLabel(m)}</span>
                <span className="seq-subj" title={m.text}>{m.subject || "(no subject)"}</span>
                <time dateTime={m.sent_at ?? m.created_at} title={new Date(m.sent_at ?? m.created_at).toLocaleString()}>{sinceLabel(m.sent_at ?? m.created_at, now)}</time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
