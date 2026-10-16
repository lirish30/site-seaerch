import { describe, it, expect } from "vitest";
import { GooglePlacesListingSource, PLACES_PAGE_SIZE } from "../src/worker/listings/places";
import { FallbackListingSource } from "../src/worker/listings/fallback";
import { RateLimitedError, RetryableError, isRateLimited, isRetryable, type ListingSource } from "../src/worker/listings/source";

const place = (id: string, extra: Record<string, unknown> = {}) => ({ id, displayName: { text: `Biz ${id}`, languageCode: "en" }, ...extra });
const q = { location: "Portland, OR", businessType: "plumber", radiusKm: 15, maxResults: 50 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; headers: Record<string, string>; body: any };
const recording = (pages: Response[]) => {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
    return pages[calls.length - 1];
  };
  return { calls, fetch };
};

describe("GooglePlacesListingSource", () => {
  it("maps a place to a Listing and sends the key, field mask and text query", async () => {
    const { calls, fetch } = recording([json({ places: [place("ChIJabc", {
      primaryTypeDisplayName: { text: "Plumber", languageCode: "en" }, formattedAddress: "1 Main St, Portland, OR 97201, USA",
      nationalPhoneNumber: "(503) 555-0134", websiteUri: "https://aceplumbing.com/", googleMapsUri: "https://maps.google.com/?cid=1",
      rating: 4.6, userRatingCount: 132 })] })]);
    const r = await new GooglePlacesListingSource({ apiKey: "KEY", fetch }).search({ ...q, maxResults: 5 });
    expect(r.provider).toBe("places");
    expect(r.requests).toBe(1);
    expect(r.listings).toEqual([{ placeId: "ChIJabc", name: "Biz ChIJabc", category: "Plumber", address: "1 Main St, Portland, OR 97201, USA",
      phone: "(503) 555-0134", websiteUrl: "https://aceplumbing.com/", mapsUrl: "https://maps.google.com/?cid=1", rating: 4.6, reviewCount: 132 }]);
    expect(calls[0].url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(calls[0].headers["x-goog-api-key"]).toBe("KEY");
    expect(calls[0].headers["x-goog-fieldmask"]).toContain("places.websiteUri");
    expect(calls[0].headers["x-goog-fieldmask"]).toContain("nextPageToken");
    expect(calls[0].body).toMatchObject({ textQuery: "plumber in Portland, OR", pageSize: 5 });
  });

  it("missing optional fields become null", async () => {
    const { fetch } = recording([json({ places: [place("ChIJ1")] })]);
    const r = await new GooglePlacesListingSource({ apiKey: "K", fetch }).search(q);
    expect(r.listings[0]).toMatchObject({ category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null });
  });

  it("follows nextPageToken with identical params until maxResults, dedupes, and stops when there is no token", async () => {
    const { calls, fetch } = recording([
      json({ places: [place("A"), place("B")], nextPageToken: "T1" }),
      json({ places: [place("B"), place("C")], nextPageToken: "T2" }),
      json({ places: [place("D")] }),
    ]);
    const r = await new GooglePlacesListingSource({ apiKey: "K", fetch }).search(q);
    expect(r.listings.map((l) => l.placeId)).toEqual(["A", "B", "C", "D"]);
    expect(r.requests).toBe(3);
    expect(calls[0].body.pageToken).toBeUndefined();
    expect(calls[1].body).toEqual({ ...calls[0].body, pageToken: "T1" });
    expect(calls[2].body.pageToken).toBe("T2");
  });

  it("asks for at most PLACES_PAGE_SIZE per page and stops once it has maxResults", async () => {
    const { calls, fetch } = recording([json({ places: Array.from({ length: 20 }, (_, i) => place(`P${i}`)), nextPageToken: "T" }), json({ places: [place("X")] })]);
    const r = await new GooglePlacesListingSource({ apiKey: "K", fetch }).search({ ...q, maxResults: 20 });
    expect(PLACES_PAGE_SIZE).toBe(20);
    expect(calls[0].body.pageSize).toBe(20);
    expect(r.listings).toHaveLength(20);
    expect(calls).toHaveLength(1);
  });

  it("no results is an empty list, not an error", async () => {
    const { fetch } = recording([json({})]);
    expect(await new GooglePlacesListingSource({ apiKey: "K", fetch }).search(q)).toMatchObject({ listings: [], requests: 1 });
  });

  it("a failure on a later page keeps the listings already fetched", async () => {
    const { fetch } = recording([json({ places: [place("A")], nextPageToken: "T" }), json({ error: { message: "boom" } }, 503)]);
    const r = await new GooglePlacesListingSource({ apiKey: "K", fetch }).search(q);
    expect(r.listings.map((l) => l.placeId)).toEqual(["A"]);
  });

  it("429 → rate limited; 5xx → retryable; 4xx → permanent, with Google's message", async () => {
    const run = (status: number, message: string) => new GooglePlacesListingSource({ apiKey: "K", fetch: async () => json({ error: { code: status, message, status: "X" } }, status) }).search(q).catch((e) => e);
    const limited = await run(429, "Quota exceeded");
    expect(isRateLimited(limited)).toBe(true); expect(isRetryable(limited)).toBe(true);
    const down = await run(503, "unavailable");
    expect(isRetryable(down)).toBe(true); expect(isRateLimited(down)).toBe(false);
    const denied = await run(403, "Places API (New) has not been used in project 123 before or it is disabled.");
    expect(isRetryable(denied)).toBe(false);
    expect(denied.message).toContain("403");
    expect(denied.message).toContain("has not been used in project");
  });

  it("a hung request is aborted as a retryable timeout", async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)));
    const err = await new GooglePlacesListingSource({ apiKey: "K", fetch: hang, requestTimeoutMs: 20 }).search(q).catch((e) => e);
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toMatch(/timed out/i);
  });
});

describe("FallbackListingSource", () => {
  const ok = (provider: "places" | "brightdata"): ListingSource => ({ search: async () => ({ listings: [], requests: 2, provider }) });
  const failing = (e: Error): ListingSource => ({ search: async () => { throw e; } });

  it("uses the first source when it works", async () => {
    expect((await new FallbackListingSource([ok("places"), failing(new Error("never"))]).search(q)).provider).toBe("places");
  });

  it("falls back when the first fails, whatever the error, and reports the fallback's provider", async () => {
    for (const e of [new Error("403 denied"), new RetryableError("503"), new RateLimitedError("429")]) {
      expect((await new FallbackListingSource([failing(e), ok("brightdata")]).search(q)).provider).toBe("brightdata");
    }
  });

  it("when every source fails, throws the last error (so its retry semantics apply) and names the earlier failure", async () => {
    const err = await new FallbackListingSource([failing(new Error("Google Places HTTP 403: disabled")), failing(new RetryableError("Bright Data HTTP 502"))]).search(q).catch((e) => e);
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toContain("Bright Data HTTP 502");
    expect(err.message).toContain("Google Places HTTP 403");
  });
});
