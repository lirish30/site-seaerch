import { describe, expect, it } from "vitest";
import { outcomeChip, outcomeWho, switchLine, todayLine, whenLine } from "../src/client/autoApproveView";

describe("auto-approve view words", () => {
  it("says what is on and what is off, and how many went today", () => {
    expect(todayLine(3, 20)).toBe("3 of 20 done without a click today");
    expect(switchLine({ enabled: false, enabledAt: null })).toContain("Off");
    expect(switchLine({ enabled: true, enabledAt: "2026-11-22T18:15:00.000Z" }, "America/Los_Angeles")).toBe("On since Nov 22, 10:15 AM. Only reminders drafted after that go on their own.");
    expect(switchLine({ enabled: true, enabledAt: null })).toContain("On.");
    expect(whenLine("not a date")).toBe("");
  });

  it("marks a send green and a failure as waiting for the owner, and names a removed client plainly", () => {
    expect(outcomeChip({ outcome: "sent" })).toEqual({ tone: "positive", text: "Sent" });
    expect(outcomeChip({ outcome: "failed" })).toEqual({ tone: "critical", text: "Not sent: waiting for you" });
    expect(outcomeWho({ businessName: " Ace Plumbing " })).toBe("Ace Plumbing");
    expect(outcomeWho({ businessName: null })).toBe("A client");
  });
});
