import { STAGE_ORDER, type DealStage } from "../worker/db/deals";

export type { DealStage };

/** What a card on the board needs from a deal (the shape `GET /api/deals` returns, less what the board never shows). */
export interface DealCard { id: string; businessId: string; businessName: string; stage: DealStage; valueCents: number | null; updatedAt: string }

export const STAGE_LABEL: Record<DealStage, string> = {
  booked: "Call booked", discovery_done: "Discovery done", recommendation_booked: "Recommendation booked",
  recommended: "Recommended", proposal_sent: "Proposal sent", won: "Won", lost: "Lost",
};

/** One column per stage, in pipeline order, empty ones included so the board never changes shape. Cards keep the order they arrive in. */
export function groupByStage(deals: DealCard[]): { stage: DealStage; deals: DealCard[] }[] {
  return STAGE_ORDER.map((stage) => ({ stage, deals: deals.filter((d) => d.stage === stage) }));
}

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** An open deal nobody has touched for 7 days. Won and lost deals are finished, so they are never stale. */
export function isStale(deal: Pick<DealCard, "stage" | "updatedAt">, now: Date): boolean {
  if (deal.stage === "won" || deal.stage === "lost") return false;
  const at = Date.parse(deal.updatedAt);
  return Number.isFinite(at) && now.getTime() - at >= STALE_AFTER_MS;
}

/** Where a card on the board goes: the deal's own page. */
export const dealHref = (d: Pick<DealCard, "id">): string => `/deals/${d.id}`;
