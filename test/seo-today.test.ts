import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addSuppression } from "../src/worker/db/suppression";
import { buildToday, TODAY_KINDS } from "../src/worker/today";
import { resetProjectWork } from "./fixtures/projects";
import { resetSeo, seoClient, seoContent, seoReview } from "./fixtures/seo";

// The Today row for a Local SEO client (Plan 14, Task 11): drafts waiting (58) or a low-rated review that needs Logan (66), one row per client, never for a rehearsal client.
const NOW = new Date("2026-12-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;

beforeEach(async () => {
  await resetSeo();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

const rows = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "seo_waiting");

describe("seo_waiting", () => {
  it("is a Today kind", () => {
    expect(TODAY_KINDS).toContain("seo_waiting");
  });

  it("counts drafted review replies and drafted content as waiting, priority 58, one row per client", async () => {
    const s = await seoClient({ name: "Ace Plumbing" });
    await seoReview(s.businessId, { rating: 5, status: "drafted" });
    await seoReview(s.businessId, { rating: 4, status: "drafted" });
    await seoContent(s.businessId, { status: "drafted" });
    expect(await rows()).toEqual([{
      id: `seo_waiting:${s.businessId}`, kind: "seo_waiting", businessId: s.businessId, businessName: "Ace Plumbing", reason: "Ace Plumbing: 3 Local SEO drafts waiting", due: null, priority: 58,
    }]);
  });

  it("says one draft in the singular", async () => {
    const s = await seoClient({ name: "Ace Plumbing" });
    await seoContent(s.businessId, { status: "drafted" });
    expect((await rows())[0].reason).toBe("Ace Plumbing: 1 Local SEO draft waiting");
  });

  it("does not count what is not drafted: new, drafting, posted and skipped replies, and planned, drafting, approved, published and rejected content", async () => {
    const s = await seoClient();
    for (const [i, status] of (["new", "drafting", "posted", "skipped"] as const).entries()) await seoReview(s.businessId, { rating: 5, status, day: `2026-12-0${i + 1}` });
    for (const [i, status] of (["planned", "drafting", "approved", "published", "rejected"] as const).entries()) await seoContent(s.businessId, { status, slot: i + 1 });
    expect(await rows()).toEqual([]);
  });

  it("a low-rated review not yet posted or skipped is priority 66 and says its stars, whatever its reply state", async () => {
    for (const status of ["new", "drafting", "drafted"] as const) {
      await env.DB.prepare(`DELETE FROM seo_reviews`).run();
      const s = await seoClient({ name: `Client ${status}` });
      await seoReview(s.businessId, { rating: 2, status });
      const [row] = (await rows()).filter((r) => r.businessId === s.businessId);
      expect(row, status).toMatchObject({ kind: "seo_waiting", priority: 66, reason: `Client ${status}: a review of 2 stars needs you` });
    }
  });

  it("a flagged review that was posted or skipped no longer needs Logan, and a 4 or 5 star one was never flagged", async () => {
    const s = await seoClient();
    await seoReview(s.businessId, { rating: 1, status: "posted", day: "2026-12-01" });
    await seoReview(s.businessId, { rating: 3, status: "skipped", day: "2026-12-02" });
    await seoReview(s.businessId, { rating: 4, status: "new", day: "2026-12-03" });
    await seoReview(s.businessId, { rating: 5, status: "new", day: "2026-12-04" });
    expect(await rows()).toEqual([]);
  });

  it("with both, one row: the low review speaks (66), naming the lowest rating, and the singular for one star", async () => {
    const s = await seoClient({ name: "Ace Plumbing" });
    await seoReview(s.businessId, { rating: 3, status: "new", day: "2026-12-01" });
    await seoReview(s.businessId, { rating: 1, status: "drafted", day: "2026-12-02" });
    await seoContent(s.businessId, { status: "drafted" });
    const out = await rows();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ priority: 66, reason: "Ace Plumbing: a review of 1 star needs you" });
  });

  it("is one row per client across clients, the low reviews ahead of the drafts", async () => {
    const a = await seoClient({ name: "Ace Plumbing" });
    const b = await seoClient({ name: "Bay Roofing" });
    await seoContent(a.businessId, { status: "drafted" });
    await seoReview(b.businessId, { rating: 2, status: "new" });
    const all = await buildToday(env.DB, NOW);
    expect(all.filter((i) => i.kind === "seo_waiting").map((i) => [i.businessName, i.priority])).toEqual([["Bay Roofing", 66], ["Ace Plumbing", 58]]);
  });

  it("never shows for a rehearsal client", async () => {
    const t = await seoClient({ test: true });
    await seoReview(t.businessId, { rating: 1, status: "new" });
    await seoContent(t.businessId, { status: "drafted" });
    expect(await rows()).toEqual([]);
  });

  it("stays for a suppressed lead (the owner's own work)", async () => {
    const s = await seoClient();
    await seoContent(s.businessId, { status: "drafted" });
    await addSuppression(env.DB, { kind: "domain", value: "ace.com", reason: "client" });
    expect(await rows()).toHaveLength(1);
  });

  it("is hidden by Done, but a new low-rated review after the Done shows at once", async () => {
    const s = await seoClient();
    await seoContent(s.businessId, { status: "drafted" });
    await env.DB.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?, ?, 'today_done', 'seo_waiting', ?)`).bind(crypto.randomUUID(), s.businessId, ago(HOUR)).run();
    expect(await rows()).toEqual([]);
    // A low review that arrived after the Done speaks again.
    await seoReview(s.businessId, { rating: 2, status: "new", createdAt: new Date(NOW.getTime() + HOUR).toISOString() });
    const later = (await buildToday(env.DB, new Date(NOW.getTime() + 2 * HOUR))).filter((i) => i.kind === "seo_waiting");
    expect(later).toEqual([expect.objectContaining({ priority: 66 })]);
  });

  it("is gone for an archived client", async () => {
    const s = await seoClient();
    await seoContent(s.businessId, { status: "drafted" });
    await env.DB.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ?`).bind(ago(HOUR), s.businessId).run();
    expect(await rows()).toEqual([]);
  });
});
