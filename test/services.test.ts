import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import typesSrc from "../src/worker/types.ts?raw";
import {
  OFFER_TO_SERVICE, createService, getServiceByKey, listServices, offerService, serviceKey, updateService,
} from "../src/worker/db/services";
import type { Offer } from "../src/worker/types";

const SPECIALTY = ["hosting-maintenance", "conversion-rate-optimization", "seo", "ai-search-optimization", "web-design-development", "wordpress-development", "graphic-design"];

// Undo what a test added or deactivated (the test DB is shared within this file); edits to text fields restore themselves.
afterEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM services WHERE sort > 340`), env.DB.prepare(`UPDATE services SET active = 1`)]);
});

describe("seed", () => {
  it("has exactly 34 services across 6 categories, ordered by sort", async () => {
    const all = await listServices(env.DB);
    expect(all).toHaveLength(34);
    expect(new Set(all.map((s) => s.category))).toEqual(new Set(
      ["Search & Visibility", "Paid Media", "Websites", "Brand & Content", "AI & Strategy", "Growth & Optimization"]));
    expect(all.map((s) => s.sort)).toEqual(all.map((_, i) => (i + 1) * 10));
    expect(all[0].name).toBe("SEO");
    expect(all[33].name).toBe("Analytics & Attribution");
    expect(all.every((s) => s.active && s.summary.length > 0)).toBe(true);
  });
  it("flags exactly the 7 specialty services", async () => {
    const all = await listServices(env.DB);
    expect(all.filter((s) => s.is_specialty).map((s) => s.key).sort()).toEqual([...SPECIALTY].sort());
  });
  it("slugs the keys the brief names exactly", async () => {
    const keys = (await listServices(env.DB)).map((s) => s.key);
    for (const k of ["hosting-maintenance", "conversion-rate-optimization", "seo", "ai-search-optimization", "web-design-development",
      "wordpress-development", "graphic-design", "technical-seo", "local-seo", "website-accessibility", "content-strategy", "ppc-paid-media"]) {
      expect(keys).toContain(k);
    }
    expect(new Set(keys).size).toBe(34);
  });
  it("maps evidence to services and only uses real finding codes", async () => {
    const declared = new Set(typesSrc.slice(typesSrc.indexOf("export type FindingCode"), typesSrc.indexOf("export interface Finding "))
      .match(/"[a-z0-9_]+"/g)!.map((s) => s.slice(1, -1)));
    expect(declared.has("slow_mobile")).toBe(true);
    const all = await listServices(env.DB);
    for (const s of all) for (const c of s.finding_codes) {
      if (c.endsWith("*")) continue;
      expect(declared.has(c), `${s.key} maps unknown code ${c}`).toBe(true);
    }
    const hosting = all.find((s) => s.key === "hosting-maintenance")!;
    expect(hosting.finding_codes).toContain("no_email_auth");
    expect(hosting.finding_categories).toEqual(["speed"]);
    expect(all.find((s) => s.key === "conversion-rate-optimization")!.finding_codes).toContain("cro:*");
    expect(all.find((s) => s.key === "web-design-development")!.finding_categories).toEqual(["design", "mobile"]);
    expect(all.find((s) => s.key === "local-seo")!.finding_codes).toEqual(["no_local_schema"]);
    expect(all.find((s) => s.key === "branding")!.finding_codes).toEqual([]);
  });
});

describe("db", () => {
  it("activeOnly excludes a service after it is deactivated", async () => {
    const seo = (await getServiceByKey(env.DB, "seo"))!;
    await updateService(env.DB, seo.id, { active: false });
    expect((await listServices(env.DB, { activeOnly: true })).map((s) => s.key)).not.toContain("seo");
    expect((await listServices(env.DB, { activeOnly: true }))).toHaveLength(33);
    expect(await listServices(env.DB)).toHaveLength(34);
  });
  it("round-trips JSON arrays, booleans and nullable fields", async () => {
    const s = (await getServiceByKey(env.DB, "copywriting"))!;
    const u = (await updateService(env.DB, s.id, {
      deliverables: ["5 pages", "tone guide"], prerequisites: ["brand brief"], first_engagement: "Homepage rewrite",
      finding_codes: ["thin_homepage"], finding_categories: ["content"], is_specialty: true, summary: "New summary.",
    }))!;
    expect(u).toMatchObject({ deliverables: ["5 pages", "tone guide"], prerequisites: ["brand brief"], first_engagement: "Homepage rewrite",
      finding_codes: ["thin_homepage"], finding_categories: ["content"], is_specialty: true, active: true, summary: "New summary." });
    expect(await getServiceByKey(env.DB, "copywriting")).toEqual(u);
    expect((await updateService(env.DB, s.id, { first_engagement: null }))!.first_engagement).toBeNull();
    await updateService(env.DB, s.id, { is_specialty: false, deliverables: [], finding_codes: [], finding_categories: [], summary: s.summary });
  });
  it("updateService returns null for an unknown id and leaves other rows alone", async () => {
    expect(await updateService(env.DB, "nope", { name: "x" })).toBeNull();
  });
  it("createService slugifies the name, appends to the end and rejects a duplicate key", async () => {
    expect(serviceKey("PPC & Paid Media")).toBe("ppc-paid-media");
    expect(serviceKey("  Pool  Cleaning!! ")).toBe("pool-cleaning");
    const s = await createService(env.DB, { name: "Pool Cleaning", category: "Other", summary: "Cleans pools." });
    expect(s).toMatchObject({ key: "pool-cleaning", name: "Pool Cleaning", category: "Other", active: true, is_specialty: false, deliverables: [], sort: 350 });
    await expect(createService(env.DB, { name: "pool cleaning", category: "Other" })).rejects.toThrow(/UNIQUE/i);
    await expect(createService(env.DB, { name: "SEO", category: "x" })).rejects.toThrow(/UNIQUE/i);
    await expect(createService(env.DB, { name: "!!!", category: "x" })).rejects.toThrow(/name/i);
  });
});

describe("offerService", () => {
  const OFFERS: Offer[] = ["new_site", "performance", "care_plan", "seo_basics", "conversion"];
  it("maps every Offer onto a seeded service key", async () => {
    expect(OFFER_TO_SERVICE).toEqual({ new_site: "web-design-development", performance: "hosting-maintenance", care_plan: "hosting-maintenance",
      seo_basics: "seo", conversion: "conversion-rate-optimization" });
    const services = await listServices(env.DB);
    for (const o of OFFERS) expect(offerService(o, services)?.key).toBe(OFFER_TO_SERVICE[o]);
  });
  it("returns null when the mapped service is inactive or missing", async () => {
    const cro = (await getServiceByKey(env.DB, "conversion-rate-optimization"))!;
    await updateService(env.DB, cro.id, { active: false });
    const services = await listServices(env.DB);
    expect(offerService("conversion", services)).toBeNull();
    expect(offerService("conversion", services.filter((s) => s.key !== "conversion-rate-optimization"))).toBeNull();
    expect(offerService("new_site", services)?.key).toBe("web-design-development");
  });
});

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

describe("routes", () => {
  it("requires auth", async () => {
    expect((await SELF.fetch("https://x/api/services")).status).toBe(401);
  });
  it("GET lists the catalog", async () => {
    const r = await api("/api/services");
    expect(r.status).toBe(200);
    const body = await r.json<any[]>();
    expect(body).toHaveLength(34);
    expect(body[0]).toMatchObject({ key: "seo", is_specialty: true, active: true, deliverables: [] });
  });
  it("PATCH updates fields and returns the service; 404 for unknown id; 400 for empty name or empty patch", async () => {
    const seo = (await getServiceByKey(env.DB, "brand-messaging"))!;
    const r = await api(`/api/services/${seo.id}`, { method: "PATCH", body: JSON.stringify({ active: false, deliverables: ["Messaging doc"], first_engagement: "Workshop" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ key: "brand-messaging", active: false, deliverables: ["Messaging doc"], first_engagement: "Workshop" });
    expect((await getServiceByKey(env.DB, "brand-messaging"))!.active).toBe(false);
    const patch = (id: string, b: unknown) => api(`/api/services/${id}`, { method: "PATCH", body: JSON.stringify(b) });
    expect((await patch("nope", { active: true })).status).toBe(404);
    expect((await patch(seo.id, { name: "   " })).status).toBe(400);
    expect((await patch(seo.id, {})).status).toBe(400);
    expect((await patch(seo.id, { finding_categories: ["bogus"] })).status).toBe(400);
    expect((await patch(seo.id, { name: "Brand Messaging (renamed)" })).status).toBe(200);
    await patch(seo.id, { name: "Brand Messaging", active: true, deliverables: [], first_engagement: null });
  });
  it("POST creates a service (201), slugging the key; 400 on empty name; 409 on duplicate", async () => {
    const post = (b: unknown) => api("/api/services", { method: "POST", body: JSON.stringify(b) });
    const r = await post({ name: "Pool Cleaning", category: "Other", summary: "Cleans pools." });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ key: "pool-cleaning", name: "Pool Cleaning", category: "Other", active: true, is_specialty: false });
    expect((await post({ name: "pool-cleaning!", category: "Other" })).status).toBe(409);
    expect((await post({ name: "  ", category: "Other" })).status).toBe(400);
    expect((await post({ name: "???", category: "Other" })).status).toBe(400);
    expect((await api("/api/services")).status).toBe(200);
  });
});
