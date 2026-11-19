import { useState } from "react";
import { api } from "../../api";
import { kickoffFromInput, kickoffToInput, videoProblem } from "../../onboardingView";
import type { OwnerOnboarding } from "../../../worker/onboarding/owner";
import type { Act } from "./shared";

/** The welcome video's link and the kickoff time. Changing the video after the welcome went out does not send it again. */
export default function OwnerFields({ o, act }: { o: OwnerOnboarding; act: Act }) {
  const [video, setVideo] = useState(o.welcomeVideoUrl ?? "");
  const [kickoff, setKickoff] = useState(kickoffToInput(o.kickoffAt));
  const [problem, setProblem] = useState("");
  const closed = !!o.closedAt;

  const save = () => {
    const bad = videoProblem(video);
    const at = kickoffFromInput(kickoff);
    if (bad) { setProblem(bad); return; }
    if (at === "invalid") { setProblem("That is not a date and time."); return; }
    setProblem("");
    return act(async () => {
      const out = await api.patch<{ onboarding: OwnerOnboarding }>(`/onboardings/${o.id}`, { welcomeVideoUrl: video.trim() || null, kickoffAt: at });
      setVideo(out.onboarding.welcomeVideoUrl ?? "");
      setKickoff(kickoffToInput(out.onboarding.kickoffAt));
    }, "Saved.");
  };

  return (
    <div>
      <div className="field-row">
        <label className="deal-field"><span>Welcome video link (https, anyone can open it)</span>
          <input type="url" maxLength={300} value={video} disabled={closed} placeholder="https://www.loom.com/share/…" onChange={(e) => { setVideo(e.target.value); setProblem(""); }} /></label>
        <label className="deal-field"><span>Kickoff call</span>
          <input type="datetime-local" value={kickoff} disabled={closed} onChange={(e) => { setKickoff(e.target.value); setProblem(""); }} /></label>
      </div>
      {o.welcomeSentAt && <p className="muted small">The welcome has gone out. A new video link shows on the client's page but is not mailed again.</p>}
      {problem && <p className="warn small" role="alert">{problem}</p>}
      <div className="cp-actions"><button type="button" className="btn-ghost-sm" disabled={closed} onClick={save}>Save video and kickoff</button></div>
    </div>
  );
}
