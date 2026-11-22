import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { refreshStudioPostCard } from "../src/worker/approvals/studioPost";
import { createPost, getPost, patchPost } from "../src/worker/db/studio";
import { completeTask } from "../src/worker/queue/db";
import "../src/worker/queue/kinds";
import * as images from "../src/worker/studio/images";
import { createStudioPost, discardStudioPost, queueStudioCopy } from "../src/worker/studio/service";
import { insertAudit } from "../src/worker/db/audits";
import { tool } from "./fixtures/mcp";
import { claimById } from "./fixtures/draftTask";
import { seedBusiness } from "./fixtures/cro";

const getApproval = (id: string) => env.DB.prepare(`SELECT id, status, title, preview FROM approvals WHERE id = ?`).bind(id).first<{ id: string; status: string; title: string; preview: string }>();
const NOW = new Date("2026-12-02T10:00:00.000Z");
const COPY = {
  headline: "Three fixes for a plumber's website", caption: "Short, plain tips from a website check.",
  slides: [{ title: "Show your phone", body: "At the top of every page." }, { title: "Load fast", body: "Shrink big photos." }, { title: "Ask us to check yours", body: "Send a message." }],
  tags: ["plumber"],
};

/** A post in review with its approval, made the way the app makes them: through the queue. */
async function reviewed() {
  const b = await seedBusiness();
  const a = await insertAudit(env.DB, {
    business_id: b.id, site_status: "ok", partial: false, pagespeed_mobile: 31, lcp_ms: 4100, cls: 0.2, mobile_friendly: null, https: true, has_title: true, has_meta_description: true, has_contact_form: false,
    copyright_year: null, latest_content_date: null, broken_link_count: 0, platform: "wix", seo_score: 62, accessibility_score: 71, score: 8000, offer: "new_site",
    findings: [{ code: "no_cta", category: "cro", severity: "important", points: 5, evidence: "The phone number is hard to find", recommendation: "Show it at the top.", source: "rule" }],
    raw_r2_key: null, mail_warning: null, health_score: 40, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {},
  } as never);
  const post = await createStudioPost(env, { kind: "audit_tip", auditId: a.id }, NOW);
  await queueStudioCopy(env, post.id);
  const task = await claimById((await getPost(env.DB, post.id))!.claudeTaskId!);
  expect(await completeTask(env, task.id, COPY)).toEqual({ ok: true });
  const saved = (await getPost(env.DB, post.id))!;
  return { post: saved, approvalId: saved.approvalId! };
}

// The simulated browser binding must never be launched in a test: the renderer is a stand-in that draws nothing.
beforeEach(() => { vi.spyOn(images, "renderPostImages").mockResolvedValue([]); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the studio.post approval", () => {
  it("is registered with the label Approve", () => {
    expect(getHandler("studio.post")).toMatchObject({ kind: "studio.post", label: "Approve" });
  });

  it("approving a review post marks it approved and sends nothing", async () => {
    const { post, approvalId } = await reviewed();
    expect(post.status).toBe("review");
    const mailBefore = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>())!.n;
    expect(await approve(env, approvalId)).toEqual({ ok: true });
    expect((await getPost(env.DB, post.id))!.status).toBe("approved");
    expect((await getApproval(approvalId))!.status).toBe("approved");
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>())!.n).toBe(mailBefore);
    // approving again is the approval's own refusal (already decided), and the post stays approved
    expect(await approve(env, approvalId)).toMatchObject({ ok: false, status: 409 });
    expect((await getPost(env.DB, post.id))!.status).toBe("approved");
  });

  it("approving a discarded post is refused", async () => {
    const { post, approvalId } = await reviewed();
    // discarded behind the approval's back (the discard route would also reject the card)
    await patchPost(env.DB, post.id, { status: "discarded" }, NOW.toISOString());
    const r = await approve(env, approvalId);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/discarded/);
    expect((r as { error: string }).error).toMatch(/^[A-Z][^<>{}]*\.$/);
    expect((await getPost(env.DB, post.id))!.status).toBe("discarded");
    expect((await getApproval(approvalId))!.status).toBe("pending");
  });

  it("discarding a post rejects its waiting approval", async () => {
    const { post, approvalId } = await reviewed();
    await discardStudioPost(env, post.id, NOW);
    expect((await getApproval(approvalId))!.status).toBe("rejected");
    expect((await getPost(env.DB, post.id))!.status).toBe("discarded");
  });

  it("refuses a post that has no copy yet, and one that is gone", async () => {
    const draft = await createPost(env.DB, { kind: "case_study", source: {}, anonymize: true }, NOW.toISOString());
    const h = getHandler("studio.post")!;
    await expect(h.execute(env, { postId: draft.id }, {} as never)).rejects.toThrow(/not ready/);
    await expect(h.execute(env, { postId: "nope" }, {} as never)).rejects.toThrow(/not found/);
    expect(h.parse({ postId: "x" })).toEqual({ postId: "x" });
    expect(() => h.parse({})).toThrow();
  });

  it("the approval card shows the headline, caption and the number of slides", async () => {
    const { post, approvalId } = await reviewed();
    const card = (await getApproval(approvalId))!;
    expect(card.title).toContain(COPY.headline);
    expect(card.preview).toContain(`Headline: ${COPY.headline}`);
    expect(card.preview).toContain(COPY.caption);
    expect(card.preview).toContain("Slides: 3");
    expect(card.preview).toMatch(/Nothing is posted/);
    // an edit of the copy rewrites the pending card
    await patchPost(env.DB, post.id, { copy: { ...COPY, headline: "A new headline", slides: COPY.slides.slice(0, 2) } }, NOW.toISOString());
    expect(await refreshStudioPostCard(env, (await getPost(env.DB, post.id))!)).toBe(true);
    const after = (await getApproval(approvalId))!;
    expect(after.preview).toContain("Headline: A new headline");
    expect(after.preview).toContain("Slides: 2");
  });
});

describe("the agent", () => {
  it("cannot propose studio.post: only the app does, and nothing is written", async () => {
    const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals`).first<{ n: number }>())!.n;
    const before = await count();
    const r = await tool("propose_approval", { kind: "studio.post", title: "Approve a post", preview: "x", payload: { postId: "p1" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/studio\.post/);
    expect(await count()).toBe(before);
  });
});
