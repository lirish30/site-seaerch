import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runSearch } from "../src/worker/pipeline/search";
import { FakeListingSource } from "../src/worker/listings/fake";
import { RateLimitedError, RetryableError } from "../src/worker/listings/source";
import { createSearch, getSearch } from "../src/worker/db/searches";
import { listBusinessesForSearch, upsertBusiness, updateLead, setBusinessError } from "../src/worker/db/businesses";
import { insertDraft, updateDraftBody } from "../src/worker/db/drafts";
import { insertAudit } from "../src/worker/db/audits";
import type { StepLike } from "../src/worker/pipeline/lead";
import type { Listing } from "../src/worker/types";
import { PRICES } from "../src/worker/cost";

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

  it("leads already being worked are linked but not restarted, and count as processed", async () => {
    const s0 = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const contacted = await upsertBusiness(env.DB, L("W-CONTACTED"), s0.id);
    await updateLead(env.DB, contacted.id, { leadStatus: "contacted" });
    const won = await upsertBusiness(env.DB, L("W-WON"), s0.id);
    await updateLead(env.DB, won.id, { leadStatus: "won" });
    const reviewedEdited = await upsertBusiness(env.DB, L("W-REV-EDITED"), s0.id);
    await updateLead(env.DB, reviewedEdited.id, { leadStatus: "reviewed" });
    const d1 = await insertDraft(env.DB, { business_id: reviewedEdited.id, audit_id: null, to_contact_id: null, recipient_reason: "r", subject: "s", body: "b", offer: "care_plan", steering_note: null });
    await updateDraftBody(env.DB, d1.id, { subject: "s2", body: "mine" });
    const reviewedPlain = await upsertBusiness(env.DB, L("W-REV-PLAIN"), s0.id);
    await updateLead(env.DB, reviewedPlain.id, { leadStatus: "reviewed" });
    await insertDraft(env.DB, { business_id: reviewedPlain.id, audit_id: null, to_contact_id: null, recipient_reason: "r", subject: "s", body: "b", offer: "care_plan", steering_note: null });

    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    const { step } = recorder();
    await runSearch({ db: env.DB, source: new FakeListingSource([L("W-CONTACTED"), L("W-WON"), L("W-REV-EDITED"), L("W-REV-PLAIN"), L("W-NEW")]),
      startLead: async (p) => { started.push(p.businessId); } }, step, s.id);
    const newB = (await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false })).find((b) => b.place_id === "W-NEW")!;
    expect(started.sort()).toEqual([reviewedPlain.id, newB.id].sort());
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.found_count).toBe(5);
    expect(after.processed_count).toBe(3);
    expect(await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false })).toHaveLength(5);
  });

  it("retryable listing errors are rethrown from the fetch step (so Workflows retries); exhaustion ends failed", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const threw: string[] = [];
    const step: StepLike = { do: async (n, fn) => { try { return await fn(); } catch (e) { threw.push(n); throw e; } }, sleep: async () => {} };
    await runSearch({ db: env.DB, source: new FakeListingSource(new RetryableError("Bright Data HTTP 503: busy")), startLead: async () => {} }, step, s.id);
    expect(threw[0]).toBe("fetch-listings");
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/503/);
  });

  it("a retryable failure is counted and its reason kept while the search is still running; success clears it", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    let calls = 0;
    const flaky = { search: async () => { if (++calls < 3) throw new RetryableError("Bright Data HTTP 502 (maps_ajax_failed)"); return { listings: [L("RETRY-1")], requests: 1 }; } };
    const states: { attempts: number; error: string | null; status: string }[] = [];
    // Behaves like Workflows: re-run a throwing step, looking at the row between attempts.
    const step: StepLike = { do: async (_n, fn) => {
      for (;;) {
        try { return await fn(); } catch (e) {
          const row = (await getSearch(env.DB, s.id))!;
          states.push({ attempts: row.fetch_attempts, error: row.error, status: row.status });
          if (states.length > 5) throw e;
        }
      }
    }, sleep: async () => {} };
    await runSearch({ db: env.DB, source: flaky, startLead: async () => {} }, step, s.id);
    expect(states).toEqual([
      { attempts: 1, error: "Bright Data HTTP 502 (maps_ajax_failed)", status: "running" },
      { attempts: 2, error: "Bright Data HTTP 502 (maps_ajax_failed)", status: "running" },
    ]);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("done");
    expect(after.error).toBeNull();
    expect(after.fetch_attempts).toBe(2);
  });

  it("a 429 is not retried in seconds: the workflow sleeps minutes, then fetches again under a new step name", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    let calls = 0;
    const source = { search: async () => { if (++calls < 3) throw new RateLimitedError("Bright Data HTTP 429 (bucket_rate_limit)"); return { listings: [L("RL-1")], requests: 1 }; } };
    const names: string[] = []; const sleeps: [string, number][] = [];
    const step: StepLike = { do: (n, fn) => { names.push(n); return fn(); }, sleep: async (n, ms) => { sleeps.push([n, ms]); } };
    await runSearch({ db: env.DB, source, startLead: async () => {} }, step, s.id);
    expect(names.slice(0, 3)).toEqual(["fetch-listings", "fetch-listings-1", "fetch-listings-2"]);
    expect(sleeps.filter(([n]) => n.startsWith("rate-limit-wait"))).toEqual([["rate-limit-wait-1", 60_000], ["rate-limit-wait-2", 180_000]]);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("done");
    expect(after.fetch_attempts).toBe(2);
    expect(after.error).toBeNull();
  });

  it("a 429 that never clears fails the search with the 429 message after the last wait", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const sleeps: string[] = [];
    const step: StepLike = { do: (_n, fn) => fn(), sleep: async (n) => { sleeps.push(n); } };
    await runSearch({ db: env.DB, source: new FakeListingSource(new RateLimitedError("Bright Data HTTP 429 (bucket_rate_limit)")), startLead: async () => {} }, step, s.id);
    expect(sleeps).toEqual(["rate-limit-wait-1", "rate-limit-wait-2"]);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/429/);
    expect(after.fetch_attempts).toBe(3);
  });

  it("records listing usage under the provider that served it, at that provider's price", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const source = { search: async () => ({ listings: [L("PR-1")], requests: 3, provider: "places" as const }) };
    const { step } = recorder();
    await runSearch({ db: env.DB, source, startLead: async () => {} }, step, s.id);
    const row = await env.DB.prepare(`SELECT units, est_cost_usd FROM usage WHERE service = 'places' ORDER BY created_at DESC LIMIT 1`).first<{ units: number; est_cost_usd: number }>();
    expect(row).toEqual({ units: 3, est_cost_usd: 3 * PRICES.placesPerRequest });
  });

  it("non-retryable listing errors are not rethrown: the step returns ok:false and marks failed", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const threw: string[] = [];
    const step: StepLike = { do: async (n, fn) => { try { return await fn(); } catch (e) { threw.push(n); throw e; } }, sleep: async () => {} };
    await runSearch({ db: env.DB, source: new FakeListingSource(new Error("Bright Data HTTP 401: bad zone")), startLead: async () => {} }, step, s.id);
    expect(threw).toEqual([]);
    expect((await getSearch(env.DB, s.id))!.status).toBe("failed");
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

  describe("new_only (Radar) searches", () => {
    const audit = (businessId: string, o: { partial?: boolean; site_status?: "ok" | "unreachable" } = {}) => insertAudit(env.DB, {
      business_id: businessId, site_status: o.site_status ?? "ok", partial: o.partial ?? false, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
      https: true, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
      platform: null, seo_score: null, accessibility_score: null, score: 10, offer: "seo_basics", findings: [], raw_r2_key: null, mail_warning: null,
      health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
    const seedBusiness = async (id: string) => {
      const s0 = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
      return upsertBusiness(env.DB, L(id), s0.id);
    };
    async function run(listings: Listing[], newOnly: boolean) {
      const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 }, { newOnly });
      const started: string[] = [];
      const { step } = recorder();
      await runSearch({ db: env.DB, source: new FakeListingSource(listings), startLead: async (p) => { started.push(p.businessId); } }, step, s.id);
      return { started, after: (await getSearch(env.DB, s.id))!, linked: await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false }) };
    }

    it("does not restart an already-audited status-new business, counts it as processed, and finishes; a manual search does restart it", async () => {
      const audited = await seedBusiness("NO-AUDITED");
      await audit(audited.id);
      const r = await run([L("NO-AUDITED")], true);
      expect(r.started).toEqual([]);
      expect(r.after).toMatchObject({ new_only: 1, status: "done", found_count: 1, processed_count: 1 });
      expect(r.linked).toHaveLength(1);
      const manual = await run([L("NO-AUDITED")], false);
      expect(manual.started).toEqual([audited.id]);
      expect(manual.after).toMatchObject({ new_only: 0, status: "done", found_count: 1, processed_count: 0 });
    });

    it("keeps an audit that is partial or from an unreachable site as 'audited' (never re-paid)", async () => {
      const a = await seedBusiness("NO-PARTIAL"); await audit(a.id, { partial: true });
      const b = await seedBusiness("NO-UNREACH"); await audit(b.id, { site_status: "unreachable" });
      const r = await run([L("NO-PARTIAL"), L("NO-UNREACH")], true);
      expect(r.started).toEqual([]);
      expect(r.after).toMatchObject({ found_count: 2, processed_count: 2 });
    });

    it("starts a never-audited business, even one that is reviewed with an unedited draft", async () => {
      const reviewed = await seedBusiness("NO-REV-NOAUDIT");
      await updateLead(env.DB, reviewed.id, { leadStatus: "reviewed" });
      const r = await run([L("NO-FRESH"), L("NO-REV-NOAUDIT")], true);
      const fresh = r.linked.find((b) => b.place_id === "NO-FRESH")!;
      expect(r.started.sort()).toEqual([fresh.id, reviewed.id].sort());
      expect(r.after).toMatchObject({ found_count: 2, processed_count: 0 });
    });

    it("an audited reviewed lead with an unedited draft is not restarted (manual still restarts it)", async () => {
      const reviewed = await seedBusiness("NO-REV-AUDITED");
      await updateLead(env.DB, reviewed.id, { leadStatus: "reviewed" });
      await audit(reviewed.id);
      expect((await run([L("NO-REV-AUDITED")], true)).started).toEqual([]);
      expect((await run([L("NO-REV-AUDITED")], false)).started).toEqual([reviewed.id]);
    });

    it("retries an audited lead whose last run failed (last_error set, e.g. the draft step), but not once it has recovered", async () => {
      const failed = await seedBusiness("NO-FAILED");
      await audit(failed.id);
      await setBusinessError(env.DB, failed.id, "Claude: overloaded");
      const retried = await run([L("NO-FAILED")], true);
      expect(retried.started).toEqual([failed.id]);
      expect(retried.after).toMatchObject({ found_count: 1, processed_count: 0 });
      // A successful run clears the error (the lead workflow's first step), so the next Radar run leaves it alone.
      await setBusinessError(env.DB, failed.id, null);
      expect((await run([L("NO-FAILED")], true)).started).toEqual([]);
    });

    it("never works skipped/contacted/replied/won/lost businesses even with no audit (new-only only restricts)", async () => {
      const ids: string[] = [];
      for (const st of ["skip", "contacted", "replied", "won", "lost"] as const) {
        const b = await seedBusiness(`NO-${st}`);
        await updateLead(env.DB, b.id, { leadStatus: st });
        ids.push(`NO-${st}`);
      }
      const r = await run(ids.map(L), true);
      expect(r.started).toEqual([]);
      expect(r.after).toMatchObject({ status: "done", found_count: 5, processed_count: 5 });
    });
  });
});
