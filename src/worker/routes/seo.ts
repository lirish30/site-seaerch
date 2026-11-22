import { Hono } from "hono";
import { z } from "zod";
import { isClient, todayKey } from "../clients/record";
import { addKeyword, getReview, listCitations, listKeywords, setCitation, setKeywordActive, setReviewDraft, setReviewStatus, type CitationStatus, type SeoReview } from "../db/seo";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { bodyOf, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";
import { runBaseline } from "../seo/baseline";
import { runRankGrid } from "../seo/grid";
import { CITATION_DIRECTORIES, parseNapResult } from "../seo/nap";
import { findPlaces } from "../seo/places";
import { CREDENTIAL_REFUSED, MAX_TEXT, MIN_TEXT, SeoRefusal, placesRefusal, runNapCheck, setupProfile, tidy } from "../seo/profile";
import { looksLikeCredential } from "../onboarding/templates";
import { replyText } from "../queue/seoReviewReply";

/**
 * Mounted at /api (behind requireAuth), all under /clients/:id/seo (the owner's local SEO setup for one client; a test client is allowed):
 * POST /place-search, PUT /profile, POST /keywords, DELETE /keywords/:keywordId, PUT /citations/:directory, POST /nap-check, POST /baseline, POST /rank-check.
 * And, for a review of a client's listing, PUT /seo/reviews/:id/draft, POST /seo/reviews/:id/posted and POST /seo/reviews/:id/skip. The app never posts a reply to Google: "posted" is Logan saying he did.
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
