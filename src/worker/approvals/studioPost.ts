import { z } from "zod";
import { createApprovalForTask, updatePendingCard, type Approval } from "../db/approvals";
import { getPost, patchPost, type StudioKind, type StudioPost } from "../db/studio";
import type { Env } from "../env";
import { registerHandler } from "./registry";

// The approval of a Studio post (Plan 15): Claude's copy and its images are ready, and Logan says they may be posted. Approving SENDS NOTHING: the Studio never posts anywhere, it only marks the post `approved`
// so Logan can post it by hand and then mark it posted. The direction of imports is queue -> approvals (the `studio.copy` task proposes this approval), never the other way.

export const STUDIO_POST_KIND = "studio.post";
const Payload = z.object({ postId: z.string().min(1) });
export type StudioPostApprovalPayload = z.infer<typeof Payload>;

const KIND_WORDS: Record<StudioKind, string> = { before_after: "before and after", audit_tip: "audit tip", case_study: "case study" };
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The card as the post reads now: its headline, its caption and the number of slides, and what approving does. */
export function describeStudioPost(post: StudioPost): { title: string; preview: string } {
  const c = (typeof post.copy === "object" && post.copy !== null ? post.copy : {}) as Record<string, unknown>;
  const headline = str(c.headline).trim() || "(no headline yet)";
  const slides = Array.isArray(c.slides) ? c.slides.length : 0;
  const images = post.imageKeys.length;
  return {
    title: `Approve the ${KIND_WORDS[post.kind]} post "${headline}"`,
    preview: [
      `Headline: ${headline}`, "", "Caption:", str(c.caption).trim() || "(none)", "",
      `Slides: ${slides}`, images ? `Images drawn: ${images}` : "Images drawn: none yet (draw them before you post).",
      post.anonymize ? "Anonymous: the business is not named." : "Not anonymous: the client agreed to be named.", "",
      "Approving only marks the post approved. Nothing is posted: you post it yourself and then mark it posted.",
    ].join("\n"),
  };
}

/** Proposes the post's approval for the task that wrote its copy: one per task, however many times this runs (the insert is keyed to the task). Returns the approval's id, and records it on the post. */
export async function proposeStudioPostApproval(env: Env, post: StudioPost, taskId: string): Promise<string> {
  const d = describeStudioPost(post);
  const made = await createApprovalForTask(env.DB, taskId, { kind: STUDIO_POST_KIND, title: d.title, preview: d.preview, payload: { postId: post.id } satisfies StudioPostApprovalPayload, drafted_by: "job" });
  const id = made?.id ?? (await env.DB.prepare(`SELECT id FROM approvals WHERE record_type = 'claude_task' AND record_id = ? ORDER BY created_at, id LIMIT 1`).bind(taskId).first<{ id: string }>())?.id;
  if (!id) throw new Error("Could not make the approval for the Studio post.");
  await patchPost(env.DB, post.id, { approvalId: id }, new Date().toISOString());
  return id;
}

/** Rewrites the card of the post's approval from the post as it is now, if it is still pending (a decided card is history). True when it was rewritten. */
export async function refreshStudioPostCard(env: Env, post: StudioPost): Promise<boolean> {
  return post.approvalId ? updatePendingCard(env.DB, post.approvalId, describeStudioPost(post)) : false;
}

registerHandler({
  kind: STUDIO_POST_KIND,
  label: "Approve",
  parse: (p) => Payload.parse(p),
  /** Marks a post in review approved and does nothing else. A post already approved or posted is left as it is (a retry); one that is discarded, or has no copy yet, is refused in plain words, and the approval goes back to pending to be rejected. */
  async execute(env: Env, p: StudioPostApprovalPayload, _a: Approval) {
    const post = await getPost(env.DB, p.postId);
    if (!post) throw new Error("This post was not found.");
    if (post.status === "approved" || post.status === "posted") return;
    if (post.status === "discarded") throw new Error("This post was discarded, so it cannot be approved. Reject this approval.");
    if (post.status !== "review") throw new Error("This post is not ready to approve: its copy has not been written yet.");
    await patchPost(env.DB, post.id, { status: "approved" }, new Date().toISOString());
  },
});
