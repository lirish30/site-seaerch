import type { Listing } from "../types";
import type { Fetcher } from "../crawler/crawl";
import { RetryableError, type ListingQuery, type ListingSource } from "./source";

export const BRIGHTDATA_PAGE_SIZE = 20;
const MAX_PAGES = 10;
const PLACE_ARRAYS = ["organic", "maps", "local_results", "places", "results"];

const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return null;
};
const str = (v: unknown) => (v === null ? null : String(v).trim() || null);
// Bright Data returns category as [{id, title}, ...]; take the primary (first) one.
const categoryOf = (v: unknown) => {
  const first = Array.isArray(v) ? v[0] : v;
  if (first && typeof first === "object") return str((first as Record<string, unknown>).title ?? null);
  return first === undefined ? null : str(first);
};
const num = (v: unknown) => {
  if (v === null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function mapBrightDataItem(o: Record<string, unknown>): Listing | null {
  const name = str(pick(o, ["title", "name", "business_name"]));
  if (!name) return null;
  let website = str(pick(o, ["website", "site", "link", "url", "domain"]));
  if (website && /(^|\.)google\.[a-z.]+\//i.test(website)) website = null;
  return {
    placeId: str(pick(o, ["place_id", "fid", "cid", "data_id", "feature_id"])),
    name,
    category: categoryOf(pick(o, ["category", "type", "main_category"])),
    address: str(pick(o, ["address", "full_address"])),
    phone: str(pick(o, ["phone", "phone_number"])),
    websiteUrl: website,
    mapsUrl: str(pick(o, ["map_link", "maps_url", "map_url", "google_maps_url"])),
    rating: num(pick(o, ["rating", "stars"])),
    reviewCount: num(pick(o, ["reviews_cnt", "reviews_count", "review_count", "reviews"])),
  };
}

function itemsOf(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  for (const k of PLACE_ARRAYS) if (Array.isArray((json as Record<string, unknown>)[k])) {
    return (json as Record<string, unknown>)[k] as Record<string, unknown>[];
  }
  return [];
}

export class BrightDataListingSource implements ListingSource {
  constructor(private o: { apiKey: string; zone: string; fetch: Fetcher }) {}

  async search(q: ListingQuery) {
    const seen = new Set<string>();
    const listings: Listing[] = [];
    let requests = 0;
    const term = encodeURIComponent(`${q.businessType} in ${q.location}`);
    for (let p = 0; p < MAX_PAGES && listings.length < q.maxResults; p++) {
      const url = `https://www.google.com/maps/search/${term}/?brd_json=1&gl=us&hl=en${p ? `&start=${p * BRIGHTDATA_PAGE_SIZE}` : ""}`;
      const res = await this.o.fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ zone: this.o.zone, url, format: "raw" }),
      });
      requests++;
      if (!res.ok) {
        const msg = `Bright Data HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        throw res.status === 429 || res.status >= 500 ? new RetryableError(msg) : new Error(msg);
      }
      const items = itemsOf(await res.json());
      if (!items.length) break;
      let added = 0;
      for (const it of items) {
        const l = mapBrightDataItem(it);
        if (!l) continue;
        const key = l.placeId ?? `${l.name}|${l.address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        listings.push(l);
        added++;
        if (listings.length >= q.maxResults) break;
      }
      if (!added) break;
    }
    return { listings, requests };
  }
}
