import type { CroStage } from "./types";

export type CroModelId = "claude-haiku-5-5" | "claude-sonnet-5-5";
// Per-stage model. Haiku by default; a stage moves to Sonnet 5.5 only where scripts/cro-eval.ts shows Haiku falls short.
export const CRO_MODELS: Record<CroStage, CroModelId> = { model: "claude-haiku-5-5", pages: "claude-haiku-5-5", synthesize: "claude-haiku-5-5" };
// Thinking depth per stage. Classifying the business is simple; reading pages and writing the roadmap are judgement calls.
export type CroEffort = "low" | "medium" | "high";
export const CRO_EFFORT: Record<CroStage, CroEffort> = { model: "low", pages: "medium", synthesize: "high" };

/** USD per million tokens. `long` is the rate when the whole prompt (uncached + cached) exceeds `longOver` tokens. */
export const MODEL_PRICES: Record<CroModelId, { in: number; out: number; longOver?: number; long?: { in: number; out: number } }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5, longOver: 100_000, long: { in: 0.5, out: 2.5 } },
  "claude-sonnet-5-5": { in: 2, out: 10 },
};

export const CRO_LIMITS = {
  maxPages: 7, maxItems: 25, topItems: 5,
  navTimeoutMs: 25_000, flowTimeoutMs: 15_000,
  staleRunningMs: 30 * 60 * 1000,
  textCap: 50_000, shotMaxHeight: 6000, desktopTopHeight: 1800, mobileTopHeight: 1600,
  retryDropShare: 0.4, minItems: 3,
};

export const CRO_DESKTOP = { width: 1440, height: 900 };
export const CRO_MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
