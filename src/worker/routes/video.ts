import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { latestAudit } from "../db/audits";
import { getBusiness } from "../db/businesses";
import { createVideoAudit, getVideoAudit, setVideoStatus, type VideoAudit } from "../db/videoAudits";
import { requestVideoScript } from "../queue/videoScript";

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
  // `jobs` are the Mac helper's jobs for this video; there are none until the helper exists.
  return c.json({ video, plan: video.plan, jobs: [], state: stateLine(video) });
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
