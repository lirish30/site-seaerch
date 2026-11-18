import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createCroAudit, getCroAudit, latestCroAudit, listCroAudits, updateCroAudit, runningCroAudit, finishRoadmap,
  replaceCroItems, failCroAudit, listCroItems, updateCroItem, croItemsForBusiness } from "../src/worker/db/cro";
import { deleteBusiness } from "../src/worker/db/businesses";
import { seedBusiness, model, ev, ranked } from "./fixtures/cro";

describe("cro db", () => {
  it("creates, updates JSON/boolean columns and reads them back", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    expect(a).toMatchObject({ status: "running", step: "capture", partial: false, evidence: [], model_overrides: {}, est_cost_usd: 0 });
    await updateCroAudit(env.DB, a.id, { step: "evidence", partial: true, evidence: [ev("E1")], business_model: model(), model_overrides: { traffic_tier: "medium" } });
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r.partial).toBe(true);
    expect(r.evidence[0].id).toBe("E1");
    expect(r.business_model!.model).toBe("lead_gen_phone");
    expect(r.model_overrides).toEqual({ traffic_tier: "medium" });
  });

  it("finishRoadmap writes the roadmap only while the audit waits on it, for the run the task belongs to", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    const roadmap = { strengths: ["Fast"], positioning: { says_now: "a", should_say: "b" }, tracking_plan: [{ event: "e", why: "w" }],
      scenario_inputs: { visitors: 1, currentRate: 0.02, targetRate: 0.03, closeRate: 0.2, dealValue: 100 }, warning: "careful",
      completedAt: "2026-10-04T00:00:00.000Z" };
    await updateCroAudit(env.DB, a.id, { status: "waiting", step: "pages", stages_at: "2026-10-03T00:00:00.000Z" });
    expect(await finishRoadmap(env.DB, a.id, { ...roadmap, notBefore: "2026-10-03T00:00:01.000Z" })).toBe(false); // still on the pages
    await updateCroAudit(env.DB, a.id, { step: "synthesize" });
    expect(await finishRoadmap(env.DB, a.id, { ...roadmap, notBefore: "2026-10-02T00:00:00.000Z" })).toBe(false); // queued before the run began
    expect(await finishRoadmap(env.DB, a.id, { ...roadmap, notBefore: "2026-10-03T00:00:01.000Z" })).toBe(true);
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "done", step: "done", error: null, strengths: ["Fast"], tracking_plan: [{ event: "e", why: "w" }],
      positioning: { says_now: "a", should_say: "b" }, scenario_inputs: roadmap.scenario_inputs, warning: "careful", completed_at: "2026-10-04T00:00:00.000Z" });
    expect(await finishRoadmap(env.DB, a.id, { ...roadmap, notBefore: "2026-10-03T00:00:01.000Z" })).toBe(false); // done already: a second completion changes nothing
  });

  it("latest/list return newest first; latest can require done", async () => {
    const b = await seedBusiness();
    const a1 = await createCroAudit(env.DB, b.id);
    await updateCroAudit(env.DB, a1.id, { status: "done", step: "done" });
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await createCroAudit(env.DB, b.id);
    expect((await latestCroAudit(env.DB, b.id))!.id).toBe(a2.id);
    expect((await latestCroAudit(env.DB, b.id, { status: "done" }))!.id).toBe(a1.id);
    expect((await listCroAudits(env.DB, b.id)).map((x) => x.id)).toEqual([a2.id, a1.id]);
  });

  it("runningCroAudit ignores and fails audits stuck running longer than 30 minutes", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    expect((await runningCroAudit(env.DB, b.id, new Date()))!.id).toBe(a.id);
    const later = new Date(Date.now() + 31 * 60 * 1000);
    expect(await runningCroAudit(env.DB, b.id, later)).toBeNull();
    expect((await getCroAudit(env.DB, a.id))!).toMatchObject({ status: "failed", error: "Timed out" });
  });

  it("a stale rebuild of an audit that already had a roadmap goes back to done, with the failure noted", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await updateCroAudit(env.DB, a.id, { status: "running", step: "synthesize", completed_at: "2026-10-01T00:00:00.000Z" });
    expect(await runningCroAudit(env.DB, b.id, new Date(Date.now() + 31 * 60 * 1000))).toBeNull();
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "done", step: "done", error: "Timed out", completed_at: "2026-10-01T00:00:00.000Z" });
  });

  it("failCroAudit fails a first run but restores an audit that had finished before", async () => {
    const b = await seedBusiness();
    const first = await createCroAudit(env.DB, b.id), rebuilt = await createCroAudit(env.DB, b.id);
    await updateCroAudit(env.DB, first.id, { status: "running", step: "pages" });
    await updateCroAudit(env.DB, rebuilt.id, { status: "running", step: "pages", completed_at: "2026-10-01T00:00:00.000Z" });
    await failCroAudit(env.DB, first.id, "boom");
    await failCroAudit(env.DB, rebuilt.id, "boom");
    expect(await getCroAudit(env.DB, first.id)).toMatchObject({ status: "failed", step: "pages", error: "boom" });
    expect(await getCroAudit(env.DB, rebuilt.id)).toMatchObject({ status: "done", step: "done", error: "boom" });
  });

  it("an old audit restarted for a rebuild is not treated as stale", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await env.DB.prepare(`UPDATE cro_audits SET created_at = '2020-01-01T00:00:00.000Z', started_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).bind(a.id).run();
    await updateCroAudit(env.DB, a.id, { status: "running", started_at: new Date().toISOString() });
    expect((await runningCroAudit(env.DB, b.id, new Date()))!.id).toBe(a.id);
  });

  it("replaceCroItems keeps edited items and skips regenerated duplicates of them", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await replaceCroItems(env.DB, a.id, [ranked({ title: "Add a quote button", rank: 1 }), ranked({ title: "Shorter form", rank: 2 })]);
    const [first] = await listCroItems(env.DB, a.id);
    await updateCroItem(env.DB, first.id, { change: "My own wording" });
    await replaceCroItems(env.DB, a.id, [ranked({ title: "add a QUOTE button", rank: 1 }), ranked({ title: "Sticky call bar", rank: 2 })]);
    const items = await listCroItems(env.DB, a.id);
    expect(items.map((i) => i.title).sort()).toEqual(["Add a quote button", "Sticky call bar"]);
    expect(items.find((i) => i.title === "Add a quote button")).toMatchObject({ change: "My own wording", edited: true });
  });

  it("updateCroItem toggles included and sets edited; croItemsForBusiness scopes to the lead", async () => {
    const b = await seedBusiness(); const other = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await replaceCroItems(env.DB, a.id, [ranked()]);
    const [i] = await listCroItems(env.DB, a.id);
    expect(await updateCroItem(env.DB, i.id, { included: false })).toMatchObject({ included: false, edited: true });
    expect((await croItemsForBusiness(env.DB, b.id, [i.id])).map((x) => x.id)).toEqual([i.id]);
    expect(await croItemsForBusiness(env.DB, other.id, [i.id])).toEqual([]);
  });

  it("deleteBusiness removes CRO audits and items", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await replaceCroItems(env.DB, a.id, [ranked()]);
    await deleteBusiness(env.DB, b.id);
    expect(await getCroAudit(env.DB, a.id)).toBeNull();
    expect(await listCroItems(env.DB, a.id)).toEqual([]);
  });
});
