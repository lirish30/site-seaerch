import { describe, expect, it } from "vitest";
import { editHoursLine, ledgerBar, statusChip, statusTone } from "../src/client/careReportsView";

const ledger = (usedMinutes: number, allowanceMinutes = 60) => {
  const percent = allowanceMinutes > 0 ? Math.floor((usedMinutes * 100) / allowanceMinutes) : null;
  const state = usedMinutes > allowanceMinutes ? "over" : allowanceMinutes > 0 && usedMinutes / allowanceMinutes >= 0.8 ? "warn" : "ok";
  return { month: "2026-11", allowanceMinutes, usedMinutes, percent, state } as const;
};

describe("statusChip", () => {
  it("says each status in plain words", () => {
    expect(statusChip("collecting")).toBe("Collecting numbers");
    expect(statusChip("ready")).toBe("Ready to send");
    expect(statusChip("sent")).toBe("Sent");
    expect(statusChip("revoked")).toBe("Taken back");
    expect(statusChip("cancelled")).toBe("Cancelled");
  });
  it("gives a tone too, so colour is never the only signal", () => {
    expect(statusTone("ready")).toBe("warning");
    expect(statusTone("sent")).toBe("positive");
    expect(statusTone("revoked")).toBe("critical");
    expect(statusTone("collecting")).toBe("");
    expect(statusTone("cancelled")).toBe("");
  });
});

describe("ledgerBar", () => {
  it("is green below 80%, amber from 80% to the allowance and red over it", () => {
    expect(ledgerBar(ledger(0))).toMatchObject({ tone: "ok", width: 0, label: "0 min of 1 h used" });
    expect(ledgerBar(ledger(47))).toMatchObject({ tone: "ok", width: 78, label: "47 min of 1 h used" });
    expect(ledgerBar(ledger(48))).toMatchObject({ tone: "warn", width: 80, note: "80% used: nearly out of edit time" });
    expect(ledgerBar(ledger(60))).toMatchObject({ tone: "warn", width: 100 });
    expect(ledgerBar(ledger(61))).toMatchObject({ tone: "over", width: 100, label: "1 h 1 min of 1 h used", note: "Over the allowance: quote the extra time" });
    expect(ledgerBar(ledger(100, 180))).toMatchObject({ tone: "ok", width: 55 });
  });
  it("says there is no allowance when the percent is null, with a full bar only when time was used", () => {
    expect(ledgerBar(ledger(0, 0))).toEqual({ tone: "none", width: 0, label: "no allowance", note: "" });
    expect(ledgerBar(ledger(5, 0))).toMatchObject({ tone: "over", width: 100, label: "5 min used, no allowance" });
  });
  it("is nothing when the client has no Care plan", () => {
    expect(ledgerBar(null)).toBeNull();
  });
});

describe("editHoursLine", () => {
  it("reads used and allowance, and is empty without a ledger", () => {
    expect(editHoursLine(ledger(30))).toBe("30 min of 1 h");
    expect(editHoursLine(null)).toBe("");
  });
});

describe("monthStage / stageLabel", () => {
  it("places each report on the month's path", async () => {
    const { monthStage, stageLabel, MONTH_STAGES } = await import("../src/client/careReportsView");
    expect(monthStage(null)).toBe("none");
    expect(monthStage({ status: "collecting", views: 0 })).toBe("collecting");
    expect(monthStage({ status: "ready", views: 0 })).toBe("ready");
    expect(monthStage({ status: "sent", views: 0 })).toBe("sent");
    expect(monthStage({ status: "sent", views: 3 })).toBe("opened");
    expect(monthStage({ status: "revoked", views: 3 })).toBe("off");
    expect(MONTH_STAGES.map((s) => s.label)).toEqual(["Not started", "Collecting", "Ready for your OK", "Sent", "Opened"]);
    expect(stageLabel("ready")).toBe("Ready for your OK");
    expect(stageLabel("off", "revoked")).toBe("Taken back");
    expect(stageLabel("off", "cancelled")).toBe("Cancelled");
  });
});
