import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { regenerateDraft, type LeadDeps } from "../src/worker/pipeline/lead";
import { saveSettings } from "../src/worker/db/settings";
import { lastMonths, monthlySpend, recordUsage } from "../src/worker/db/usage";
import { saveGoogleAuth } from "../src/worker/db/google";
import { createFitProfile } from "../src/worker/db/fit";
import { MATCH_AT } from "../src/worker/routes/fit";
import { seedBusiness, seedLeadAudit } from "./fixtures/cro";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, redirect: "manual", headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

describe("usage history", () => {
  it("lists the last six months ending at the given month, oldest first", () => {
    expect(lastMonths("2026-10", 6)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(lastMonths("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
  it("sums each month's estimated cost and zero-fills quiet months", async () => {
    await env.DB.prepare(`DELETE FROM usage`).run();
    const ins = (month: string, cost: number) => env.DB.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES (?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), month, "claude", 1, cost, `${month}-05T00:00:00.000Z`).run();
    await ins("2026-08", 10); await ins("2026-08", 2.5); await ins("2026-10", 4); await ins("2025-01", 99);
    expect(await monthlySpend(env.DB, "2026-10")).toEqual([
      { month: "2026-05", est_cost_usd: 0 }, { month: "2026-06", est_cost_usd: 0 }, { month: "2026-07", est_cost_usd: 0 },
      { month: "2026-08", est_cost_usd: 12.5 }, { month: "2026-09", est_cost_usd: 0 }, { month: "2026-10", est_cost_usd: 4 },
    ]);
    await env.DB.prepare(`DELETE FROM usage`).run();
  });
  it("is served at /api/settings/usage-history with six months ending now", async () => {
    await recordUsage(env.DB, "claude", 1, 0.5);
    const r = await (await api("/api/settings/usage-history")).json<any>();
    expect(r.months).toHaveLength(6);
    expect(r.months[5]).toEqual({ month: new Date().toISOString().slice(0, 7), est_cost_usd: 0.5 });
    await env.DB.prepare(`DELETE FROM usage`).run();
  });
});

describe("mailing footer and Gmail defaults", () => {
  afterEach(async () => { await saveSettings(env.DB, { footer_freelance: 1, footer_full_time: 0, attach_audit_pdf: 1, default_purpose: "full_time" }); });
  const put = (body: unknown) => api("/api/settings", { method: "PUT", body: JSON.stringify(body) });

  it("defaults to what drafts already did: footer on for freelance, off for full-time, PDF attached", async () => {
    const s = (await (await api("/api/settings")).json<any>()).settings;
    expect([s.footer_freelance, s.footer_full_time, s.attach_audit_pdf]).toEqual([1, 0, 1]);
  });
  it("saves the three switches and rejects anything but 0 or 1", async () => {
    const r = await put({ footer_full_time: 1, attach_audit_pdf: 0 });
    expect(await r.json()).toMatchObject({ footer_full_time: 1, attach_audit_pdf: 0, footer_freelance: 1 });
    expect((await put({ footer_freelance: 2 })).status).toBe(400);
    expect((await put({ footer_freelance: "yes" })).status).toBe(400);
  });

  const deps = (): LeadDeps => ({ db: env.DB, raw: env.RAW, pagespeedKey: "K", fetch: async () => new Response(""), now: () => new Date(),
    claude: async () => ({ variants: [{ angle: "A", subject: "S", body: "B" }], to_contact_id: null, recipient_reason: "r" }) }) as unknown as LeadDeps;
  it("new drafts take their footer default from the settings", async () => {
    const b = await seedBusiness(); await seedLeadAudit(b.id);
    await saveSettings(env.DB, { footer_full_time: 1, footer_freelance: 0 });
    expect((await regenerateDraft(deps(), b.id, { purpose: "full_time" })).include_footer).toBe(true);
    expect((await regenerateDraft(deps(), b.id, { purpose: "freelance" })).include_footer).toBe(false);
    await saveSettings(env.DB, { footer_full_time: 0, footer_freelance: 1 });
    expect((await regenerateDraft(deps(), b.id, { purpose: "full_time" })).include_footer).toBe(false);
    expect((await regenerateDraft(deps(), b.id, { purpose: "freelance" })).include_footer).toBe(true);
  });
});

describe("google status", () => {
  it("reports when it was connected (only while connected), and the callback returns to the Google page", async () => {
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect(await (await api("/api/google/status")).json()).toEqual({ configured: false, connected: false, email: null });
    await saveGoogleAuth(env.DB, "me@example.com", "sealed");
    const st = await (await api("/api/google/status")).json<any>();
    expect(st).toMatchObject({ connected: true, email: "me@example.com" });
    expect(Date.parse(st.connected_at)).not.toBeNaN();
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    const cb = await SELF.fetch("https://x/api/google/callback?code=c&state=bad", { redirect: "manual" });
    expect(cb.headers.get("location")).toBe("/settings/google?google=failed");
  });
});

describe("fit profile match counts", () => {
  it("counts leads that fit each profile alone at MATCH_AT or better; a profile with no criteria matches none", async () => {
    const b = await seedBusiness({ name: "Ace Plumbing" }); // Plumber, Boise, 38 reviews
    const plumbers = await createFitProfile(env.DB, { name: "Plumbers", service_key: "seo", industries: ["plumber"], geos: ["boise"] });
    const half = await createFitProfile(env.DB, { name: "Half", service_key: "seo", industries: ["plumber"], geos: ["tulsa"] });
    const empty = await createFitProfile(env.DB, { name: "Empty", service_key: "seo" });
    const r = await (await api("/api/fit-profiles/matches")).json<any>();
    expect(r.matchAt).toBe(MATCH_AT);
    expect(r.counts[plumbers.id]).toBeGreaterThanOrEqual(1);
    expect(r.counts[half.id]).toBe(0);
    expect(r.counts[empty.id]).toBe(0);
    expect(b.id).toBeTruthy();
    await env.DB.prepare(`DELETE FROM fit_profiles WHERE id IN (?,?,?)`).bind(plumbers.id, half.id, empty.id).run();
  });
});
