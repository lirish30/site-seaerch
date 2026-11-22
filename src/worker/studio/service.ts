// The Studio's operations (Plan 15), the one place the routes (and the later page and MCP tool) go through: make a post, queue its copy, edit the copy, mark it posted, discard it.
// Everything stays inside the Worker. Nothing here posts anywhere; "posted" is Logan saying he posted it himself.
import { refreshStudioPostCard } from "../approvals/studioPost";
import { reject } from "../approvals/decide";
import { calendarDateIn } from "../billing/dates";
import { isClient } from "../clients/record";
import { getAudit } from "../db/audits";
import { getBusiness } from "../db/businesses";
import { getSettings } from "../db/settings";
import { createPost, getPost, patchPost, type StudioKind, type StudioPost } from "../db/studio";
import type { Env } from "../env";
import { queueStudioCopyTask, type StudioCopyResult } from "../queue/studioCopy";
import { zoneOf } from "../sop/cadence";
import { auditTips, caseFacts } from "./sources";

/** The input cannot make a post: the message is a plain sentence the route shows as it is (422). */
export class StudioInputError extends Error {}
/** The post is in a state that does not allow this (409). */
export class StudioStateError extends Error {}

export interface StudioPostInput { kind: StudioKind; businessId?: string; auditId?: string; anonymize?: boolean; agreed?: boolean }

/**
 * Makes a post in `draft`. Anonymous by default: turning that off needs `agreed: true` (the client agreed to be named), which stamps `agreed_at`. An audit tip needs an audit whose findings can be used
 * (with anonymity on, ones that can be made anonymous); a case study needs a client with work done. The facts themselves are read again when Claude's task is built, not stored here.
 */
export async function createStudioPost(env: Env, i: StudioPostInput, now: Date): Promise<StudioPost> {
  const db = env.DB;
  const anonymize = i.anonymize ?? true;
  if (!anonymize && i.agreed !== true) throw new StudioInputError("A post can only name the client if the client agreed. Tick that they agreed, or keep the post anonymous.");

  let businessId: string | null = null;
  let source: Record<string, unknown> = {};
  if (i.kind === "audit_tip") {
    if (!i.auditId) throw new StudioInputError("Choose the audit this tip post is about.");
    const audit = await getAudit(db, i.auditId);
    if (!audit) throw new StudioInputError("That audit was not found.");
    if (!(await auditTips(db, audit.id, { anonymize }))) {
      throw new StudioInputError(anonymize
        ? "This audit has nothing that can be posted without showing whose site it is. Pick another audit, or turn anonymity off if the client agreed."
        : "This audit has nothing to post about.");
    }
    businessId = audit.business_id;
    source = { auditId: audit.id };
  } else if (i.kind === "case_study") {
    if (!i.businessId) throw new StudioInputError("Choose the client this case study is about.");
    if (!(await getBusiness(db, i.businessId))) throw new StudioInputError("That client was not found.");
    if (!(await isClient(db, i.businessId)) || !(await caseFacts(db, i.businessId))) throw new StudioInputError("There is no finished work for that client to write about yet.");
    businessId = i.businessId;
  } else if (i.businessId) {
    if (!(await getBusiness(db, i.businessId))) throw new StudioInputError("That client was not found.");
    businessId = i.businessId;
  }

  const iso = now.toISOString();
  const post = await createPost(db, { kind: i.kind, businessId, source, anonymize }, iso);
  return anonymize ? post : (await patchPost(db, post.id, { agreedAt: iso }, iso)) ?? post;
}

/** Queues Claude's copy for a post (one task per post) and sets it `writing`. Only a draft, or one already waiting for its copy, may be queued. */
export async function queueStudioCopy(env: Env, postId: string): Promise<void> {
  const post = await getPost(env.DB, postId);
  if (!post) throw new StudioStateError("That post was not found.");
  if (post.status !== "draft" && post.status !== "writing") throw new StudioStateError("This post already has its copy. Edit it, or make a new post.");
  await queueStudioCopyTask(env, postId);
}

/** Saves an edited copy (already checked against the same schema Claude's result is) on a post still being reviewed, and rewrites its pending approval card to match. */
export async function saveStudioCopy(env: Env, postId: string, copy: StudioCopyResult, now: Date): Promise<StudioPost> {
  const post = await getPost(env.DB, postId);
  if (!post) throw new StudioStateError("That post was not found.");
  if (post.status !== "review" && post.status !== "draft") throw new StudioStateError("This post can no longer be edited.");
  const saved = (await patchPost(env.DB, postId, { copy }, now.toISOString()))!;
  await refreshStudioPostCard(env, saved);
  return saved;
}

/** Records that Logan posted an approved post himself, on today's date in the booking zone. */
export async function markStudioPosted(env: Env, postId: string, now: Date): Promise<StudioPost> {
  const post = await getPost(env.DB, postId);
  if (!post) throw new StudioStateError("That post was not found.");
  if (post.status === "posted") return post;
  if (post.status !== "approved") throw new StudioStateError("Approve this post before you mark it posted.");
  const zone = zoneOf(await getSettings(env.DB));
  return (await patchPost(env.DB, postId, { status: "posted", postedOn: calendarDateIn(now, zone) }, now.toISOString()))!;
}

/** Discards a post that has not been posted, and rejects its approval if that is still waiting. */
export async function discardStudioPost(env: Env, postId: string, now: Date): Promise<StudioPost> {
  const post = await getPost(env.DB, postId);
  if (!post) throw new StudioStateError("That post was not found.");
  if (post.status === "posted") throw new StudioStateError("This post was already posted.");
  if (post.status === "discarded") return post;
  const saved = (await patchPost(env.DB, postId, { status: "discarded" }, now.toISOString()))!;
  if (post.approvalId) await reject(env.DB, post.approvalId, "The post was discarded.");
  return saved;
}
