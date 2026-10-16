import type { ListingQuery, ListingSource } from "./source";

/**
 * Tries each source in order and returns the first that works. Any failure moves on to the next, because a source being
 * down, unconfigured or over quota says nothing about the others. If the last one fails too, its error is the one thrown
 * (so its retry/rate-limit semantics decide what the workflow does), with the earlier failures named in the message.
 */
export class FallbackListingSource implements ListingSource {
  constructor(private sources: ListingSource[]) {}

  async search(q: ListingQuery) {
    const earlier: string[] = [];
    for (const [i, source] of this.sources.entries()) {
      try {
        return await source.search(q);
      } catch (e) {
        if (i < this.sources.length - 1) { earlier.push(String((e as Error)?.message ?? e)); continue; }
        if (earlier.length && e instanceof Error) e.message = `${e.message} (earlier source failed: ${earlier.join("; ")})`;
        throw e;
      }
    }
    throw new Error("No listing source configured");
  }
}
