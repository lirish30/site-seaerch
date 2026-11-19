import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { VideoPlan } from "../../../worker/video/plan";
import Icon from "../Icon";

type Phase = "idle" | "recording" | "sending";

const MIME = "audio/webm";
const canRecord = () => typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && MediaRecorder.isTypeSupported(MIME);

/**
 * Records one line from the microphone and sends it. The browser measures how long the take ran (a webm file carries no length of its own) and
 * the server stores it against the line's current words. Stopping sends it straight away: there is no preview step, the player beside the line does that.
 */
export default function RecordButton({ videoId, segId, again, disabled, onSaved, onError }: {
  videoId: string; segId: string; again: boolean; disabled: boolean; onSaved: (plan: VideoPlan) => void; onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearInterval(tick.current); recorder.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  if (!canRecord()) return <span className="vd-note">This browser can't record. Use Chrome or Edge.</span>;

  async function start() {
    onError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: MIME });
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = () => void send(stream);
      recorder.current = rec;
      started.current = performance.now();
      rec.start();
      setSeconds(0); setPhase("recording");
      tick.current = setInterval(() => setSeconds(Math.round((performance.now() - started.current) / 1000)), 500);
    } catch {
      onError("The microphone isn't available. Allow it for this site and try again.");
    }
  }
  function stop() { clearInterval(tick.current); recorder.current?.stop(); }

  async function send(stream: MediaStream) {
    const ms = Math.round(performance.now() - started.current);
    stream.getTracks().forEach((t) => t.stop());
    if (!alive.current) return;
    setPhase("sending");
    try {
      const { plan } = await api.putRaw<{ plan: VideoPlan }>(`/video-audits/${videoId}/segments/${segId}/recording`, new Blob(chunks.current, { type: MIME }), { "content-type": MIME, "x-duration-ms": String(ms) });
      if (alive.current) onSaved(plan);
    } catch (e) {
      if (alive.current) onError(e instanceof ApiError ? e.message : "The recording didn't save. Try again.");
    } finally { if (alive.current) setPhase("idle"); }
  }

  return phase === "recording"
    ? <button type="button" className="btn sm danger-ghost" onClick={stop}><span className="vd-rec-dot" aria-hidden="true" />Stop ({seconds}s)</button>
    : <button type="button" className="btn sm" onClick={() => void start()} disabled={disabled || phase === "sending"}><Icon name="zap" size={13} />{phase === "sending" ? "Saving…" : again ? "Record again" : "Record"}</button>;
}
