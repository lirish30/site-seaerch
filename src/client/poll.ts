import type { Search } from "./types";

const DELAYS = [4000, 8000, 15000];

/** Poll interval: 4s when healthy, backing off to 8s then 15s (cap) after consecutive failures. */
export function pollDelay(consecutiveFailures: number): number {
  return DELAYS[Math.min(Math.max(0, consecutiveFailures), DELAYS.length - 1)];
}

export function searchFinished(s: Search): boolean {
  return s.status === "failed" || (s.status === "done" && s.processed_count >= s.found_count);
}
