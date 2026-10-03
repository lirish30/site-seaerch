import { describe, it, expect } from "vitest";
import { BrightDataListingSource, mapBrightDataItem } from "../src/worker/listings/brightdata";
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
});
