import { env } from "cloudflare:test";
import { createSearch } from "../../src/worker/db/searches";
import { upsertBusiness } from "../../src/worker/db/businesses";
import type { BusinessModel, Evidence, PageSnapshot, RankedItem, Recommendation } from "../../src/worker/cro/types";

export async function seedBusiness(o: { websiteUrl?: string | null; name?: string } = {}) {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  return upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: o.name ?? "Ace Plumbing", category: "Plumber",
    address: "12 Main St, Boise, ID 83702", phone: "(208) 555-1234",
    websiteUrl: o.websiteUrl === undefined ? "https://ace.com" : o.websiteUrl, mapsUrl: null, rating: 4.6, reviewCount: 38 }, s.id);
}

export const box = (x = 0, y = 0, w = 120, h = 40) => ({ x, y, w, h });

export function snapshot(o: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://ace.com/", title: "Ace Plumbing", viewport: { w: 1440, h: 900 },
    h1: ["Welcome to Our Website"], heroText: "Welcome to Our Website. Quality service at competitive prices.",
    ctas: [], nav: [], stickyHeader: false, telLinks: [], headerPhoneText: null, mailtoCount: 0,
    forms: [], trust: { reviewWidget: null, testimonialCount: 0, attributedTestimonials: 0, badgeCount: 0, guaranteeText: null, yearsText: null },
    scripts: [], globals: [], overflowX: false, smallTextPct: 0,
    text: "Welcome to Our Website Quality service at competitive prices. We are a family business. Call (208) 555-1234. 12 Main St, Boise",
    ...o,
  };
}

export const model = (o: Partial<BusinessModel> = {}): BusinessModel => ({
  model: "lead_gen_phone", secondary_model: null, primary_conversion: "Quote request or phone call",
  micro_conversions: ["Tap to call", "Start quote form"], customer_jobs: ["Fix a burst pipe today"],
  deal_value_band: { low: 300, high: 1500, rationale: "Repair work", evidence_ids: [] },
  sales_cycle: { label: "Same day to 1 week", rationale: "Urgent repairs" },
  traffic_tier: "low", confidence: "medium", ...o,
});

export const ev = (id: string, o: Partial<Evidence> = {}): Evidence => ({
  id, page: "https://ace.com/", pageKind: "home", family: "cta", fact: `fact ${id}`, ...o,
});

export const rec = (o: Partial<Recommendation> = {}): Recommendation => ({
  title: "Add a quote button to the header", observation: "The header has no button", change: "Add a 'Get a Quote' button",
  why: "Visitors look top-right for the next step", area: "header_nav", mode: "fix", impact: "high", effort: "low",
  evidence_ids: ["E1"], catalog_id: "header_cta", we_can_do_it: "Quick fix: I'll add it", ...o,
});

export const ranked = (o: Partial<RankedItem> = {}): RankedItem => ({ ...rec(o), rank: 1, horizon: 30, pxl_score: 4, ...o });
