import type { Listing } from "../types";
import type { Fetcher } from "../crawler/crawl";

export interface ListingQuery {
  location: string;
  businessType: string;
  radiusKm: number;
  maxResults: number;
}

/** Which provider served a search: its usage is recorded and priced under this name. Omitted means Bright Data. */
export type ListingProvider = "brightdata" | "places";

export interface ListingSource {
  search(q: ListingQuery): Promise<{ listings: Listing[]; requests: number; provider?: ListingProvider }>;
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

// A provider can hold a connection open for minutes before giving up. Without a per-request limit the workflow step hits its
// own timeout, which the engine enforces from outside the step, so no failure is recorded and the progress card just spins.
export const REQUEST_TIMEOUT_MS = 45_000;
// Once a search has used this long, stop paging and keep what it has, well inside the step timeout.
export const SEARCH_DEADLINE_MS = 120_000;

/** One POST with a timeout that also covers reading the body. A timeout is retryable; any other failure passes through. */
export async function fetchWithTimeout(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number, label: string) {
  try {
    const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { res, body: await res.text() };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new RetryableError(`${label} request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  }
}
