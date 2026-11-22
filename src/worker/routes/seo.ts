import { Hono } from "hono";
import { z } from "zod";
import { previousMonth } from "../care/reportSweep";
import { clientSql, isClient, isTestClient, testClientSql, todayKey } from "../clients/record";
import { logActivity } from "../db/activity";
import { addKeyword, getContent, getProfile, getReview, listCitations, listContent, listKeywords, listReviews, setCitation, setContent, setKeywordActive, setReviewDraft, setReviewStatus, snapshotsFor, type CitationStatus, type ContentItem, type SeoReview } from "../db/seo";
import { getSeoReport, listSeoReports } from "../db/seoReports";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { bodyOf, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";
import { runBaseline } from "../seo/baseline";
import { runRankGrid } from "../seo/grid";
import { CITATION_DIRECTORIES, parseNapResult } from "../seo/nap";
import { findPlaces } from "../seo/places";
import { CREDENTIAL_REFUSED, MAX_TEXT, MIN_TEXT, SeoRefusal, placesRefusal, runNapCheck, setupProfile, tidy } from "../seo/profile";
import { looksLikeCredential } from "../onboarding/templates";
import { SeoContentResult, kindProblem } from "../queue/seoContent";
import { replyText } from "../queue/seoReviewReply";
import { draftTriesFor, planFor } from "../seo/content";
import { latestGrid, waitingFor } from "../seo/overview";
import { checkSeoWords, editSeoReport, revokeSeoReportNow, seoReportRow } from "../seo/reportAdmin";
import { SeoReportRefused, startSeoReport } from "../seo/sweep";
import { zoneOf } from "../sop/cadence";

/**
 * Mounted at /api (behind requireAuth), all under /clients/:id/seo (the owner's local SEO setup for one client; a test client is allowed):
 * POST /place-search, PUT /profile, POST /keywords, DELETE /keywords/:keywordId, PUT /citations/:directory, POST /nap-check, POST /baseline, POST /rank-check and POST /report (last month's report by hand).
 * And, for a review of a client's listing, PUT /seo/reviews/:id/draft, POST /seo/reviews/:id/posted and POST /seo/reviews/:id/skip. The app never posts a reply to Google: "posted" is Logan saying he did.
 * And the owner's reading and the month's reports: GET /clients/:id/seo (everything about one client in one answer), GET /seo/board (one row per active client), GET /seo/reports (?period=YYYY-MM, ?clientId=),
 * PUT /seo/reports/:id (edit the words of a `ready` report) and POST /seo/reports/:id/revoke. No answer carries a report's token except, for a `sent` report, as the path of its page.
 * And, for the month's content: GET /clients/:id/seo/content (?period=YYYY-MM), PUT /seo/content/:id (edit the words) and POST /seo/content/:id/{approve,published,reject}. The app never publishes anything:
 * "published" is Logan saying he put it on the client's site or profile.
 * Places data, site text and business names are untrusted: nothing from the request body sets a location, and neither the Places key nor anything a remote service said is ever returned.
 */
export const seoRoutes = new Hono<{ Bindings: Env }>();
seoRoutes.onError((e, c) => (e instanceof SeoRefusal ? c.json({ error: e.message }, e.status) : ownerOnError(e, c)));

export const MAX_ACTIVE_KEYWORDS = 10;
const CITATION_STATUSES = ["todo", "listed", "needs_fix", "not_applicable"] as const satisfies readonly CitationStatus[];

/** The client's id, or the 404 to send back when this is not a client. */
async function clientId(c: Ctx): Promise<string | Response> {
  const id = c.req.param("id") ?? "";
  return (await isClient(c.env.DB, id)) ? id : c.json(NOT_FOUND, 404);
}

const SearchBody = z.object({ name: z.string().trim().min(1, "name is required.").max(200), address: z.string().trim().max(300) });

/** Google's best matches for a business name and address (five at most). The owner picks one; nothing is chosen here, even when two have the same name. */
seoRoutes.post("/clients/:id/seo/place-search", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const body = await bodyOf(c, SearchBody);
  if (body instanceof Response) return body;
  try {
    return c.json({ candidates: await findPlaces(c.env, body) });
  } catch (e) {
    throw placesRefusal(e) ?? e;
  }
});

const ProfileBody = z.object({ placeId: z.string(), trade: z.string(), towns: z.array(z.string()), gridKm: z.number(), siteId: z.string().optional() });

/** Ties the client to the chosen Google place. The location, name, address and phone come from Google; any other field in the body is ignored. */
seoRoutes.put("/clients/:id/seo/profile", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const body = await bodyOf(c, ProfileBody);
  if (body instanceof Response) return body;
  const profile = await setupProfile(c.env, id, body, new Date().toISOString());
  return c.json({ profile: { ...profile, napResult: parseNapResult(profile.napResult) }, citations: await listCitations(c.env.DB, id) });
});

const KeywordBody = z.object({ term: z.string(), town: z.string().optional() });

const sameWords = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const lengthOk = (s: string) => s.length >= MIN_TEXT && s.length <= MAX_TEXT;

/**
 * Adds a keyword to track (a term, and a town if it is one). Ten may be active; adding one that is already there changes nothing, and adding one that was switched off puts it back if there is room.
 * 201 for a new keyword, 200 for one that was already there.
 */
seoRoutes.post("/clients/:id/seo/keywords", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const body = await bodyOf(c, KeywordBody);
  if (body instanceof Response) return body;
  const term = tidy(body.term);
  const town = tidy(body.town ?? "");
  if (!lengthOk(term)) throw new SeoRefusal(`A keyword must be ${MIN_TEXT} to ${MAX_TEXT} characters.`);
  if (town !== "" && !lengthOk(town)) throw new SeoRefusal(`A town must be ${MIN_TEXT} to ${MAX_TEXT} characters.`);
  if (looksLikeCredential(term) || looksLikeCredential(town)) throw new SeoRefusal(CREDENTIAL_REFUSED);

  const all = await listKeywords(c.env.DB, id);
  const there = all.find((k) => sameWords(k.term, term) && sameWords(k.town, town));
  if (there?.active) return c.json({ keyword: there, created: false });
  if (all.filter((k) => k.active).length >= MAX_ACTIVE_KEYWORDS) throw new SeoRefusal(`You can track ${MAX_ACTIVE_KEYWORDS} keywords at most. Switch one off first.`, 409);
  if (there) {
    await setKeywordActive(c.env.DB, there.id, true);
    return c.json({ keyword: { ...there, active: true }, created: false });
  }
  const { keyword, created } = await addKeyword(c.env.DB, id, { term, town }, new Date().toISOString());
  return c.json({ keyword, created }, created ? 201 : 200);
});

/** Switches a keyword off (its past rank checks stay). Switching off one that is off already is fine. */
seoRoutes.delete("/clients/:id/seo/keywords/:keywordId", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const keyword = (await listKeywords(c.env.DB, id)).find((k) => k.id === c.req.param("keywordId"));
  if (!keyword) return c.json(NOT_FOUND, 404);
  await setKeywordActive(c.env.DB, keyword.id, false);
  return c.json({ keyword: { ...keyword, active: false } });
});

const isWebAddress = (s: string): boolean => {
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "";
  } catch { return false; }
};
const CitationBody = z.object({
  status: z.enum(CITATION_STATUSES, "status must be todo, listed, needs_fix or not_applicable."),
  url: z.string().trim().max(500).refine(isWebAddress, "url must be an http or https address.").optional(),
  note: z.string().max(500).optional(),
});

/** Records where the client stands in one directory: its status, the listing's link and a note. What is not given is left as it was. */
seoRoutes.put("/clients/:id/seo/citations/:directory", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const directory = c.req.param("directory");
  if (!CITATION_DIRECTORIES.includes(directory)) return c.json(NOT_FOUND, 404);
  const body = await bodyOf(c, CitationBody);
  if (body instanceof Response) return body;
  const note = body.note === undefined ? undefined : tidy(body.note);
  if (note !== undefined && looksLikeCredential(note)) throw new SeoRefusal(CREDENTIAL_REFUSED);
  const takenOn = todayKey(await getSettings(c.env.DB), new Date());
  const saved = await setCitation(c.env.DB, id, directory, { status: body.status, ...(body.url !== undefined ? { url: body.url } : {}), ...(note !== undefined ? { note } : {}) }, takenOn);
  if (!saved) return c.json(NOT_FOUND, 404);
  const citations = await listCitations(c.env.DB, id);
  return c.json({ citation: citations.find((x) => x.directory === directory), citations });
});

/** Reads the client's site and compares its name, address and phone with the listing's. */
seoRoutes.post("/clients/:id/seo/nap-check", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  return c.json({ nap: await runNapCheck(c.env, id) });
});

/**
 * Takes the baseline now: the listing's numbers, the name, address and phone check, the first rank grid, and the watch switched on. A manual "Check now": it is not held by the spend gate.
 * Answers with the snapshot, the check result and how many keywords ended with a usable check.
 */
seoRoutes.post("/clients/:id/seo/baseline", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  return c.json(await runBaseline(c.env, id, new Date()));
});

/** Runs the rank grid for every active keyword now (a second run the same local day replaces that day's check). Answers with how many were stored and how many have no usable check. */
seoRoutes.post("/clients/:id/seo/rank-check", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  return c.json(await runRankGrid(c.env, id, new Date()));
});

/**
 * Starts last month's report for the client by hand, any day (a rehearsal client too): 201 with `{ report: { id, status, period } }`, or 200 with the one that is already there. No Places call is made: the report is built from the
 * rank checks already stored. 404 for something that is not a client; 409 with a plain sentence when there is no usable rank check from this month yet.
 */
seoRoutes.post("/clients/:id/seo/report", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const now = new Date();
  try {
    const { report, created } = await startSeoReport(c.env, id, previousMonth(now, zoneOf(await getSettings(c.env.DB))), { test: await isTestClient(c.env.DB, id), now });
    return c.json({ report: { id: report.id, status: report.status, period: report.period } }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof SeoReportRefused) return c.json({ error: e.message }, 409);
    throw e;
  }
});

/** The review, or the 404 to send back when it does not exist or its business is not a client. */
async function reviewOf(c: Ctx): Promise<SeoReview | Response> {
  const review = await getReview(c.env.DB, c.req.param("id") ?? "");
  return review && (await isClient(c.env.DB, review.businessId)) ? review : c.json(NOT_FOUND, 404);
}

const DraftBody = z.object({ draft: z.string() });

/**
 * Saves Logan's own words as the reply and marks it `drafted`, from `new`, `drafting` (his words win over Claude's) or `drafted`. The same text rules as Claude's drafts hold:
 * 1 to 700 characters, with no link, email address, phone number, dollar amount, offer, markdown or run of blank lines.
 */
seoRoutes.put("/seo/reviews/:id/draft", async (c) => {
  const review = await reviewOf(c);
  if (review instanceof Response) return review;
  const body = await bodyOf(c, DraftBody);
  if (body instanceof Response) return body;
  const parsed = replyText.safeParse(body.draft);
  if (!parsed.success) throw new SeoRefusal(parsed.error.issues[0]?.message ?? "That reply can't be used.");
  if (!(await setReviewDraft(c.env.DB, review.id, ["new", "drafting", "drafted"], { draft: parsed.data, status: "drafted" }))) {
    throw new SeoRefusal(`This review is already ${review.replyStatus}, so its reply can't be changed.`, 409);
  }
  return c.json({ review: await getReview(c.env.DB, review.id) });
});

/** Logan says he posted the drafted reply on Google. Only a drafted reply can be marked posted. */
seoRoutes.post("/seo/reviews/:id/posted", async (c) => {
  const review = await reviewOf(c);
  if (review instanceof Response) return review;
  if (!(await setReviewStatus(c.env.DB, review.id, ["drafted"], "posted"))) {
    throw new SeoRefusal(review.replyStatus === "posted" ? "This reply is already marked as posted." : "Only a drafted reply can be marked as posted. Write or approve a draft first.", 409);
  }
  return c.json({ review: await getReview(c.env.DB, review.id) });
});

/** Logan chooses not to reply to this review. A review he has already posted a reply to can't be skipped. */
seoRoutes.post("/seo/reviews/:id/skip", async (c) => {
  const review = await reviewOf(c);
  if (review instanceof Response) return review;
  if (!(await setReviewStatus(c.env.DB, review.id, ["new", "drafting", "drafted"], "skipped"))) {
    throw new SeoRefusal(`This review is already ${review.replyStatus}.`, 409);
  }
  return c.json({ review: await getReview(c.env.DB, review.id) });
});

// --- content ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The content item, or the 404 to send back when it does not exist or its business is not a client. */
async function contentOf(c: Ctx): Promise<ContentItem | Response> {
  const item = await getContent(c.env.DB, c.req.param("id") ?? "");
  return item && (await isClient(c.env.DB, item.businessId)) ? item : c.json(NOT_FOUND, 404);
}

/** The items with how many draft tasks for each ended failed or expired (`draftTries`): the panel says Claude could not draft a slot once that reaches the cap. */
async function withTries(db: D1Database, businessId: string, items: ContentItem[]): Promise<(ContentItem & { draftTries: number })[]> {
  const tries = await draftTriesFor(db, businessId);
  return items.map((i) => ({ ...i, draftTries: tries.get(i.id) ?? 0 }));
}

/** The client's content: every month, or one with `?period=YYYY-MM`, and what its plan includes each month (null when it has no live Local SEO plan). */
seoRoutes.get("/clients/:id/seo/content", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const period = c.req.query("period");
  if (period !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) throw new SeoRefusal("period must be a month written YYYY-MM.");
  return c.json({ plan: await planFor(c.env.DB, id), content: await withTries(c.env.DB, id, await listContent(c.env.DB, { businessId: id, ...(period !== undefined ? { period } : {}) })) });
});

const EditBody = z.object({ title: z.string().optional(), metaTitle: z.string().optional(), metaDescription: z.string().optional(), body: z.string().optional() });

/**
 * Saves Logan's own words for a `drafted` or `approved` item: whatever of the title, meta title, meta description and body is given (what is not given stays). The same text rules as Claude's drafts hold,
 * and a Google post keeps its limits. The status does not change.
 */
seoRoutes.put("/seo/content/:id", async (c) => {
  const item = await contentOf(c);
  if (item instanceof Response) return item;
  const body = await bodyOf(c, EditBody);
  if (body instanceof Response) return body;
  if (body.title === undefined && body.metaTitle === undefined && body.metaDescription === undefined && body.body === undefined) {
    throw new SeoRefusal("Give a title, meta title, meta description or body to change.");
  }
  if (item.status !== "drafted" && item.status !== "approved") {
    throw new SeoRefusal(item.status === "planned" || item.status === "drafting" ? "Claude has not drafted this yet, so there is nothing to edit." : `This item is already ${item.status}, so its words can't be changed.`, 409);
  }
  const parsed = SeoContentResult.safeParse({
    title: body.title ?? item.title, metaTitle: body.metaTitle ?? item.metaTitle, metaDescription: body.metaDescription ?? item.metaDescription, body: body.body ?? item.body,
  });
  if (!parsed.success) throw new SeoRefusal(parsed.error.issues[0]?.message ?? "That text can't be used.");
  const problem = kindProblem(item.kind, parsed.data);
  if (problem) throw new SeoRefusal(problem);
  if (!(await setContent(c.env.DB, item.id, ["drafted", "approved"], parsed.data, new Date().toISOString()))) {
    throw new SeoRefusal(`This item is no longer drafted or approved, so its words can't be changed.`, 409);
  }
  return c.json({ content: await getContent(c.env.DB, item.id) });
});

/** Logan approves the drafted words. Only a drafted item can be approved. */
seoRoutes.post("/seo/content/:id/approve", async (c) => {
  const item = await contentOf(c);
  if (item instanceof Response) return item;
  if (!(await setContent(c.env.DB, item.id, ["drafted"], { status: "approved" }, new Date().toISOString()))) {
    throw new SeoRefusal(item.status === "approved" ? "This item is already approved." : "Only a drafted item can be approved.", 409);
  }
  return c.json({ content: await getContent(c.env.DB, item.id) });
});

const PublishedBody = z.object({
  url: z.string().trim().max(500).refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" && u.username === "" && u.password === "";
    } catch { return false; }
  }, "url must be an https address.").optional(),
});

/** Logan says he put the approved words on the client's site or profile, with the address if he has it (https). The app publishes nothing. Only an approved item can be marked published. */
seoRoutes.post("/seo/content/:id/published", async (c) => {
  const item = await contentOf(c);
  if (item instanceof Response) return item;
  const body = await bodyOf(c, PublishedBody);
  if (body instanceof Response) return body;
  if (!(await setContent(c.env.DB, item.id, ["approved"], { status: "published", ...(body.url !== undefined ? { url: body.url } : {}) }, new Date().toISOString()))) {
    throw new SeoRefusal(item.status === "published" ? "This item is already marked as published." : "Only an approved item can be marked as published. Approve it first.", 409);
  }
  return c.json({ content: await getContent(c.env.DB, item.id) });
});

const RejectBody = z.object({ reason: z.string().trim().min(3, "Say why in 3 to 300 characters.").max(300, "Say why in 3 to 300 characters.") });

/** Logan turns the item down, with a reason (kept in the client's timeline). Anything not yet published can be rejected; a rejected slot is not planned again this month. */
seoRoutes.post("/seo/content/:id/reject", async (c) => {
  const item = await contentOf(c);
  if (item instanceof Response) return item;
  const body = await bodyOf(c, RejectBody);
  if (body instanceof Response) return body;
  const reason = tidy(body.reason);
  if (looksLikeCredential(reason)) throw new SeoRefusal(CREDENTIAL_REFUSED);
  if (!(await setContent(c.env.DB, item.id, ["planned", "drafting", "drafted", "approved"], { status: "rejected" }, new Date().toISOString()))) {
    throw new SeoRefusal(`This item is already ${item.status}.`, 409);
  }
  await logActivity(c.env.DB, item.businessId, "note", `Rejected ${item.kind.replace("_", " ")} for ${item.period} (${item.brief}): ${reason}`);
  return c.json({ content: await getContent(c.env.DB, item.id) });
});

// --- the owner's reading ---------------------------------------------------------------------------------------------------------------------------------------

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const MAX_REVIEWS_SHOWN = 100;

/**
 * Everything about one client's Local SEO in one answer (a test client too): the profile (no checker text: the name, address and phone result is `nap`), every keyword, the latest rank check of each active keyword,
 * the latest Google profile snapshot, the reviews (newest first, 100 at most), the content, the directory list and the latest report. A client with no setup yet gets nulls and empty lists. The report carries no token;
 * a `sent` report carries `linkPath`, the path of its page on the client link address.
 */
seoRoutes.get("/clients/:id/seo", async (c) => {
  const id = await clientId(c);
  if (id instanceof Response) return id;
  const db = c.env.DB;
  const tz = zoneOf(await getSettings(db));
  const profile = await getProfile(db, id);
  const latest = (await listSeoReports(db, { businessId: id })).sort((x, y) => y.period.localeCompare(x.period))[0];
  const row = latest ? await seoReportRow(c.env, latest, tz) : null;
  return c.json({
    profile: profile ? { ...profile, napResult: undefined } : null,
    keywords: await listKeywords(db, id),
    latestGrid: await latestGrid(db, id),
    snapshot: (await snapshotsFor(db, id, {})).at(-1) ?? null,
    nap: profile ? parseNapResult(profile.napResult) : null,
    reviews: (await listReviews(db, id)).reverse().slice(0, MAX_REVIEWS_SHOWN),
    content: await withTries(db, id, await listContent(db, { businessId: id })),
    citations: await listCitations(db, id),
    report: latest && row ? {
      id: row.id, period: row.period, status: row.status, summary: row.summary, recommendation: row.recommendation, priorities: row.priorities, source: row.source, sentOn: row.sentOn, views: row.views, test: row.test,
      ...(latest.status === "sent" ? { linkPath: `/l/${latest.token}` } : {}),
    } : null,
  });
});

/** What Logan does next for a client, as a plain sentence: the first thing that applies. */
function nextStep(o: { keywords: number; waiting: { replies: number; content: number; flagged: number }; report: { status: string; period: string } | null }): string {
  const { keywords, waiting, report } = o;
  if (keywords === 0) return "Add the search terms to track.";
  if (waiting.flagged > 0) return `Answer ${waiting.flagged === 1 ? "the low-rated review" : `the ${waiting.flagged} low-rated reviews`}.`;
  const drafts = waiting.replies + waiting.content;
  if (drafts > 0) return `Look at the ${drafts === 1 ? "draft" : `${drafts} drafts`} waiting for you.`;
  if (report?.status === "ready") return `Approve the ${report.period} report.`;
  if (report === null) return "Start last month's report once a rank check is in.";
  return "Nothing waiting.";
}

/**
 * One row per client whose Local SEO watch is on (a profile with `active` status; a rehearsal client and an archived one are left out), by name: the client, what to do next in plain words, how many drafts wait
 * (review replies and content), how many low-rated reviews still need an answer, and last month's report (`period` and its status, or null when it has not been started).
 */
seoRoutes.get("/seo/board", async (c) => {
  const db = c.env.DB;
  const period = previousMonth(new Date(), zoneOf(await getSettings(db)));
  const clients = (await db.prepare(
    `SELECT b.id AS id, b.name AS name FROM seo_profiles sp JOIN businesses b ON b.id = sp.business_id
     WHERE sp.status = 'active' AND b.archived_at IS NULL AND ${clientSql("b")} AND NOT ${testClientSql("b")} ORDER BY LOWER(b.name), b.id`,
  ).all<{ id: string; name: string }>()).results;
  const rows = await Promise.all(clients.map(async (b) => {
    const waiting = await waitingFor(db, b.id);
    const found = await listSeoReports(db, { businessId: b.id, period });
    const report = found[0] ? { period: found[0].period, status: found[0].status, id: found[0].id } : null;
    const keywords = (await listKeywords(db, b.id, { activeOnly: true })).length;
    return { clientId: b.id, client: b.name, next: nextStep({ keywords, waiting, report }), draftsWaiting: waiting.replies + waiting.content, flaggedReviews: waiting.flagged, report };
  }));
  return c.json({ period, rows });
});

/**
 * The month's reports (`?period=YYYY-MM`, default last month in the booking zone), oldest first, each with its client, status, words, priorities, how often the client opened it and, only for a `ready` or `sent` report,
 * the link to copy. `?clientId=` narrows to one client; with no `period` it is every month of that client, newest first (`period` is then null). 400 for a period that is not `YYYY-MM`. Never a bare token.
 */
seoRoutes.get("/seo/reports", async (c) => {
  const tz = zoneOf(await getSettings(c.env.DB));
  const wanted = c.req.query("clientId");
  const asked = c.req.query("period");
  if (asked !== undefined && !MONTH.test(asked)) return c.json({ error: "period must look like 2026-11." }, 400);
  const period = asked ?? (wanted === undefined ? previousMonth(new Date(), tz) : null);
  const reports = await listSeoReports(c.env.DB, { ...(period !== null ? { period } : {}), ...(wanted !== undefined ? { businessId: wanted } : {}) });
  if (period === null) reports.sort((x, y) => y.period.localeCompare(x.period));
  return c.json({ period, reports: await Promise.all(reports.map((r) => seoReportRow(c.env, r, tz))) });
});

/** The report's id, or the 404 to send back when it does not exist or its business is not a client. */
async function reportOf(c: Ctx): Promise<string | Response> {
  const report = await getSeoReport(c.env.DB, c.req.param("id") ?? "");
  return report && (await isClient(c.env.DB, report.businessId)) ? report.id : c.json(NOT_FOUND, 404);
}

/**
 * Logan's edit of a `ready` report's words (summary, recommendation and exactly three priorities), with the very same text rules as Claude's words. 400 with a sentence for words that break them, nothing changed;
 * 409 for a report that is not `ready`; 404 for an unknown one. The pending approval's card is rewritten to show the new words.
 */
seoRoutes.put("/seo/reports/:id", async (c) => {
  const id = await reportOf(c);
  if (id instanceof Response) return id;
  const words = checkSeoWords(await c.req.json().catch(() => null));
  if (!words.ok) return c.json({ error: words.error }, 400);
  const done = await editSeoReport(c.env, id, words);
  if (!done.ok) return c.json(done.status === 404 ? NOT_FOUND : { error: done.error }, done.status);
  return c.json({ report: await seoReportRow(c.env, done.report, zoneOf(await getSettings(c.env.DB))) });
});

/** Takes a `ready` or `sent` report back: its link stops working, its queued Claude job is closed and its pending approval rejected. 409 for any other state, 404 for an unknown report. */
seoRoutes.post("/seo/reports/:id/revoke", async (c) => {
  const id = await reportOf(c);
  if (id instanceof Response) return id;
  const done = await revokeSeoReportNow(c.env, id, new Date());
  if (!done.ok) return c.json(done.status === 404 ? NOT_FOUND : { error: done.error }, done.status);
  return c.json({ report: await seoReportRow(c.env, done.report, zoneOf(await getSettings(c.env.DB))) });
});
