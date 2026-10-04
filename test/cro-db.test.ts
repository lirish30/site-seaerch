import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createCroAudit, getCroAudit, latestCroAudit, listCroAudits, updateCroAudit, addCroCost, runningCroAudit,
  replaceCroItems, listCroItems, updateCroItem, croItemsForBusiness } from "../src/worker/db/cro";
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

  it("accumulates cost and records the model per stage", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await addCroCost(env.DB, a.id, 0.01, "model", "claude-haiku-4-5");
    await addCroCost(env.DB, a.id, 0.02, "pages", "claude-haiku-4-5");
    const r = (await getCroAudit(env.DB, a.id))!;
    expect(r.est_cost_usd).toBeCloseTo(0.03);
    expect(r.models_used).toEqual({ model: "claude-haiku-4-5", pages: "claude-haiku-4-5" });
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
