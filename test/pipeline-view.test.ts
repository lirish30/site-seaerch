import { describe, expect, it } from "vitest";
import { STAGE_ORDER } from "../src/worker/db/deals";
import { boardColumns, boardFilterOf, boardSummary, cardPackage, cardStatus, groupByStage, isStale, STAGE_LABEL, type BoardDeal, type DealCard } from "../src/client/pipelineView";

const card = (o: Partial<DealCard> = {}): DealCard => ({
  id: "d1", businessId: "b1", businessName: "Ace Plumbing", stage: "booked", valueCents: null, updatedAt: "2026-11-10T12:00:00.000Z", ...o,
});

describe("groupByStage", () => {
  it("keeps every stage column, even empty ones", () => {
    const cols = groupByStage([card({ id: "a", stage: "recommended" })]);
    expect(cols.map((c) => c.stage)).toEqual([...STAGE_ORDER]);
    expect(cols.find((c) => c.stage === "recommended")!.deals.map((d) => d.id)).toEqual(["a"]);
    expect(cols.filter((c) => c.deals.length === 0)).toHaveLength(STAGE_ORDER.length - 1);
    expect(groupByStage([]).every((c) => c.deals.length === 0)).toBe(true);
  });
  it("keeps the order deals arrive in within a column", () => {
    const cols = groupByStage([card({ id: "a" }), card({ id: "b" }), card({ id: "c", stage: "won" })]);
    expect(cols[0].deals.map((d) => d.id)).toEqual(["a", "b"]);
  });
  it("has a label for every stage", () => {
    for (const s of STAGE_ORDER) expect(STAGE_LABEL[s], s).toBeTruthy();
  });
});

describe("isStale", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");
  it("a deal with no activity for 7 days is flagged stale", () => {
    expect(isStale(card({ updatedAt: "2026-11-11T12:00:00.000Z" }), now)).toBe(true);
    expect(isStale(card({ updatedAt: "2026-10-01T00:00:00.000Z" }), now)).toBe(true);
  });
  it("a deal updated within the week is not", () => {
    expect(isStale(card({ updatedAt: "2026-11-11T12:00:01.000Z" }), now)).toBe(false);
    expect(isStale(card({ updatedAt: "2026-11-18T11:00:00.000Z" }), now)).toBe(false);
  });
  it("a won or lost deal is never stale, and a bad date is not stale", () => {
    expect(isStale(card({ stage: "won", updatedAt: "2026-01-01T00:00:00.000Z" }), now)).toBe(false);
    expect(isStale(card({ stage: "lost", updatedAt: "2026-01-01T00:00:00.000Z" }), now)).toBe(false);
    expect(isStale(card({ updatedAt: "garbage" }), now)).toBe(false);
  });
});

describe("the board", () => {
  const now = new Date("2026-11-22T12:00:00.000Z");
  const d = (o: Partial<BoardDeal>): BoardDeal => ({ id: "x", businessId: "b", businessName: "Ace", stage: "booked", valueCents: null, updatedAt: "2026-11-21T12:00:00.000Z", ...o });
  const deals = [
    d({ id: "a", stage: "booked" }), d({ id: "b", stage: "proposal_sent", valueCents: 100000 }), d({ id: "c", stage: "won", valueCents: 50000, closedAt: "2026-11-03T00:00:00.000Z" }),
    d({ id: "e", stage: "won", valueCents: 70000, closedAt: "2026-10-03T00:00:00.000Z" }), d({ id: "f", stage: "lost" }),
  ];
  it("shows the open stages and won this month, or what the sidebar filter asks for", () => {
    expect(boardColumns(deals, "all", now).map((c) => c.key)).toEqual(["booked", "discovery_done", "recommendation_booked", "recommended", "proposal_sent", "won_month"]);
    expect(boardColumns(deals, "all", now).at(-1)!.deals.map((x) => x.id)).toEqual(["c"]);
    expect(boardColumns(deals, "closed", now).map((c) => c.deals.length)).toEqual([2, 1]);
    expect(boardColumns(deals, "proposal_sent", now)[0].totalCents).toBe(100000);
    expect(boardFilterOf("booked")).toBe("booked");
    expect(boardFilterOf("nonsense")).toBe("all");
  });
  it("sums the open deals and what was won this month", () => {
    expect(boardSummary(deals, now, (c) => String(c / 100))).toBe("2 open deals · 1000 · 500 won this month");
  });
  it("names the package, and says what is happening on the card", () => {
    expect(cardPackage(d({ stage: "booked" }))).toBe("No package yet");
    expect(cardPackage(d({ stage: "recommended", recommendedOptionId: "b", options: [{ id: "b", label: "Starter Site", recommended: true }] }))).toBe("Starter Site");
    const viewed = { sentAt: "2026-11-20T00:00:00Z", expiresAt: null, views: 2, status: "viewed", paidAt: null, signedAt: null };
    expect(cardStatus(d({ stage: "proposal_sent" }), { proposal: viewed }, now, "UTC").text).toBe("Viewed 2 times");
    expect(cardStatus(d({ stage: "booked", updatedAt: "2026-11-01T00:00:00Z" }), {}, now, "UTC").tone).toBe("warning");
    expect(cardStatus(d({ stage: "lost", lostReason: "Too dear" }), {}, now).text).toBe("Lost: Too dear");
  });
});

describe("quietSummary and closedDeals", async () => {
  const { quietSummary, closedDeals } = await import("../src/client/pipelineView");
  it("says plainly that nothing is open, then what was won and lost", () => {
    expect(quietSummary([card({ stage: "won" })])).toBe("No open deals · 1 won so far");
    expect(quietSummary([card({ stage: "won" }), card({ stage: "lost" })])).toBe("No open deals · 1 won so far · 1 lost");
    expect(quietSummary([])).toBe("No open deals");
  });
  it("lists won and lost deals, newest close first", () => {
    const list = closedDeals([card({ id: "a", stage: "won", closedAt: "2026-10-01T00:00:00Z" } as Partial<BoardDeal>), card({ id: "b", stage: "booked" }), card({ id: "c", stage: "lost", closedAt: "2026-11-01T00:00:00Z" } as Partial<BoardDeal>)] as BoardDeal[]);
    expect(list.map((d) => d.id)).toEqual(["c", "a"]);
  });
});
