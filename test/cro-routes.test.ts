import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { createCroAudit, getCroAudit, latestCroAudit, listCroItems, replaceCroItems, updateCroAudit } from "../src/worker/db/cro";
import { shotKey, textKey } from "../src/worker/cro/pipeline";
import { defaultScenario } from "../src/worker/cro/scenario";
import { seedBusiness, model, ranked, ev } from "./fixtures/cro";
import type { PageReview } from "../src/worker/cro/types";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const created: { id: string; params: unknown }[] = [];
const orig = env.CRO_AUDIT_WORKFLOW.create;

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(() => { created.length = 0; (env.CRO_AUDIT_WORKFLOW as any).create = async (o: any) => { created.push(o); return { id: o.id }; }; });
afterEach(() => { (env.CRO_AUDIT_WORKFLOW as any).create = orig; });

async function doneAudit() {
  const b = await seedBusiness();
  const a = await createCroAudit(env.DB, b.id);
  await updateCroAudit(env.DB, a.id, { status: "done", step: "done", business_model: model(), reviewed_as: "lead_gen_phone", evidence: [ev("E1")],
    pages: [{ index: 0, url: "https://ace.com/", kind: "home", ok: true, key: "k" }] });
  await replaceCroItems(env.DB, a.id, [ranked()]);
  return { b, a };
}

const review: PageReview = { page: "https://ace.com/", five_second_read: { thinks_business_does: "plumbing", would_do_next: "call" }, strengths: [], issues: [] };

describe("CRO routes", () => {
  it("refuses leads without a real website and creates nothing", async () => {
    for (const url of [null, "https://facebook.com/aceplumbing"]) {
      const b = await seedBusiness({ websiteUrl: url });
      const r = await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "This lead has no website to audit" });
      expect(await latestCroAudit(env.DB, b.id)).toBeNull();
    }
    expect(created).toEqual([]);
  });

  it("refuses blank, unparseable and social-only websites (no scheme) without creating an audit", async () => {
    for (const url of ["   ", "not a url at all", "instagram.com/aceplumbing", "www.facebook.com/aceplumbing"]) {
      const b = await seedBusiness({ websiteUrl: url });
      const r = await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" });
      expect(r.status).toBe(400);
      expect(await latestCroAudit(env.DB, b.id)).toBeNull();
    }
    expect((await api(`/api/leads/nope/cro-audit`, { method: "POST" })).status).toBe(404);
    expect(created).toEqual([]);
  });

  it("starts an audit, logs activity, and refuses a second run while one is in flight", async () => {
    const b = await seedBusiness();
    const r = await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" });
    expect(r.status).toBe(202);
    const a = await r.json<any>();
    expect(created[0].params).toEqual({ auditId: a.id });
    const lead = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(lead.activity[0].kind).toBe("cro_audit");
    const again = await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("lets a new run start when the previous one has been stuck for over 30 minutes", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await env.DB.prepare(`UPDATE cro_audits SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).bind(a.id).run();
    expect((await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" })).status).toBe(202);
    expect((await getCroAudit(env.DB, a.id))!.status).toBe("failed");
  });

  it("fails the audit it just created (so the lead isn't blocked) when the workflow can't be started", async () => {
    const b = await seedBusiness();
    (env.CRO_AUDIT_WORKFLOW as any).create = async () => { throw new Error("workflow down"); };
    const r = await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" });
    expect(r.status).toBe(502);
    const a = await latestCroAudit(env.DB, b.id);
    expect(a).toMatchObject({ status: "failed" });
    expect(a!.error).toMatch(/start/i);
    (env.CRO_AUDIT_WORKFLOW as any).create = async (o: any) => { created.push(o); return { id: o.id }; };
    expect((await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" })).status).toBe(202);
  });

  it("blocks the run when it would exceed the monthly spend limit", async () => {
    const b = await seedBusiness();
    await saveSettings(env.DB, { monthly_spend_limit_usd: 0 });
    try {
      const r = await api(`/api/leads/${b.id}/cro-audit`, { method: "POST" });
      expect(r.status).toBe(402);
      expect((await r.json<any>()).error).toBe("spend limit");
      expect(await latestCroAudit(env.DB, b.id)).toBeNull();
    } finally { await saveSettings(env.DB, { monthly_spend_limit_usd: 25 }); }
  });

  it("returns the latest audit with items, or an empty state; ignores another lead's audit id", async () => {
    const empty = await seedBusiness();
    expect(await (await api(`/api/leads/${empty.id}/cro-audit`)).json()).toEqual({ audit: null, items: [] });
    const { b, a } = await doneAudit();
    const r = await (await api(`/api/leads/${b.id}/cro-audit`)).json<any>();
    expect(r.audit.id).toBe(a.id);
    expect(r.items).toHaveLength(1);
    expect(await (await api(`/api/leads/${empty.id}/cro-audit?audit=${a.id}`)).json()).toEqual({ audit: null, items: [] });
    expect((await (await api(`/api/leads/${b.id}/cro-audits`)).json<any[]>())[0]).toMatchObject({ id: a.id, item_count: 1 });
  });

  it("marks a dead run failed when the lead's audit is read, so the UI stops polling it", async () => {
    const b = await seedBusiness();
    const a = await createCroAudit(env.DB, b.id);
    await env.DB.prepare(`UPDATE cro_audits SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).bind(a.id).run();
    const r = await (await api(`/api/leads/${b.id}/cro-audit`)).json<any>();
    expect(r.audit).toMatchObject({ id: a.id, status: "failed" });
  });

  it("edits an item and validates the body", async () => {
    const { a } = await doneAudit();
    const [item] = await listCroItems(env.DB, a.id);
    const r = await api(`/api/cro-items/${item.id}`, { method: "PATCH", body: JSON.stringify({ change: "Use a bright orange button", included: false }) });
    expect(await r.json()).toMatchObject({ change: "Use a bright orange button", included: false, edited: true });
    expect((await api(`/api/cro-items/${item.id}`, { method: "PATCH", body: JSON.stringify({ horizon: 45 }) })).status).toBe(400);
    expect((await api(`/api/cro-items/nope`, { method: "PATCH", body: JSON.stringify({ title: "x" }) })).status).toBe(404);
  });

  it("only applies whitelisted item fields and rejects empty or non-object bodies", async () => {
    const { a } = await doneAudit();
    const [item] = await listCroItems(env.DB, a.id);
    const r = await api(`/api/cro-items/${item.id}`, { method: "PATCH", body: JSON.stringify({
      title: "New title", cro_audit_id: "other", id: "other", edited: false, pxl_score: 99, evidence_ids: ["X"], created_at: "x" }) });
    expect(r.status).toBe(200);
    const after = (await listCroItems(env.DB, a.id))[0];
    expect(after).toMatchObject({ id: item.id, cro_audit_id: a.id, title: "New title", edited: true, pxl_score: item.pxl_score, evidence_ids: item.evidence_ids, created_at: item.created_at });
    for (const body of ["{}", "null", "[]", "not json", JSON.stringify({ title: "" }), JSON.stringify({ title: null })])
      expect((await api(`/api/cro-items/${item.id}`, { method: "PATCH", body })).status).toBe(400);
    expect((await listCroItems(env.DB, a.id))[0].title).toBe("New title");
  });

  it("saves assumptions; rebuild re-runs page reviews only when the business model changed", async () => {
    const { a } = await doneAudit();
    const save = await api(`/api/cro-audits/${a.id}/assumptions`, { method: "PATCH", body: JSON.stringify({
      overrides: { traffic_tier: "medium", deal_value_band: { low: 500, high: 2000 }, sales_cycle: "1-2 weeks" },
      scenario: { visitors: 900, currentRate: 0.02, targetRate: 0.04, closeRate: 0.5, dealValue: 1200 } }) });
    expect((await save.json<any>()).model_overrides).toEqual({ traffic_tier: "medium",
      deal_value_band: { low: 500, high: 2000, rationale: "Set by you", evidence_ids: [] }, sales_cycle: { label: "1-2 weeks", rationale: "Set by you" } });
    let r = await api(`/api/cro-audits/${a.id}/rebuild`, { method: "POST" });
    expect(await r.json()).toEqual({ ok: true, from: "synthesize" });
    expect((await api(`/api/cro-audits/${a.id}/rebuild`, { method: "POST" })).status).toBe(409);
    await updateCroAudit(env.DB, a.id, { status: "done" });
    await api(`/api/cro-audits/${a.id}/assumptions`, { method: "PATCH", body: JSON.stringify({ overrides: { model: "appointment" } }) });
    r = await api(`/api/cro-audits/${a.id}/rebuild`, { method: "POST" });
    expect(await r.json()).toEqual({ ok: true, from: "pages" });
    expect(created.map((c) => c.params)).toEqual([{ auditId: a.id, from: "synthesize" }, { auditId: a.id, from: "pages" }]);
  });

  it("keeps the revenue scenario in step with job value, traffic and model edits until the user saves their own scenario", async () => {
    const { a } = await doneAudit();
    const patch = (body: unknown) => api(`/api/cro-audits/${a.id}/assumptions`, { method: "PATCH", body: JSON.stringify(body) }).then((r) => r.json<any>());
    await updateCroAudit(env.DB, a.id, { scenario_inputs: defaultScenario(model()) });
    let r = await patch({ overrides: { deal_value_band: { low: 5000, high: 10000 }, traffic_tier: "high", model: "appointment" } });
    expect(r.scenario_inputs).toEqual({ ...defaultScenario({ ...model(), deal_value_band: { low: 5000, high: 10000, rationale: "", evidence_ids: [] }, traffic_tier: "high", model: "appointment" }) });
    expect(r.scenario_inputs).toMatchObject({ dealValue: 7500, visitors: 8000 });
    expect(r.scenario_inputs.edited).toBeUndefined();
    r = await patch({ overrides: { sales_cycle: "1 week" } });
    expect(r.scenario_inputs).toMatchObject({ dealValue: 7500, visitors: 8000 });
    // The user's own numbers win from then on, and a later job-value edit no longer touches them.
    r = await patch({ scenario: { visitors: 900, currentRate: 0.02, targetRate: 0.04, closeRate: 0.5, dealValue: 1200 } });
    expect(r.scenario_inputs).toEqual({ visitors: 900, currentRate: 0.02, targetRate: 0.04, closeRate: 0.5, dealValue: 1200, edited: true });
    r = await patch({ overrides: { deal_value_band: { low: 100, high: 300 }, traffic_tier: "low" } });
    expect(r.scenario_inputs).toEqual({ visitors: 900, currentRate: 0.02, targetRate: 0.04, closeRate: 0.5, dealValue: 1200, edited: true });
  });

  it("leaves a missing scenario alone when assumptions change before the first roadmap", async () => {
    const { a } = await doneAudit();
    const r = await api(`/api/cro-audits/${a.id}/assumptions`, { method: "PATCH", body: JSON.stringify({ overrides: { traffic_tier: "high" } }) }).then((x) => x.json<any>());
    expect(r.scenario_inputs).toBeNull();
  });

  it("rejects nonsense assumptions without changing anything, and refuses edits while the audit is running", async () => {
    const { a } = await doneAudit();
    const bad = [
      { scenario: { visitors: -1, currentRate: 0.02, targetRate: 0.04, closeRate: 0.5, dealValue: 1200 } },
      { scenario: { visitors: 900, currentRate: 2, targetRate: 0.04, closeRate: 0.5, dealValue: 1200 } },
      { scenario: { visitors: 900, currentRate: 0.02, targetRate: 0.04, closeRate: -0.1, dealValue: 1200 } },
      { scenario: { visitors: 900, currentRate: 0.02, targetRate: 0.04, closeRate: 0.5, dealValue: -5 } },
      { scenario: { visitors: "900", currentRate: 0.02, targetRate: 0.04, closeRate: 0.5, dealValue: 1 } },
      { scenario: { visitors: 900, currentRate: 0.02, targetRate: 0.04, closeRate: 0.5 } },
      { overrides: { model: "nonsense" } },
      { overrides: { traffic_tier: "huge" } },
      { overrides: { deal_value_band: { low: 2000, high: 500 } } },
      { overrides: { deal_value_band: { low: -1, high: 500 } } },
      { overrides: { sales_cycle: "   " } },
      "nope",
    ];
    for (const body of bad) expect((await api(`/api/cro-audits/${a.id}/assumptions`, { method: "PATCH", body: JSON.stringify(body) })).status).toBe(400);
    expect((await api(`/api/cro-audits/nope/assumptions`, { method: "PATCH", body: JSON.stringify({}) })).status).toBe(404);
    const after = (await getCroAudit(env.DB, a.id))!;
    expect(after.model_overrides).toEqual({});
    expect(after.scenario_inputs).toBeNull();
    await updateCroAudit(env.DB, a.id, { status: "running" });
    expect((await api(`/api/cro-audits/${a.id}/assumptions`, { method: "PATCH", body: JSON.stringify({ overrides: { traffic_tier: "high" } }) })).status).toBe(409);
  });

  it("refuses rebuilds that have nothing to build on or that run while another audit for the lead is in flight", async () => {
    expect((await api(`/api/cro-audits/nope/rebuild`, { method: "POST" })).status).toBe(404);
    const b = await seedBusiness();
    const fresh = await createCroAudit(env.DB, b.id);
    await updateCroAudit(env.DB, fresh.id, { status: "failed" });
    expect((await api(`/api/cro-audits/${fresh.id}/rebuild`, { method: "POST" })).status).toBe(409); // no business model yet
    const { a: done, b: lead } = await doneAudit();
    await createCroAudit(env.DB, lead.id); // a second audit for the same lead is running
    expect((await api(`/api/cro-audits/${done.id}/rebuild`, { method: "POST" })).status).toBe(409);
    expect(created).toEqual([]);
  });

  it("blocks rebuild over the spend limit", async () => {
    const { a } = await doneAudit();
    await saveSettings(env.DB, { monthly_spend_limit_usd: 0 });
    try {
      const r = await api(`/api/cro-audits/${a.id}/rebuild`, { method: "POST" });
      expect(r.status).toBe(402);
      expect((await getCroAudit(env.DB, a.id))!.status).toBe("done");
    } finally { await saveSettings(env.DB, { monthly_spend_limit_usd: 25 }); }
  });

  it("retries only failed audits, from the step that failed", async () => {
    const { a } = await doneAudit();
    expect((await api(`/api/cro-audits/${a.id}/retry`, { method: "POST" })).status).toBe(409);
    await updateCroAudit(env.DB, a.id, { status: "failed", step: "evidence" });
    expect(await (await api(`/api/cro-audits/${a.id}/retry`, { method: "POST" })).json()).toEqual({ ok: true, from: "capture" });
    expect((await getCroAudit(env.DB, a.id))!).toMatchObject({ status: "running", error: null });
    expect((await api(`/api/cro-audits/nope/retry`, { method: "POST" })).status).toBe(404);
  });

  it("picks the retry point from what was stored, not from a stale step", async () => {
    const retry = async (patch: Parameters<typeof updateCroAudit>[2]) => {
      const { a } = await doneAudit();
      await updateCroAudit(env.DB, a.id, { status: "failed", ...patch });
      const r = await api(`/api/cro-audits/${a.id}/retry`, { method: "POST" });
      expect(r.status).toBe(202);
      return (await r.json<any>()).from;
    };
    // Stale "done" next to a failure: only the stored outputs say where to resume.
    expect(await retry({ step: "done", pages: [] })).toBe("capture");
    expect(await retry({ step: "done", evidence: [] })).toBe("capture");
    expect(await retry({ step: "done", pages: [{ index: 0, url: "https://ace.com/", kind: "home", ok: false, key: null }] })).toBe("capture");
    expect(await retry({ step: "done", business_model: null })).toBe("model");
    expect(await retry({ step: "done", page_reviews: [] })).toBe("pages");
    expect(await retry({ step: "done", page_reviews: [review] })).toBe("synthesize");
    // The step is honoured when it points earlier than the outputs (they're left over from a previous run).
    expect(await retry({ step: "pages", page_reviews: [review] })).toBe("pages");
    expect(await retry({ step: "model", page_reviews: [review] })).toBe("model");
    expect(await retry({ step: "synthesize", page_reviews: [review] })).toBe("synthesize");
    // A step that claims more progress than was stored is ignored.
    expect(await retry({ step: "synthesize", page_reviews: [] })).toBe("pages");
    // Reviews written for a different business model are redone.
    expect(await retry({ step: "done", page_reviews: [review], model_overrides: { model: "appointment" } })).toBe("pages");
    expect(created.map((c) => (c.params as any).from)).toHaveLength(11);
  });

  it("won't retry while the lead has another audit in flight", async () => {
    const { a, b } = await doneAudit();
    await updateCroAudit(env.DB, a.id, { status: "failed" });
    await createCroAudit(env.DB, b.id);
    expect((await api(`/api/cro-audits/${a.id}/retry`, { method: "POST" })).status).toBe(409);
    expect(created).toEqual([]);
  });

  it("marks a retry failed again when the workflow can't be started", async () => {
    const { a } = await doneAudit();
    await updateCroAudit(env.DB, a.id, { status: "failed", step: "evidence", error: "boom" });
    (env.CRO_AUDIT_WORKFLOW as any).create = async () => { throw new Error("workflow down"); };
    expect((await api(`/api/cro-audits/${a.id}/retry`, { method: "POST" })).status).toBe(502);
    expect((await getCroAudit(env.DB, a.id))!.status).toBe("failed");
  });

  it("a rebuild or retry that can't start leaves an audit that had a roadmap usable, with the failure noted", async () => {
    const { a } = await doneAudit();
    await updateCroAudit(env.DB, a.id, { completed_at: "2026-10-01T00:00:00.000Z" });
    (env.CRO_AUDIT_WORKFLOW as any).create = async () => { throw new Error("workflow down"); };
    expect((await api(`/api/cro-audits/${a.id}/rebuild`, { method: "POST" })).status).toBe(502);
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "done", step: "done", error: "Couldn't start the audit workflow", completed_at: "2026-10-01T00:00:00.000Z" });
    const r = await api(`/api/leads/${a.business_id}/cro-audit`).then((x) => x.json<any>());
    expect(r.audit.status).toBe("done");
    expect(r.items).toHaveLength(1);
    // A later rebuild that does start clears the note.
    (env.CRO_AUDIT_WORKFLOW as any).create = async (o: any) => { created.push(o); return { id: o.id }; };
    expect((await api(`/api/cro-audits/${a.id}/rebuild`, { method: "POST" })).status).toBe(202);
    expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "running", error: null, completed_at: "2026-10-01T00:00:00.000Z" });
  });

  it("serves screenshots and the eval fixture", async () => {
    const { a } = await doneAudit();
    expect((await api(`/api/cro-audits/${a.id}/shot/0/desktop`)).status).toBe(404);
    await env.RAW.put(shotKey(a.id, 0, "desktop"), new Uint8Array([1, 2]));
    await env.RAW.put(shotKey(a.id, 0, "mobile", true), new Uint8Array([3]));
    await env.RAW.put(textKey(a.id, 0), "Welcome to Our Website");
    const s = await api(`/api/cro-audits/${a.id}/shot/0/desktop`);
    expect(s.headers.get("content-type")).toBe("image/jpeg");
    expect((await api(`/api/cro-audits/${a.id}/shot/0/mobile?top=1`)).status).toBe(200);
    const fx = await (await api(`/api/cro-audits/${a.id}/eval-fixture`)).json<any>();
    expect(fx.pages[0]).toMatchObject({ text: "Welcome to Our Website", shots: { desktop: null, mobile: "Aw==" } });
    expect(fx.evidence[0].id).toBe("E1");
    expect(fx.business.name).toBe("Ace Plumbing");
  });

  it("only serves shots for pages that belong to the audit, never a caller-chosen key", async () => {
    const { a } = await doneAudit();
    const other = await doneAudit();
    await env.RAW.put(shotKey(a.id, 0, "desktop"), new Uint8Array([1]));
    await env.RAW.put(shotKey(a.id, 5, "desktop"), new Uint8Array([9])); // exists in R2 but isn't one of this audit's pages
    await env.RAW.put("secret.jpg", new Uint8Array([7]));
    expect((await api(`/api/cro-audits/${a.id}/shot/5/desktop`)).status).toBe(404);
    expect((await api(`/api/cro-audits/nope/shot/0/desktop`)).status).toBe(404);
    expect((await api(`/api/cro-audits/${other.a.id}/shot/0/desktop`)).status).toBe(404); // its own R2 object is absent
    for (const p of [`/api/cro-audits/${a.id}/shot/0/desktop.jpg`, `/api/cro-audits/${a.id}/shot/0/tablet`, `/api/cro-audits/${a.id}/shot/-1/desktop`,
      `/api/cro-audits/${a.id}/shot/..%2F..%2Fsecret.jpg/desktop`, `/api/cro-audits/..%2Fsecret/shot/0/desktop`])
      expect([p, (await api(p)).status]).toEqual([p, 404]);
    expect((await api(`/api/cro-audits/${a.id}/shot/0/desktop`)).status).toBe(200);
  });

  it("only exports the eval fixture for a finished audit", async () => {
    const { a } = await doneAudit();
    const r = await api(`/api/cro-audits/${a.id}/eval-fixture`);
    expect(r.headers.get("content-disposition")).toContain(`cro-fixture-${a.id}.json`);
    await updateCroAudit(env.DB, a.id, { status: "failed" });
    expect((await api(`/api/cro-audits/${a.id}/eval-fixture`)).status).toBe(404);
    expect((await api(`/api/cro-audits/nope/eval-fixture`)).status).toBe(404);
  });
});
