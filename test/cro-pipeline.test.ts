import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runCroAudit, runCroWithErrorHandling, shotKey, textKey, type CroDeps } from "../src/worker/cro/pipeline";
import { CRO_MODEL_KIND, CRO_PAGE_KIND, startCroStages } from "../src/worker/queue/cro";
import type { PageCapture } from "../src/worker/cro/types";
import type { StepLike } from "../src/worker/pipeline/lead";
import { createCroAudit, getCroAudit, replaceCroItems, updateCroAudit } from "../src/worker/db/cro";
import { croReportFor } from "../src/worker/report/cro";
import { capture, seedBusiness, seedLeadAudit, model, ranked } from "./fixtures/cro";

const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} };
function deps(o: Partial<CroDeps> & { pages?: Record<string, Partial<PageCapture>> } = {}) {
  const visited: string[] = [];
  const { pages, ...rest } = o;
  const d: CroDeps = { db: env.DB, raw: env.RAW, now: () => new Date("2026-10-04T00:00:00Z"), start: (id, from) => startCroStages(env, id, from),
    browser: async (url) => { visited.push(url); return capture(url, pages?.[url]); }, ...rest };
  return { d, visited };
}
async function start(links = {}) {
  const b = await seedBusiness();
  await seedLeadAudit(b.id, links);
  return { b, a: await createCroAudit(env.DB, b.id) };
}
const tasksOf = async (kind: string, auditId: string) =>
  (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ? AND target_id = ?`).bind(kind, auditId).all<Record<string, any>>()).results;

// What the Claude stages do once queued is in cro-queue.test.ts; this is the workflow's own part: capture, evidence, and the hand-over.
describe("runCroAudit", () => {
  it("captures pages, builds evidence and queues the first Claude stage, then ends", async () => {
    const { a } = await start({ contact: "https://ace.com/contact" });
    const { d, visited } = deps();
    await runCroAudit(d, step, { auditId: a.id });
    expect(visited).toEqual(["https://ace.com/", "https://ace.com/contact"]);
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r).toMatchObject({ status: "waiting", step: "model", partial: false, warning: null, error: null, completed_at: null, business_model: null, page_reviews: [] });
    expect(r.evidence.length).toBeGreaterThan(5);
    expect(r.pages.map((p) => p.ok)).toEqual([true, true]);
    expect(await tasksOf(CRO_MODEL_KIND, a.id)).toHaveLength(1);
    expect(await tasksOf(CRO_PAGE_KIND, a.id)).toHaveLength(0); // the pages are queued once the model is answered
    expect(await env.RAW.get(shotKey(a.id, 0, "desktop"))).not.toBeNull();
    expect(await env.RAW.get(shotKey(a.id, 1, "mobile", true))).not.toBeNull();
    expect(await (await env.RAW.get(textKey(a.id, 0)))!.text()).toContain("Quality service at competitive prices");
  });

  it("skips a page that fails to load and marks the audit partial", async () => {
    const { a } = await start({ contact: "https://ace.com/contact" });
    await runCroAudit(deps({ pages: { "https://ace.com/contact": { ok: false } } }).d, step, { auditId: a.id });
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r).toMatchObject({ status: "waiting", partial: true });
    expect(r.pages.map((p) => p.ok)).toEqual([true, false]);
  });

  it("fails with a clear message when the homepage can't be loaded", async () => {
    const { a } = await start();
    await runCroWithErrorHandling(deps({ browser: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } }).d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "failed", error: "Couldn't load the site" });
    expect(await tasksOf(CRO_MODEL_KIND, a.id)).toHaveLength(0);
  });

  it("fails clearly when Browser Rendering isn't configured", async () => {
    const { a } = await start();
    await runCroWithErrorHandling(deps({ browser: undefined }).d, step, { auditId: a.id });
    expect((await getCroAudit(env.DB, a.id))!.error).toBe("Browser Rendering isn't configured, so pages can't be captured");
  });

  it("fails the audit with the reason when the stages can't be queued", async () => {
    const { a } = await start();
    await runCroWithErrorHandling(deps({ start: async () => { throw new Error("D1 is down"); } }).d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "failed", error: "D1 is down" });
  });

  it("rebuilds from pages on the stored capture, with no new render and no new model request", async () => {
    const { a } = await start({ contact: "https://ace.com/contact" });
    await runCroAudit(deps().d, step, { auditId: a.id });
    await updateCroAudit(env.DB, a.id, { business_model: model(), step: "pages" });
    const { d, visited } = deps();
    await runCroAudit(d, step, { auditId: a.id, from: "pages" });
    expect(visited).toEqual([]);
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "waiting", step: "pages", pending_pages: [0, 1], reviewed_as: "lead_gen_phone" });
    expect(await tasksOf(CRO_PAGE_KIND, a.id)).toHaveLength(2);
  });

  it("refuses to rebuild from a later stage with no business model to build on", async () => {
    const { a } = await start();
    await runCroAudit(deps().d, step, { auditId: a.id });
    await runCroWithErrorHandling(deps().d, step, { auditId: a.id, from: "pages" });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "failed", error: "No business model to build on; run the full audit first" });
  });

  it("keeps the last good roadmap usable when a rebuild or retry fails afterwards", async () => {
    const { b, a } = await start();
    await updateCroAudit(env.DB, a.id, { status: "done", step: "done", completed_at: "2026-10-01T00:00:00.000Z", business_model: model() });
    await replaceCroItems(env.DB, a.id, [ranked()]);
    await runCroWithErrorHandling(deps({ browser: async () => { throw new Error("net::ERR_TIMED_OUT"); } }).d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "done", step: "done", error: "Couldn't load the site", completed_at: "2026-10-01T00:00:00.000Z" });
    expect((await croReportFor(env, b.id))!.audit.id).toBe(a.id);
  });

  it("handles a desktop-only capture (no mobile snapshot or images)", async () => {
    const { a } = await start();
    const { d } = deps({ pages: { "https://ace.com/": { mobile: null, mobileJpeg: null, mobileTopJpeg: null } } });
    await runCroAudit(d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "waiting", partial: false });
    expect(await env.RAW.get(shotKey(a.id, 0, "mobile"))).toBeNull();
    expect(await env.RAW.get(shotKey(a.id, 0, "desktop"))).not.toBeNull();
  });

  it("restarts the stale-run clock", async () => {
    const { a } = await start();
    await updateCroAudit(env.DB, a.id, { started_at: "2020-01-01T00:00:00.000Z", status: "failed", error: "Timed out" });
    await runCroAudit(deps().d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "waiting", error: null, started_at: "2026-10-04T00:00:00.000Z" });
  });
});
