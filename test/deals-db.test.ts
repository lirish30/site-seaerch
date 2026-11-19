import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { STAGE_ORDER, DealInputError, DealMoveError, canMove, createDeal, getDeal, listDeals, moveDeal, openDealFor, type DealStage } from "../src/worker/db/deals";
import { deleteBusiness } from "../src/worker/db/businesses";
import { seedBusiness } from "./fixtures/cro";

describe("deals", () => {
  it("creating a second open deal returns the first", async () => {
    const b = await seedBusiness();
    const first = await createDeal(env.DB, { businessId: b.id, source: "manual" });
    const second = await createDeal(env.DB, { businessId: b.id, source: "booking", skipCall: true });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ stage: "booked", source: "manual", skipCall: false });
    expect((await listDeals(env.DB)).filter((d) => d.businessId === b.id)).toHaveLength(1);
    expect((await openDealFor(env.DB, b.id))!.id).toBe(first.id);
  });

  it("a closed deal does not block the next one", async () => {
    const b = await seedBusiness();
    const first = await createDeal(env.DB, { businessId: b.id, source: "manual" });
    await moveDeal(env.DB, first.id, "lost", { lostReason: "went quiet" });
    expect(await openDealFor(env.DB, b.id)).toBeNull();
    const next = await createDeal(env.DB, { businessId: b.id, source: "manual" });
    expect(next.id).not.toBe(first.id);
  });

  it("canMove allows skipping forward and lost from any open stage", () => {
    expect(canMove("booked", "discovery_done")).toBe(true);
    expect(canMove("booked", "recommended")).toBe(true);
    expect(canMove("discovery_done", "proposal_sent")).toBe(true);
    for (const from of STAGE_ORDER.filter((s) => s !== "won" && s !== "lost")) expect(canMove(from, "lost"), from).toBe(true);
  });

  it("canMove refuses going back and leaving won or lost", () => {
    expect(canMove("recommended", "booked")).toBe(false);
    expect(canMove("discovery_done", "discovery_done")).toBe(false);
    for (const to of STAGE_ORDER) { expect(canMove("won", to), `won to ${to}`).toBe(false); expect(canMove("lost", to), `lost to ${to}`).toBe(false); }
  });

  it("skipCall deal starts at discovery_done", async () => {
    const b = await seedBusiness();
    const d = await createDeal(env.DB, { businessId: b.id, source: "manual", skipCall: true });
    expect(d).toMatchObject({ stage: "discovery_done", skipCall: true, options: null, notes: null, callPrep: null, recap: null, priceSnapshot: [], closedAt: null });
  });

  it("moveDeal moves forward, stamps the update and closes a lost deal", async () => {
    const b = await seedBusiness();
    const d = await createDeal(env.DB, { businessId: b.id, source: "booking" });
    const moved = await moveDeal(env.DB, d.id, "recommended");
    expect(moved.stage).toBe("recommended");
    expect(moved.updatedAt >= d.updatedAt).toBe(true);
    await expect(moveDeal(env.DB, d.id, "booked")).rejects.toBeInstanceOf(DealMoveError);
    const lost = await moveDeal(env.DB, d.id, "lost", { lostReason: "  chose another agency " });
    expect(lost).toMatchObject({ stage: "lost", lostReason: "chose another agency" });
    expect(lost.closedAt).not.toBeNull();
    await expect(moveDeal(env.DB, d.id, "won")).rejects.toBeInstanceOf(DealMoveError);
  });

  it("moveDeal to lost requires a reason", async () => {
    const b = await seedBusiness();
    const d = await createDeal(env.DB, { businessId: b.id, source: "manual" });
    await expect(moveDeal(env.DB, d.id, "lost")).rejects.toBeInstanceOf(DealInputError);
    await expect(moveDeal(env.DB, d.id, "lost", { lostReason: "   " })).rejects.toBeInstanceOf(DealInputError);
    expect((await getDeal(env.DB, d.id))!.stage).toBe("booked");
  });

  it("reads a damaged JSON column as empty instead of throwing", async () => {
    const b = await seedBusiness();
    const d = await createDeal(env.DB, { businessId: b.id, source: "manual" });
    await env.DB.prepare(`UPDATE deals SET options = ?, price_snapshot = ?, notes = ? WHERE id = ?`).bind("{oops", "not json", "[1", d.id).run();
    expect(await getDeal(env.DB, d.id)).toMatchObject({ options: null, priceSnapshot: [], notes: null });
  });

  it("listDeals names the lead and can list open deals only", async () => {
    const b = await seedBusiness({ name: "Pine Street Dental" });
    const d = await createDeal(env.DB, { businessId: b.id, source: "manual" });
    expect((await listDeals(env.DB, { openOnly: true })).find((x) => x.id === d.id)).toMatchObject({ businessName: "Pine Street Dental", stage: "booked" });
    await moveDeal(env.DB, d.id, "lost", { lostReason: "no budget" });
    expect((await listDeals(env.DB, { openOnly: true })).some((x) => x.id === d.id)).toBe(false);
    expect((await listDeals(env.DB)).some((x) => x.id === d.id)).toBe(true);
  });

  it("deleting a lead removes its deals", async () => {
    const b = await seedBusiness();
    const d = await createDeal(env.DB, { businessId: b.id, source: "manual" });
    await deleteBusiness(env.DB, b.id);
    expect(await getDeal(env.DB, d.id)).toBeNull();
    expect(await openDealFor(env.DB, b.id)).toBeNull();
  });

  it("stage order is the spec's", () => {
    expect([...STAGE_ORDER] as DealStage[]).toEqual(["booked", "discovery_done", "recommendation_booked", "recommended", "proposal_sent", "won", "lost"]);
  });
});
