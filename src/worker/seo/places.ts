import type { Env } from "../env";
import type { Fetcher } from "../crawler/crawl";
import { PRICES } from "../cost";
import { recordUsage } from "../db/usage";
import { REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../listings/source";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAILS_URL = "https://places.googleapis.com/v1/places/";
const MAX_CANDIDATES = 5;
const CANDIDATE_MASK = ["places.id", "places.displayName", "places.formattedAddress", "places.googleMapsUri", "places.rating", "places.userRatingCount"].join(",");
const DETAILS_MASK = [
  "id", "displayName", "formattedAddress", "nationalPhoneNumber", "websiteUri", "googleMapsUri", "rating", "userRatingCount",
  "location", "primaryTypeDisplayName", "photos", "regularOpeningHours", "reviews",
].join(",");

/** A Google Places failure. `status` is Google's HTTP status when it answered. `retryable` is true for a 429, a 5xx, a timeout or a dropped connection: another try may work. */
export class PlacesError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "PlacesError";
  }
}
/** GOOGLE_PLACES_API_KEY is not set, so no request was made. */
export class PlacesNotConfigured extends Error {
  constructor() {
    super("Google Places is not configured (GOOGLE_PLACES_API_KEY is not set)");
    this.name = "PlacesNotConfigured";
  }
}

export interface PlaceCandidate { id: string; name: string; address: string; mapsUrl: string | null; rating: number | null; reviewCount: number | null }
export interface PlaceReview { externalId: string; rating: number; author: string; text: string; publishedAt: string | null }
export interface PlaceDetails {
  id: string; name: string; address: string; phone: string | null; website: string | null; mapsUrl: string | null;
  rating: number | null; reviewCount: number | null; lat: number; lng: number; category: string | null;
  photoCount: number | null; hasHours: boolean; reviews: PlaceReview[];
}

interface RawReview { name?: string; rating?: number; text?: { text?: string }; originalText?: { text?: string }; authorAttribution?: { displayName?: string }; publishTime?: string }
interface RawPlace {
  id?: string; displayName?: { text?: string }; formattedAddress?: string; nationalPhoneNumber?: string; websiteUri?: string; googleMapsUri?: string;
  rating?: number; userRatingCount?: number; location?: { latitude?: number; longitude?: number }; primaryTypeDisplayName?: { text?: string };
  photos?: unknown[]; regularOpeningHours?: unknown; reviews?: RawReview[];
}

// Looks `fetch` up on each call (and calls it unbound), as workflows.ts does, so a test can stub it.
const defaultFetch: Fetcher = (u, i) => fetch(u, i);

const orNull = <T>(v: T | undefined | ""): T | null => (v === undefined || v === "" ? null : v);

/** One Places request. A response Google answered (a 2xx, or a 404 when `allow404`) is billed and recorded as one usage row; a failure is not. */
async function call(env: Env, f: Fetcher, url: string, init: { method: "GET" | "POST"; mask: string; body?: unknown }, price: number, allow404 = false): Promise<unknown | null> {
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new PlacesNotConfigured();
  // Nothing that reaches a message or a log may carry the key, whatever Google echoes back.
  const scrub = (s: string) => s.split(key).join("[key]");
  let res: Response;
  let body: string;
  try {
    ({ res, body } = await fetchWithTimeout(f, url, {
      method: init.method,
      headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": init.mask },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }, REQUEST_TIMEOUT_MS, "Google Places"));
  } catch (e) {
    throw new PlacesError(scrub(`Google Places request failed: ${e instanceof Error ? e.message : String(e)}`), true);
  }
  if (allow404 && res.status === 404) {
    await recordUsage(env.DB, "places", 1, price);
    return null;
  }
  if (!res.ok) {
    let detail = body.slice(0, 200);
    try { detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* not JSON: keep the raw text */ }
    throw new PlacesError(scrub(`Google Places HTTP ${res.status}: ${detail || "no body"}`), res.status === 429 || res.status >= 500, res.status);
  }
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new PlacesError(scrub(`Google Places returned non-JSON: ${body.slice(0, 200)}`), true); }
  await recordUsage(env.DB, "places", 1, price);
  return json;
}

/** Text search for the business a client typed in, so the agency can pick the right listing. Five candidates at most. */
export async function findPlaces(env: Env, q: { name: string; address: string }, f: Fetcher = defaultFetch): Promise<PlaceCandidate[]> {
  const json = (await call(env, f, SEARCH_URL, {
    method: "POST", mask: CANDIDATE_MASK, body: { textQuery: `${q.name} ${q.address}`.trim(), pageSize: MAX_CANDIDATES, languageCode: "en" },
  }, PRICES.placesPerRequest)) as { places?: RawPlace[] };
  const out: PlaceCandidate[] = [];
  for (const p of json.places ?? []) {
    if (!p.id) continue;
    out.push({ id: p.id, name: p.displayName?.text ?? "", address: p.formattedAddress ?? "", mapsUrl: orNull(p.googleMapsUri), rating: orNull(p.rating), reviewCount: orNull(p.userRatingCount) });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** One place with its photos, hours flag and up to five reviews. Null when Google does not know the id (404). */
export async function placeDetails(env: Env, placeId: string, f: Fetcher = defaultFetch): Promise<PlaceDetails | null> {
  const json = (await call(env, f, `${DETAILS_URL}${encodeURIComponent(placeId)}`, { method: "GET", mask: DETAILS_MASK }, PRICES.placesDetailsPerRequest, true)) as RawPlace | null;
  if (json === null) return null;
  const lat = json.location?.latitude;
  const lng = json.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") throw new PlacesError("Google Places returned a place without a location", false);
  const reviews: PlaceReview[] = [];
  for (const r of json.reviews ?? []) {
    if (!r.name || typeof r.rating !== "number") continue;
    reviews.push({ externalId: r.name, rating: r.rating, author: r.authorAttribution?.displayName ?? "", text: r.text?.text ?? r.originalText?.text ?? "", publishedAt: orNull(r.publishTime) });
  }
  return {
    id: json.id ?? placeId, name: json.displayName?.text ?? "", address: json.formattedAddress ?? "", phone: orNull(json.nationalPhoneNumber),
    website: orNull(json.websiteUri), mapsUrl: orNull(json.googleMapsUri), rating: orNull(json.rating), reviewCount: orNull(json.userRatingCount),
    lat, lng, category: orNull(json.primaryTypeDisplayName?.text), photoCount: json.photos ? json.photos.length : null,
    hasHours: json.regularOpeningHours !== undefined && json.regularOpeningHours !== null, reviews,
  };
}

/** Where `placeId` ranks on page one of a text search for `term` around a point: 1-based, or null when it is not there. Ids only, the cheap SKU. */
export async function rankAt(env: Env, o: { term: string; lat: number; lng: number; radiusM: number; placeId: string }, f: Fetcher = defaultFetch): Promise<number | null> {
  const json = (await call(env, f, SEARCH_URL, {
    method: "POST", mask: "places.id",
    body: { textQuery: o.term, languageCode: "en", locationBias: { circle: { center: { latitude: o.lat, longitude: o.lng }, radius: o.radiusM } } },
  }, PRICES.placesIdsPerRequest)) as { places?: { id?: string }[] };
  const i = (json.places ?? []).findIndex((p) => p.id === o.placeId);
  return i < 0 ? null : i + 1;
}
