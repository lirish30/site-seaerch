import type { Search } from "./types";

// Mirrors the worker's pacing (src/worker/pipeline/search.ts): leads start in batches of 5,
// 20s apart. FETCH and per-batch work times are rough guesses until measured pace is available.
const FETCH_S = 60;
const BATCH_SIZE = 5;
const BATCH_GAP_S = 20;
const BATCH_WORK_S = 15;
const MEASURE_AFTER = 10; // leads processed before trusting measured pace

export type Stage = "fetching" | "auditing" | "done" | "failed";

export function searchStage(s: Search): Stage {
  if (s.status === "failed") return "failed";
  if (s.status === "running" && s.found_count === 0) return "fetching";
  if (s.processed_count >= s.found_count && s.status === "done") return "done";
  return "auditing";
}

function auditSeconds(leads: number): number {
  const batches = Math.ceil(leads / BATCH_SIZE);
  return batches * BATCH_WORK_S + Math.max(0, batches - 1) * BATCH_GAP_S;
}

export function elapsedSeconds(createdAt: string, nowMs: number): number {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : 0;
}

/** Rough seconds until the search finishes, or null when it is finished/failed. */
export function estimateRemainingSeconds(s: Search, nowMs: number): number | null {
  const stage = searchStage(s);
  if (stage === "done" || stage === "failed") return null;
  const elapsed = elapsedSeconds(s.created_at, nowMs);
  if (stage === "fetching") {
    const fetchLeft = Math.max(15, FETCH_S - elapsed);
    return fetchLeft + auditSeconds(s.max_results);
  }
  const left = Math.max(0, s.found_count - s.processed_count);
  if (s.processed_count >= MEASURE_AFTER) {
    const perLead = Math.max(0, elapsed - FETCH_S) / s.processed_count;
    return Math.round(left * perLead);
  }
  return auditSeconds(left);
}

export function formatClock(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return "under a minute";
  return `about ${Math.round(seconds / 60)} min`;
}

/** Pre-submit estimate for N types at M results each (searches run in parallel on the worker). */
export function estimateNewSearchSeconds(maxResults: number): number {
  return FETCH_S + auditSeconds(maxResults);
}
