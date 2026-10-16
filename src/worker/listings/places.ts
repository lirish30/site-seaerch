import type { Listing } from "../types";
import type { Fetcher } from "../crawler/crawl";
import { RateLimitedError, RetryableError, REQUEST_TIMEOUT_MS, SEARCH_DEADLINE_MS, fetchWithTimeout, type ListingQuery, type ListingSource } from "./source";

export const PLACES_PAGE_SIZE = 20;
const MAX_PAGES = 3; // Google caps a text search at 60 results in total
const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
// Phone, website and rating put the request in the Enterprise SKU; that is what the audit needs, so ask for them all.
const FIELD_MASK = [
  "places.id", "places.displayName", "places.primaryTypeDisplayName", "places.formattedAddress", "places.nationalPhoneNumber",
  "places.websiteUri", "places.googleMapsUri", "places.rating", "places.userRatingCount", "nextPageToken",
].join(",");

interface Place {
  id?: string; displayName?: { text?: string }; primaryTypeDisplayName?: { text?: string }; formattedAddress?: string;
  nationalPhoneNumber?: string; websiteUri?: string; googleMapsUri?: string; rating?: number; userRatingCount?: number;
}

const orNull = <T>(v: T | undefined): T | null => (v === undefined || v === "" ? null : v);

export function mapPlace(p: Place): Listing | null {
  const name = p.displayName?.text?.trim();
  if (!name) return null;
  return {
    placeId: orNull(p.id), name, category: orNull(p.primaryTypeDisplayName?.text), address: orNull(p.formattedAddress),
    phone: orNull(p.nationalPhoneNumber), websiteUrl: orNull(p.websiteUri), mapsUrl: orNull(p.googleMapsUri),
    rating: orNull(p.rating), reviewCount: orNull(p.userRatingCount),
  };
}

/** Google Places API (New) Text Search: Google's own API rather than a scrape, so it is not blocked or throttled like one. */
export class GooglePlacesListingSource implements ListingSource {
  constructor(private o: { apiKey: string; fetch: Fetcher; requestTimeoutMs?: number; deadlineMs?: number }) {}

  async search(q: ListingQuery) {
    const seen = new Set<string>();
    const listings: Listing[] = [];
    let requests = 0;
    let pageToken: string | undefined;
    const timeoutMs = this.o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const startedAt = Date.now();
    // Every page after the first must repeat the first request's parameters, so pageSize is fixed for the whole search.
    const base = { textQuery: `${q.businessType} in ${q.location}`, pageSize: Math.max(1, Math.min(PLACES_PAGE_SIZE, q.maxResults)), regionCode: "US", languageCode: "en" };
    for (let p = 0; p < MAX_PAGES && listings.length < q.maxResults; p++) {
      if (p > 0 && Date.now() - startedAt >= (this.o.deadlineMs ?? SEARCH_DEADLINE_MS)) break;
      try {
        requests++;
        const { res, body } = await fetchWithTimeout(this.o.fetch, ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.o.apiKey, "x-goog-fieldmask": FIELD_MASK },
          body: JSON.stringify(pageToken ? { ...base, pageToken } : base),
        }, timeoutMs, "Google Places");
        if (!res.ok) {
          let detail = body.slice(0, 200);
          try { detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* not JSON: keep the raw text */ }
          const msg = `Google Places HTTP ${res.status}: ${detail || "no body"}`;
          throw res.status === 429 ? new RateLimitedError(msg) : res.status >= 500 ? new RetryableError(msg) : new Error(msg);
        }
        let json: { places?: Place[]; nextPageToken?: string };
        try { json = JSON.parse(body); } catch { throw new RetryableError(`Google Places returned non-JSON: ${body.slice(0, 200)}`); }
        for (const place of json.places ?? []) {
          const l = mapPlace(place);
          if (!l) continue;
          const key = l.placeId ?? `${l.name}|${l.address}`;
          if (seen.has(key)) continue;
          seen.add(key);
          listings.push(l);
          if (listings.length >= q.maxResults) break;
        }
        pageToken = json.nextPageToken;
      } catch (e) {
        if (listings.length) break; // a later page failed: keep what the earlier pages found rather than pay for it twice
        throw e;
      }
      if (!pageToken) break;
    }
    return { listings, requests, provider: "places" as const };
  }
}
