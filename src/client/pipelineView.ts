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

/* ---------- The board (Pipeline page): columns, the header line and each card's status line ---------- */

/** What a card can also show when the full deal is at hand (`GET /api/deals` sends the whole deal). All optional, so a bare card still works. */
export interface DealCardExtra {
  options?: { id: "a" | "b" | "c"; label: string; recommended: boolean }[] | null;
  recommendedOptionId?: "a" | "b" | "c" | null;
  notes?: { callHeldAt: string | null } | null;
  recap?: { generatedAt: string } | null;
  lostReason?: string | null;
  closedAt?: string | null;
  createdAt?: string;
}
export type BoardDeal = DealCard & DealCardExtra;

/** The sidebar's `?stage=` filter: the whole board, proposals out, booked calls, or won and lost. */
export type BoardFilter = "all" | "proposal_sent" | "booked" | "closed";
export const boardFilterOf = (s: string | null): BoardFilter => (s === "proposal_sent" || s === "booked" || s === "closed" ? s : "all");
export const BOARD_FILTER_LABEL: Record<BoardFilter, string> = { all: "All stages", proposal_sent: "Proposals out", booked: "Booked calls", closed: "Won and lost" };

/** Column names on the board: short enough to sit on one line in a narrow column. */
export const BOARD_LABEL: Record<DealStage, string> = { ...STAGE_LABEL, discovery_done: "Call held", recommendation_booked: "Meeting booked" };

export type ColumnKey = DealStage | "won_month";
export interface BoardColumn { key: ColumnKey; label: string; deals: BoardDeal[]; totalCents: number }

const sameMonth = (iso: string | null | undefined, now: Date): boolean => {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
};
/** When a won deal was won: its close time, or its last update for an older row without one. */
const wonAt = (d: BoardDeal) => d.closedAt ?? d.updatedAt;

/**
 * The columns the board shows. The whole board: the five open stages, then "Won this month". Proposals out: that column alone. Booked calls: the two
 * stages with a call or meeting booked. Won and lost: every won deal and every lost deal. Each column carries the sum of its deals' values.
 */
export function boardColumns(deals: BoardDeal[], filter: BoardFilter, now: Date): BoardColumn[] {
  const col = (key: ColumnKey, label: string, list: BoardDeal[]): BoardColumn => ({ key, label, deals: list, totalCents: list.reduce((n, d) => n + (d.valueCents ?? 0), 0) });
  const of = (s: DealStage) => col(s, BOARD_LABEL[s], deals.filter((d) => d.stage === s));
  if (filter === "proposal_sent") return [of("proposal_sent")];
  if (filter === "booked") return [of("booked"), of("recommendation_booked")];
  if (filter === "closed") return [of("won"), of("lost")];
  const open = STAGE_ORDER.filter((s) => s !== "won" && s !== "lost").map(of);
  return [...open, col("won_month", "Won this month", deals.filter((d) => d.stage === "won" && sameMonth(wonAt(d), now)))];
}

/** "11 open deals · $40,367 · $7,126 won this month": the board's one-line summary. Values are each deal's first-year value. */
export function boardSummary(deals: BoardDeal[], now: Date, money: (cents: number) => string): string {
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const openCents = open.reduce((n, d) => n + (d.valueCents ?? 0), 0);
  const wonCents = deals.filter((d) => d.stage === "won" && sameMonth(wonAt(d), now)).reduce((n, d) => n + (d.valueCents ?? 0), 0);
  return [`${open.length} open ${open.length === 1 ? "deal" : "deals"}`, money(openCents), `${money(wonCents)} won this month`].join(" · ");
}

/** The package line on a card: the recommended option's name, or what is missing before there is one. */
export function cardPackage(d: Pick<BoardDeal, "stage" | "options" | "recommendedOptionId">): string {
  const opt = d.options?.find((o) => o.id === d.recommendedOptionId) ?? d.options?.find((o) => o.recommended);
  if (opt) return opt.label.trim() || `Option ${opt.id.toUpperCase()}`;
  return d.stage === "booked" ? "No package yet" : "No options yet";
}

/** What the board knows about a deal's proposal and booked call (loaded alongside the deals). */
export interface CardContext {
  booking?: { startAt: string; kind: "discovery" | "recommendation"; meetUrl: string | null } | null;
  proposal?: { sentAt: string | null; expiresAt: string | null; views: number; status: string; paidAt: string | null; signedAt: string | null } | null;
}
export type CardIcon = "calendar" | "eye" | "send" | "check" | "x" | "file-text" | "pen" | "alert" | "clock";
export interface CardStatus { icon: CardIcon; text: string; tone: "neutral" | "positive" | "warning" }

const DAY_MS = 86_400_000;
/** "Nov 15", or "today" / "yesterday" for the last two days. */
export function shortDay(iso: string, now: Date, tz?: string): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  const day = fmt(new Date(iso));
  if (day === fmt(now)) return "today";
  if (day === fmt(new Date(now.getTime() - DAY_MS))) return "yesterday";
  return day;
}
/** "Today 2:00 PM", "Thu 10:00 AM", "Dec 2 1:30 PM": when a booked call is. */
export function slotLabel(iso: string, now: Date, tz?: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const day = shortDay(iso, now, tz);
  if (day === "today") return `Today ${time}`;
  if (d.getTime() > now.getTime() && d.getTime() - now.getTime() < 6 * DAY_MS) return `${d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz })} ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })} ${time}`;
}

/** The one status line on a card, with its icon: what happened last, or what is waiting. A deal untouched for 7 days says so instead. */
export function cardStatus(d: BoardDeal, ctx: CardContext, now: Date, tz?: string): CardStatus {
  if (d.stage === "lost") return { icon: "x", text: d.lostReason ? `Lost: ${d.lostReason}` : "Lost", tone: "neutral" };
  if (d.stage === "won") {
    const p = ctx.proposal;
    if (p?.paidAt) return { icon: "check", text: `Deposit paid ${shortDay(p.paidAt, now, tz)}`, tone: "positive" };
    return { icon: "check", text: `Won ${shortDay(wonAt(d), now, tz)}`, tone: "positive" };
  }
  if (isStale(d, now)) return { icon: "alert", text: `No update since ${shortDay(d.updatedAt, now, tz)}`, tone: "warning" };
  const b = ctx.booking;
  if ((d.stage === "booked" || d.stage === "recommendation_booked") && b) {
    return { icon: "calendar", text: `${slotLabel(b.startAt, now, tz)}${b.meetUrl ? " · Google Meet" : ""}`, tone: "neutral" };
  }
  if (d.stage === "proposal_sent") {
    const p = ctx.proposal;
    if (p?.signedAt) return { icon: "pen", text: `Signed ${shortDay(p.signedAt, now, tz)} · deposit not paid yet`, tone: "neutral" };
    const expires = p?.expiresAt ? ` · expires ${shortDay(p.expiresAt, now, tz)}` : "";
    if (p && p.views > 0) return { icon: "eye", text: `Viewed ${p.views} ${p.views === 1 ? "time" : "times"}${expires}`, tone: "neutral" };
    if (p?.sentAt) return { icon: "send", text: `Sent ${shortDay(p.sentAt, now, tz)} · not opened`, tone: "neutral" };
    return { icon: "send", text: "Waiting for your approval to send", tone: "neutral" };
  }
  if (d.stage === "recommended") {
    const n = d.options?.length ?? 0;
    return { icon: "file-text", text: `${n} options presented · proposal not made`, tone: "neutral" };
  }
  if (d.stage === "recommendation_booked") return { icon: "calendar", text: "Meeting booked", tone: "neutral" };
  if (d.stage === "discovery_done") {
    if (d.recap) return { icon: "file-text", text: "Recap ready · offer two times", tone: "neutral" };
    const held = d.notes?.callHeldAt;
    return { icon: "pen", text: held ? `Call held ${shortDay(held, now, tz)} · recap not drafted` : "Recap not drafted", tone: "neutral" };
  }
  return { icon: "calendar", text: "Call booked", tone: "neutral" };
}
