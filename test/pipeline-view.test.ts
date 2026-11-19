import { describe, expect, it } from "vitest";
import { STAGE_ORDER } from "../src/worker/db/deals";
import { groupByStage, isStale, STAGE_LABEL, type DealCard } from "../src/client/pipelineView";

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
