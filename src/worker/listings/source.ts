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
/**
 * HTTP 429 (Bright Data's bucket_rate_limit): the account is being throttled, so retrying 30s later just hits the same
 * wall. The search workflow waits minutes between rounds instead (RATE_LIMIT_WAITS_MS in pipeline/search.ts).
 */
export class RateLimitedError extends RetryableError {
  readonly rateLimited = true;
}
export const isRateLimited = (e: unknown): boolean => (e as { rateLimited?: unknown } | null)?.rateLimited === true;
export const isRetryable = (e: unknown): boolean => (e as { retryable?: unknown } | null)?.retryable === true;
