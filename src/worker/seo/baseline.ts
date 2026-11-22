// The local SEO baseline (Plan 14): the first full look at a client, taken when the watch is switched on. The Google listing's numbers, the check of the client's own site against the
// listing's name, address and phone, and the first rank grid for every active keyword. Ranks are only ever "in our check", and nothing here promises a position.
import type { Env } from "../env";
import { logActivityOnce } from "../db/activity";
import { getSettings } from "../db/settings";
import { getProfile, listKeywords, upsertProfile, upsertSnapshot, type GbpSnapshot } from "../db/seo";
import { localDay } from "../monitoring/rollup";
import { zoneOf } from "../sop/cadence";
import { runRankGrid } from "./grid";
import type { NapResult } from "./nap";
import { placeDetails } from "./places";
import { SeoRefusal, placesRefusal, runNapCheck } from "./profile";

/**
 * Takes the client's baseline: saves today's snapshot of the Google listing (rating, review count, category, photos, hours), checks the site's name, address and phone against the listing,
 * runs the rank grid for every active keyword, switches the profile to `active`, and logs one `seo_baseline` line per booking-zone day. Safe to run again the same day: the snapshot and the
 * rank checks are replaced, and no second line is logged.
 * Refused, with a plain sentence, when the profile has no Google place yet, Google no longer knows it, Google can't be reached, or the site can't be read for the name, address and phone check;
 * the profile is switched on only after all of it worked. `ranked` is how many active keywords ended with a usable check.
 */
export async function runBaseline(env: Env, businessId: string, now: Date): Promise<{ snapshot: GbpSnapshot | null; nap: NapResult; ranked: number }> {
  const profile = await getProfile(env.DB, businessId);
  if (!profile) throw new SeoRefusal("Set up the profile first, so there is a Google place to take the baseline from.", 409);
  if (!profile.placeId || profile.lat === null || profile.lng === null) throw new SeoRefusal("Pick this client's Google place first, then take the baseline.", 409);

  const takenOn = localDay(now.toISOString(), zoneOf(await getSettings(env.DB)));

  let details;
  try { details = await placeDetails(env, profile.placeId); } catch (e) { throw placesRefusal(e) ?? e; }
  if (!details) throw new SeoRefusal("Google can't find that place any more. Search for the business again and pick it from the list.", 409);
  const snapshot: GbpSnapshot = {
    businessId, takenOn, rating: details.rating, reviewCount: details.reviewCount, category: details.category, photoCount: details.photoCount, hasHours: details.hasHours,
  };
  await upsertSnapshot(env.DB, { ...snapshot, now: now.toISOString() });

  const nap = await runNapCheck(env, businessId, undefined, now);
  const { unmeasured } = await runRankGrid(env, businessId, now);
  const active = (await listKeywords(env.DB, businessId, { activeOnly: true })).length;

  await upsertProfile(env.DB, businessId, { status: "active" }, now.toISOString());
  await logActivityOnce(env.DB, businessId, "seo_baseline", `Baseline for ${takenOn}`);
  return { snapshot, nap, ranked: Math.max(0, active - unmeasured) };
}
