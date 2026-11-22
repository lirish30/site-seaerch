import type { StudioKind, StudioPost as WorkerPost, StudioStatus } from "../worker/db/studio";
import type { StudioCopy } from "../worker/studio/templates";

/** A post as the page gets it: the worker's post with the R2 keys cut to a count (see `postView` in routes/studio.ts). */
export type StudioPost = Omit<WorkerPost, "imageKeys"> & { images: number };
export type { StudioKind, StudioStatus, StudioCopy };

const STATUS_WORDS: Record<StudioStatus, string> = {
  draft: "Draft", writing: "Waiting for Claude", review: "Ready to review", approved: "Approved", posted: "Posted", discarded: "Discarded",
};
/** The status in words, never the code. */
export const statusLabel = (s: StudioStatus): string => STATUS_WORDS[s];

export const statusTone = (s: StudioStatus): "" | "positive" | "info" | "warning" => (s === "approved" || s === "posted" ? "positive" : s === "writing" ? "info" : s === "review" ? "warning" : "");

export const KIND_LABEL: Record<StudioKind, string> = { before_after: "Before and after", audit_tip: "Audit tips", case_study: "Case study" };

/** What is left to do on a post: a draft is written by Claude (the route to ask for it), a post under review waits in the inbox, an approved one is downloaded and posted by hand. Nothing for the rest. */
export function nextAction(p: Pick<StudioPost, "id" | "status">): { label: string; route: string } | null {
  switch (p.status) {
    case "draft": return { label: "Write the words", route: `/api/studio/${encodeURIComponent(p.id)}/write` };
    case "review": return { label: "Approve in the inbox", route: "/today" };
    case "approved": return { label: "Download and post", route: `/api/studio/${encodeURIComponent(p.id)}/posted` };
    default: return null;
  }
}

/** The caption, a blank line, then the tags as hashtags: what gets pasted into the post. With no tags, just the caption. */
export function captionWithTags(copy: StudioCopy): string {
  const tags = copy.tags.map((t) => `#${t.replace(/^#+/, "")}`).join(" ");
  return tags ? `${copy.caption}\n\n${tags}` : copy.caption;
}

/** The post's words, or null while there are none (an unreadable or empty copy). */
export function copyOf(p: Pick<StudioPost, "copy">): StudioCopy | null {
  const c = p.copy as Partial<StudioCopy> | null;
  if (!c || typeof c.headline !== "string" || typeof c.caption !== "string") return null;
  return { headline: c.headline, caption: c.caption, slides: Array.isArray(c.slides) ? c.slides : [], tags: Array.isArray(c.tags) ? c.tags : [] };
}

/** A post can still be changed until it is posted or discarded. */
export const isOpen = (p: Pick<StudioPost, "status">): boolean => p.status !== "posted" && p.status !== "discarded";

/** What the New post form holds. */
export interface NewPostForm { kind: StudioKind; auditId: string; businessId: string; anonymous: boolean; agreed: boolean }

/**
 * The body for `POST /api/studio`, or the sentence for what is missing. A post is anonymous unless the "anonymous" box is unticked AND the client agreed: unticked alone still sends an anonymous post
 * (the box cannot be unticked without the agreement on the page, and the server refuses it too).
 */
export function newPostBody(f: NewPostForm): { body: Record<string, unknown> } | { problem: string } {
  const named = !f.anonymous && f.agreed;
  const tail = named ? { anonymize: false, agreed: true } : { anonymize: true };
  if (f.kind === "audit_tip") {
    const auditId = f.auditId.trim();
    return auditId ? { body: { kind: f.kind, auditId, ...tail } } : { problem: "Enter the id of the audit this post is about." };
  }
  if (f.kind === "case_study") return f.businessId ? { body: { kind: f.kind, businessId: f.businessId, ...tail } } : { problem: "Choose the client this case study is about." };
  return { body: { kind: f.kind, ...tail } };
}

/** The edit boxes of a post's words: the tags are one line of text, the slides are title and body pairs. */
export interface CopyEditForm { headline: string; caption: string; slides: { title: string; body: string }[]; tagText: string }

/** The edit boxes as a copy the server takes: trimmed, hashes and commas taken out of the tags, a slide with no words left out. */
export function copyEdit(f: CopyEditForm): StudioCopy {
  return {
    headline: f.headline.trim(), caption: f.caption.trim(),
    slides: f.slides.map((s) => ({ title: s.title.trim(), body: s.body.trim() })).filter((s) => s.title || s.body),
    tags: f.tagText.split(/[\s,]+/).map((t) => t.replace(/^#+/, "")).filter(Boolean),
  };
}

/** The download name for slide `n` (1-based) of a post. */
export const imageName = (p: Pick<StudioPost, "id">, n: number): string => `post-${p.id.slice(0, 8)}-${n}.png`;
