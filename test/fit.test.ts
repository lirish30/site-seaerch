import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { scoreFit } from "../src/worker/scoring/fit";
import { createFitProfile, deleteFitProfile, listFitProfiles, updateFitProfile } from "../src/worker/db/fit";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { insertAudit } from "../src/worker/db/audits";
import type { Audit, Business, FitProfile } from "../src/worker/types";

const biz = (o: Partial<Business> = {}): Business => ({
  id: "b1", place_id: null, domain: null, name: "Ace Plumbing", category: "Plumber", address: "12 Main St, Boise, ID",
  phone: null, website_url: "https://ace.com", maps_url: null, rating: 4.5, review_count: 30, first_seen_search_id: null,
  lead_status: "new", notes: null, contacted_at: null, last_error: null, created_at: "2026-01-01", archived_at: null,
  follow_up_at: null, deal_value: null, ...o,
});
const aud = (o: Partial<Audit> = {}): Audit => ({ id: "a1", business_id: "b1", created_at: "2026-01-01", site_status: "ok", health_score: 80, platform: "wordpress", ...o } as Audit);
const prof = (o: Partial<FitProfile> = {}): FitProfile => ({
  id: "p1", name: "P", service_key: "seo", industries: [], geos: [], platforms: [], min_reviews: null, min_rating: null, active: true, ...o,
});

describe("scoreFit", () => {
  it("industry+geo scores higher than geo-only for the same profile", () => {
    const p = prof({ industries: ["plumb"], geos: ["boise"] });
    const both = scoreFit(biz(), null, [p]);
    const geoOnly = scoreFit(biz({ category: "Bakery" }), null, [p]);
    expect(both.fit).toBe(100);
    expect(geoOnly.fit).toBe(50);
    expect(both.fit!).toBeGreaterThan(geoOnly.fit!);
  });
  it("matches industry and geo case-insensitively as substrings", () => {
    const r = scoreFit(biz({ category: "Emergency PLUMBER", address: "1 x, BOISE" }), null, [prof({ industries: ["plumber"], geos: ["Boise"] })]);
    expect(r.matched).toEqual(["industry", "geo"]);
  });
  it("is null with no active profiles", () => {
    expect(scoreFit(biz(), null, [])).toEqual({ fit: null, profile: null, matched: [], missing: [] });
    expect(scoreFit(biz(), null, [prof({ geos: ["boise"], active: false })]).fit).toBeNull();
  });
  it("ignores a profile with no defined criteria", () => {
    const r = scoreFit(biz(), null, [prof({ id: "empty" }), prof({ id: "real", geos: ["nowhere"] })]);
    expect(r.profile?.id).toBe("real");
    expect(r.fit).toBe(0);
    expect(scoreFit(biz(), null, [prof()]).fit).toBeNull();
  });
  it("matches platform from the audit; a null platform or no audit leaves it missing", () => {
    const p = prof({ platforms: ["wordpress"] });
    expect(scoreFit(biz(), aud({ platform: "wordpress" }), [p])).toMatchObject({ fit: 100, matched: ["platform"], missing: [] });
    expect(scoreFit(biz(), aud({ platform: null }), [p])).toMatchObject({ fit: 0, matched: [], missing: ["platform"] });
    expect(scoreFit(biz(), aud({ platform: "wix" }), [p])).toMatchObject({ fit: 0, missing: ["platform"] });
    expect(scoreFit(biz(), null, [p])).toMatchObject({ fit: 0, missing: ["platform"] });
  });
  it("scores reviews and rating thresholds; unknown values are missing", () => {
    const p = prof({ min_reviews: 10, min_rating: 4 });
    expect(scoreFit(biz(), null, [p])).toMatchObject({ fit: 100, matched: ["reviews", "rating"] });
    expect(scoreFit(biz({ review_count: 9 }), null, [p])).toMatchObject({ fit: 50, matched: ["rating"], missing: ["reviews"] });
    expect(scoreFit(biz({ review_count: null, rating: null }), null, [p])).toMatchObject({ fit: 0, missing: ["reviews", "rating"] });
    expect(scoreFit(biz({ review_count: 10, rating: 4 }), null, [p]).fit).toBe(100);
  });
  it("lists criterion names in matched and missing", () => {
    const r = scoreFit(biz(), aud({ platform: "wix" }), [prof({ industries: ["plumb"], geos: ["tulsa"], platforms: ["wordpress"], min_reviews: 5 })]);
    expect(r.matched).toEqual(["industry", "reviews"]);
    expect(r.missing).toEqual(["geo", "platform"]);
    expect(r.fit).toBe(50);
  });
  it("rounds to a whole number", () => {
    expect(scoreFit(biz(), null, [prof({ industries: ["plumb"], geos: ["x"], min_reviews: 1 })]).fit).toBe(67);
  });
  it("best profile wins and ties go to the first", () => {
    const a = prof({ id: "a", name: "A", geos: ["tulsa"] });
    const b = prof({ id: "b", name: "B", geos: ["boise"], service_key: "local-seo" });
    const c = prof({ id: "c", name: "C", geos: ["boise"] });
    const r = scoreFit(biz(), null, [a, b, c]);
    expect(r.profile).toEqual({ id: "b", name: "B", service_key: "local-seo" });
    expect(r.fit).toBe(100);
  });
  it("skips inactive profiles when picking the best", () => {
    const r = scoreFit(biz(), null, [prof({ id: "off", geos: ["boise"], active: false }), prof({ id: "on", geos: ["tulsa"] })]);
    expect(r.profile?.id).toBe("on");
  });
  it("never uses site health: a failed crawl fits the same as a healthy site", () => {
    const profiles = [prof({ industries: ["plumb"], platforms: ["wordpress"], min_reviews: 10 })];
    const healthy = scoreFit(biz(), aud({ health_score: 92, site_status: "ok" }), profiles);
    const failed = scoreFit(biz(), aud({ health_score: null, site_status: "unreachable" }), profiles);
    expect(failed).toEqual(healthy);
    expect(failed.fit).toBe(100);
  });
});

describe("fit profile db + routes", () => {
  let cookie = "";
  const api = (path: string, init: RequestInit = {}) =>
    SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  afterEach(async () => { await env.DB.prepare(`DELETE FROM fit_profiles WHERE id NOT LIKE 'fit-%'`).run(); });

  it("seeds the three profiles with stable ids", async () => {
    const all = await listFitProfiles(env.DB);
    const byId = Object.fromEntries(all.map((p) => [p.id, p]));
    expect(byId["fit-wordpress-care"]).toMatchObject({ name: "WordPress care", service_key: "hosting-maintenance", platforms: ["wordpress"], industries: [], geos: [], min_reviews: null, min_rating: null, active: true });
    expect(byId["fit-cro"]).toMatchObject({ name: "CRO", service_key: "conversion-rate-optimization", platforms: [], min_reviews: 10, min_rating: 4 });
    expect(byId["fit-redesign"]).toMatchObject({ name: "Redesign", service_key: "web-design-development", platforms: ["wix", "squarespace", "godaddy", "weebly"] });
  });
  it("db round trip: create, partial update, delete", async () => {
    const p = await createFitProfile(env.DB, { name: "Local", service_key: "local-seo", geos: ["Boise"], min_rating: 4.2 });
    expect(p).toMatchObject({ name: "Local", geos: ["Boise"], industries: [], min_rating: 4.2, active: true });
    const u = await updateFitProfile(env.DB, p.id, { active: false, industries: ["plumber"] });
    expect(u).toMatchObject({ active: false, industries: ["plumber"], geos: ["Boise"], min_rating: 4.2 });
    expect(await updateFitProfile(env.DB, p.id, { min_rating: null })).toMatchObject({ min_rating: null });
    expect(await updateFitProfile(env.DB, "nope", { active: false })).toBeNull();
    expect(await deleteFitProfile(env.DB, p.id)).toBe(true);
    expect(await deleteFitProfile(env.DB, p.id)).toBe(false);
  });
  it("requires auth", async () => {
    expect((await SELF.fetch("https://x/api/fit-profiles")).status).toBe(401);
  });
  it("CRUD round trip over HTTP", async () => {
    const list = await (await api("/api/fit-profiles")).json<any[]>();
    expect(list.map((p) => p.id)).toEqual(expect.arrayContaining(["fit-wordpress-care", "fit-cro", "fit-redesign"]));
    const created = await api("/api/fit-profiles", { method: "POST", body: JSON.stringify({ name: "Boise plumbers", service_key: "seo", industries: ["plumber"], geos: ["Boise"], platforms: ["wix"], min_reviews: 5 }) });
    expect(created.status).toBe(201);
    const p = await created.json<any>();
    expect(p).toMatchObject({ name: "Boise plumbers", service_key: "seo", industries: ["plumber"], platforms: ["wix"], min_reviews: 5, min_rating: null, active: true });
    const patched = await api(`/api/fit-profiles/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: false, min_reviews: null }) });
    expect(await patched.json<any>()).toMatchObject({ active: false, min_reviews: null, geos: ["Boise"] });
    expect((await api(`/api/fit-profiles/${p.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/fit-profiles/${p.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await api(`/api/fit-profiles/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: true }) })).status).toBe(404);
  });
  it("400s for an unknown service_key, bad platform, bad numbers and empty patches", async () => {
    const post = (b: unknown) => api("/api/fit-profiles", { method: "POST", body: JSON.stringify(b) });
    expect((await post({ name: "X", service_key: "not-a-service" })).status).toBe(400);
    expect((await post({ name: "", service_key: "seo" })).status).toBe(400);
    expect((await post({ name: "X", service_key: "seo", platforms: ["myspace"] })).status).toBe(400);
    expect((await post({ name: "X", service_key: "seo", min_rating: 9 })).status).toBe(400);
    expect((await post({ name: "X", service_key: "seo", min_reviews: -1 })).status).toBe(400);
    const patch = (b: unknown) => api("/api/fit-profiles/fit-cro", { method: "PATCH", body: JSON.stringify(b) });
    expect((await patch({ service_key: "not-a-service" })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await listFitProfiles(env.DB)).find((p) => p.id === "fit-cro")!.service_key).toBe("conversion-rate-optimization");
  });
  it("accepts a patch that moves a profile to another catalog service", async () => {
    const p = await createFitProfile(env.DB, { name: "M", service_key: "seo", geos: ["x"] });
    const r = await api(`/api/fit-profiles/${p.id}`, { method: "PATCH", body: JSON.stringify({ service_key: "local-seo" }) });
    expect(await r.json<any>()).toMatchObject({ service_key: "local-seo" });
  });
});

describe("fit in lead payloads", () => {
  let cookie = "";
  const api = (path: string) => SELF.fetch(`https://x${path}`, { headers: { cookie } });
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  it("puts fit on list rows and the detail payload, including a business with no audit", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const mk = (name: string, o: object = {}) => upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: "Plumber", address: "1 Main, Boise", phone: null, websiteUrl: "https://x.com", mapsUrl: null, rating: 4.6, reviewCount: 40, ...o }, s.id);
    const withAudit = await mk("With Audit");
    const noAudit = await mk("No Audit");
    await insertAudit(env.DB, { business_id: withAudit.id, site_status: "unreachable", partial: true, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
      https: null, has_title: null, has_meta_description: null, has_contact_form: null, copyright_year: null, latest_content_date: null, broken_link_count: null,
      platform: "wordpress", seo_score: null, accessibility_score: null, mail_warning: null, score: 10, offer: "new_site", findings: [], raw_r2_key: null,
      health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
    const rows = await (await api("/api/leads?limit=500")).json<any[]>();
    const a = rows.find((r) => r.business.id === withAudit.id), n = rows.find((r) => r.business.id === noAudit.id);
    expect(a.fit.profile.id).toBe("fit-wordpress-care");
    expect(a.fit).toMatchObject({ fit: 100, matched: ["platform"], missing: [] });
    // no audit: platform criterion is missing (WP care 0, Redesign 0), but CRO matches on reviews/rating
    expect(n.fit).toMatchObject({ fit: 100, profile: { id: "fit-cro", service_key: "conversion-rate-optimization" }, matched: ["reviews", "rating"] });
    const detail = await (await api(`/api/leads/${withAudit.id}`)).json<any>();
    expect(detail.fit).toEqual(a.fit);
    const search = await (await api(`/api/searches/${s.id}`)).json<any>();
    expect(search.leads.every((l: any) => "fit" in l)).toBe(true);
  });
});
