import type { Listing } from "../types";

export interface ListingQuery {
  location: string;
  businessType: string;
  radiusKm: number;
  maxResults: number;
}

export interface ListingSource {
  search(q: ListingQuery): Promise<{ listings: Listing[]; requests: number }>;
}
