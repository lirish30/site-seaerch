import { describe, expect, it } from "vitest";
import { agingRows, barWidths, costPct, daysLate, freedomLine, fmtUsd, hoursLabel, monthLabel, targetCentsFrom, usdToCents } from "../src/client/moneyView";

describe("fmtUsd", () => {
  it("shows whole dollars without cents and others with two decimals", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(123450)).toBe("$1,234.50");
    expect(fmtUsd(123400)).toBe("$1,234");
    expect(fmtUsd(5)).toBe("$0.05");
    expect(fmtUsd(100_000_000)).toBe("$1,000,000");
  });
  it("puts the minus sign before the dollar sign", () => {
    expect(fmtUsd(-500)).toBe("-$5");
    expect(fmtUsd(-123450)).toBe("-$1,234.50");
  });
});

describe("barWidths", () => {
  it("is a percent of the largest value", () => {
    expect(barWidths([50, 100])).toEqual([50, 100]);
    expect(barWidths([1, 3])).toEqual([33.3, 100]);
  });
  it("is all zeros when every value is 0 (or the list is empty)", () => {
    expect(barWidths([0, 0])).toEqual([0, 0]);
    expect(barWidths([])).toEqual([]);
  });
  it("shows a negative month as an empty bar", () => {
    expect(barWidths([-20, 40])).toEqual([0, 100]);
  });
});

describe("agingRows", () => {
  it("gives a label, a formatted amount and a count per bucket, in the order given", () => {
    const ar = { openCents: 150_050, buckets: [
      { key: "current" as const, label: "Current", cents: 100_000, count: 2 },
      { key: "d1_30" as const, label: "1-30 days late", cents: 50_050, count: 1 },
      { key: "d31_60" as const, label: "31-60 days late", cents: 0, count: 0 },
      { key: "d61_plus" as const, label: "61+ days late", cents: 0, count: 0 },
    ], oldest: [] };
    expect(agingRows(ar)).toEqual([
      { label: "Current", amount: "$1,000", count: 2 }, { label: "1-30 days late", amount: "$500.50", count: 1 },
      { label: "31-60 days late", amount: "$0", count: 0 }, { label: "61+ days late", amount: "$0", count: 0 },
    ]);
  });
});

describe("freedomLine", () => {
  it("says how far MRR is toward the target", () => {
    expect(freedomLine({ targetCents: 500_000, mrrCents: 320_000, pct: 64, gapCents: 180_000 })).toBe("$3,200 of $5,000 a month (64%)");
    expect(freedomLine({ targetCents: 500_000, mrrCents: 12_900, pct: 2.6, gapCents: 487_100 })).toBe("$129 of $5,000 a month (2.6%)");
  });
  it("can pass 100%", () => {
    expect(freedomLine({ targetCents: 100_000, mrrCents: 150_000, pct: 150, gapCents: 0 })).toBe("$1,500 of $1,000 a month (150%)");
  });
  it("asks for a target when there is none", () => {
    expect(freedomLine({ targetCents: 0, mrrCents: 0, pct: null, gapCents: 0 })).toBe("Set a target");
    expect(freedomLine({ targetCents: 0, mrrCents: 30_000, pct: null, gapCents: 0 })).toBe("Set a target");
  });
});

describe("the page's small helpers", () => {
  it("names a month", () => { expect(monthLabel("2027-03")).toBe("Mar 2027"); });
  it("reads a typed target as whole cents, or refuses it", () => {
    expect(targetCentsFrom("5000")).toBe(500_000);
    expect(targetCentsFrom(" $3,200.50 ")).toBe(320_050);
    expect(targetCentsFrom("0")).toBe(0);
    expect(targetCentsFrom("100000")).toBe(10_000_000);
    for (const bad of ["", "abc", "-5", "100000.01", "1.234", "5e3"]) expect(targetCentsFrom(bad), bad).toBeNull();
  });
  it("shows costs against the cap", () => {
    expect(costPct(5, 20)).toBe(25);
    expect(costPct(30, 20)).toBe(100);
    expect(costPct(5, 0)).toBe(0);
    expect(fmtUsd(usdToCents(12.345))).toBe("$12.35");
  });
  it("words hours and days", () => {
    expect(hoursLabel(270)).toBe("4.5 h");
    expect(hoursLabel(0)).toBe("0 h");
    expect(daysLate(1)).toBe("1 day late");
    expect(daysLate(12)).toBe("12 days late");
  });
});
