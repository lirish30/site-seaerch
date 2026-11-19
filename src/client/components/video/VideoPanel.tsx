import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api";
import { pollDelay } from "../../poll";
import { canCancel, canUnpublish, isOpen, lastAttemptNotice, videoStateLine } from "../../videoView";
import { watchedLine } from "../../videoViewsView";
import InlineError from "../InlineError";

interface Latest { video: { id: string; status: string; error: string | null } | null; helperOnline?: boolean; watched?: { maxPct: number; lastAt: string } | null }
const WATCHING = new Set(["capturing", "scripting", "producing"]);

/**
 * The lead's "Video audit" section: where the newest video stands, and the one button that fits (make one, open it, or open it to review).
 * Starting one needs a full audit of a site that loaded; the page passes whether the lead has that.
 */
export default function VideoPanel({ leadId, canStart, whyNot }: { leadId: string; canStart: boolean; whyNot: string }) {
  const nav = useNavigate();
  const [data, setData] = useState<Latest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [tick, setTick] = useState(0);
  const failures = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    const r = await api.get<Latest>(`/leads/${leadId}/video`);
    if (alive.current) { setData(r); setError(""); }
  }, [leadId]);
  useEffect(() => { setData(null); load().catch((e) => { if (alive.current) setError(e instanceof ApiError ? e.message : "Couldn't load the video."); }); }, [load]);

  const status = data?.video?.status;
  useEffect(() => {
    if (!status || !WATCHING.has(status)) return;
    const t = setTimeout(() => load().then(() => { failures.current = 0; }).catch(() => { failures.current++; }).finally(() => setTick((n) => n + 1)), pollDelay(failures.current));
    return () => clearTimeout(t);
  }, [status, tick, load]);

  async function start() {
    setBusy("start"); setError("");
    try { await api.post(`/leads/${leadId}/video`, {}); nav(`/leads/${leadId}/video`); }
    catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the video.");
      if (e instanceof ApiError && e.status === 409) await load().catch(() => {});
    } finally { if (alive.current) setBusy(""); }
  }
  async function cancel() {
    if (!data?.video || !window.confirm("Cancel this video? It can't be made or published afterwards. You can start another.")) return;
    setBusy("cancel"); setError("");
    try { await api.post(`/video-audits/${data.video.id}/cancel`); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't cancel the video."); await load().catch(() => {}); }
    finally { if (alive.current) setBusy(""); }
  }

  async function unpublish() {
    if (!data?.video || !window.confirm("Unpublish this video? It goes off the report page right away, and an email that already went out will show a broken picture. You can make another video afterwards.")) return;
    setBusy("unpublish"); setError("");
    try { await api.post(`/video-audits/${data.video.id}/unpublish`); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't unpublish the video."); await load().catch(() => {}); }
    finally { if (alive.current) setBusy(""); }
  }

  if (!data) return error ? <InlineError message={error} /> : <p className="muted small">Loading…</p>;
  const v = data.video;
  const line = v ? videoStateLine({ status: v.status, jobs: [], helperOnline: !!data.helperOnline, error: v.error }) : "";
  const open = !!v && isOpen(v.status);
  const attempt = v ? lastAttemptNotice(v.status, v.error) : "";
  return (
    <div className="vd-panel">
      {v && (line ? <p className="prop-note" role="status">{line}</p> : <p className="prop-note" role="status">The script is ready for your edits.</p>)}
      {attempt && <p className="prop-note" role="status">{attempt}</p>}
      {data.watched && <p className="prop-note" role="status">{watchedLine(data.watched, new Date())}</p>}
      {!v && <p className="prop-note">A short narrated screen recording of what is wrong with their site.</p>}
      <div className="btn-row nowrap">
        {v && (open || v.status === "published") && <Link className="btn" to={`/leads/${leadId}/video`}>{v.status === "review" ? "Edit the script" : "Open the video"}</Link>}
        {(!v || !open) && v?.status !== "published" && (
          <button type="button" className="btn primary" onClick={() => void start()} disabled={!canStart || busy === "start"} title={canStart ? undefined : whyNot}>
            {busy === "start" ? "Starting…" : v ? "Make another video" : "Make a video audit"}
          </button>
        )}
        {v && canCancel(v.status) && <button type="button" className="btn" onClick={() => void cancel()} disabled={!!busy}>Cancel video</button>}
        {v && canUnpublish(v.status) && <button type="button" className="btn" onClick={() => void unpublish()} disabled={!!busy}>{busy === "unpublish" ? "Unpublishing…" : "Unpublish"}</button>}
      </div>
      {!canStart && (!v || !open) && <p className="prop-note">{whyNot}</p>}
      <InlineError message={error} />
    </div>
  );
}
