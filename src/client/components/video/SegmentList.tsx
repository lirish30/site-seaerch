import { useState } from "react";
import { api, ApiError } from "../../api";
import { hashText, wordCount, type Segment, type VideoPlan } from "../../../worker/video/plan";
import { clock, expectedSeconds, lineTimeline, lineVoice, setSegmentShot, setSegmentText, shotLabel } from "../../videoView";
import { Chip } from "../ds";
import RecordButton from "./RecordButton";

/**
 * The script panel's list (Figma 59:4263 "Script"): one row per line with its start time, name, markers and words. The selected line opens to
 * edit its words, pick its screenshot and record it. `tab="voice"` lists every line's voice instead, each with its recorder.
 * Typing changes the plan at once; leaving a field saves it (`onCommit`). A recording belongs to the words it was made from: edit the words and
 * the recording is gone, so the row says so.
 */
export default function SegmentList({ videoId, plan, selectedId, readOnly, tab = "script", onSelect, onChange, onCommit, onPlan, onError }: {
  videoId: string; plan: VideoPlan; selectedId: string | null; readOnly: boolean; tab?: "script" | "voice";
  onSelect: (id: string) => void; onChange: (seg: Segment) => void; onCommit: () => void; onPlan: (saved: VideoPlan) => void; onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const times = lineTimeline(plan);

  async function useClone(segId: string) {
    setBusy(segId); onError("");
    try { onPlan((await api.del<{ plan: VideoPlan }>(`/video-audits/${videoId}/segments/${segId}/recording`)).plan); }
    catch (e) { onError(e instanceof ApiError ? e.message : "Couldn't remove the recording."); }
    finally { setBusy(""); }
  }

  const voiceRow = (seg: Segment, i: number) => {
    const recorded = seg.audio?.source === "recorded" && seg.audio.textHash === hashText(seg.text);
    const n = wordCount(seg.text);
    return (
      <div className="hox-vd-voice">
        {recorded && <audio controls preload="none" src={`/api/video-audits/${videoId}/segments/${seg.id}/recording?v=${seg.audio!.textHash}-${plan.version}`} aria-label={`Your recording of line ${i + 1}`} />}
        {!readOnly && <RecordButton videoId={videoId} segId={seg.id} again={recorded} disabled={n === 0 || !!busy} onSaved={onPlan} onError={onError} />}
        {!readOnly && recorded && plan.narration === "clone" && <button type="button" className="btn sm" disabled={busy === seg.id} onClick={() => void useClone(seg.id)}>Use the cloned voice instead</button>}
      </div>
    );
  };

  return (
    <ol className="hox-vd-lines" aria-label={tab === "voice" ? "Voice for each line" : "Script lines"}>
      {plan.segments.map((seg, i) => {
        const voice = lineVoice(seg, plan.narration);
        const n = wordCount(seg.text);
        const on = seg.id === selectedId;
        const t = times[i];
        const marks = seg.markups.length;
        return (
          <li key={seg.id} className={`hox-vd-line${on ? " on" : ""}`}>
            <button type="button" className="hox-vd-line-head" aria-expanded={tab === "script" ? on : undefined} onClick={() => onSelect(seg.id)}>
              <time>{clock(t.start)}</time>
              <b>{t.name}</b>
              <span className="ds-grow" />
              {tab === "voice" || voice.needsWork
                ? <Chip tone={voice.needsWork ? "warning" : "positive"} dot>{voice.label}</Chip>
                : marks > 0 ? <Chip tone="positive">{marks} {marks === 1 ? "marker" : "markers"}</Chip> : null}
            </button>
            {tab === "script" && !on && <p className="hox-vd-quote" onClick={() => onSelect(seg.id)}>“{seg.text.trim() || "No words yet"}”</p>}
            {tab === "script" && on && (
              <div className="hox-vd-edit">
                <textarea className="hox-vd-text" rows={4} value={seg.text} readOnly={readOnly} aria-label={`${t.name} words`}
                  onChange={(e) => onChange(setSegmentText(seg, e.target.value))} onBlur={onCommit} />
                <div className="hox-vd-edit-row">
                  <span className="ds-help">{n} words · about {expectedSeconds(seg.text)} seconds</span>
                  <label className="hox-vd-shot">
                    <span>Screenshot</span>
                    <select className="hox-vd-sel" value={seg.shotId} disabled={readOnly} onChange={(e) => { onChange(setSegmentShot(seg, e.target.value)); onSelect(seg.id); onCommit(); }}>
                      {plan.shots.map((s) => <option key={s.id} value={s.id}>{shotLabel(plan.shots, s.id)}</option>)}
                      {!plan.shots.some((s) => s.id === seg.shotId) && <option value={seg.shotId}>{seg.shotId} (missing)</option>}
                    </select>
                  </label>
                </div>
                {!readOnly && <div className="hox-vd-edit-voice"><Chip tone={voice.needsWork ? "warning" : "positive"} dot>{voice.label}</Chip>{voiceRow(seg, i)}</div>}
              </div>
            )}
            {tab === "voice" && voiceRow(seg, i)}
          </li>
        );
      })}
    </ol>
  );
}
