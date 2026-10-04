import type { CroStage } from "./types";

export type CroModelId = "claude-haiku-4-5" | "claude-sonnet-5-5";
// Per-stage model. Haiku by default; a stage moves to Sonnet 5.5 only where scripts/cro-eval.ts shows Haiku falls short.
export const CRO_MODELS: Record<CroStage, CroModelId> = { model: "claude-haiku-4-5", pages: "claude-haiku-4-5", synthesize: "claude-haiku-4-5" };

/** USD per million tokens. */
export const MODEL_PRICES: Record<CroModelId, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
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
