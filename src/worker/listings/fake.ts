import type { Listing } from "../types";
import type { ListingQuery, ListingSource } from "./source";

export class FakeListingSource implements ListingSource {
  constructor(private result: Listing[] | Error) {}

  async search(q: ListingQuery) {
    if (this.result instanceof Error) throw this.result;
    return { listings: this.result.slice(0, q.maxResults), requests: 1 };
  }
}
