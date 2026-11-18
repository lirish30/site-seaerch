import { describe, expect, it } from "vitest";
import { jobValueText, leaderRowId, statText, usdText, verdictLine } from "../src/client/nicheView";
import type { NicheRow } from "../src/worker/niche";

const row = (id: string, o: Partial<NicheRow> = {}): NicheRow => ({ campaignId: id, name: `Trade ${id}`, niche: id, audited: 10, avgScore: 50, avgReviews: 10, jobValueUsd: 1000, opportunity: 1000, ...o });

describe("verdictLine", () => {
  it("not ready: counts the audits and says to keep searching", () => {
    expect(verdictLine({ ready: false, audited: 12, needed: 50, leaderId: null }, [row("a")])).toBe("12 of 50 audits. Keep searching before you pick a trade.");
    // Even with a leader showing, a verdict that is not ready names nobody.
    expect(verdictLine({ ready: false, audited: 49, needed: 50, leaderId: "a" }, [row("a")])).toBe("49 of 50 audits. Keep searching before you pick a trade.");
  });
  it("ready with a leader: names the trade", () => {
    expect(verdictLine({ ready: true, audited: 60, needed: 50, leaderId: "b" }, [row("a"), row("b", { name: "Plumbers" })])).toBe("Plumbers leads on opportunity. Commit to it, or keep testing.");
  });
  it("ready with no leader: asks for job values", () => {
    expect(verdictLine({ ready: true, audited: 60, needed: 50, leaderId: null }, [row("a", { opportunity: null })])).toBe("Enter a job value for each trade to compare them.");
    expect(verdictLine({ ready: true, audited: 60, needed: 50, leaderId: "gone" }, [row("a")])).toBe("Enter a job value for each trade to compare them.");
  });
});

describe("leaderRowId", () => {
  it("is the leader only once the verdict is ready", () => {
    expect(leaderRowId({ ready: true, audited: 60, needed: 50, leaderId: "a" })).toBe("a");
    expect(leaderRowId({ ready: false, audited: 20, needed: 50, leaderId: "a" })).toBeNull();
    expect(leaderRowId({ ready: true, audited: 60, needed: 50, leaderId: null })).toBeNull();
  });
});

describe("display text", () => {
  it("rounds averages to whole numbers and shows a dash for none", () => {
    expect(statText(70.4)).toBe("70");
    expect(statText(70.5)).toBe("71");
    expect(statText(0)).toBe("0");
    expect(statText(null)).toBe("—");
  });
  it("formats dollars", () => {
    expect(usdText(30000)).toBe("$30,000");
    expect(usdText(0)).toBe("$0");
    expect(usdText(null)).toBe("—");
  });
  it("fills the job value box from the stored value", () => {
    expect(jobValueText(1250)).toBe("1250");
    expect(jobValueText(null)).toBe("");
  });
});
