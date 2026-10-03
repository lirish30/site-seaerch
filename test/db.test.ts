import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSearch, getSearch, incrementProcessed } from "../src/worker/db/searches";
import { upsertBusiness, updateLead, listBusinessesForSearch } from "../src/worker/db/businesses";
import { insertAudit, latestAudit } from "../src/worker/db/audits";
import { replaceContacts, listContacts } from "../src/worker/db/contacts";
import { getSettings, saveSettings } from "../src/worker/db/settings";
import { recordUsage, monthUsage } from "../src/worker/db/usage";
import type { Listing } from "../src/worker/types";

const listing = (o: Partial<Listing> = {}): Listing => ({
  placeId: "p1", name: "Ace Plumbing", category: "Plumber", address: "1 Main St", phone: "555",
  websiteUrl: "https://aceplumbing.com/", mapsUrl: null, rating: 4.5, reviewCount: 10, ...o,
});

describe("db", () => {
  it("creates a search and increments progress", async () => {
    const s = await createSearch(env.DB, { location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 50 });
    await incrementProcessed(env.DB, s.id);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
  });

  it("dedupes businesses by place_id and links to both searches", async () => {
    const s1 = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const s2 = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing(), s1.id);
    const b = await upsertBusiness(env.DB, listing(), s2.id);
    expect(b.id).toBe(a.id);
    expect(await listBusinessesForSearch(env.DB, s2.id, { hideSkipped: false })).toHaveLength(1);
  });

  it("dedupes by website domain when place_id is missing, ignoring www and path", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing({ placeId: null, websiteUrl: "http://www.dom-x.com/home" }), s.id);
    const b = await upsertBusiness(env.DB, listing({ placeId: null, websiteUrl: "https://dom-x.com" }), s.id);
    expect(b.id).toBe(a.id);
  });

  it("re-upsert does not reset lead status; skip hides from search list", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing({ placeId: "p-skip" }), s.id);
    await updateLead(env.DB, a.id, { leadStatus: "skip" });
    const again = await upsertBusiness(env.DB, listing({ placeId: "p-skip" }), s.id);
    expect(again.lead_status).toBe("skip");
    expect(await listBusinessesForSearch(env.DB, s.id, { hideSkipped: true })).toHaveLength(0);
  });

  it("marks contacted_at when status becomes contacted", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const a = await upsertBusiness(env.DB, listing({ placeId: "p-c" }), s.id);
    const u = await updateLead(env.DB, a.id, { leadStatus: "contacted" });
    expect(u.contacted_at).not.toBeNull();
  });

  it("stores audits with findings JSON and returns latest", async () => {
    const s = await createSearch(env.DB, { location: "A", businessType: "b", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "p-a" }), s.id);
    await insertAudit(env.DB, {
      business_id: b.id, site_status: "ok", partial: false, pagespeed_mobile: 40, lcp_ms: 5000, cls: 0.1,
      mobile_friendly: true, https: true, has_title: true, has_meta_description: false, has_contact_form: true,
      copyright_year: 2019, latest_content_date: null, broken_link_count: 0, score: 41, offer: "performance",
      findings: [{ code: "slow_mobile", group: "speed", severity: "high", points: 25, evidence: "x" }], raw_r2_key: null,
    });
    const a = await latestAudit(env.DB, b.id);
    expect(a!.findings[0].code).toBe("slow_mobile");
    expect(a!.partial).toBe(false);
  });

  it("replaces contacts", async () => {
    await replaceContacts(env.DB, "biz1", [{ type: "email", value: "a@b.com", source_url: null, person_name: null, role: null, confidence: 0.9 }]);
    await replaceContacts(env.DB, "biz1", [{ type: "phone", value: "555", source_url: null, person_name: null, role: null, confidence: 0.5 }]);
    const c = await listContacts(env.DB, "biz1");
    expect(c.map((x) => x.type)).toEqual(["phone"]);
  });

  it("saves settings and sums usage per month", async () => {
    await saveSettings(env.DB, { your_name: "Logan" });
    expect((await getSettings(env.DB)).your_name).toBe("Logan");
    await recordUsage(env.DB, "claude", 1, 0.01);
    await recordUsage(env.DB, "claude", 2, 0.02);
    const month = new Date().toISOString().slice(0, 7);
    const rows = await monthUsage(env.DB, month);
    expect(rows.find((r) => r.service === "claude")!.units).toBe(3);
  });
});
