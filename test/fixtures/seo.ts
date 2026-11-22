import { env } from "cloudflare:test";
import { addKeyword, insertContentSlots, upsertProfile, upsertRankCheck, upsertReviews, upsertSnapshot, setReviewDraft, setReviewStatus, type ContentKind, type ContentStatus, type ReplyStatus } from "../../src/worker/db/seo";
import { getSeoReport, insertSeoReport, setSeoSummary, type SeoReport } from "../../src/worker/db/seoReports";
import { seedClient } from "./clients";

// Local SEO rows for the owner-side tests (Plan 14, Task 11): a client with a profile, and reviews, content and reports in any state, made through the data layer.

export const SEO_PLAN = [{ key: "local_seo" as const, monthlyCents: 60_000 }];
export const NOW_ISO = "2026-12-02T18:00:00.000Z";

export const PLACE_ID = "ChIJ-PLACE-ID-SENTINEL";
export const MAPS_URL = "https://maps.google.example/?cid=MAPS-SENTINEL";
export const REVIEW_BODY = "REVIEW-BODY-SENTINEL the plumber was late and rude";
export const REVIEWER = "REVIEWER-SENTINEL Jordan Q";
export const REPLY_DRAFT = "REPLY-DRAFT-SENTINEL thank you for telling us";

/** A client with a Local SEO profile (`active` by default). `test: true` makes it a rehearsal client. */
export async function seoClient(o: { name?: string; test?: boolean; status?: "setup" | "active" | "paused"; profile?: boolean; placeId?: string } = {}) {
  const s = await seedClient({ subs: SEO_PLAN, test: o.test });
  if (o.name) await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(o.name, s.businessId).run();
  if (o.profile !== false) {
    await upsertProfile(env.DB, s.businessId, {
      placeId: o.placeId ?? PLACE_ID, mapsUrl: MAPS_URL, napName: "Ace Plumbing", napAddress: "1 Main St, Tigard", napPhone: "503-555-0100", lat: 45.4312, lng: -122.7715,
      trade: "plumber", towns: ["Tigard"], gridKm: 3, status: o.status ?? "active",
    }, NOW_ISO);
  }
  return s;
}

let n = 0;
/** A review of the client, first seen on `day`, in the reply state asked for (a draft is stored for any state that has one). */
export async function seoReview(businessId: string, o: { rating?: number; status?: ReplyStatus; day?: string; createdAt?: string } = {}) {
  const rating = o.rating ?? 5;
  const { inserted } = await upsertReviews(env.DB, businessId, [{ externalId: `ext-${++n}`, rating, author: REVIEWER, body: REVIEW_BODY, publishedAt: "2026-11-20T10:00:00.000Z" }], { takenOn: o.day ?? "2026-12-01", now: o.createdAt ?? NOW_ISO });
  const review = inserted[0];
  const status = o.status ?? "new";
  if (status === "drafted" || status === "posted" || status === "skipped") {
    await setReviewDraft(env.DB, review.id, ["new"], { draft: REPLY_DRAFT, status: "drafted" });
    if (status !== "drafted") await setReviewStatus(env.DB, review.id, ["drafted"], status);
  } else if (status === "drafting") await setReviewDraft(env.DB, review.id, ["new"], { draft: "", status: "drafting" });
  return review;
}

/** A content slot of the client in the status asked for. */
export async function seoContent(businessId: string, o: { status?: ContentStatus; kind?: ContentKind; slot?: number; period?: string; title?: string } = {}) {
  const [item] = await insertContentSlots(env.DB, [{
    businessId, period: o.period ?? "2026-12", kind: o.kind ?? "page", slot: o.slot ?? 1, keywordId: null, brief: "a page about drains", title: o.title ?? "Drain cleaning in Tigard", metaTitle: "Drain cleaning", metaDescription: "We clear drains.",
    body: "Our crew clears drains fast.", status: o.status ?? "drafted", claudeTaskId: null, url: null,
  }], NOW_ISO);
  return item;
}

export const nine = (top: number) => Array.from({ length: 9 }, (_, i) => ({ lat: 45 + i / 100, lng: -122 - i / 100, pos: i < top ? 2 : 9, ok: true }));

/** A keyword with one rank check taken on `day`, and the client's Google snapshot. */
export async function seoRanked(businessId: string, o: { term?: string; town?: string; top?: number; day?: string } = {}) {
  const { keyword } = await addKeyword(env.DB, businessId, { term: o.term ?? "drain cleaning", town: o.town ?? "Tigard" }, NOW_ISO);
  await upsertRankCheck(env.DB, { businessId, keywordId: keyword.id, takenOn: o.day ?? "2026-12-01", points: nine(o.top ?? 2), now: NOW_ISO });
  return keyword;
}
export const seoSnapshot = (businessId: string, o: { rating?: number | null; reviewCount?: number | null; day?: string } = {}) =>
  upsertSnapshot(env.DB, { businessId, takenOn: o.day ?? "2026-12-01", rating: o.rating === undefined ? 4.6 : o.rating, reviewCount: o.reviewCount === undefined ? 42 : o.reviewCount, category: "Plumber", photoCount: 10, hasHours: true, now: NOW_ISO });

export const SUMMARY = "In our check the business showed in the top three at two of nine points for drain cleaning.";
export const RECOMMENDATION = "Ask recent customers to leave a review.";
export const PRIORITIES = ["Answer the one low review", "Fix the address on the website", "Publish the water heater page"];
export const FACTS = {
  version: 1, period: "2026-11", label: "November 2026", clientName: "Ace Plumbing", rankAsOf: "2026-12-01", previousRankAsOf: null,
  terms: [{ term: "drain cleaning", town: "Tigard", points: nine(2).map(({ pos, ok }) => ({ pos, ok })), measured: 9, visible: 2, previousVisible: null }],
  gbp: { rating: 4.6, reviewCount: 42, reviewsGained: null, ratingChange: null }, reviews: { seen: 1, posted: 0, needsYou: 0 },
  content: { published: [], drafted: 0, planned: 0 }, citations: null, nap: null, generatedAt: NOW_ISO,
};

let t = 0;
/** A report of the client in the state asked for, with the words stored for any state past `collecting`. */
export async function seoReport(businessId: string, status: "collecting" | "ready" | "sent" | "revoked" | "cancelled" = "ready", o: { period?: string; test?: boolean; token?: string } = {}): Promise<SeoReport> {
  const { report } = await insertSeoReport(env.DB, { businessId, period: o.period ?? "2026-11", token: o.token ?? `tok-seo-owner-${++t}-${"x".repeat(24)}`, facts: FACTS, test: o.test ?? false, now: "2026-12-01T10:00:00.000Z" });
  if (status !== "collecting") await setSeoSummary(env.DB, report.id, ["collecting"], { summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, source: "claude", now: "2026-12-01T11:00:00.000Z" });
  if (status === "sent") await env.DB.prepare(`UPDATE seo_reports SET status = 'sent', sent_at = '2026-12-01T17:00:00.000Z' WHERE id = ?`).bind(report.id).run();
  if (status === "revoked") await env.DB.prepare(`UPDATE seo_reports SET status = 'revoked', revoked_at = '2026-12-02T10:00:00.000Z' WHERE id = ?`).bind(report.id).run();
  if (status === "cancelled") await env.DB.prepare(`UPDATE seo_reports SET status = 'cancelled' WHERE id = ?`).bind(report.id).run();
  return (await getSeoReport(env.DB, report.id))!;
}

/** Empties every Local SEO table (and the approvals and Claude tasks of the report kind), for a test's `beforeEach`. */
export async function resetSeo(): Promise<void> {
  for (const table of ["seo_reports", "seo_content", "seo_reviews", "seo_citations", "seo_gbp_snapshots", "seo_rank_checks", "seo_keywords", "seo_profiles"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'seo.report'`).run();
  await env.DB.prepare(`DELETE FROM claude_tasks WHERE kind IN ('seo.report', 'seo.content', 'seo.review_reply')`).run();
}
