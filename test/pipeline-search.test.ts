import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runSearch } from "../src/worker/pipeline/search";
import { FakeListingSource } from "../src/worker/listings/fake";
import { createSearch, getSearch } from "../src/worker/db/searches";
import { listBusinessesForSearch, upsertBusiness, updateLead } from "../src/worker/db/businesses";
import type { StepLike } from "../src/worker/pipeline/lead";
import type { Listing } from "../src/worker/types";

const L = (id: string): Listing => ({ placeId: id, name: `B${id}`, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null });

function recorder() {
  const sleeps: string[] = [];
  const step: StepLike = { do: (_n, fn) => fn(), sleep: async (n) => { sleeps.push(n); } };
  return { step, sleeps };
}

describe("runSearch", () => {
  it("upserts listings, starts leads in batches, marks done", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    const { step, sleeps } = recorder();
    const listings = Array.from({ length: 12 }, (_, i) => L(`S1-${i}`));
    await runSearch({ db: env.DB, source: new FakeListingSource(listings), startLead: async (p) => { started.push(p.businessId); } }, step, s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.found_count).toBe(12);
    expect(after.status).toBe("done");
    expect(started).toHaveLength(12);
    expect(sleeps).toHaveLength(2); // 5 + 5 + 2
    expect(await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false })).toHaveLength(12);
  });

  it("listing error → failed with message, nothing written", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource(new Error("Bright Data HTTP 401: bad zone")), startLead: async () => {} }, step, s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/401/);
    expect(await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false })).toHaveLength(0);
  });

  it("previously skipped businesses are not re-processed but count as processed", async () => {
    const s0 = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const b = await upsertBusiness(env.DB, L("SKIP-1"), s0.id);
    await updateLead(env.DB, b.id, { leadStatus: "skip" });
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource([L("SKIP-1"), L("NEW-1")]), startLead: async (p) => { started.push(p.businessId); } }, step, s.id);
    expect(started).toHaveLength(1);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
  });

  it("zero listings → done with found 0", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource([]), startLead: async () => {} }, step, s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("done");
    expect(after.found_count).toBe(0);
  });

  it("duplicate listings are de-duped: found_count counts unique businesses, one lead each", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource([L("DUP-1"), L("DUP-1"), L("DUP-2")]), startLead: async (p) => { started.push(p.businessId); } }, step, s.id);
    expect((await getSearch(env.DB, s.id))!.found_count).toBe(2);
    expect(started).toHaveLength(2);
    expect(new Set(started).size).toBe(2);
  });

  it("unexpected failure after fetch → failed with message", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource([L("ERR-1")]), startLead: async () => { throw new Error("boom start"); } }, step, s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/boom start/);
  });
});
