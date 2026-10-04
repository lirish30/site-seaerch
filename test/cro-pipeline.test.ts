import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runCroAudit, runCroWithErrorHandling, shotKey, type CroDeps } from "../src/worker/cro/pipeline";
import type { CroCaller, StageRequest } from "../src/worker/cro/ai";
import type { PageCapture } from "../src/worker/cro/types";
import type { StepLike } from "../src/worker/pipeline/lead";
import { createCroAudit, getCroAudit, listCroItems, updateCroAudit } from "../src/worker/db/cro";
import { seedBusiness, seedLeadAudit, snapshot, model, rec } from "./fixtures/cro";

const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} };
const capture = (url: string, o: Partial<PageCapture> = {}): PageCapture => ({
  ok: true, finalUrl: url, desktop: snapshot({ url }), mobile: snapshot({ url, viewport: { w: 390, h: 844 } }),
  desktopJpeg: new Uint8Array([1]), mobileJpeg: new Uint8Array([2]), desktopTopJpeg: new Uint8Array([3]), mobileTopJpeg: new Uint8Array([4]),
  axe: null, consoleErrors: [], failedRequests: [], requestHosts: [], flow: null, ...o,
});
const review = { five_second_read: { thinks_business_does: "Plumbing", would_do_next: "Call" }, strengths: ["Clear phone number"],
  issues: [{ observation: "No button in the header", principle: "Visitors look top-right", evidence_ids: ["E1"] }] };
const roadmap = (recs = [
  rec({ title: "Say what you do in the headline", observation: `Your headline says "Welcome to Our Website"`, area: "hero", mode: "test" }),
  rec({ title: "Track calls and forms", area: "tracking", catalog_id: "tracking_plan", mode: "strategic", effort: "medium" }),
  rec({ title: "Add a quote button to the header", mode: "test" }),
]) => ({ strengths: ["Real team photos"], positioning: { says_now: "Welcome to Our Website", should_say: "Boise's same-day plumbers" },
  tracking_plan: [{ event: "call_click", why: "Calls are the main lead" }], recommendations: recs });

function fakeAi(o: { model?: unknown; page?: unknown; synth?: unknown } = {}) {
  const calls: StageRequest[] = [];
  const ai: CroCaller = async (r) => {
    calls.push(r);
    const input = r.stage === "model" ? ("model" in o ? o.model : model()) : r.stage === "pages" ? o.page ?? review : o.synth ?? roadmap();
    return { input, costUsd: 0.01, model: "claude-haiku-4-5" };
  };
  return { ai, calls, count: (s: string) => calls.filter((c) => c.stage === s).length };
}
function deps(o: Partial<CroDeps> & { pages?: Record<string, Partial<PageCapture>> } = {}) {
  const visited: string[] = [];
  const { pages, ...rest } = o;
  const d: CroDeps = { db: env.DB, raw: env.RAW, now: () => new Date("2026-10-04T00:00:00Z"), ai: fakeAi().ai,
    browser: async (url) => { visited.push(url); return capture(url, pages?.[url]); }, ...rest };
  return { d, visited };
}
async function start(links = {}) {
  const b = await seedBusiness();
  await seedLeadAudit(b.id, links);
  return { b, a: await createCroAudit(env.DB, b.id) };
}

describe("runCroAudit", () => {
  it("captures pages, builds evidence, runs the three stages and saves a ranked roadmap", async () => {
    const { a } = await start({ contact: "https://ace.com/contact" });
    const ai = fakeAi();
    const { d, visited } = deps({ ai: ai.ai });
    await runCroAudit(d, step, { auditId: a.id });
    expect(visited).toEqual(["https://ace.com/", "https://ace.com/contact"]);
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r).toMatchObject({ status: "done", step: "done", partial: false, warning: null, reviewed_as: "lead_gen_phone" });
    expect(r.evidence.length).toBeGreaterThan(5);
    expect(r.page_reviews).toHaveLength(2);
    expect(r.scenario_inputs).toMatchObject({ visitors: 500, dealValue: 900 });
    expect(r.est_cost_usd).toBeCloseTo(0.04);
    expect(r.models_used).toEqual({ model: "claude-haiku-4-5", pages: "claude-haiku-4-5", synthesize: "claude-haiku-4-5" });
    expect([ai.count("model"), ai.count("pages"), ai.count("synthesize")]).toEqual([1, 2, 1]);
    const items = await listCroItems(env.DB, a.id);
    expect(items[0].area).toBe("tracking");
    expect(items.find((i) => i.area === "hero")!.mode).toBe("test");
    expect(items.find((i) => i.area === "header_nav")!.mode).toBe("fix_measure");
    expect(await env.RAW.get(shotKey(a.id, 0, "desktop"))).not.toBeNull();
    expect(await env.RAW.get(shotKey(a.id, 1, "mobile", true))).not.toBeNull();
  });

  it("skips a page that fails to load and marks the audit partial", async () => {
    const { a } = await start({ contact: "https://ace.com/contact" });
    await runCroAudit(deps({ pages: { "https://ace.com/contact": { ok: false } } }).d, step, { auditId: a.id });
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r).toMatchObject({ status: "done", partial: true });
    expect(r.pages.map((p) => p.ok)).toEqual([true, false]);
    expect(r.page_reviews).toHaveLength(1);
  });

  it("fails with a clear message when the homepage can't be loaded", async () => {
    const { a } = await start();
    await runCroWithErrorHandling(deps({ browser: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } }).d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "failed", error: "Couldn't load the site" });
  });

  it("fails clearly when Browser Rendering isn't configured", async () => {
    const { a } = await start();
    await runCroWithErrorHandling(deps({ browser: undefined }).d, step, { auditId: a.id });
    expect((await getCroAudit(env.DB, a.id))!.error).toBe("Browser Rendering isn't configured, so pages can't be captured");
  });

  it("records the failing step when the model stage gives unusable output twice", async () => {
    const { a } = await start();
    const ai = fakeAi({ model: null });
    await runCroWithErrorHandling(deps({ ai: ai.ai }).d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "failed", step: "model", error: "Couldn't work out how this business makes money" });
    expect(ai.count("model")).toBe(2);
  });

  it("completes with a warning when too few recommendations survive, after one retry with the reasons", async () => {
    const { a } = await start();
    const ai = fakeAi({ synth: roadmap([rec({ title: "A", observation: `Your button says "Get Started Today"` }),
      rec({ title: "B", observation: `The "Free same-day quotes" banner` }), rec({ title: "C" })]) });
    await runCroAudit(deps({ ai: ai.ai }).d, step, { auditId: a.id });
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r.status).toBe("done");
    expect(r.warning).toContain("Only 1 recommendation had solid evidence behind it");
    expect(await listCroItems(env.DB, a.id)).toHaveLength(1);
    expect(ai.count("synthesize")).toBe(2);
    expect(JSON.stringify(ai.calls.filter((c) => c.stage === "synthesize")[1].content)).toContain("is not on the page");
  });

  it("rebuilds from synthesize with the user's overrides and without re-capturing", async () => {
    const { a } = await start();
    await runCroAudit(deps().d, step, { auditId: a.id });
    await updateCroAudit(env.DB, a.id, { model_overrides: { traffic_tier: "medium" } });
    const ai = fakeAi();
    const { d, visited } = deps({ ai: ai.ai });
    await runCroAudit(d, step, { auditId: a.id, from: "synthesize" });
    expect(visited).toEqual([]);
    expect([ai.count("model"), ai.count("pages"), ai.count("synthesize")]).toEqual([0, 0, 1]);
    expect((await listCroItems(env.DB, a.id)).find((i) => i.area === "header_nav")!.mode).toBe("test");
  });
  it("handles a desktop-only capture (no mobile snapshot or images)", async () => {
    const { a } = await start();
    const { d } = deps({ pages: { "https://ace.com/": { mobile: null, mobileJpeg: null, mobileTopJpeg: null } } });
    await runCroAudit(d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "done", partial: false });
    expect(await env.RAW.get(shotKey(a.id, 0, "mobile"))).toBeNull();
    expect(await env.RAW.get(shotKey(a.id, 0, "desktop"))).not.toBeNull();
  });

  it("records an AI refusal or API error as a failed audit at that step", async () => {
    const { a } = await start();
    const ai: CroCaller = async (r) => { if (r.stage === "pages") throw new Error("Claude declined to review this site"); return { input: model(), costUsd: 0.01, model: "claude-haiku-4-5" }; };
    await runCroWithErrorHandling(deps({ ai }).d, step, { auditId: a.id });
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "failed", step: "pages", error: "Claude declined to review this site" });
  });

  it("accepts a quote of wording inside a fact (a button label) but not wording the code wrote into a fact", async () => {
    const { a } = await start();
    const codeFact = "No guarantee or warranty wording found";
    const cta = { text: "Get a Quote", href: "/q", box: { x: 0, y: 0, w: 120, h: 40 }, aboveFold: true, inHeader: true, contrast: 5, fontPx: 16 };
    const idOf = async (match: string) => (await getCroAudit(env.DB, a.id))!.evidence.find((e) => e.fact.includes(match))!.id;
    const ai: CroCaller = async (r) => {
      if (r.stage === "model") return { input: model(), costUsd: 0, model: "claude-haiku-4-5" };
      const [btn, guar] = [await idOf("Desktop header button"), await idOf(codeFact)];
      if (r.stage === "pages") return { costUsd: 0, model: "claude-haiku-4-5", input: { ...review, issues: [
        { observation: "Button is clear", principle: "p", evidence_ids: [btn], quote: "Get a Quote" },
        { observation: "No promise made", principle: "p", evidence_ids: [guar], quote: codeFact }] } };
      return { costUsd: 0, model: "claude-haiku-4-5", input: roadmap([
        rec({ title: "Keep the header button", observation: `The header button says "Get a Quote"`, evidence_ids: [btn] }),
        rec({ title: "Add a guarantee", observation: `Your site says "${codeFact}"`, evidence_ids: [guar] }),
        rec({ title: "Show reviews", observation: "No review widget", evidence_ids: [btn] }),
        rec({ title: "Add phone to header", observation: "No phone in the header", evidence_ids: [btn] })]) };
    };
    const { d } = deps({ ai, pages: { "https://ace.com/": { desktop: snapshot({ ctas: [cta] }) } } });
    await runCroAudit(d, step, { auditId: a.id });
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r.page_reviews[0].issues.map((i) => i.quote)).toEqual(["Get a Quote"]);
    expect((await listCroItems(env.DB, a.id)).map((i) => i.title).sort()).toEqual(["Add phone to header", "Keep the header button", "Show reviews"]);
  });

  it("caps strengths at 6 and restarts the stale-run clock", async () => {
    const { a } = await start();
    await updateCroAudit(env.DB, a.id, { started_at: "2020-01-01T00:00:00.000Z", status: "failed", error: "Timed out" });
    const ai = fakeAi({ synth: { ...roadmap(), strengths: Array.from({ length: 9 }, (_, i) => `Strength ${i}`) } });
    await runCroAudit(deps({ ai: ai.ai }).d, step, { auditId: a.id });
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r.strengths).toHaveLength(6);
    expect(r).toMatchObject({ status: "done", error: null, started_at: "2026-10-04T00:00:00.000Z" });
  });
});
