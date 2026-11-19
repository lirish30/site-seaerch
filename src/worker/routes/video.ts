import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getAudit, latestAudit } from "../db/audits";
import { getBusiness } from "../db/businesses";
import { createVideoAudit, getVideoAudit, latestVideoFor, moveVideoStatus, savePlan, setVideoStatus, type VideoAudit } from "../db/videoAudits";
import { cancelTasksFor } from "../queue/db";
import { cancelHelperJobsFor, helperJobsForVideo, helperStatus } from "../helper/jobs";
import "../helper/kinds"; // a helper job is only valid for a registered kind
import { requestVideoScript } from "../queue/videoScript";
import { MAX_MARKUPS, SegmentSchema, approvalBlockers, checkPlanRefs, hashText, type Segment, type VideoPlan } from "../video/plan";
import { getSettings } from "../db/settings";
import { reject } from "../approvals/decide";
import { mediaFor, serveObject } from "../video/media";
import { startProduction, voiceBlockers } from "../video/production";

export const videoRoutes = new Hono<{ Bindings: Env }>();

/** One line saying where a video is, for the lead page and the editor. */
export function stateLine(v: Pick<VideoAudit, "status" | "error">): string {
  switch (v.status) {
    case "capturing": return "Taking screenshots of the site.";
    case "scripting": return "Waiting for Claude. The script will be written in your next queue session.";
    case "review": return "";
    case "producing": return "Waiting for your Mac. Voice and video are made when the helper is running.";
    case "rendered": return "Ready to approve. Watch it, then approve it in the inbox.";
    case "published": return "Live on the report page.";
    case "failed": return `Something went wrong: ${v.error ?? "unknown error"}`;
    case "cancelled": return "Cancelled.";
  }
}

const NoteBody = z.object({ steeringNote: z.string().trim().max(1000).nullable().optional() });

videoRoutes.post("/leads/:id/video", async (c) => {
  const id = c.req.param("id");
  const business = await getBusiness(c.env.DB, id);
  if (!business) return c.json({ error: "not found" }, 404);
  const body = NoteBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  // A video is made from a full audit: the lead was fully scanned and its site was reachable.
  const audit = await latestAudit(c.env.DB, id);
  if (business.scan_stage !== "full" || !audit || audit.site_status !== "ok") return c.json({ error: "Run a full audit on this lead first" }, 422);
  const video = await createVideoAudit(c.env.DB, { businessId: id, auditId: audit.id });
  if (!video) return c.json({ error: "A video is already in progress for this audit" }, 409);
  if (body.data.steeringNote) await setVideoStatus(c.env.DB, video.id, "capturing", { steering_note: body.data.steeringNote });
  try {
    await c.env.VIDEO_WORKFLOW.create({ id: `video-${video.id}`, params: { videoId: video.id } });
  } catch {
    // Failed straight away, so the audit is free for another try.
    await setVideoStatus(c.env.DB, video.id, "failed", { error: "Couldn't start the video workflow" });
    return c.json({ error: "Couldn't start the video workflow" }, 502);
  }
  return c.json({ videoId: video.id }, 202);
});

videoRoutes.get("/video-audits/:id", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  if (!video) return c.json({ error: "not found" }, 404);
  // `jobs` are the Mac helper's jobs for this video. `helperOnline` is whether the Mac helper has checked in lately; the client words the state line itself from both.
  const [audit, business, jobs, helper, approval] = await Promise.all([
    getAudit(c.env.DB, video.audit_id), getBusiness(c.env.DB, video.business_id), helperJobsForVideo(c.env.DB, video.id), helperStatus(c.env.DB, new Date()),
    video.publish_approval_id
      ? c.env.DB.prepare(`SELECT id, status, decision_note FROM approvals WHERE id = ?`).bind(video.publish_approval_id).first<{ id: string; status: string; decision_note: string | null }>()
      : null,
  ]);
  return c.json({
    video, plan: video.plan, jobs, helperOnline: helper.online, state: stateLine(video), publishApproval: approval ?? null,
    findingCodes: audit?.findings.map((f) => f.code) ?? [], business: business ? { id: business.id, name: business.name } : null,
  });
});

/** The lead's newest video (without its plan), or null: what the lead page's Video audit panel shows. */
videoRoutes.get("/leads/:id/video", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  const v = await latestVideoFor(c.env.DB, id);
  if (!v) return c.json({ video: null });
  const { plan: _plan, ...video } = v;
  return c.json({ video, helperOnline: (await helperStatus(c.env.DB, new Date())).online });
});

videoRoutes.get("/video-audits/:id/shots/:shotId/preview", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  const shot = video?.plan?.shots.find((s) => s.id === c.req.param("shotId"));
  const obj = shot ? await c.env.RAW.get(shot.previewKey) : null;
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });
});

/** The owner watching a rendered (or published) video, before or after it goes live: the same files the report page serves, behind the login. */
videoRoutes.get("/video-audits/:id/media/:name", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  const file = video && (video.status === "rendered" || video.status === "published") ? mediaFor(video, c.req.param("name")) : null;
  if (!file) return c.json({ error: "not found" }, 404);
  const res = await serveObject(c.env.RAW, file.key, file.type, c.req.header("range") ?? null);
  // A re-render replaces the files, so the owner's copy is checked each time.
  if (res.status === 200 || res.status === 206) res.headers.set("cache-control", "private, no-cache");
  return res;
});

const MAX_LINES = 20;
const MAX_LINE_CHARS = 2000;
const PlanBody = z.object({
  segments: z.array(SegmentSchema).min(1).max(MAX_LINES),
  narration: z.enum(["clone", "recorded"]),
  version: z.number().int().nonnegative().optional(),
});

/** Takes the files of recordings that are no longer in the plan out of storage. A file that will not go is left for a later sweep; the plan is already right. */
async function dropRecordings(raw: R2Bucket, before: Segment[], after: Segment[]): Promise<void> {
  const kept = new Set(after.map((s) => s.audio?.key).filter(Boolean));
  const gone = before.flatMap((s) => (s.audio?.source === "recorded" && !kept.has(s.audio.key) ? [s.audio.key] : []));
  if (gone.length) await raw.delete(gone).catch(() => {});
}

/**
 * Saves the editor's plan: the lines, their markups and who narrates. The shots are not the editor's to change. A line keeps its audio only
 * when its words are unchanged (same text hash); anything the client sends as `audio` is ignored. A script that is too short or long
 * saves fine: that blocks approval, not editing.
 */
videoRoutes.put("/video-audits/:id/plan", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  if (!video) return c.json({ error: "not found" }, 404);
  if (video.status !== "review" || !video.plan) return c.json({ error: "The plan can only be edited while the video is in review" }, 409);
  const body = PlanBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid" }, 400);
  const { segments, narration, version } = body.data;
  if (version !== undefined && version !== video.plan.version) return c.json({ error: "The plan changed somewhere else. Reload to see it." }, 409);

  const ids = new Set(segments.map((s) => s.id));
  if (ids.size !== segments.length) return c.json({ error: "Two lines have the same id" }, 400);
  const tooMany = segments.findIndex((s) => s.markups.length > MAX_MARKUPS);
  if (tooMany >= 0) return c.json({ error: `Line ${tooMany + 1} has more than ${MAX_MARKUPS} markups` }, 400);
  const tooLong = segments.findIndex((s) => s.text.length > MAX_LINE_CHARS);
  if (tooLong >= 0) return c.json({ error: `Line ${tooLong + 1} is longer than ${MAX_LINE_CHARS} characters` }, 400);
  const audit = await getAudit(c.env.DB, video.audit_id);
  const refs = checkPlanRefs({ shots: video.plan.shots, segments }, audit?.findings.map((f) => f.code) ?? []);
  if (refs.length) return c.json({ error: refs.join(" ") }, 400);

  const before = new Map(video.plan.segments.map((s) => [s.id, s]));
  const next: Segment[] = segments.map(({ audio: _ignored, ...s }) => {
    const old = before.get(s.id)?.audio;
    return old && old.textHash === hashText(s.text) ? { ...s, audio: old } : s;
  });
  const plan: VideoPlan = await savePlan(c.env.DB, video.id, { shots: video.plan.shots, segments: next, narration, version: video.plan.version });
  await dropRecordings(c.env.RAW, video.plan.segments, next);
  return c.json({ plan });
});

export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
const MAX_RECORDING_MS = 10 * 60_000;
const RECORDING_TYPES: Record<string, "webm" | "wav"> = { "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav" };

/** One line's own voice: the raw recording as the body, how long it ran (the browser measured it) in `x-duration-ms`. Only while the video is in review. */
videoRoutes.put("/video-audits/:id/segments/:segId/recording", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  if (!video) return c.json({ error: "not found" }, 404);
  if (video.status !== "review" || !video.plan) return c.json({ error: "Recordings can only be added while the video is in review" }, 409);
  const segId = c.req.param("segId");
  if (!video.plan.segments.some((s) => s.id === segId)) return c.json({ error: "not found" }, 404);
  const kind = RECORDING_TYPES[(c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase()];
  if (!kind) return c.json({ error: "The recording must be audio/webm or audio/wav" }, 415);
  const durationMs = Number(c.req.header("x-duration-ms"));
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_RECORDING_MS) return c.json({ error: "x-duration-ms must be how long the recording runs, in milliseconds" }, 400);
  const tooBig = { error: "That recording is over 8 MB" };
  if (Number(c.req.header("content-length")) > MAX_RECORDING_BYTES) return c.json(tooBig, 413);
  const data = await c.req.arrayBuffer();
  if (data.byteLength > MAX_RECORDING_BYTES) return c.json(tooBig, 413);
  if (data.byteLength === 0) return c.json({ error: "The recording is empty" }, 400);

  // Name the file by the words it says, so a take of old words can never pass for the line's current ones.
  const seg = video.plan.segments.find((s) => s.id === segId)!;
  const textHash = hashText(seg.text);
  const key = `video/${video.id}/recordings/${segId}-${textHash}.${kind}`;
  await c.env.RAW.put(key, data, { httpMetadata: { contentType: `audio/${kind}` } });

  // Read the plan again: another save may have landed while the file was uploading.
  const fresh = await getVideoAudit(c.env.DB, video.id);
  if (!fresh?.plan || fresh.status !== "review") return c.json({ error: "Recordings can only be added while the video is in review" }, 409);
  const now = fresh.plan.segments.find((s) => s.id === segId);
  if (!now || hashText(now.text) !== textHash) { await c.env.RAW.delete(key).catch(() => {}); return c.json({ error: "The line changed while it was uploading. Record it again." }, 409); }
  const segments = fresh.plan.segments.map((s) => (s.id === segId ? { ...s, audio: { key, source: "recorded" as const, durationMs: Math.round(durationMs), textHash } } : s));
  const plan = await savePlan(c.env.DB, video.id, { ...fresh.plan, segments });
  await dropRecordings(c.env.RAW, fresh.plan.segments, segments);
  return c.json({ plan });
});

/** Plays a line's recording back in the editor. */
videoRoutes.get("/video-audits/:id/segments/:segId/recording", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  const audio = video?.plan?.segments.find((s) => s.id === c.req.param("segId"))?.audio;
  const obj = audio?.source === "recorded" ? await c.env.RAW.get(audio.key) : null;
  if (!audio || !obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": audio.key.endsWith(".wav") ? "audio/wav" : "audio/webm", "cache-control": "private, no-cache" } });
});

/** Takes a line's own recording away (to go back to the cloned voice for it). A line with no recording is left as it is. */
videoRoutes.delete("/video-audits/:id/segments/:segId/recording", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  if (!video) return c.json({ error: "not found" }, 404);
  if (video.status !== "review" || !video.plan) return c.json({ error: "Recordings can only be changed while the video is in review" }, 409);
  const segId = c.req.param("segId");
  const seg = video.plan.segments.find((s) => s.id === segId);
  if (!seg) return c.json({ error: "not found" }, 404);
  if (seg.audio?.source !== "recorded") return c.json({ plan: video.plan });
  const segments = video.plan.segments.map((s) => { if (s.id !== segId) return s; const { audio: _gone, ...rest } = s; return rest; });
  const plan = await savePlan(c.env.DB, video.id, { ...video.plan, segments });
  await dropRecordings(c.env.RAW, video.plan.segments, segments);
  return c.json({ plan });
});

/** Approves the plan: every blocker is listed back when there are any, otherwise production starts (once, however many times this is called). */
videoRoutes.post("/video-audits/:id/approve", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  if (!video) return c.json({ error: "not found" }, 404);
  if (video.status !== "review" || !video.plan) return c.json({ error: "Only a video in review can be approved" }, 409);
  const audit = await getAudit(c.env.DB, video.audit_id);
  const blockers = [...approvalBlockers(video.plan, audit?.findings.map((f) => f.code) ?? []), ...voiceBlockers(video.plan, await getSettings(c.env.DB))];
  if (blockers.length) return c.json({ error: "The video can't be approved yet", blockers }, 409);
  if (!(await startProduction(c.env, video.id))) return c.json({ error: "Only a video in review can be approved" }, 409);
  return c.json({ ok: true }, 202);
});

/**
 * "Write it myself": drops the script Claude was asked for and goes back to editing the plan the video already has. Only for a new script
 * asked for from review (a first script has no plan to edit yet).
 */
videoRoutes.post("/video-audits/:id/keep-script", async (c) => {
  const id = c.req.param("id");
  const video = await getVideoAudit(c.env.DB, id);
  if (!video) return c.json({ error: "not found" }, 404);
  if (video.status !== "scripting" || !video.plan?.segments.length) return c.json({ error: "There is no new script to drop" }, 409);
  if (!(await moveVideoStatus(c.env.DB, id, ["scripting"], "review"))) return c.json({ error: "There is no new script to drop" }, 409);
  await cancelTasksFor(c.env.DB, "video", id);
  return c.json({ ok: true });
});

/**
 * "Edit and re-render": takes a rendered video that was not published back to review, so its script and markups can be changed. The plan's version is bumped
 * (so an editor holding the old plan is told), the Mac's open jobs for it are closed, and a publish approval still waiting is withdrawn.
 */
videoRoutes.post("/video-audits/:id/reopen", async (c) => {
  const id = c.req.param("id");
  const video = await getVideoAudit(c.env.DB, id);
  if (!video) return c.json({ error: "not found" }, 404);
  if (!(await moveVideoStatus(c.env.DB, id, ["rendered"], "review", { error: null, publish_approval_id: null }))) return c.json({ error: "Only a rendered video can be edited and re-rendered" }, 409);
  if (video.publish_approval_id) await reject(c.env.DB, video.publish_approval_id, "Reopened for editing");
  if (video.plan) await savePlan(c.env.DB, id, video.plan);
  await cancelHelperJobsFor(c.env.DB, id);
  return c.json({ ok: true });
});

/** Stops a video that is not finished with: it can no longer be made or published, and its audit is free for a new one. */
videoRoutes.post("/video-audits/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const moved = await moveVideoStatus(c.env.DB, id, ["capturing", "scripting", "review", "producing", "rendered"], "cancelled");
  if (moved) { await cancelTasksFor(c.env.DB, "video", id); await cancelHelperJobsFor(c.env.DB, id); return c.json({ ok: true }); }
  return (await getVideoAudit(c.env.DB, id)) ? c.json({ error: "This video is already finished" }, 409) : c.json({ error: "not found" }, 404);
});

videoRoutes.post("/video-audits/:id/regenerate-script", async (c) => {
  const video = await getVideoAudit(c.env.DB, c.req.param("id"));
  if (!video) return c.json({ error: "not found" }, 404);
  const body = NoteBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid" }, 400);
  if (video.status !== "review") return c.json({ error: "A new script can only be written while the video is in review" }, 409);
  const note = body.data.steeringNote === undefined ? video.steering_note : body.data.steeringNote || null;
  // The plan stays as it is: the editor keeps showing it until the new script is applied. The status moves first, because a script is only accepted while the video is `scripting`.
  await setVideoStatus(c.env.DB, video.id, "scripting", { steering_note: note });
  try {
    await requestVideoScript(c.env.DB, video.id, note);
  } catch (e) {
    await setVideoStatus(c.env.DB, video.id, "review");
    throw e;
  }
  return c.json({ ok: true }, 202);
});
