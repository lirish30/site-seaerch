import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { computeHealth, type HealthInput } from "../src/worker/clients/health";

const CLEAN: HealthInput = { openDown: false, domainDaysLeft: null, uptime30: null, checks30: 0, overdueInvoices: 0, held: false, pastDueSubscription: false, accessUnresolved: 0, waitingOnClient: false };
const with_ = (p: Partial<HealthInput>): HealthInput => ({ ...CLEAN, ...p });

describe("computeHealth", () => {
  it("a client with nothing wrong is 100, good, no reasons and no data", () => {
    expect(computeHealth(CLEAN)).toEqual({ score: 100, band: "good", reasons: [], hasData: false });
  });

  it("an open down incident alone is 70 and watch", () => {
    expect(computeHealth(with_({ openDown: true }))).toEqual({ score: 70, band: "watch", reasons: ["Site is down"], hasData: false });
  });

  it("down plus a held billing plus an overdue invoice is 30, at risk, three reasons in deduction order", () => {
    expect(computeHealth(with_({ openDown: true, held: true, overdueInvoices: 2 }))).toEqual({
      score: 30, band: "at_risk", reasons: ["Site is down", "An invoice is overdue", "Billing is on hold"], hasData: false,
    });
  });

  it("every deduction at once clamps to 0, with every reason in order", () => {
    const h = computeHealth(with_({
      openDown: true, domainDaysLeft: 3, uptime30: 90, checks30: 500, overdueInvoices: 1, held: true, pastDueSubscription: true, accessUnresolved: 2, waitingOnClient: true,
    }));
    expect(h.score).toBe(0);
    expect(h.band).toBe("at_risk");
    expect(h.hasData).toBe(true);
    expect(h.reasons).toEqual([
      "Site is down", "Domain expires in 3 days", "Uptime 90% in 30 days", "An invoice is overdue", "Billing is on hold", "A subscription payment failed",
      "Site access is still missing", "Waiting on the client",
    ]);
  });

  it("uptime under 99.0 takes 20 and under 99.5 takes 10, only from 20 checks", () => {
    expect(computeHealth(with_({ uptime30: 98.7, checks30: 5 }))).toMatchObject({ score: 100, reasons: [], hasData: true });
    expect(computeHealth(with_({ uptime30: 98.7, checks30: 19 })).score).toBe(100);
    expect(computeHealth(with_({ uptime30: 98.7, checks30: 20 }))).toMatchObject({ score: 80, reasons: ["Uptime 98.7% in 30 days"] });
    expect(computeHealth(with_({ uptime30: 99.0, checks30: 20 }))).toMatchObject({ score: 90, reasons: ["Uptime 99% in 30 days"] });
    expect(computeHealth(with_({ uptime30: 99.4, checks30: 20 })).score).toBe(90);
    expect(computeHealth(with_({ uptime30: 99.5, checks30: 20 }))).toMatchObject({ score: 100, reasons: [] });
    expect(computeHealth(with_({ uptime30: 100, checks30: 500 })).score).toBe(100);
  });

  it("a null uptime takes nothing even with checks counted", () => {
    expect(computeHealth(with_({ uptime30: null, checks30: 40 }))).toMatchObject({ score: 100, reasons: [], hasData: true });
  });

  it("the domain takes 20 at 7 days or fewer (past included), 10 from 8 to 30, nothing beyond", () => {
    expect(computeHealth(with_({ domainDaysLeft: 7 }))).toMatchObject({ score: 80, reasons: ["Domain expires in 7 days"] });
    expect(computeHealth(with_({ domainDaysLeft: 8 }))).toMatchObject({ score: 90, reasons: ["Domain expires in 8 days"] });
    expect(computeHealth(with_({ domainDaysLeft: 30 }))).toMatchObject({ score: 90 });
    expect(computeHealth(with_({ domainDaysLeft: 31 }))).toMatchObject({ score: 100, reasons: [] });
    expect(computeHealth(with_({ domainDaysLeft: null }))).toMatchObject({ score: 100, reasons: [] });
    expect(computeHealth(with_({ domainDaysLeft: -3 }))).toMatchObject({ score: 80, reasons: ["Domain expired 3 days ago"] });
    expect(computeHealth(with_({ domainDaysLeft: -1 })).reasons).toEqual(["Domain expired 1 day ago"]);
    expect(computeHealth(with_({ domainDaysLeft: 0 })).reasons).toEqual(["Domain expires today"]);
    expect(computeHealth(with_({ domainDaysLeft: 1 })).reasons).toEqual(["Domain expires in 1 day"]);
  });

  it("each single deduction has its amount and sentence", () => {
    expect(computeHealth(with_({ overdueInvoices: 3 }))).toMatchObject({ score: 85, reasons: ["An invoice is overdue"] });
    expect(computeHealth(with_({ held: true }))).toMatchObject({ score: 75, reasons: ["Billing is on hold"] });
    expect(computeHealth(with_({ pastDueSubscription: true }))).toMatchObject({ score: 85, reasons: ["A subscription payment failed"] });
    expect(computeHealth(with_({ accessUnresolved: 4 }))).toMatchObject({ score: 90, reasons: ["Site access is still missing"] });
    expect(computeHealth(with_({ waitingOnClient: true }))).toMatchObject({ score: 90, reasons: ["Waiting on the client"] });
  });

  it("bands: 80 good, 79 watch, 60 watch, 59 at risk", () => {
    expect(computeHealth(with_({ domainDaysLeft: 5 })).band).toBe("good"); // 80
    expect(computeHealth(with_({ domainDaysLeft: 5, waitingOnClient: true }))).toMatchObject({ score: 70, band: "watch" });
    expect(computeHealth(with_({ openDown: true, accessUnresolved: 1, waitingOnClient: true }))).toMatchObject({ score: 50, band: "at_risk" });
    expect(computeHealth(with_({ openDown: true, overdueInvoices: 1 }))).toMatchObject({ score: 55, band: "at_risk" });
    expect(computeHealth(with_({ openDown: true, domainDaysLeft: 20 }))).toMatchObject({ score: 60, band: "watch" });
    expect(computeHealth(with_({ held: true, pastDueSubscription: true }))).toMatchObject({ score: 60, band: "watch" });
    expect(computeHealth(with_({ held: true, pastDueSubscription: true, accessUnresolved: 1 }))).toMatchObject({ score: 50, band: "at_risk" });
    expect(computeHealth(with_({ held: true, overdueInvoices: 1, waitingOnClient: true }))).toMatchObject({ score: 50, band: "at_risk" });
    expect(computeHealth(with_({ held: true, accessUnresolved: 1 }))).toMatchObject({ score: 65, band: "watch" });
  });

  it("the score is a finite integer between 0 and 100 for every combination", () => {
    for (let bits = 0; bits < 256; bits++) {
      for (const [uptime30, checks30] of [[null, 0], [98.7, 30], [99.2, 30], [100, 30], [0, 100]] as const) {
        for (const domainDaysLeft of [null, -40, 0, 7, 8, 30, 31, 400]) {
          const h = computeHealth({
            openDown: !!(bits & 1), domainDaysLeft, uptime30, checks30, overdueInvoices: bits & 2 ? 2 : 0, held: !!(bits & 4), pastDueSubscription: !!(bits & 8),
            accessUnresolved: bits & 16 ? 3 : 0, waitingOnClient: !!(bits & 32),
          });
          expect(Number.isInteger(h.score)).toBe(true);
          expect(h.score).toBeGreaterThanOrEqual(0);
          expect(h.score).toBeLessThanOrEqual(100);
          expect(h.band).toBe(h.score >= 80 ? "good" : h.score >= 60 ? "watch" : "at_risk");
        }
      }
    }
  });
});

// The scaffold's first test lived in this file before the score did; it stays.
it("GET /api/health returns ok", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
