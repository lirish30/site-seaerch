import { useState } from "react";
import { api, ApiError } from "../../api";
import { hashText, wordCount, type Segment, type VideoPlan } from "../../../worker/video/plan";
import { expectedSeconds, lineVoice, roleLabel, setSegmentShot, setSegmentText, shotLabel } from "../../videoView";
import { Badge } from "../Score";
import RecordButton from "./RecordButton";

/**
 * The script, one card per line: its words, its screenshot, and who says it. Typing changes the plan at once; leaving a field saves it (`onCommit`).
 * A recording belongs to the words it was made from: edit the words and the recording is gone, so the card says so.
 */
export default function SegmentList({ videoId, plan, selectedId, readOnly, onSelect, onChange, onCommit, onPlan, onError }: {
  videoId: string; plan: VideoPlan; selectedId: string | null; readOnly: boolean;
  onSelect: (id: string) => void; onChange: (seg: Segment) => void; onCommit: () => void; onPlan: (saved: VideoPlan) => void; onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState("");

  async function useClone(segId: string) {
    setBusy(segId); onError("");
    try { onPlan((await api.del<{ plan: VideoPlan }>(`/video-audits/${videoId}/segments/${segId}/recording`)).plan); }
    catch (e) { onError(e instanceof ApiError ? e.message : "Couldn't remove the recording."); }
    finally { setBusy(""); }
  }

  return (
    <ol className="vd-lines">
      {plan.segments.map((seg, i) => {
        const voice = lineVoice(seg, plan.narration);
        const recorded = seg.audio?.source === "recorded" && seg.audio.textHash === hashText(seg.text);
        const n = wordCount(seg.text);
        return (
          <li key={seg.id} className={`vd-line${seg.id === selectedId ? " on" : ""}`}>
            <div className="vd-line-head" onClick={() => onSelect(seg.id)}>
              <span className="vd-line-n">Line {i + 1}</span>
              <Badge tone="neutral">{roleLabel(seg.role)}</Badge>
              <span className="grow" />
              <Badge tone={voice.needsWork ? "warning" : "positive"} dot>{voice.label}</Badge>
            </div>
            <textarea className="vd-text" rows={4} value={seg.text} readOnly={readOnly} aria-label={`Line ${i + 1} words`}
              onFocus={() => onSelect(seg.id)} onChange={(e) => onChange(setSegmentText(seg, e.target.value))} onBlur={onCommit} />
            <div className="vd-line-row">
              <span className="vd-note">{n} words, about {expectedSeconds(seg.text)} seconds</span>
              <label className="vd-shot">
                <span className="sr-only">Screenshot for line {i + 1}</span>
                <select value={seg.shotId} disabled={readOnly} onChange={(e) => { onChange(setSegmentShot(seg, e.target.value)); onSelect(seg.id); onCommit(); }}>
                  {plan.shots.map((s) => <option key={s.id} value={s.id}>{shotLabel(plan.shots, s.id)}</option>)}
                  {!plan.shots.some((s) => s.id === seg.shotId) && <option value={seg.shotId}>{seg.shotId} (missing)</option>}
                </select>
              </label>
            </div>
            <div className="vd-voice">
              {recorded && <audio controls preload="none" src={`/api/video-audits/${videoId}/segments/${seg.id}/recording?v=${seg.audio!.textHash}-${plan.version}`} aria-label={`Your recording of line ${i + 1}`} />}
              {!readOnly && <RecordButton videoId={videoId} segId={seg.id} again={recorded} disabled={n === 0 || !!busy} onSaved={onPlan} onError={onError} />}
              {!readOnly && recorded && plan.narration === "clone" && <button type="button" className="btn sm" disabled={busy === seg.id} onClick={() => void useClone(seg.id)}>Use the cloned voice instead</button>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
