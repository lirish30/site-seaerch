import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness, deleteBusiness } from "../src/worker/db/businesses";
import {
  applySync, bestOpenPosting, closeAll, getCareerSource, listDueSources, listPostingsForLead, listUndiscovered, openRelevantByBusiness, saveCareerSource,
  type PostingWrite,
} from "../src/worker/db/jobs";

const T0 = "2026-10-14T12:00:00.000Z", T1 = "2026-10-15T12:00:00.000Z", T2 = "2026-10-16T12:00:00.000Z";
const row = (id: string, title: string, kind: PostingWrite["role_kind"] = null, posted: string | null = null): PostingWrite =>
  ({ external_id: id, title, url: `https://boards.example/${id}`, location: null, department: null, role_kind: kind, posted_at: posted });

let searchId = "";
async function lead(name = "Acme") {
  if (!searchId) searchId = (await createSearch(env.DB, { location: "Boise", businessType: "agency", radiusKm: 10, maxResults: 5 })).id;
  return upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: `https://${name.toLowerCase()}.com`, mapsUrl: null, rating: null, reviewCount: null }, searchId);
}
beforeEach(async () => { for (const t of ["job_postings", "career_sources", "audits", "activity"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("applySync", () => {
  it("inserts new roles, flags the baseline, and returns them as added", async () => {
    const b = await lead();
    const r = await applySync(env.DB, b.id, [row("1", "SEO Manager", "seo"), row("2", "Welder")], T0, true);
    expect(r.added.map((p) => [p.external_id, p.baseline, p.first_seen_at])).toEqual([["1", true, T0], ["2", true, T0]]);
    expect(r.closed).toBe(0);
    expect((await listPostingsForLead(env.DB, b.id)).map((p) => p.role_kind).sort()).toEqual([null, "seo"]);
  });

  it("keeps first_seen_at on a second sync, adds only new roles, and closes the ones that disappeared", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [row("1", "SEO Manager", "seo"), row("2", "Web Developer", "web_dev")], T0, true);
    const r = await applySync(env.DB, b.id, [row("1", "SEO Manager II", "seo"), row("3", "CRO Analyst", "cro")], T1, false);
    expect(r.added.map((p) => [p.external_id, p.baseline])).toEqual([["3", false]]);
    expect(r.closed).toBe(1);
    const all = await listPostingsForLead(env.DB, b.id);
    const by = Object.fromEntries(all.map((p) => [p.external_id, p]));
    expect(by["1"]).toMatchObject({ title: "SEO Manager II", first_seen_at: T0, last_seen_at: T1, closed_at: null, baseline: true });
    expect(by["2"].closed_at).toBe(T1);
  });

  it("reopens a closed role that comes back without calling it new", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [row("1", "SEO Manager", "seo")], T0, true);
    await applySync(env.DB, b.id, [row("2", "Other", "seo")], T1, false);
    const r = await applySync(env.DB, b.id, [row("1", "SEO Manager", "seo"), row("2", "Other", "seo")], T2, false);
    expect(r.added).toEqual([]);
    expect((await listPostingsForLead(env.DB, b.id)).every((p) => p.closed_at === null)).toBe(true);
  });

  it("keeps a posted_at it already has when the board stops reporting one", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [row("1", "SEO", "seo", "2026-09-01T00:00:00.000Z")], T0, false);
    await applySync(env.DB, b.id, [row("1", "SEO", "seo", null)], T1, false);
    expect((await listPostingsForLead(env.DB, b.id))[0].posted_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("ignores a role the board lists twice", async () => {
    const b = await lead();
    const r = await applySync(env.DB, b.id, [row("1", "SEO", "seo"), row("1", "SEO", "seo")], T0, false);
    expect(r.added).toHaveLength(1);
  });
});

describe("reads", () => {
  it("closeAll closes every open role and counts them", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [row("1", "SEO", "seo"), row("2", "Web", "web_dev")], T0, false);
    expect(await closeAll(env.DB, b.id, T1)).toBe(2);
    expect(await closeAll(env.DB, b.id, T2)).toBe(0);
  });

  it("openRelevantByBusiness returns only open roles with a role kind", async () => {
    const a = await lead("Acme"), c = await lead("Beta");
    await applySync(env.DB, a.id, [row("1", "SEO", "seo"), row("2", "Welder"), row("3", "Gone", "cro")], T0, false);
    await applySync(env.DB, a.id, [row("1", "SEO", "seo"), row("2", "Welder")], T1, false); // role 3 closes
    await applySync(env.DB, c.id, [row("9", "Web", "web_dev")], T1, false);
    const m = await openRelevantByBusiness(env.DB, [a.id, c.id, "missing"]);
    expect(m.get(a.id)!.map((p) => p.external_id)).toEqual(["1"]);
    expect(m.get(c.id)!.map((p) => p.external_id)).toEqual(["9"]);
    expect(m.has("missing")).toBe(false);
  });

  it("bestOpenPosting ignores roles not seen in the last 48 hours and roles outside the field", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [row("1", "SEO", "seo"), row("2", "Welder")], T0, false);
    expect((await bestOpenPosting(env.DB, b.id, "2026-10-15T11:00:00.000Z"))?.external_id).toBe("1");
    expect(await bestOpenPosting(env.DB, b.id, "2026-10-17T00:00:00.000Z")).toBeNull();
  });
});

describe("sources", () => {
  const src = { business_id: "x", status: "active" as const, ats: "lever" as const, token: "acme", careers_url: "https://acme.com/careers", checked_at: T0, next_check_at: T1 };

  it("saves, updates in place and reads back", async () => {
    await saveCareerSource(env.DB, src);
    await saveCareerSource(env.DB, { ...src, empty_streak: 1, last_error: "boom", last_ok_at: T0 });
    expect(await getCareerSource(env.DB, "x")).toMatchObject({ ats: "lever", token: "acme", empty_streak: 1, last_error: "boom", last_ok_at: T0, created_at: T0 });
  });

  it("lists only active sources that are due, oldest first", async () => {
    await saveCareerSource(env.DB, { ...src, business_id: "late", next_check_at: "2026-10-14T10:00:00.000Z" });
    await saveCareerSource(env.DB, { ...src, business_id: "early", next_check_at: "2026-10-14T09:00:00.000Z" });
    await saveCareerSource(env.DB, { ...src, business_id: "future", next_check_at: T2 });
    await saveCareerSource(env.DB, { ...src, business_id: "none", status: "none", next_check_at: "2026-10-14T08:00:00.000Z" });
    expect((await listDueSources(env.DB, T0, 10)).map((s) => s.business_id)).toEqual(["early", "late"]);
    expect(await listDueSources(env.DB, T0, 1)).toHaveLength(1);
  });

  it("listUndiscovered returns scanned leads with no source, or a none/error source that is due", async () => {
    const fresh = await lead("Fresh"), unscanned = await lead("Unscanned"), retry = await lead("Retry"), settled = await lead("Settled"), archived = await lead("Archived");
    for (const b of [fresh, retry, settled, archived])
      await env.DB.prepare(`INSERT INTO audits (id, business_id, created_at, site_status, partial, score, offer, findings) VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), b.id, T0, "ok", 1, 10, "care_plan", "[]").run();
    await env.DB.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ?`).bind(T0, archived.id).run();
    await saveCareerSource(env.DB, { ...src, business_id: retry.id, status: "error", next_check_at: "2026-10-14T00:00:00.000Z" });
    await saveCareerSource(env.DB, { ...src, business_id: settled.id, status: "none", next_check_at: T2 });
    const ids = (await listUndiscovered(env.DB, T0, 10)).map((r) => r.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(retry.id);
    expect(ids).not.toContain(unscanned.id);
    expect(ids).not.toContain(settled.id);
    expect(ids).not.toContain(archived.id);
  });
});

describe("deleteBusiness", () => {
  it("removes the lead's roles and board", async () => {
    const b = await lead();
    await applySync(env.DB, b.id, [row("1", "SEO", "seo")], T0, false);
    await saveCareerSource(env.DB, { business_id: b.id, status: "active", ats: "lever", token: "acme", careers_url: null, checked_at: T0, next_check_at: T1 });
    await deleteBusiness(env.DB, b.id);
    expect(await listPostingsForLead(env.DB, b.id)).toEqual([]);
    expect(await getCareerSource(env.DB, b.id)).toBeNull();
  });
});
