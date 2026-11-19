import { describe, expect, it } from "vitest";
import { budgetProblem, formatSlot, groupByDay } from "../src/client/bookingView";

describe("formatSlot", () => {
  it("shows the viewer's zone", () => {
    expect(formatSlot("2027-03-16T17:00:00.000Z", "America/Los_Angeles")).toBe("Tue, Mar 16, 10:00 AM PDT");
    expect(formatSlot("2027-03-16T17:00:00.000Z", "Europe/London")).toBe("Tue, Mar 16, 5:00 PM GMT");
    // The date moves with the zone.
    expect(formatSlot("2027-03-16T17:00:00.000Z", "Asia/Tokyo")).toBe("Wed, Mar 17, 2:00 AM GMT+9");
  });
});

describe("groupByDay", () => {
  const slots = ["2026-11-25T03:00:00.000Z", "2026-11-25T17:00:00.000Z", "2026-11-25T17:20:00.000Z"];
  it("groups ISO starts by local date", () => {
    expect(groupByDay(slots, "America/Los_Angeles")).toEqual([
      { day: "2026-11-24", slots: ["2026-11-25T03:00:00.000Z"] },
      { day: "2026-11-25", slots: ["2026-11-25T17:00:00.000Z", "2026-11-25T17:20:00.000Z"] },
    ]);
    // In Tokyo the same starts fall on other dates.
    expect(groupByDay(slots, "Asia/Tokyo")).toEqual([
      { day: "2026-11-25", slots: ["2026-11-25T03:00:00.000Z"] },
      { day: "2026-11-26", slots: ["2026-11-25T17:00:00.000Z", "2026-11-25T17:20:00.000Z"] },
    ]);
    expect(groupByDay([], "America/Los_Angeles")).toEqual([]);
  });
});

describe("budgetProblem", () => {
  const opt = (minCents: number) => ({ id: String(minCents), label: "x", minCents });
  it("names the problem when the lowest option is under the minimum engagement, and is empty otherwise", () => {
    expect(budgetProblem([opt(50000), opt(200000)], 79700)).toBe("The lowest option is $500, below your $797 minimum engagement.");
    expect(budgetProblem([opt(200000), opt(79700)], 79700)).toBe("");
    expect(budgetProblem([], 79700)).toBe("Add at least one budget option.");
  });
});
