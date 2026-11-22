import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRICES } from "../src/worker/cost";
import type { Env } from "../src/worker/env";
import { findPlaces, placeDetails, rankAt, PlacesError, PlacesNotConfigured } from "../src/worker/seo/places";

const KEY = "AIza-SECRET-KEY-123";
const e = { ...env, GOOGLE_PLACES_API_KEY: KEY } as Env;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function stub(responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return responses[calls.length - 1];
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const thrown = async (p: Promise<unknown>): Promise<PlacesError> => { try { await p; } catch (x) { return x as PlacesError; } throw new Error("expected a rejection"); };
const usage = async () => (await env.DB.prepare(`SELECT units, est_cost_usd FROM usage WHERE service = 'places' ORDER BY created_at, rowid`).all<{ units: number; est_cost_usd: number }>()).results;
afterEach(() => vi.unstubAllGlobals());

const place = (id: string) => ({ id, displayName: { text: `Biz ${id}` }, formattedAddress: `${id} Main St`, googleMapsUri: `https://maps.google.com/?cid=${id}`, rating: 4.5, userRatingCount: 10 });

describe("findPlaces", () => {
  it("sends the key and a field mask with places.id, returns at most 5, and records one usage row", async () => {
    const before = (await usage()).length;
    const calls = stub([json({ places: ["a", "b", "c", "d", "e", "f", "g"].map(place) })]);
    const r = await findPlaces(e, { name: "Ace Plumbing", address: "1 Main St, Portland, OR" });
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual({ id: "a", name: "Biz a", address: "a Main St", mapsUrl: "https://maps.google.com/?cid=a", rating: 4.5, reviewCount: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-goog-api-key"]).toBe(KEY);
    expect(calls[0].headers["x-goog-fieldmask"].split(",")).toContain("places.id");
    expect(calls[0].body.textQuery).toContain("Ace Plumbing");
    expect(calls[0].body.textQuery).toContain("1 Main St, Portland, OR");
    const rows = (await usage()).slice(before);
    expect(rows).toEqual([{ units: 1, est_cost_usd: PRICES.placesPerRequest }]);
  });

  it("returns nothing when Google finds nothing", async () => {
    stub([json({})]);
    expect(await findPlaces(e, { name: "x", address: "y" })).toEqual([]);
  });
});

describe("placeDetails", () => {
  const review = (n: number) => ({ name: `places/ChIJabc/reviews/R${n}`, rating: n, text: { text: `text ${n}` }, authorAttribution: { displayName: `Author ${n}` }, publishTime: `2026-0${n}-01T00:00:00Z` });
  const body = {
    id: "ChIJabc", displayName: { text: "Ace Plumbing" }, formattedAddress: "1 Main St, Portland, OR 97201, USA",
    nationalPhoneNumber: "(503) 555-0134", websiteUri: "https://aceplumbing.com/", googleMapsUri: "https://maps.google.com/?cid=1",
    rating: 4.6, userRatingCount: 132, location: { latitude: 45.52, longitude: -122.68 }, primaryTypeDisplayName: { text: "Plumber" },
    photos: [{}, {}, {}], regularOpeningHours: { weekdayDescriptions: ["Monday: 8-5"] }, reviews: [1, 2, 3, 4, 5].map(review),
  };

  it("maps the place, its photos, hours and five reviews, and records one details usage row", async () => {
    const before = (await usage()).length;
    const calls = stub([json(body)]);
    const d = await placeDetails(e, "ChIJabc");
    expect(calls[0].url).toBe("https://places.googleapis.com/v1/places/ChIJabc");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers["x-goog-api-key"]).toBe(KEY);
    expect(d).toMatchObject({
      id: "ChIJabc", name: "Ace Plumbing", address: "1 Main St, Portland, OR 97201, USA", phone: "(503) 555-0134", website: "https://aceplumbing.com/",
      mapsUrl: "https://maps.google.com/?cid=1", rating: 4.6, reviewCount: 132, lat: 45.52, lng: -122.68, category: "Plumber", photoCount: 3, hasHours: true,
    });
    expect(d!.reviews).toHaveLength(5);
    expect(d!.reviews[2]).toEqual({ externalId: "places/ChIJabc/reviews/R3", rating: 3, author: "Author 3", text: "text 3", publishedAt: "2026-03-01T00:00:00Z" });
    expect((await usage()).slice(before)).toEqual([{ units: 1, est_cost_usd: PRICES.placesDetailsPerRequest }]);
  });

  it("reports no hours, no photos data and missing optional fields as such", async () => {
    stub([json({ id: "p", displayName: { text: "Bare" }, formattedAddress: "x", location: { latitude: 1, longitude: 2 } })]);
    const d = await placeDetails(e, "p");
    expect(d).toMatchObject({ phone: null, website: null, mapsUrl: null, rating: null, reviewCount: null, category: null, photoCount: null, hasHours: false, reviews: [] });
  });

  it("gives null on a 404", async () => {
    stub([json({ error: { message: "not found" } }, 404)]);
    expect(await placeDetails(e, "gone")).toBeNull();
  });
});

describe("rankAt", () => {
  const o = { term: "plumber", lat: 45.5, lng: -122.6, radiusM: 3000, placeId: "mine" };

  it("returns the 1-based position and asks for ids only with a circle bias", async () => {
    const before = (await usage()).length;
    const calls = stub([json({ places: [{ id: "x" }, { id: "y" }, { id: "mine" }, { id: "z" }] })]);
    expect(await rankAt(e, o)).toBe(3);
    expect(calls[0].headers["x-goog-fieldmask"]).toBe("places.id");
    expect(calls[0].body.textQuery).toBe("plumber");
    expect(calls[0].body.locationBias).toEqual({ circle: { center: { latitude: 45.5, longitude: -122.6 }, radius: 3000 } });
    expect((await usage()).slice(before)).toEqual([{ units: 1, est_cost_usd: PRICES.placesIdsPerRequest }]);
  });

  it("returns null when the place is not on page one", async () => {
    stub([json({ places: [{ id: "x" }] })]);
    expect(await rankAt(e, o)).toBeNull();
  });

  it("returns null when Google returns no places", async () => {
    stub([json({})]);
    expect(await rankAt(e, o)).toBeNull();
  });
});

describe("errors", () => {
  it("a 429 and a 5xx are retryable PlacesErrors; any other failure is not", async () => {
    stub([json({ error: { message: "slow down" } }, 429)]);
    await expect(rankAt(e, { term: "t", lat: 0, lng: 0, radiusM: 1, placeId: "p" })).rejects.toMatchObject({ name: "PlacesError", retryable: true });
    stub([json({}, 503)]);
    await expect(findPlaces(e, { name: "a", address: "b" })).rejects.toMatchObject({ retryable: true });
    stub([json({ error: { message: "bad" } }, 400)]);
    const err = await thrown(placeDetails(e, "p"));
    expect(err).toBeInstanceOf(PlacesError);
    expect(err.retryable).toBe(false);
  });

  it("records no usage when the call fails", async () => {
    const before = (await usage()).length;
    stub([json({}, 400)]);
    await findPlaces(e, { name: "a", address: "b" }).catch(() => undefined);
    expect((await usage()).length).toBe(before);
  });

  it("a network failure is a retryable PlacesError", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("connection reset"); });
    await expect(findPlaces(e, { name: "a", address: "b" })).rejects.toMatchObject({ name: "PlacesError", retryable: true });
  });

  it("an unset key throws PlacesNotConfigured and makes no request", async () => {
    const calls = stub([json({})]);
    const bare = { ...env, GOOGLE_PLACES_API_KEY: undefined } as Env;
    await expect(findPlaces(bare, { name: "a", address: "b" })).rejects.toBeInstanceOf(PlacesNotConfigured);
    await expect(placeDetails(bare, "p")).rejects.toBeInstanceOf(PlacesNotConfigured);
    await expect(rankAt(bare, { term: "t", lat: 0, lng: 0, radiusM: 1, placeId: "p" })).rejects.toBeInstanceOf(PlacesNotConfigured);
    expect(calls).toHaveLength(0);
  });

  it("never puts the key in a thrown message, even when Google echoes it", async () => {
    for (const status of [400, 429, 500]) {
      stub([json({ error: { message: `API key ${KEY} is invalid` } }, status)]);
      const err = await thrown(findPlaces(e, { name: "a", address: "b" }));
      expect(err).toBeInstanceOf(PlacesError);
      expect(String(err.message)).not.toContain(KEY);
    }
  });
});
