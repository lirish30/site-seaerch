// The review watch (Plan 14): the Google listing's numbers and newest reviews for the booking-zone day, and a Claude task that drafts a reply to each review nobody has answered.
// Review text, reviewer names and place data are untrusted: they go to the database and to the queue's untrusted block, nowhere else. The app never posts a reply anywhere.
import type { Env } from "../env";
import type { Fetcher } from "../crawler/crawl";
import { logActivityOnce } from "../db/activity";
import { getSettings } from "../db/settings";
import { getProfile, listReviews, snapshotsFor, upsertProfile, upsertReviews, upsertSnapshot, type GbpSnapshot } from "../db/seo";
import { localDay } from "../monitoring/rollup";
import { MAX_REVIEWS_PER_TASK, queueReviewReplies } from "../queue/seoReviewReply";
import { zoneOf } from "../sop/cadence";
import { placeDetails } from "./places";
import { SeoRefusal, placesRefusal } from "./profile";

/**
 * Reads the client's listing now. Saves the booking-zone day's snapshot and the profile's `last_watch_on`, stores the reviews Google shows that were not known (each once, by Google's id),
 * and queues ONE Claude task for the oldest ten reviews still `new`, marking them `drafting`. Safe to run again the same day: the snapshot is replaced, no review is stored twice, and reviews already
 * handed to Claude are not queued again.
 * `unseen` is how many reviews the listing gained that Google did not show us: the rise in its review count since the latest earlier snapshot, less the reviews stored by this call, never below 0
 * (0 too when either count is missing).
 * A place Google no longer knows, or lists under a different id now, pauses the profile with one timeline note and changes nothing else (`snapshot: null`, `paused: true`). Refused, with a plain sentence and nothing changed, when there is no Google place yet or Google can't be reached.
 */
export async function watchReviews(
  env: Env, businessId: string, now: Date, o: { fetch?: Fetcher } = {},
): Promise<{ snapshot: GbpSnapshot | null; inserted: number; unseen: number; queued: boolean; paused: boolean }> {
  const profile = await getProfile(env.DB, businessId);
  if (!profile) throw new SeoRefusal("Set up the profile first, so there is a Google place to watch.", 409);
  if (!profile.placeId) throw new SeoRefusal("Pick this client's Google place first, then watch its reviews.", 409);

  const takenOn = localDay(now.toISOString(), zoneOf(await getSettings(env.DB)));

  let details;
  try { details = await placeDetails(env, profile.placeId, o.fetch); } catch (e) { throw placesRefusal(e) ?? e; }
  // A place Google no longer knows, or now lists under another id, is no longer the client's: pause the client (the sweep and the reports stop), say so once on the timeline, and set the watch day so the paid call does
  // not repeat every day. Picking the place again (the profile) and taking the baseline switches the watch back on.
  if (!details || details.id !== profile.placeId) {
    await upsertProfile(env.DB, businessId, { status: "paused", lastWatchOn: takenOn }, now.toISOString());
    await logActivityOnce(env.DB, businessId, "note", details ? "Local SEO paused: Google now lists this place under a different id: pick it again." : "Local SEO paused: Google no longer knows this place: pick it again.");
    return { snapshot: null, inserted: 0, unseen: 0, queued: false, paused: true };
  }

  const earlier = (await snapshotsFor(env.DB, businessId, { to: takenOn })).filter((s) => s.takenOn < takenOn).at(-1);
  const snapshot: GbpSnapshot = {
    businessId, takenOn, rating: details.rating, reviewCount: details.reviewCount, category: details.category, photoCount: details.photoCount, hasHours: details.hasHours,
  };
  await upsertSnapshot(env.DB, { ...snapshot, now: now.toISOString() });
  await upsertProfile(env.DB, businessId, { lastWatchOn: takenOn }, now.toISOString());

  const { inserted } = await upsertReviews(
    env.DB, businessId, details.reviews.map((r) => ({ externalId: r.externalId, rating: r.rating, author: r.author, body: r.text, publishedAt: r.publishedAt })),
    { takenOn, now: now.toISOString() },
  );
  const rise = earlier?.reviewCount != null && snapshot.reviewCount !== null ? snapshot.reviewCount - earlier.reviewCount : 0;
  const unseen = Math.max(0, rise - inserted.length);

  const waiting = (await listReviews(env.DB, businessId, { status: ["new"] })).slice(0, MAX_REVIEWS_PER_TASK);
  const queued = await queueReviewReplies(env, businessId, waiting.map((r) => r.id));
  return { snapshot, inserted: inserted.length, unseen, queued, paused: false };
}
