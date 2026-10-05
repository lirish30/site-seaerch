import { describe, expect, it } from "vitest";
import { applyLeadFilters, defaultFilters, NOT_CRAWLED, platformOptions, type LeadFilters } from "../src/client/leadFilters";
import type { FitResult, LeadRow } from "../src/client/types";

let n = 0;
const NO_FIT: FitResult = { fit: null, profile: null, matched: [], missing: [] };
const row = (o: Partial<Omit<LeadRow, "business">> & { status?: string } = {}): LeadRow => {
  const { status, ...rest } = o;
  const flat = { rating: 4, reviewCount: 10, ...rest }; // business row mirrors the flat fields, as leadRows builds them
  return { business: { id: `b${n++}`, name: "N", category: null, address: null, phone: null, website_url: null, maps_url: null,
    lead_status: (status ?? "new") as any, notes: null, contacted_at: null, last_error: null, rating: flat.rating, review_count: flat.reviewCount,
    archived_at: null, follow_up_at: null, deal_value: null, created_at: "2026-10-03T00:00:00.000Z", scan_stage: "full" },
  score: 50, health: null, niche: null, poc: null, topFinding: null, offer: "care_plan", bestContact: null, hasEmail: false, partial: false, platform: "wix", fit: NO_FIT, scan_stage: "full", ...flat };
};
const f = (o: Partial<LeadFilters> = {}): LeadFilters => ({ ...defaultFilters, ...o });
const ids = (rows: LeadRow[]) => rows.map((r) => r.business.id);

describe("applyLeadFilters", () => {
  it("defaults hide skipped and keep everything else", () => {
    const [a, b] = [row(), row({ status: "skip" })];
    expect(applyLeadFilters([a, b], defaultFilters)).toEqual([a]);
    expect(applyLeadFilters([a, b], f({ hideSkipped: false }))).toEqual([a, b]);
  });
  it("returns an empty list for empty input", () => expect(applyLeadFilters([], f({ minScore: 10, emailOnly: true }))).toEqual([]));
  it("min score treats null score as 0", () => {
    const [a, b, c] = [row({ score: 70 }), row({ score: 20 }), row({ score: null })];
    expect(ids(applyLeadFilters([a, b, c], f({ minScore: 30 })))).toEqual([a.business.id]);
    expect(applyLeadFilters([a, b, c], f({ minScore: 0 }))).toHaveLength(3);
  });
  it("email only", () => {
    const [a, b] = [row({ hasEmail: true }), row()];
    expect(applyLeadFilters([a, b], f({ emailOnly: true }))).toEqual([a]);
  });
  it("min reviews excludes low and null counts; 0 or empty is off", () => {
    const [a, b, c] = [row({ reviewCount: 50 }), row({ reviewCount: 5 }), row({ reviewCount: null })];
    expect(ids(applyLeadFilters([a, b, c], f({ minReviews: 10 })))).toEqual([a.business.id]);
    expect(applyLeadFilters([a, b, c], f({ minReviews: 0 }))).toHaveLength(3);
    expect(applyLeadFilters([a, b, c], f({ minReviews: null }))).toHaveLength(3);
    expect(applyLeadFilters([a, b, c], f({ minReviews: -5 }))).toHaveLength(3);
  });
  it("max rating is at-or-below and excludes null ratings; empty is off", () => {
    const [a, b, c, d] = [row({ rating: 3.5 }), row({ rating: 4 }), row({ rating: 4.6 }), row({ rating: null })];
    expect(ids(applyLeadFilters([a, b, c, d], f({ maxRating: 4 })))).toEqual([a.business.id, b.business.id]);
    expect(applyLeadFilters([a, b, c, d], f({ maxRating: null }))).toHaveLength(4);
  });
  it("max rating of 0 is a real filter (not off)", () => {
    const [a, b] = [row({ rating: 0 }), row({ rating: 1 })];
    expect(applyLeadFilters([a, b], f({ maxRating: 0 }))).toEqual([a]);
  });
  it("offer filter excludes null offers", () => {
    const [a, b, c] = [row({ offer: "new_site" }), row({ offer: "seo_basics" }), row({ offer: null })];
    expect(applyLeadFilters([a, b, c], f({ offer: "new_site" }))).toEqual([a]);
    expect(applyLeadFilters([a, b, c], f({ offer: "any" }))).toHaveLength(3);
  });
  it("platform filter matches exactly, 'not crawled' matches null", () => {
    const [a, b, c] = [row({ platform: "wix" }), row({ platform: "other" }), row({ platform: null })];
    expect(applyLeadFilters([a, b, c], f({ platform: "wix" }))).toEqual([a]);
    expect(applyLeadFilters([a, b, c], f({ platform: "other" }))).toEqual([b]);
    expect(applyLeadFilters([a, b, c], f({ platform: NOT_CRAWLED }))).toEqual([c]);
    expect(applyLeadFilters([a, b, c], f({ platform: "any" }))).toHaveLength(3);
  });
  it("combines filters with AND", () => {
    const hit = row({ hasEmail: true, score: 80, reviewCount: 40, rating: 3.2, offer: "new_site", platform: "godaddy" });
    const misses = [row({ hasEmail: false, score: 80, reviewCount: 40, rating: 3.2, offer: "new_site", platform: "godaddy" }),
      row({ hasEmail: true, score: 10, reviewCount: 40, rating: 3.2, offer: "new_site", platform: "godaddy" }),
      row({ hasEmail: true, score: 80, reviewCount: 4, rating: 3.2, offer: "new_site", platform: "godaddy" }),
      row({ hasEmail: true, score: 80, reviewCount: 40, rating: 4.9, offer: "new_site", platform: "godaddy" }),
      row({ hasEmail: true, score: 80, reviewCount: 40, rating: 3.2, offer: "care_plan", platform: "godaddy" }),
      row({ hasEmail: true, score: 80, reviewCount: 40, rating: 3.2, offer: "new_site", platform: "wix" })];
    const filters = f({ emailOnly: true, minScore: 50, minReviews: 20, maxRating: 4, offer: "new_site", platform: "godaddy" });
    expect(applyLeadFilters([hit, ...misses], filters)).toEqual([hit]);
  });
  it("returns a new array even when nothing is filtered out, so callers can sort in place", () => {
    const rows = [row({ score: 1 }), row({ score: 2 })];
    const out = applyLeadFilters(rows, f());
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
});

describe("platformOptions", () => {
  it("lists distinct non-null platforms, sorted", () => {
    expect(platformOptions([row({ platform: "wix" }), row({ platform: null }), row({ platform: "godaddy" }), row({ platform: "wix" })])).toEqual(["godaddy", "wix"]);
    expect(platformOptions([])).toEqual([]);
  });
});
