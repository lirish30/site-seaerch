// The local rank grid (Plan 14): where a client's Google listing shows for a keyword from 9 points around the business, as one check per keyword per local day.
// A rank is only ever "in our check": one text search per point, page one only, with Google's own location bias. Nothing here promises a position.
import type { Env } from "../env";
import type { Fetcher } from "../crawler/crawl";
import { getSettings } from "../db/settings";
import { getProfile, listKeywords, rankChecksFor, upsertRankCheck, type RankPoint } from "../db/seo";
import { localDay } from "../monitoring/rollup";
import { zoneOf } from "../sop/cadence";
import { PlacesError, PlacesNotConfigured, rankAt } from "./places";
import { SeoRefusal, placesRefusal } from "./profile";

/** A keyword's check counts only when at least this many of its 9 points were measured. */
export const MIN_MEASURED_POINTS = 7;
/** Retryable Places errors in a row after which the whole run stops (Google is throttling or down; more calls only add to the bill and the queue). */
const MAX_RETRYABLE_IN_A_ROW = 3;

const EARTH_KM = 6371;
const KM_PER_DEGREE = (Math.PI * EARTH_KM) / 180;

/** The 9 points of a 3x3 grid, row by row from the north-west (index 4 is `center`), with neighbours `km` apart. The longitude step widens with the cosine of the latitude. */
export function gridPoints(center: { lat: number; lng: number }, km: number): { lat: number; lng: number }[] {
  const dLat = km / KM_PER_DEGREE;
  const dLng = km / (KM_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180));
  const out: { lat: number; lng: number }[] = [];
  for (let row = -1; row <= 1; row++) {
    for (let col = -1; col <= 1; col++) out.push({ lat: center.lat - row * dLat, lng: center.lng + col * dLng });
  }
  return out;
}

/** The search circle around each point: half the spacing, in metres, so neighbouring circles meet. The 10 km largest grid is 5 000 m, inside Google's 50 000 m cap. */
export const radiusMeters = (km: number): number => (km * 1000) / 2;

/** True when enough points were measured for the check to be worth showing. */
export const isUsable = (points: RankPoint[]): boolean => points.filter((p) => p.ok).length >= MIN_MEASURED_POINTS;

/**
 * Checks every active keyword of the client from the 9 grid points and stores one check per keyword for the booking-zone day of `now` (a second run that day replaces it, but a point that failed this time keeps the measurement an earlier run made from the same spot, and nothing is written when that changes nothing).
 * The calls are made one after another. A call that throws leaves its point `{ pos: null, ok: false }` (not found is `pos: null, ok: true`). After 3 retryable errors in a row, or at the first 401 or 403 (a key Google refuses), the run stops:
 * the keyword in progress is stored with the points it measured and the rest `ok: false`, and the keywords not reached are not stored at all.
 * `checked` is the keywords stored; `unmeasured` is the active keywords that ended without a usable check (stored with too few points, or not reached).
 * Refused, with nothing requested, when the profile has no place or location yet or the Places key is not set.
 * `o.calls`, when given, is a counter this run adds each Places request it starts to (a request that fails counts too: it is still a subrequest), so the daily sweep can keep within the Worker's subrequest budget.
 */
export async function runRankGrid(
  env: Env, businessId: string, now: Date, o: { fetch?: Fetcher; calls?: { n: number } } = {},
): Promise<{ checked: number; unmeasured: number }> {
  const profile = await getProfile(env.DB, businessId);
  if (!profile) throw new SeoRefusal("Set up the profile first, so there is a place to check rankings for.", 409);
  if (!profile.placeId || profile.lat === null || profile.lng === null) throw new SeoRefusal("Pick this client's Google place first, so there is somewhere to check rankings from.", 409);
  if (!env.GOOGLE_PLACES_API_KEY) throw placesRefusal(new PlacesNotConfigured())!;

  const takenOn = localDay(now.toISOString(), zoneOf(await getSettings(env.DB)));
  const keywords = await listKeywords(env.DB, businessId, { activeOnly: true });
  const grid = gridPoints({ lat: profile.lat, lng: profile.lng }, profile.gridKm);
  const radiusM = radiusMeters(profile.gridKm);

  const today = new Map((await rankChecksFor(env.DB, businessId, { from: takenOn, to: takenOn })).map((r) => [r.keywordId, r.points]));

  let checked = 0;
  let usable = 0;
  let retryableInARow = 0;
  for (const keyword of keywords) {
    if (retryableInARow >= MAX_RETRYABLE_IN_A_ROW) break;
    const term = keyword.town ? `${keyword.term} ${keyword.town}` : keyword.term;
    const points: RankPoint[] = [];
    let attempted = 0;
    for (const p of grid) {
      if (retryableInARow >= MAX_RETRYABLE_IN_A_ROW) { points.push({ lat: p.lat, lng: p.lng, pos: null, ok: false }); continue; }
      attempted++;
      if (o.calls) o.calls.n++;
      try {
        const pos = await rankAt(env, { term, lat: p.lat, lng: p.lng, radiusM, placeId: profile.placeId }, o.fetch);
        retryableInARow = 0;
        points.push({ lat: p.lat, lng: p.lng, pos, ok: true });
      } catch (e) {
        // A key Google refuses (401 or 403) fails every call of the day the same way: stop at the first one, as after three throttled calls in a row.
        const refused = e instanceof PlacesError && (e.status === 401 || e.status === 403);
        retryableInARow = refused ? MAX_RETRYABLE_IN_A_ROW : e instanceof PlacesError && e.retryable ? retryableInARow + 1 : 0;
        points.push({ lat: p.lat, lng: p.lng, pos: null, ok: false });
      }
    }
    if (attempted === 0) break;
    // A point that failed this time keeps the measurement an earlier run that day made from the same spot, so a worse rerun never degrades the day's check.
    const before = today.get(keyword.id);
    const merged = points.map((pt, i) => {
      const old = before?.[i];
      return !pt.ok && old && old.ok && old.lat === pt.lat && old.lng === pt.lng ? old : pt;
    });
    const same = before !== undefined && before.length === merged.length && merged.every((m, i) => m.lat === before[i].lat && m.lng === before[i].lng && m.pos === before[i].pos && m.ok === before[i].ok);
    if (!same) await upsertRankCheck(env.DB, { businessId, keywordId: keyword.id, takenOn, points: merged, now: now.toISOString() });
    checked++;
    if (isUsable(merged)) usable++;
  }
  return { checked, unmeasured: keywords.length - usable };
}
