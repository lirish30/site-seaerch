import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { pollDelay } from "../poll";
import type { Segment, VideoPlan } from "../../worker/video/plan";
import { approveBlockers, canCancel, editorMode, isWatching, mergeSaved, replaceSegment, scriptSummary, videoStateLine, type VideoResponse } from "../videoView";
import Icon from "../components/Icon";
import { Badge } from "../components/Score";
import ShotCanvas from "../components/video/ShotCanvas";
import SegmentList from "../components/video/SegmentList";

type Save = "idle" | "saving" | "saved" | "failed";

/**
 * A lead's video before it is made: the script on the left (words, screenshot and voice for each line), the screenshot with its markups on the right.
 * Edits save when a field loses focus or a markup is let go. The video can be changed only while it is in review; in any other state the page shows
 * the plan as it is and where the video stands.
 */
export default function VideoEditor() {
  const { id: leadId } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<VideoResponse | null>(null);
  const [none, setNone] = useState(false);
  const [plan, setPlanState] = useState<VideoPlan | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [save, setSave] = useState<Save>("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [blockers, setBlockers] = useState<string[] | null>(null); // the server's list, after an approve it refused
  const [note, setNote] = useState("");
  const [tick, setTick] = useState(0);
  const planRef = useRef<VideoPlan | null>(null);
  const dirty = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const failures = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const setPlan = useCallback((p: VideoPlan | null) => { planRef.current = p; setPlanState(p); }, []);

  const load = useCallback(async (keepEdits: boolean) => {
    const latest = await api.get<{ video: { id: string } | null }>(`/leads/${leadId}/video`);
    if (!alive.current) return;
    if (!latest.video) { setNone(true); return; }
    const r = await api.get<VideoResponse>(`/video-audits/${latest.video.id}`);
    if (!alive.current) return;
    setData(r);
    // Never replace what is being typed with an older copy: while there are unsaved edits only the server-owned parts (version, audio) come in.
    if (r.plan && !(keepEdits && dirty.current && planRef.current)) setPlan(r.plan);
    else if (r.plan && planRef.current) setPlan(mergeSaved(planRef.current, r.plan));
    setSelected((s) => s ?? r.plan?.segments[0]?.id ?? null);
  }, [leadId, setPlan]);

  useEffect(() => { setData(null); setNone(false); setPlan(null); load(false).catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load the video.")); }, [leadId, load, setPlan]);

  // While the video is being made or waiting on Claude the status can change under us; a failed poll backs off.
  const status = data?.video.status;
  useEffect(() => {
    if (!status || !isWatching(status)) return;
    const t = setTimeout(() => load(true).then(() => { failures.current = 0; }).catch(() => { failures.current++; }).finally(() => setTick((n) => n + 1)), pollDelay(failures.current));
    return () => clearTimeout(t);
  }, [status, tick, load]);

  const videoId = data?.video.id;
  const mode = data ? editorMode(data.video.status, plan) : "state";
  const editable = mode === "edit";

  /** Saves the plan as it is now. Saves run one after another so a slow one never lands after a newer one. */
  const commit = useCallback((): Promise<void> => {
    chain.current = chain.current.then(async () => {
      if (!dirty.current || !videoId || !planRef.current) return;
      const sent = planRef.current;
      dirty.current = false;
      setSave("saving");
      try {
        const r = await api.put<{ plan: VideoPlan }>(`/video-audits/${videoId}/plan`, { segments: sent.segments, narration: sent.narration, version: sent.version });
        if (!alive.current) return;
        setPlan(mergeSaved(planRef.current ?? sent, r.plan));
        setSave("saved"); setError("");
      } catch (e) {
        dirty.current = true;
        if (alive.current) { setSave("failed"); setError(e instanceof ApiError ? `Not saved: ${e.message}` : "Not saved: request failed."); }
      }
    });
    return chain.current;
  }, [videoId, setPlan]);

  const edit = useCallback((next: VideoPlan) => { dirty.current = true; setPlan(next); setSave("idle"); setBlockers(null); }, [setPlan]);
  const editSegment = useCallback((seg: Segment) => { if (planRef.current) edit(replaceSegment(planRef.current, seg)); }, [edit]);
  // A recording or a removed one is already saved by its own request; fold in what the server now has.
  const serverPlan = useCallback((saved: VideoPlan) => { if (planRef.current) setPlan(mergeSaved(planRef.current, saved)); else setPlan(saved); setBlockers(null); }, [setPlan]);

  const live = useMemo(() => (plan && data ? approveBlockers(plan, data.findingCodes) : []), [plan, data]);
  const summary = useMemo(() => (plan ? scriptSummary(plan) : null), [plan]);
  const stateLine = data ? videoStateLine({ status: data.video.status, jobs: data.jobs, helperOnline: data.helperOnline, error: data.video.error }) : "";
  const current = plan?.segments.find((s) => s.id === selected) ?? plan?.segments[0];
  const shot = current && plan ? plan.shots.find((s) => s.id === current.shotId) : undefined;

  async function act(name: string, fn: () => Promise<unknown>, after?: () => void | Promise<void>) {
    setBusy(name); setError("");
    try { await fn(); await after?.(); }
    catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else setError("Request failed.");
      await load(true).catch(() => {});
    } finally { if (alive.current) setBusy(""); }
  }

  const approve = () => act("approve", async () => {
    await commit();
    if (dirty.current) throw new ApiError(409, "Fix what stopped the save first.");
    try { await api.post(`/video-audits/${videoId}/approve`); }
    catch (e) {
      // The server checks again and names what is still in the way.
      const list = (e as ApiError).body && ((e as ApiError).body as { blockers?: unknown }).blockers;
      if (e instanceof ApiError && Array.isArray(list)) setBlockers(list.map(String));
      throw e;
    }
  }, () => load(false));

  const regenerate = () => {
    if (!window.confirm("Claude will write a new script in your next queue session and it will replace this one, including your edits. Continue?")) return;
    void act("regen", async () => { await commit(); await api.post(`/video-audits/${videoId}/regenerate-script`, note.trim() ? { steeringNote: note.trim() } : {}); }, () => load(false));
  };
  const writeMyself = () => act("keep", () => api.post(`/video-audits/${videoId}/keep-script`), () => load(false));
  const cancel = () => {
    if (!window.confirm("Cancel this video? It can't be made or published afterwards. You can start another from the lead.")) return;
    void act("cancel", () => api.post(`/video-audits/${videoId}/cancel`), () => nav(`/leads/${leadId}`));
  };

  const back = <Link to={`/leads/${leadId}`} className="vd-back"><Icon name="chevron-left" size={14} />{data?.business?.name ?? "Lead"}</Link>;

  if (none) return (
    <>
      <header className="page-header"><div>{back}<h1>Video audit</h1></div></header>
      <div className="page-body"><div className="card"><p>This lead has no video yet. Start one from the Video audit panel on the lead.</p></div></div>
    </>
  );
  if (!data) return <div className="page-body">{error ? <p className="error" role="alert">{error}</p> : <p>Loading…</p>}</div>;

  const waitingForNewScript = data.video.status === "scripting" && mode !== "state";
  const shown = blockers ?? live;
  return (
    <>
      <header className="page-header vd-header">
        <div>
          {back}
          <h1>Video audit</h1>
          {stateLine && <p className="vd-state" role="status">{stateLine}</p>}
        </div>
        <div className="vd-header-actions">
          {mode !== "state" && summary && <span className={`vd-summary${summary.inWindow ? "" : " off"}`} title="The video should run 80 to 130 seconds">{summary.words} words · about {summary.seconds} seconds{summary.inWindow ? "" : " (outside 80 to 130)"}</span>}
          <span className="vd-save" aria-live="polite">{save === "saving" ? "Saving…" : save === "saved" ? "Saved" : save === "failed" ? "Not saved" : ""}</span>
          {canCancel(data.video.status) && <button type="button" className="btn" onClick={cancel} disabled={!!busy}>Cancel video</button>}
          {editable && <button type="button" className="btn primary" onClick={() => void approve()} disabled={!!busy || shown.length > 0 || save === "saving"} aria-describedby="vd-blockers">{busy === "approve" ? "Approving…" : "Approve and make the video"}</button>}
        </div>
      </header>

      <div className="page-body vd-body">
        {error && <p className="error" role="alert">{error}</p>}
        {waitingForNewScript && (
          <div className="notice" role="status">
            <span><Icon name="clock" size={14} /> Claude is writing a new script. It arrives in your next queue session and will replace this one.</span>
            <button type="button" className="btn sm" onClick={() => void writeMyself()} disabled={!!busy}>Write it myself</button>
          </div>
        )}
        {mode === "state" && !stateLine && <div className="card"><p>There is no script to edit yet.</p></div>}

        {mode !== "state" && plan && (
          <div className="vd-split">
            <section className="vd-left" aria-label="Script">
              {editable && (
                <div className="vd-narration">
                  <label htmlFor="vd-narration">Who speaks</label>
                  <select id="vd-narration" value={plan.narration} onChange={(e) => { edit({ ...plan, narration: e.target.value as VideoPlan["narration"] }); void commit(); }}>
                    <option value="recorded">I record every line</option>
                    <option value="clone">My cloned voice (record a line to use your own)</option>
                  </select>
                </div>
              )}
              <SegmentList videoId={data.video.id} plan={plan} selectedId={current?.id ?? null} readOnly={!editable} onSelect={setSelected} onChange={editSegment} onCommit={() => void commit()} onPlan={serverPlan} onError={setError} />
              {editable && (
                <details className="vd-regen">
                  <summary>Write a different script</summary>
                  <label htmlFor="vd-note" className="vd-note">What should change? (optional)</label>
                  <textarea id="vd-note" rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Lead with the speed problem" />
                  <button type="button" className="btn sm" onClick={regenerate} disabled={!!busy}>Ask Claude for a new script</button>
                </details>
              )}
            </section>
            <section className="vd-right" aria-label="Screenshot">
              {current && shot
                ? <ShotCanvas key={`${current.id}:${shot.id}`} videoId={data.video.id} shot={shot} segment={current} readOnly={!editable} onChange={editSegment} onCommit={() => void commit()} />
                : <p className="vd-note">This line uses a screenshot that isn't in the video. Choose another for it.</p>}
            </section>
          </div>
        )}

        {editable && (
          <div id="vd-blockers" className="vd-blockers" aria-live="polite">
            {shown.length === 0 ? <Badge tone="positive" dot>Ready to approve</Badge> : (
              <>
                <b>Before you can approve:</b>
                <ul>{shown.map((b, i) => <li key={i}>{b}</li>)}</ul>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
