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

/** A transient listing-provider failure (HTTP 429/5xx) that a step retry may fix. */
export class RetryableError extends Error {
  readonly retryable = true;
}
export const isRetryable = (e: unknown): boolean => (e as { retryable?: unknown } | null)?.retryable === true;
