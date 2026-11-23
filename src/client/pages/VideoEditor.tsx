import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { pollDelay } from "../poll";
import type { Segment, VideoPlan } from "../../worker/video/plan";
import { approveBlockers, canCancel, canReopen, canUnpublish, clock, editorMode, hasPlayer, isWatching, lastAttemptNotice, lineTimeline, lineVoice, mergeSaved, publishState, replaceSegment, scriptSummary, shotLabel, statusChip, videoStateLine, type VideoResponse } from "../videoView";
import Icon from "../components/Icon";
import { Banner, Card, Chip, Empty, PageHeader, Seg } from "../components/ds";
import { SwitchRow } from "../components/StepFields";
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
  const [tab, setTab] = useState<"script" | "voice">("script");
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
  const unpublish = () => {
    if (!window.confirm("Unpublish this video? It goes off the report page right away, and an email that already went out will show a broken picture. You can make another video afterwards.")) return;
    void act("unpublish", () => api.post(`/video-audits/${videoId}/unpublish`), () => load(false));
  };
  const writeMyself = () => act("keep", () => api.post(`/video-audits/${videoId}/keep-script`), () => load(false));
  const cancel = () => {
    if (!window.confirm("Cancel this video? It can't be made or published afterwards. You can start another from the lead.")) return;
    void act("cancel", () => api.post(`/video-audits/${videoId}/cancel`), () => nav(`/leads/${leadId}`));
  };

  // The made video: watch it, then publish it (the same approval the inbox shows), reject it, or take it back to review to change and render again.
  const publishApproval = data?.publishApproval ?? null;
  const pstate = data ? publishState(data.video.status, publishApproval) : "none";
  const publishVideo = () => act("publish", () => api.post(`/approvals/${encodeURIComponent(publishApproval!.id)}/approve`), () => load(false));
  const rejectVideo = () => act("reject", () => api.post(`/approvals/${encodeURIComponent(publishApproval!.id)}/reject`), () => load(false));
  const reopen = () => act("reopen", () => api.post(`/video-audits/${videoId}/reopen`), () => load(false));

  const name = data?.business?.name ?? "Lead";
  const crumbs = [{ label: "Leads", to: "/leads" }, { label: name, to: `/leads/${leadId}` }, { label: "Video audit" }];

  if (none) return (
    <div className="ds-page hox-vd">
      <PageHeader crumbs={crumbs} title="Video audit" />
      <div className="ds-body">
        <div className="ds-card"><Empty icon="eye" title="No video for this lead yet" action={<Link to={`/leads/${leadId}`} className="btn sm primary">Open the lead</Link>}>
          A video audit is a short narrated screen recording of what is wrong with their site. Start one from the Video audit panel on the lead.
        </Empty></div>
      </div>
    </div>
  );
  if (!data) return (
    <div className="ds-page hox-vd">
      <PageHeader crumbs={crumbs} title="Video audit" />
      <div className="ds-body">{error ? <Banner tone="critical" title="Couldn't load the video">{error}</Banner> : <div className="ds-card hox-pad"><i className="hox-skel" style={{ width: "40%", height: 16 }} /></div>}</div>
    </div>
  );

  const attempt = lastAttemptNotice(data.video.status, data.video.error);
  const waitingForNewScript = data.video.status === "scripting" && mode !== "state";
  const shown = blockers ?? live;
  const chip = statusChip(data.video.status);
  const times = plan ? lineTimeline(plan) : [];
  const total = times.length ? times[times.length - 1].start + times[times.length - 1].seconds : 0;
  const at = current ? times.find((t) => t.id === current.id) : undefined;
  const sceneNo = current && plan ? plan.segments.indexOf(current) + 1 : 0;
  const needVoice = plan ? plan.segments.filter((sg) => lineVoice(sg, plan.narration).needsWork).length : 0;
  const STATE_TITLE: Record<string, string> = { capturing: "Taking screenshots of the site", scripting: "Claude hasn't written the script yet", producing: "Your Mac is making the video",
    failed: "The video didn't get made", cancelled: "This video was cancelled", published: "This video is live" };
  const sub = mode === "state" ? "A short narrated look at what is wrong with their site, made from a script you approve." : stateLine || (editable
    ? "Claude wrote the script and placed the markups. Change any line, move a markup or record your own voice, then approve to make the video."
    : "The script as it was approved.");

  // The strip under the screenshot: where this line sits in the video, and every line as a block sized by its length. Click one to open it.
  const timeline = plan && (
    <footer className="hox-vd-timeline">
      <div className="hox-vd-tl-head">
        <span className="hox-vd-clock"><b>{clock(at?.start ?? 0)}</b> / {clock(total)}</span>
        <span className="ds-grow" />
        <span className="hox-vd-tl-note">Narration: {plan.narration === "clone" ? "your cloned voice" : "you record every line"}</span>
        {needVoice > 0 ? <Chip tone="warning" dot>{needVoice} to record</Chip> : <Chip tone="positive" dot>Voice ready</Chip>}
      </div>
      <div className="hox-vd-blocks" role="group" aria-label="Lines in order">
        {times.map((t) => (
          <button key={t.id} type="button" className={t.id === current?.id ? "on" : ""} style={{ flexGrow: t.seconds }} aria-pressed={t.id === current?.id} onClick={() => setSelected(t.id)}>
            <b>{t.name}</b><span>{clock(t.seconds)}</span>
          </button>
        ))}
      </div>
    </footer>
  );

  return (
    <div className="ds-page hox-vd">
      <PageHeader
        crumbs={crumbs}
        title={`Video audit · ${name}`}
        chips={<>
          <Chip tone={chip.tone}>{chip.label}</Chip>
          {mode !== "state" && summary && <Chip tone={summary.inWindow ? "outline" : "warning"} title="A video should run 80 to 130 seconds">{clock(summary.seconds)}{summary.inWindow ? "" : " · aim for 1:20 to 2:10"}</Chip>}
        </>}
        sub={<span role="status">{sub}</span>}
        actions={<>
          <span className="hox-vd-save" aria-live="polite">{save === "saving" ? "Saving…" : save === "saved" ? <><Icon name="check" size={14} />Saved</> : save === "failed" ? "Not saved" : ""}</span>
          {canCancel(data.video.status) && <button type="button" className="btn" onClick={cancel} disabled={!!busy}>Cancel video</button>}
          {canUnpublish(data.video.status) && <button type="button" className="btn" onClick={unpublish} disabled={!!busy}>{busy === "unpublish" ? "Unpublishing…" : "Unpublish"}</button>}
          {editable && <button type="button" className="btn primary" onClick={() => void approve()} disabled={!!busy || shown.length > 0 || save === "saving"} aria-describedby="vd-blockers"><Icon name="send" size={16} />{busy === "approve" ? "Approving…" : "Approve and make the video"}</button>}
        </>}
      />

      <div className="ds-body">
        {error && <Banner tone="critical" title="Something didn't work">{error}</Banner>}
        {attempt && <Banner tone="warning" title="The last try didn't finish">{attempt}</Banner>}
        {waitingForNewScript && (
          <Banner tone="info" icon="clock" title="Claude is writing a new script" action={<button type="button" className="btn sm" onClick={() => void writeMyself()} disabled={!!busy}>Write it myself</button>}>
            It arrives in your next queue session and replaces this one.
          </Banner>
        )}
        {editable && (
          <div id="vd-blockers" aria-live="polite">
            {shown.length === 0
              ? <Banner tone="positive" title="Ready to approve">Approving sends the script to your Mac, which makes the voice and the video. You publish it after you watch it.</Banner>
              : <Banner tone="warning" title={`Before you can approve, fix ${shown.length === 1 ? "this" : `these ${shown.length}`}`}><span className="hox-vd-blockers">{shown.map((b, i) => <span key={i}>{b}</span>)}</span></Banner>}
          </div>
        )}

        {hasPlayer(data.video) && (
          <Card icon="eye" title="The video" className="hox-vd-player" note={data.video.duration_ms ? clock(data.video.duration_ms / 1000) : undefined}>
            <video controls preload="metadata" playsInline className="hox-vd-video"
              src={`/api/video-audits/${data.video.id}/media/video.mp4`} poster={`/api/video-audits/${data.video.id}/media/poster.jpg`}>
              Your browser can't play this video.
            </video>
            {pstate === "rejected" && <p role="status">You rejected this video{publishApproval?.decision_note ? `: ${publishApproval.decision_note}` : ""}. Edit it and render it again to try once more.</p>}
            <div className="hox-vd-acts">
              {pstate === "waiting" && <button type="button" className="btn primary" onClick={() => void publishVideo()} disabled={!!busy}><Icon name="check" size={16} />{busy === "publish" ? "Publishing…" : "Approve and publish"}</button>}
              {pstate === "waiting" && <button type="button" className="btn" onClick={() => void rejectVideo()} disabled={!!busy}>Reject</button>}
              {canReopen(data.video.status) && <button type="button" className={`btn${pstate === "rejected" ? " primary" : ""}`} onClick={() => void reopen()} disabled={!!busy}><Icon name="pen" size={16} />{busy === "reopen" ? "Reopening…" : "Edit and re-render"}</button>}
            </div>
          </Card>
        )}
        {mode === "state" && (
          <div className="ds-card">
            <Empty icon={data.video.status === "failed" ? "alert" : data.video.status === "cancelled" ? "x" : "clock"} title={STATE_TITLE[data.video.status] ?? "No script yet"}
              action={<Link to={`/leads/${leadId}`} className="btn sm">Back to the lead</Link>}>
              {stateLine || "There is no script to edit yet."} {isWatching(data.video.status) && "This page updates by itself."}
            </Empty>
          </div>
        )}

        {mode !== "state" && plan && (
          <div className="hox-vd-cols">
            <div className="ds-col">
              {current && shot
                ? <ShotCanvas key={`${current.id}:${shot.id}`} videoId={data.video.id} shot={shot} segment={current} readOnly={!editable}
                    title={`Scene ${sceneNo} · ${at?.name ?? ""}`} shotName={shotLabel(plan.shots, shot.id)} footer={timeline} onChange={editSegment} onCommit={() => void commit()} />
                : <section className="ds-card hox-vd-scene"><Banner tone="warning" title="This line's screenshot isn't in the video">Choose another screenshot for it in the script.</Banner>{timeline}</section>}
            </div>
            <section className="ds-card hox-vd-script" aria-label="Script">
              <header className="ds-card-head">
                <Icon name="file-text" size={16} />
                <h2>Script</h2>
                <Seg label="Show" value={tab} onChange={setTab} options={[{ key: "script", label: "Script" }, { key: "voice", label: "Voice", count: needVoice || undefined }]} />
              </header>
              {tab === "voice" && editable && (
                <div className="hox-vd-narration">
                  <SwitchRow checked={plan.narration === "clone"} label="Use my cloned voice"
                    help={plan.narration === "clone" ? "Your Mac speaks every line in your cloned voice. Record a line to use your own voice for it." : "Off: you record every line yourself before you can approve."}
                    onChange={(on) => { edit({ ...plan, narration: on ? "clone" : "recorded" }); void commit(); }} />
                </div>
              )}
              <SegmentList videoId={data.video.id} plan={plan} selectedId={current?.id ?? null} readOnly={!editable} tab={tab} onSelect={setSelected} onChange={editSegment} onCommit={() => void commit()} onPlan={serverPlan} onError={setError} />
              {editable && (
                <details className="hox-vd-regen">
                  <summary><Icon name="refresh" size={14} />Write a different script</summary>
                  <div className="hox-vd-regen-body">
                    <label className="deal-field">
                      <span>What should change? (optional)</span>
                      <textarea id="vd-note" rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Lead with the speed problem" />
                      <small>Claude writes a new script in your next queue session. It replaces this one, edits included.</small>
                    </label>
                    <div><button type="button" className="btn sm" onClick={regenerate} disabled={!!busy}>Ask Claude for a new script</button></div>
                  </div>
                </details>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
