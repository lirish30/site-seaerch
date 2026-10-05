import { describe, it, expect } from "vitest";
import { BrightDataListingSource, mapBrightDataItem } from "../src/worker/listings/brightdata";
import { isRetryable } from "../src/worker/listings/source";
import fixture from "./fixtures/brightdata-maps.json";

describe("mapBrightDataItem", () => {
  it("maps common alias fields", () => {
    expect(mapBrightDataItem({
      title: "Ace Plumbing", category: "Plumber", address: "1 Main St, Boise, ID", phone: "(208) 555-0134",
      link: "https://aceplumbing.com/", rating: "4.6", reviews_cnt: 132, fid: "0x123:0x456",
      map_link: "https://maps.google.com/?cid=1",
    })).toEqual({
      placeId: "0x123:0x456", name: "Ace Plumbing", category: "Plumber", address: "1 Main St, Boise, ID",
      phone: "(208) 555-0134", websiteUrl: "https://aceplumbing.com/", mapsUrl: "https://maps.google.com/?cid=1",
      rating: 4.6, reviewCount: 132,
    });
  });

  it("returns null when no name", () => {
    expect(mapBrightDataItem({ address: "x" })).toBeNull();
  });

  it("ignores google.com links as websites", () => {
    expect(mapBrightDataItem({ title: "A", link: "https://www.google.com/maps/place/x" })!.websiteUrl).toBeNull();
  });
});

describe("BrightDataListingSource", () => {
  it("every listing parsed from the captured fixture has a name", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => Response.json(fixture) });
    const { listings } = await src.search({ location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 20 });
    expect(listings.length).toBeGreaterThan(0);
    for (const l of listings) expect(l.name.length).toBeGreaterThan(0);
  });

  it("maps the live-captured response shape (category is an array of {id,title})", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => Response.json(fixture) });
    const { listings } = await src.search({ location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 20 });
    expect(listings[0]).toMatchObject({
      name: "Perfect Plumbing Heating & Air",
      category: "Plumber",
      address: "109 W 44th St, Garden City, ID 83714",
      phone: "+12082311936",
      rating: 4.8,
      reviewCount: 5649,
      placeId: "0x54aeff4cb0b24461:0x23720b81e2bed658",
    });
    expect(listings[0].websiteUrl).toMatch(/^https:\/\/perfectplumbingheatingair\.com\//);
    for (const l of listings) expect(l.category).not.toMatch(/\[object/);
  });

  it("pages until maxResults, dedupes, stops on empty page, counts requests", async () => {
    const calls: string[] = [];
    const page = (ids: string[]) => ({ organic: ids.map((id) => ({ title: `B${id}`, fid: id })) });
    const pages = [page(["1", "2"]), page(["2", "3"]), page([])];
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async (_u, init) => {
      calls.push(JSON.parse(init!.body as string).url); return Response.json(pages[calls.length - 1]);
    } });
    const r = await src.search({ location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 50 });
    expect(r.listings.map((l) => l.placeId)).toEqual(["1", "2", "3"]);
    expect(r.requests).toBe(3);
    expect(calls[0]).toContain("/maps/search/plumber%20in%20Boise%2C%20ID");
    expect(calls[0]).toContain("brd_json=1");
    expect(calls[1]).toContain("start=20");
  });

  it("throws with status on HTTP error", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => new Response("bad zone", { status: 401 }) });
    await expect(src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 })).rejects.toThrow(/401/);
  });

  it.each([429, 500, 503])("HTTP %i → retryable error", async (status) => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => new Response("busy", { status }) });
    const err = await src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(String(status));
    expect(isRetryable(err)).toBe(true);
  });

  // Live-captured: Bright Data reports an upstream Google Maps failure as HTTP 200 + empty body, with the real
  // status in x-brd-status-code. Previously res.json() threw "Unexpected end of JSON input" (not retryable).
  it("HTTP 200 with x-brd-status-code 502 and empty body → retryable error naming the Bright Data error", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () =>
      new Response("", { status: 200, headers: { "x-brd-status-code": "502", "x-brd-error-code": "maps_ajax_failed", "x-brd-error": "Significant request was rejected" } }) });
    const err = await src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 }).catch((e) => e);
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toContain("502");
    expect(err.message).toContain("maps_ajax_failed");
    expect(err.message).not.toMatch(/JSON/);
  });

  it("HTTP 200 with an empty body and no error headers → retryable error, not a JSON SyntaxError", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => new Response("", { status: 200 }) });
    const err = await src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 }).catch((e) => e);
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toMatch(/empty/i);
  });

  it("HTTP 200 with x-brd-status-code 4xx (not 429) → non-retryable error", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () =>
      new Response("", { status: 200, headers: { "x-brd-status-code": "403", "x-brd-error-code": "blocked" } }) });
    const err = await src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 }).catch((e) => e);
    expect(err.message).toContain("403");
    expect(isRetryable(err)).toBe(false);
  });

  it("HTTP 200 with a non-JSON body → readable, retryable error", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => new Response("<html>oops</html>", { status: 200 }) });
    const err = await src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 }).catch((e) => e);
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toContain("<html>oops");
  });

  it("HTTP 4xx (not 429) → non-retryable error", async () => {
    const src = new BrightDataListingSource({ apiKey: "K", zone: "Z", fetch: async () => new Response("bad zone", { status: 401 }) });
    const err = await src.search({ location: "x", businessType: "y", radiusKm: 1, maxResults: 5 }).catch((e) => e);
    expect(isRetryable(err)).toBe(false);
  });
});
