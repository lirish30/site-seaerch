import { z } from "zod";
import type { Env } from "../env";
import { registerHandler } from "./registry";
import { createApproval } from "../db/approvals";
import { latestAudit } from "../db/audits";
import { getBusiness } from "../db/businesses";
import { getVideoAudit, moveVideoStatus } from "../db/videoAudits";
import { checkConflict } from "../conflict";

const Payload = z.object({ videoId: z.string().min(1) });
export type VideoPublishPayload = z.infer<typeof Payload>;

/** Like the email previews: enough of the script to judge it by, not all of it. */
const SCRIPT_PREVIEW_CHARS = 600;

/** 95 seconds as "1:35". */
export function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Puts a rendered video up for approval: one approval at a time per video. It is linked from the video (`publish_approval_id`) so the editor can read
 * how it was decided. A video that already has a waiting approval keeps it; one whose approval was rejected (and was re-edited and rendered again) gets a new one.
 */
export async function createPublishApproval(env: Env, videoId: string): Promise<void> {
  const video = await getVideoAudit(env.DB, videoId);
  if (!video) throw new Error(`video ${videoId} not found`);
  if (video.status !== "rendered") throw new Error(`video ${videoId} is ${video.status}, not rendered`);
  const business = await getBusiness(env.DB, video.business_id);
  if (!business) throw new Error(`lead ${video.business_id} not found`);
  const script = (video.plan?.segments ?? []).map((s) => s.text.trim()).filter(Boolean).join("\n\n").slice(0, SCRIPT_PREVIEW_CHARS);
  const a = await createApproval(env.DB, {
    kind: "video.publish", title: `Publish the video audit for ${business.name}`,
    preview: `Lead: ${business.name}\nLength: ${clock(video.duration_ms ?? 0)}\n\n${script}`,
    payload: { videoId } satisfies VideoPublishPayload, record_type: "lead", record_id: business.id, drafted_by: "job",
  });
  // Link it only when the video is still rendered and has no waiting approval, in one statement, so two callers end with one approval.
  const linked = await env.DB.prepare(
    `UPDATE video_audits SET publish_approval_id = ?, updated_at = ? WHERE id = ? AND status = 'rendered'
       AND (publish_approval_id IS NULL OR publish_approval_id NOT IN (SELECT id FROM approvals WHERE status = 'pending'))`,
  ).bind(a.id, new Date().toISOString(), videoId).run();
  if (!(linked.meta.changes ?? 0)) await env.DB.prepare(`DELETE FROM approvals WHERE id = ? AND status = 'pending'`).bind(a.id).run();
}

registerHandler({
  kind: "video.publish",
  label: "Publish video",
  parse: (p) => Payload.parse(p),
  /**
   * Idempotent: a published video stays as it was. Everything is checked again at approval, because days may have passed since the render:
   * the video is still rendered, the lead is not on a suppression or do-not-contact list, and its audit is still the lead's latest.
   */
  async execute(env, p: VideoPublishPayload) {
    const video = await getVideoAudit(env.DB, p.videoId);
    if (!video) throw new Error("video not found");
    if (video.status === "published") return;
    if (video.status !== "rendered") throw new Error(`this video is ${video.status}, so it can't be published`);
    if (!video.video_key) throw new Error("this video has no file to publish");
    const business = await getBusiness(env.DB, video.business_id);
    if (!business) throw new Error("lead not found");
    const gate = await checkConflict(env.DB, { email: "", businessId: business.id });
    if (gate.blocked) throw new Error(`${business.name} is blocked: ${gate.reason}`);
    const latest = await latestAudit(env.DB, business.id);
    if (!latest || latest.id !== video.audit_id) throw new Error("A newer audit exists for this lead, so this video is out of date. Make a new video from the latest audit.");
    if (await moveVideoStatus(env.DB, video.id, ["rendered"], "published")) return;
    // Lost a race: fine if the other caller published it.
    if ((await getVideoAudit(env.DB, video.id))?.status !== "published") throw new Error("the video changed while it was being published");
  },
});
