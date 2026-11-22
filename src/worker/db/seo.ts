// Local SEO data (Plan 14): a client's profile, keywords, rank checks, Google Business Profile snapshots, reviews, monthly content and citations.
// Times (`now`, `createdAt`, `updatedAt`) are UTC ISO strings with milliseconds. Every `*On` field is a local date (YYYY-MM-DD) the caller worked out in the booking zone; nothing here computes a zone.
// Each state change is one statement, and a change that depends on the current state is a compare-and-set: it names the states it may start from and returns false when the row was in none of them.

export type ProfileStatus = "setup" | "active" | "paused";
export type ReplyStatus = "new" | "drafting" | "drafted" | "posted" | "skipped";
export type ContentKind = "page" | "post" | "gbp_post";
export type ContentStatus = "planned" | "drafting" | "drafted" | "approved" | "published" | "rejected";
export type CitationStatus = "todo" | "listed" | "needs_fix" | "not_applicable";

export interface SeoProfile {
  businessId: string; siteId: string | null; placeId: string | null; mapsUrl: string | null; napName: string; napAddress: string; napPhone: string; lat: number | null; lng: number | null;
  trade: string; towns: string[]; gridKm: number; status: ProfileStatus; lastWatchOn: string | null;
  /** The result of the last name, address and phone check, as the text the checker stored (not read here). */
  napResult: string | null;
  createdAt: string; updatedAt: string;
}
export interface SeoKeyword { id: string; businessId: string; term: string; town: string; active: boolean; createdAt: string }
/** One of the 9 grid points of a rank check: where it was searched from, and where the business showed (null when it did not). */
export interface RankPoint { lat: number; lng: number; pos: number | null; ok: boolean }
export interface RankCheck { id: string; businessId: string; keywordId: string; takenOn: string; points: RankPoint[]; createdAt: string }
export interface GbpSnapshot {
  businessId: string; takenOn: string; rating: number | null; reviewCount: number | null; category: string | null; photoCount: number | null; hasHours: boolean | null;
}
export interface SeoReview {
  id: string; businessId: string; externalId: string; rating: number; author: string; body: string; publishedAt: string | null; firstSeenOn: string; replyStatus: ReplyStatus; replyDraft: string;
  flagged: boolean; claudeTaskId: string | null; createdAt: string;
}
export interface ContentItem {
  id: string; businessId: string; period: string; kind: ContentKind; slot: number; keywordId: string | null; brief: string; title: string; metaTitle: string; metaDescription: string; body: string;
  status: ContentStatus; claudeTaskId: string | null; url: string | null; updatedAt: string;
}
export interface Citation { id: string; businessId: string; directory: string; status: CitationStatus; url: string | null; note: string; checkedOn: string | null; createdAt: string }

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const changed = (res: { meta: { changes?: number } }) => (res.meta.changes ?? 0) === 1;
const flag = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0);
const bool = (n: number | null): boolean | null => (n === null ? null : !!n);

// --- profiles -------------------------------------------------------------------------------------------------------------------------------------------------------

interface ProfileRow {
  business_id: string; site_id: string | null; place_id: string | null; maps_url: string | null; nap_name: string; nap_address: string; nap_phone: string; lat: number | null; lng: number | null;
  trade: string; towns: string; grid_km: number; status: ProfileStatus; last_watch_on: string | null; nap_result: string | null; created_at: string; updated_at: string;
}

const parseList = (s: string): string[] => {
  try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

const toProfile = (r: ProfileRow): SeoProfile => ({
  businessId: r.business_id, siteId: r.site_id, placeId: r.place_id, mapsUrl: r.maps_url, napName: r.nap_name, napAddress: r.nap_address, napPhone: r.nap_phone, lat: r.lat, lng: r.lng,
  trade: r.trade, towns: parseList(r.towns), gridKm: r.grid_km, status: r.status, lastWatchOn: r.last_watch_on, napResult: r.nap_result, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** The patchable profile fields and their columns; `towns` is stored as JSON. */
const PROFILE_COLUMNS = {
  siteId: "site_id", placeId: "place_id", mapsUrl: "maps_url", napName: "nap_name", napAddress: "nap_address", napPhone: "nap_phone", lat: "lat", lng: "lng", trade: "trade", towns: "towns",
  gridKm: "grid_km", status: "status", lastWatchOn: "last_watch_on", napResult: "nap_result",
} as const;

export async function getProfile(db: D1Database, businessId: string): Promise<SeoProfile | null> {
  const r = await db.prepare(`SELECT * FROM seo_profiles WHERE business_id = ?`).bind(businessId).first<ProfileRow>();
  return r ? toProfile(r) : null;
}

/** Every client whose local SEO watch is switched on, oldest profile first. */
export async function listActiveProfiles(db: D1Database): Promise<SeoProfile[]> {
  const rows = (await db.prepare(`SELECT * FROM seo_profiles WHERE status = 'active' ORDER BY created_at, rowid`).all<ProfileRow>()).results;
  return rows.map(toProfile);
}

/**
 * Makes the client's profile, or changes the fields in `patch` (a field left out, or undefined, is not touched; null clears a nullable one), in one statement. A new profile starts with the column defaults.
 * `updatedAt` is `now`; `createdAt` is set once.
 */
export async function upsertProfile(
  db: D1Database, businessId: string, patch: Partial<Omit<SeoProfile, "businessId" | "createdAt">>, now: string,
): Promise<SeoProfile> {
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const key of Object.keys(PROFILE_COLUMNS) as (keyof typeof PROFILE_COLUMNS)[]) {
    const v = patch[key];
    if (v === undefined) continue;
    cols.push(PROFILE_COLUMNS[key]);
    args.push(key === "towns" ? JSON.stringify(v) : v);
  }
  const insertCols = ["business_id", ...cols, "created_at", "updated_at"];
  const sets = [...cols.map((c) => `${c} = excluded.${c}`), "updated_at = excluded.updated_at"];
  const row = await db.prepare(
    `INSERT INTO seo_profiles (${insertCols.join(", ")}) VALUES (${marks(insertCols.length)}) ON CONFLICT (business_id) DO UPDATE SET ${sets.join(", ")} RETURNING *`,
  ).bind(businessId, ...args, now, now).first<ProfileRow>();
  if (!row) throw new Error("could not save the SEO profile");
  return toProfile(row);
}

// --- keywords -------------------------------------------------------------------------------------------------------------------------------------------------------

interface KeywordRow { id: string; business_id: string; term: string; town: string; active: number; created_at: string }
const toKeyword = (r: KeywordRow): SeoKeyword => ({ id: r.id, businessId: r.business_id, term: r.term, town: r.town, active: !!r.active, createdAt: r.created_at });

/** Adds a (term, town) to the client once: a second call changes nothing and returns the row that is there, with `created: false`. */
export async function addKeyword(
  db: D1Database, businessId: string, o: { term: string; town: string }, now: string,
): Promise<{ keyword: SeoKeyword; created: boolean }> {
  const made = await db.prepare(
    `INSERT INTO seo_keywords (id, business_id, term, town, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (business_id, term, town) DO NOTHING RETURNING *`,
  ).bind(crypto.randomUUID(), businessId, o.term, o.town, now).first<KeywordRow>();
  if (made) return { keyword: toKeyword(made), created: true };
  const existing = await db.prepare(`SELECT * FROM seo_keywords WHERE business_id = ? AND term = ? AND town = ?`).bind(businessId, o.term, o.town).first<KeywordRow>();
  if (!existing) throw new Error("could not add the keyword");
  return { keyword: toKeyword(existing), created: false };
}

/** The client's keywords, oldest first; `activeOnly` leaves out the ones switched off. */
export async function listKeywords(db: D1Database, businessId: string, o: { activeOnly?: boolean } = {}): Promise<SeoKeyword[]> {
  const rows = (await db.prepare(`SELECT * FROM seo_keywords WHERE business_id = ? ${o.activeOnly ? "AND active = 1" : ""} ORDER BY created_at, rowid`).bind(businessId).all<KeywordRow>()).results;
  return rows.map(toKeyword);
}

/** Switches a keyword on or off; false when there is no such keyword. */
export async function setKeywordActive(db: D1Database, id: string, active: boolean): Promise<boolean> {
  return changed(await db.prepare(`UPDATE seo_keywords SET active = ? WHERE id = ?`).bind(active ? 1 : 0, id).run());
}

// --- rank checks ----------------------------------------------------------------------------------------------------------------------------------------------------

interface RankRow { id: string; business_id: string; keyword_id: string; taken_on: string; points: string; created_at: string }

const toRankCheck = (r: RankRow): RankCheck => {
  let points: RankPoint[] = [];
  try { const v: unknown = JSON.parse(r.points); if (Array.isArray(v)) points = v as RankPoint[]; } catch { /* unreadable points are none */ }
  return { id: r.id, businessId: r.business_id, keywordId: r.keyword_id, takenOn: r.taken_on, points, createdAt: r.created_at };
};

/** Saves a keyword's check for one day; a second call for the same keyword and day replaces the points. */
export async function upsertRankCheck(db: D1Database, o: { businessId: string; keywordId: string; takenOn: string; points: RankPoint[]; now: string }): Promise<void> {
  await db.prepare(
    `INSERT INTO seo_rank_checks (id, business_id, keyword_id, taken_on, points, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (keyword_id, taken_on) DO UPDATE SET points = excluded.points`,
  ).bind(crypto.randomUUID(), o.businessId, o.keywordId, o.takenOn, JSON.stringify(o.points), o.now).run();
}

/** The client's checks from `from` to `to` (local dates, either left out for no limit, both included), oldest first. */
export async function rankChecksFor(db: D1Database, businessId: string, o: { from?: string; to?: string }): Promise<RankCheck[]> {
  const where = ["business_id = ?"];
  const args: string[] = [businessId];
  if (o.from !== undefined) { where.push("taken_on >= ?"); args.push(o.from); }
  if (o.to !== undefined) { where.push("taken_on <= ?"); args.push(o.to); }
  const rows = (await db.prepare(`SELECT * FROM seo_rank_checks WHERE ${where.join(" AND ")} ORDER BY taken_on, created_at, rowid`).bind(...args).all<RankRow>()).results;
  return rows.map(toRankCheck);
}

// --- Google Business Profile snapshots ------------------------------------------------------------------------------------------------------------------------------

interface SnapshotRow {
  business_id: string; taken_on: string; rating: number | null; review_count: number | null; category: string | null; photo_count: number | null; has_hours: number | null;
}

/** Saves the profile's numbers for one day; a second call for the day replaces them. */
export async function upsertSnapshot(db: D1Database, s: GbpSnapshot & { now: string }): Promise<void> {
  await db.prepare(
    `INSERT INTO seo_gbp_snapshots (business_id, taken_on, rating, review_count, category, photo_count, has_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (business_id, taken_on) DO UPDATE SET rating = excluded.rating, review_count = excluded.review_count, category = excluded.category, photo_count = excluded.photo_count, has_hours = excluded.has_hours`,
  ).bind(s.businessId, s.takenOn, s.rating, s.reviewCount, s.category, s.photoCount, flag(s.hasHours), s.now).run();
}

/** The client's snapshots from `from` to `to` (local dates, either left out for no limit, both included), oldest first. */
export async function snapshotsFor(db: D1Database, businessId: string, o: { from?: string; to?: string }): Promise<GbpSnapshot[]> {
  const where = ["business_id = ?"];
  const args: string[] = [businessId];
  if (o.from !== undefined) { where.push("taken_on >= ?"); args.push(o.from); }
  if (o.to !== undefined) { where.push("taken_on <= ?"); args.push(o.to); }
  const rows = (await db.prepare(`SELECT business_id, taken_on, rating, review_count, category, photo_count, has_hours FROM seo_gbp_snapshots WHERE ${where.join(" AND ")} ORDER BY taken_on`).bind(...args).all<SnapshotRow>()).results;
  return rows.map((r) => ({ businessId: r.business_id, takenOn: r.taken_on, rating: r.rating, reviewCount: r.review_count, category: r.category, photoCount: r.photo_count, hasHours: bool(r.has_hours) }));
}

// --- reviews --------------------------------------------------------------------------------------------------------------------------------------------------------

interface ReviewRow {
  id: string; business_id: string; external_id: string; rating: number; author: string; body: string; published_at: string | null; first_seen_on: string; reply_status: ReplyStatus; reply_draft: string;
  flagged: number; claude_task_id: string | null; created_at: string;
}

const toReview = (r: ReviewRow): SeoReview => ({
  id: r.id, businessId: r.business_id, externalId: r.external_id, rating: r.rating, author: r.author, body: r.body, publishedAt: r.published_at, firstSeenOn: r.first_seen_on, replyStatus: r.reply_status,
  replyDraft: r.reply_draft, flagged: !!r.flagged, claudeTaskId: r.claude_task_id, createdAt: r.created_at,
});

/**
 * Saves the reviews the watch saw, once each by the platform's id. A new one starts as `new`, and is flagged when it is three stars or fewer. One already known is left exactly as it is
 * (its text, rating and reply state), so a re-read of the same review changes nothing. Returns only the rows this call made.
 */
export async function upsertReviews(
  db: D1Database, businessId: string,
  reviews: { externalId: string; rating: number; author: string; body: string; publishedAt: string | null }[],
  o: { takenOn: string; now: string },
): Promise<{ inserted: SeoReview[] }> {
  const inserted: SeoReview[] = [];
  for (const r of reviews) {
    const made = await db.prepare(
      `INSERT INTO seo_reviews (id, business_id, external_id, rating, author, body, published_at, first_seen_on, flagged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (business_id, external_id) DO NOTHING RETURNING *`,
    ).bind(crypto.randomUUID(), businessId, r.externalId, r.rating, r.author, r.body, r.publishedAt, o.takenOn, r.rating <= 3 ? 1 : 0, o.now).first<ReviewRow>();
    if (made) inserted.push(toReview(made));
  }
  return { inserted };
}

/** The client's reviews, oldest seen first; with `status`, only those in one of the given reply states (an empty list matches none). */
export async function listReviews(db: D1Database, businessId: string, o: { status?: ReplyStatus[] } = {}): Promise<SeoReview[]> {
  if (o.status && o.status.length === 0) return [];
  const rows = (await db.prepare(
    `SELECT * FROM seo_reviews WHERE business_id = ? ${o.status ? `AND reply_status IN (${marks(o.status.length)})` : ""} ORDER BY first_seen_on, created_at, rowid`,
  ).bind(businessId, ...(o.status ?? [])).all<ReviewRow>()).results;
  return rows.map(toReview);
}

/**
 * Sets a review's reply draft and state while it is in one of the `from` states. One statement, so two callers cannot both win; false when the review was in none of them.
 * A `taskId` that is not given leaves the stored one as it is.
 */
export async function setReviewDraft(
  db: D1Database, id: string, from: ReplyStatus[], o: { draft: string; status: ReplyStatus; taskId?: string },
): Promise<boolean> {
  if (from.length === 0) return false;
  const res = await db.prepare(
    `UPDATE seo_reviews SET reply_draft = ?, reply_status = ?, claude_task_id = CASE WHEN ? = 1 THEN ? ELSE claude_task_id END WHERE id = ? AND reply_status IN (${marks(from.length)})`,
  ).bind(o.draft, o.status, o.taskId !== undefined ? 1 : 0, o.taskId ?? null, id, ...from).run();
  return changed(res);
}

/** One review by id, or null. */
export async function getReview(db: D1Database, id: string): Promise<SeoReview | null> {
  const r = await db.prepare(`SELECT * FROM seo_reviews WHERE id = ?`).bind(id).first<ReviewRow>();
  return r ? toReview(r) : null;
}

/** Moves a review to `status` while it is in one of the `from` states, leaving its draft as it is. One statement; false when the review was in none of them. */
export async function setReviewStatus(db: D1Database, id: string, from: ReplyStatus[], status: ReplyStatus): Promise<boolean> {
  if (from.length === 0) return false;
  const res = await db.prepare(`UPDATE seo_reviews SET reply_status = ? WHERE id = ? AND reply_status IN (${marks(from.length)})`).bind(status, id, ...from).run();
  return changed(res);
}

// --- content --------------------------------------------------------------------------------------------------------------------------------------------------------

interface ContentRow {
  id: string; business_id: string; period: string; kind: ContentKind; slot: number; keyword_id: string | null; brief: string; title: string; meta_title: string; meta_description: string; body: string;
  status: ContentStatus; claude_task_id: string | null; url: string | null; updated_at: string;
}

const toContent = (r: ContentRow): ContentItem => ({
  id: r.id, businessId: r.business_id, period: r.period, kind: r.kind, slot: r.slot, keywordId: r.keyword_id, brief: r.brief, title: r.title, metaTitle: r.meta_title,
  metaDescription: r.meta_description, body: r.body, status: r.status, claudeTaskId: r.claude_task_id, url: r.url, updatedAt: r.updated_at,
});

/**
 * Plans the month's content, once per (business, period, kind, slot): a slot that is already there is left as it is. Returns the row of every slot given, in the order given
 * (the new one, or the one that was there).
 */
export async function insertContentSlots(db: D1Database, rows: Omit<ContentItem, "id" | "updatedAt">[], now: string): Promise<ContentItem[]> {
  const out: ContentItem[] = [];
  for (const r of rows) {
    const made = await db.prepare(
      `INSERT INTO seo_content (id, business_id, period, kind, slot, keyword_id, brief, title, meta_title, meta_description, body, status, claude_task_id, url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (business_id, period, kind, slot) DO NOTHING RETURNING *`,
    ).bind(crypto.randomUUID(), r.businessId, r.period, r.kind, r.slot, r.keywordId, r.brief, r.title, r.metaTitle, r.metaDescription, r.body, r.status, r.claudeTaskId, r.url, now, now).first<ContentRow>();
    if (made) { out.push(toContent(made)); continue; }
    const existing = await db.prepare(`SELECT * FROM seo_content WHERE business_id = ? AND period = ? AND kind = ? AND slot = ?`).bind(r.businessId, r.period, r.kind, r.slot).first<ContentRow>();
    if (!existing) throw new Error("could not plan the content slot");
    out.push(toContent(existing));
  }
  return out;
}

export async function getContent(db: D1Database, id: string): Promise<ContentItem | null> {
  const r = await db.prepare(`SELECT * FROM seo_content WHERE id = ?`).bind(id).first<ContentRow>();
  return r ? toContent(r) : null;
}

/** Content of one client and/or one period and/or in any of the given statuses (an empty status list matches none), in period, kind and slot order. */
export async function listContent(db: D1Database, o: { businessId?: string; period?: string; status?: ContentStatus[] }): Promise<ContentItem[]> {
  if (o.status && o.status.length === 0) return [];
  const where: string[] = [];
  const args: string[] = [];
  if (o.businessId !== undefined) { where.push("business_id = ?"); args.push(o.businessId); }
  if (o.period !== undefined) { where.push("period = ?"); args.push(o.period); }
  if (o.status) { where.push(`status IN (${marks(o.status.length)})`); args.push(...o.status); }
  const rows = (await db.prepare(`SELECT * FROM seo_content ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY period, business_id, kind, slot`).bind(...args).all<ContentRow>()).results;
  return rows.map(toContent);
}

const CONTENT_COLUMNS = {
  title: "title", metaTitle: "meta_title", metaDescription: "meta_description", body: "body", status: "status", claudeTaskId: "claude_task_id", url: "url",
} as const;

/**
 * Changes the fields in `patch` (one left out, or undefined, is not touched) while the item is in one of the `from` statuses, and stamps `updated_at`. One statement, so two callers
 * cannot both win; false when the item was in none of them.
 */
export async function setContent(
  db: D1Database, id: string, from: ContentStatus[],
  patch: Partial<Pick<ContentItem, "title" | "metaTitle" | "metaDescription" | "body" | "status" | "claudeTaskId" | "url">>, now: string,
): Promise<boolean> {
  if (from.length === 0) return false;
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const key of Object.keys(CONTENT_COLUMNS) as (keyof typeof CONTENT_COLUMNS)[]) {
    const v = patch[key];
    if (v === undefined) continue;
    sets.push(`${CONTENT_COLUMNS[key]} = ?`);
    args.push(v);
  }
  sets.push("updated_at = ?");
  args.push(now);
  const res = await db.prepare(`UPDATE seo_content SET ${sets.join(", ")} WHERE id = ? AND status IN (${marks(from.length)})`).bind(...args, id, ...from).run();
  return changed(res);
}

// --- citations ------------------------------------------------------------------------------------------------------------------------------------------------------

interface CitationRow { id: string; business_id: string; directory: string; status: CitationStatus; url: string | null; note: string; checked_on: string | null; created_at: string }
const toCitation = (r: CitationRow): Citation => ({
  id: r.id, businessId: r.business_id, directory: r.directory, status: r.status, url: r.url, note: r.note, checkedOn: r.checked_on, createdAt: r.created_at,
});

/** The client's citations, in the order they were first made. */
export async function listCitations(db: D1Database, businessId: string): Promise<Citation[]> {
  const rows = (await db.prepare(`SELECT * FROM seo_citations WHERE business_id = ? ORDER BY created_at, rowid`).bind(businessId).all<CitationRow>()).results;
  return rows.map(toCitation);
}

/** Makes a `todo` row for each directory the client does not have yet (a second call adds none, and a directory named twice is made once), and returns all of the client's rows. */
export async function ensureCitations(db: D1Database, businessId: string, directories: readonly string[], now: string): Promise<Citation[]> {
  for (const directory of directories) {
    await db.prepare(`INSERT INTO seo_citations (id, business_id, directory, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (business_id, directory) DO NOTHING`).bind(crypto.randomUUID(), businessId, directory, now).run();
  }
  return listCitations(db, businessId);
}

/** Sets a directory's status and stamps `checked_on` with the local date `takenOn`; a url or note that is not given is left as it is. False when the client has no such directory. */
export async function setCitation(
  db: D1Database, businessId: string, directory: string, patch: { status: CitationStatus; url?: string; note?: string }, takenOn: string,
): Promise<boolean> {
  const res = await db.prepare(
    `UPDATE seo_citations SET status = ?, url = CASE WHEN ? = 1 THEN ? ELSE url END, note = CASE WHEN ? = 1 THEN ? ELSE note END, checked_on = ? WHERE business_id = ? AND directory = ?`,
  ).bind(patch.status, patch.url !== undefined ? 1 : 0, patch.url ?? null, patch.note !== undefined ? 1 : 0, patch.note ?? "", takenOn, businessId, directory).run();
  return changed(res);
}
