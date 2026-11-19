import { describe, expect, it } from "vitest";
import {
  PLAN_FOR_DELAYS, itemActions, itemRows, kickoffFromInput, kickoffToInput, silenceNote, sizeLabel, stageLabel, stageTone, statusLabel, videoProblem, welcomeLine,
} from "../src/client/onboardingView";
import type { Stage } from "../src/worker/onboarding/schedule";
import type { ItemStatus } from "../src/worker/db/onboardings";

const STAGES: Stage[] = ["welcome", "questionnaire", "collecting", "waiting_on_client", "complete"];
const row = (key: string, status: ItemStatus, position: number) => ({ key, status, position });

describe("stageLabel and stageTone", () => {
  it("stageLabel covers every Stage", () => {
    for (const s of STAGES) expect(stageLabel(s), s).toMatch(/^[A-Z][A-Za-z ]+$/);
    expect(new Set(STAGES.map(stageLabel)).size).toBe(STAGES.length);
    expect(stageLabel("waiting_on_client")).toBe("Waiting on the client");
  });
  it("a finished onboarding is good, a silent client is a warning, the rest are neutral", () => {
    expect(STAGES.map(stageTone)).toEqual(["neutral", "neutral", "neutral", "warn", "good"]);
  });
});

describe("itemRows", () => {
  it("itemRows order: waiting first, then received, then done, each in its own order", () => {
    const rows = itemRows([
      row("a", "accepted", 0), row("b", "waiting", 1), row("c", "received", 2), row("d", "not_applicable", 3), row("e", "waiting", 4), row("f", "received", 5), row("g", "accepted", 6),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["b", "e", "c", "f", "a", "d", "g"]);
  });
  it("does not change the list it is given", () => {
    const input = [row("a", "accepted", 0), row("b", "waiting", 1)];
    itemRows(input);
    expect(input.map((r) => r.key)).toEqual(["a", "b"]);
  });
});

describe("itemActions", () => {
  it("offers Accept only on a received item, Not needed unless already, and Ask again once it is no longer waiting", () => {
    expect(itemActions("waiting")).toEqual([{ status: "not_applicable", label: "Not needed" }]);
    expect(itemActions("received")).toEqual([{ status: "accepted", label: "Accept" }, { status: "not_applicable", label: "Not needed" }, { status: "waiting", label: "Ask again" }]);
    expect(itemActions("accepted")).toEqual([{ status: "not_applicable", label: "Not needed" }, { status: "waiting", label: "Ask again" }]);
    expect(itemActions("not_applicable")).toEqual([{ status: "waiting", label: "Ask again" }]);
  });
  it("statusLabel names every status", () => {
    expect((["waiting", "received", "accepted", "not_applicable"] as ItemStatus[]).map(statusLabel)).toEqual(["Waiting", "Received", "Accepted", "Not needed"]);
  });
});

describe("silenceNote", () => {
  it("names the clause and the day it starts to apply", () => {
    expect(silenceNote(9)).toBe("No reply for 9 days. The back-of-queue clause applies at 14.");
    expect(silenceNote(1)).toBe("No reply for 1 day. The back-of-queue clause applies at 14.");
  });
  it("silenceNote at 14 days names the clause as applying", () => {
    expect(silenceNote(14)).toBe("No reply for 14 days. The back-of-queue clause applies now.");
    expect(silenceNote(20)).toBe("No reply for 20 days. The back-of-queue clause applies now.");
  });
  it("says so when the client was in touch today", () => {
    expect(silenceNote(0)).toBe("The client was in touch today.");
  });
});

describe("welcomeLine", () => {
  const a = (status: string) => ({ id: "ap1", status });
  it("once sent, says when", () => {
    expect(welcomeLine({ welcomeSentAt: "2026-12-01T17:00:00.000Z", closedAt: null }, a("approved"))).toMatchObject({ kind: "sent", canRequest: false });
  });
  it("waiting for approval points at Home", () => {
    expect(welcomeLine({ welcomeSentAt: null, closedAt: null }, a("pending"))).toMatchObject({ kind: "pending", canRequest: false, text: expect.stringMatching(/waiting for your approval/i) });
  });
  it("an approval that was rejected, or none at all, can be asked for again", () => {
    expect(welcomeLine({ welcomeSentAt: null, closedAt: null }, a("rejected"))).toMatchObject({ kind: "none", canRequest: true });
    expect(welcomeLine({ welcomeSentAt: null, closedAt: null }, null)).toMatchObject({ kind: "none", canRequest: true });
  });
  it("nothing is asked for after close", () => {
    expect(welcomeLine({ welcomeSentAt: null, closedAt: "2026-12-05T00:00:00.000Z" }, null)).toMatchObject({ canRequest: false });
  });
});

describe("videoProblem", () => {
  it("is empty for a blank (it clears) or an https link, and says why otherwise", () => {
    expect(videoProblem("")).toBeNull();
    expect(videoProblem("  ")).toBeNull();
    expect(videoProblem("https://www.loom.com/share/abc")).toBeNull();
    expect(videoProblem("http://loom.com/x")).toMatch(/https/);
    expect(videoProblem("https://user:pw@loom.com/x")).toMatch(/login|password/i);
    expect(videoProblem("https://loom.com/x?token=1")).toMatch(/login|password|token/i);
    expect(videoProblem(`https://loom.com/${"a".repeat(300)}`)).toMatch(/300/);
    expect(videoProblem("nope")).toMatch(/link/);
  });
});

describe("kickoff time fields", () => {
  it("round trips an instant through the datetime-local field", () => {
    const iso = "2026-12-10T18:30:00.000Z";
    expect(kickoffFromInput(kickoffToInput(iso))).toBe(iso);
  });
  it("blank is none, a bad value is refused", () => {
    expect(kickoffToInput(null)).toBe("");
    expect(kickoffFromInput("")).toBeNull();
    expect(kickoffFromInput("garbage")).toBe("invalid");
  });
});

describe("small labels", () => {
  it("sizeLabel", () => {
    expect(sizeLabel(512)).toBe("512 B");
    expect(sizeLabel(2048)).toBe("2 KB");
    expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
  });
  it("the fixed planning line", () => {
    expect(PLAN_FOR_DELAYS).toBe("Plan for client delays of 15–25% in every timeline (spec §9.5)");
  });
});
