import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { seedBusiness, seedLeadAudit } from "./fixtures/cro";
import { addSuppression } from "../src/worker/db/suppression";
import { applySync, saveCareerSource } from "../src/worker/db/jobs";

let cookie = "";
const api = (path: string, init: RequestInit = {}) => SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => { for (const t of ["job_postings", "career_sources", "audits"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

const NOW = new Date().toISOString();
const role = (id: string, title: string, kind: "seo" | "web_dev" | null = "seo") =>
  ({ external_id: id, title, url: `https://boards.example/${id}`, location: null, department: null, role_kind: kind, posted_at: null });

describe("jobs routes", () => {
  it("requires a login", async () => {
    expect((await SELF.fetch("https://x/api/jobs")).status).toBe(401);
    expect((await SELF.fetch("https://x/api/jobs/run", { method: "POST" })).status).toBe(401);
  });

  it("GET /api/jobs lists open roles in the field and hides suppressed and archived leads", async () => {
    const shown = await seedBusiness(), blocked = await seedBusiness(), archived = await seedBusiness();
    await env.DB.prepare(`UPDATE businesses SET website_url = ?, domain = ? WHERE id = ?`).bind("https://blocked.example", "blocked.example", blocked.id).run();
    await env.DB.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ?`).bind(NOW, archived.id).run();
    await addSuppression(env.DB, { kind: "domain", value: "blocked.example", reason: "client" });
    for (const [b, t] of [[shown, "SEO Manager"], [blocked, "Blocked SEO"], [archived, "Archived SEO"]] as const) await applySync(env.DB, b.id, [role("1", t), role("2", "Welder", null)], NOW, false);
    const body = (await (await api("/api/jobs")).json()) as { jobs: { title: string; business_name: string }[] };
    expect(body.jobs.map((j) => j.title)).toEqual(["SEO Manager"]);
    expect(body.jobs[0].business_name).toBe(shown.name);
  });

  it("GET /api/jobs drops roles the board has not shown in the last 48 hours", async () => {
    const stale = await seedBusiness(), fresh = await seedBusiness();
    await applySync(env.DB, stale.id, [role("1", "Stale SEO")], new Date(Date.now() - 3 * 86_400_000).toISOString(), false);
    await applySync(env.DB, fresh.id, [role("1", "Fresh SEO")], NOW, false);
    const body = (await (await api("/api/jobs")).json()) as { jobs: { title: string }[] };
    expect(body.jobs.map((j) => j.title)).toEqual(["Fresh SEO"]);
  });

  it("GET /api/jobs/leads/:id returns the board and its roles, and 404s for an unknown lead", async () => {
    const b = await seedBusiness();
    await saveCareerSource(env.DB, { business_id: b.id, status: "active", ats: "lever", token: "acme", careers_url: null, checked_at: NOW, next_check_at: NOW });
    await applySync(env.DB, b.id, [role("1", "SEO Manager")], NOW, false);
    const body = (await (await api(`/api/jobs/leads/${b.id}`)).json()) as { source: { ats: string }; postings: { title: string }[] };
    expect([body.source.ats, body.postings.map((p) => p.title)]).toEqual(["lever", ["SEO Manager"]]);
    expect((await api("/api/jobs/leads/nope")).status).toBe(404);
    expect((await api("/api/jobs/leads/nope/check", { method: "POST" })).status).toBe(404);
  });

  it("GET for a lead nobody has checked yet is an empty answer, not an error", async () => {
    const b = await seedBusiness();
    expect(await (await api(`/api/jobs/leads/${b.id}`)).json()).toEqual({ source: null, postings: [] });
  });

  it("POST check on a lead that has not been scanned yet records nothing and makes no request", async () => {
    const b = await seedBusiness();
    const r = await api(`/api/jobs/leads/${b.id}/check`, { method: "POST" });
    expect([r.status, await r.json()]).toEqual([200, { source: null, postings: [] }]);
  });

  it("POST check on a scanned lead with no careers link records that there is no board", async () => {
    const b = await seedBusiness(); await seedLeadAudit(b.id);
    await env.DB.prepare(`UPDATE audits SET site_links = '{}' WHERE business_id = ?`).bind(b.id).run();
    const body = (await (await api(`/api/jobs/leads/${b.id}/check`, { method: "POST" })).json()) as { source: { status: string } };
    expect(body.source.status).toBe("none");
  });

  it("POST /api/jobs/run answers 202 straight away", async () => {
    const r = await api("/api/jobs/run", { method: "POST" });
    expect([r.status, await r.json()]).toEqual([202, { started: true }]);
  });

  it("POST /api/leads/:id/regenerate rejects a usePosting that is not a boolean, before doing any work", async () => {
    const b = await seedBusiness();
    const r = await api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: JSON.stringify({ usePosting: "yes" }) });
    expect([r.status, await r.json()]).toEqual([400, { error: "invalid" }]);
  });
});
