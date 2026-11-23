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
  const dirty = video !== (o.welcomeVideoUrl ?? "") || kickoff !== kickoffToInput(o.kickoffAt);

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
    <form className="ds-form slx-owner-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="deal-field wide"><span>Welcome video link</span>
        <input type="url" maxLength={300} value={video} disabled={closed} placeholder="https://www.loom.com/share/…" aria-invalid={!!problem && !!videoProblem(video)} onChange={(e) => { setVideo(e.target.value); setProblem(""); }} />
        <small>{o.welcomeSentAt ? "The welcome has gone out. A new link shows on the client’s page but is not mailed again." : "An https link anyone can open, like Loom."}</small></label>
      <label className="deal-field wide slx-mid"><span>Kickoff call</span>
        <input type="datetime-local" value={kickoff} disabled={closed} onChange={(e) => { setKickoff(e.target.value); setProblem(""); }} /></label>
      {problem && <p className="slx-error wide" role="alert">{problem}</p>}
      <div className="ds-form-actions"><button type="submit" className="btn sm primary" disabled={closed || !dirty}>Save video and kickoff</button></div>
    </form>
  );
}
