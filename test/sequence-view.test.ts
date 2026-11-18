import { describe, it, expect } from "vitest";
import { messageLabel, pickableCampaigns, showStartedNotice, stepStateLabel, stepStatusText, stepTitle, type StepView } from "../src/client/sequenceView";

const NOW = new Date("2026-11-18T10:00:00.000Z");

describe("stepStateLabel", () => {
  it("names a sent step by the day it went", () => {
    expect(stepStateLabel("sent", "2026-12-18T09:00:00.000Z", NOW)).toBe("Sent Dec 18");
    expect(stepStateLabel("sent", null, NOW)).toBe("Sent");
  });
  it("says a pending step is waiting for the owner", () => {
    expect(stepStateLabel("pending", "2026-11-18T09:00:00.000Z", NOW)).toBe("Waiting for your OK");
  });
  it("says a due step is due now", () => {
    expect(stepStateLabel("due", "2026-11-17T09:00:00.000Z", NOW)).toBe("Due now");
    expect(stepStateLabel("due", null, NOW)).toBe("Due now");
  });
  it("gives an upcoming step its day, in UTC", () => {
    expect(stepStateLabel("upcoming", "2026-12-18T23:30:00.000Z", NOW)).toBe("Due Dec 18");
    expect(stepStateLabel("upcoming", "2026-12-19T00:30:00.000Z", NOW)).toBe("Due Dec 19");
    expect(stepStateLabel("upcoming", null, NOW)).toBe("Upcoming");
  });
  it("labels a skipped step", () => {
    expect(stepStateLabel("skipped", null, NOW)).toBe("Skipped");
  });
  it("never says Due now for an upcoming step, even when its estimated day has passed", () => {
    expect(stepStateLabel("upcoming", "2026-11-18T09:59:59.000Z", NOW)).toBe("Due Nov 18");
    expect(stepStateLabel("upcoming", "2026-11-01T09:59:59.000Z", NOW)).toBe("Due Nov 1");
    expect(stepStateLabel("upcoming", "2026-11-18T10:00:01.000Z", NOW)).toBe("Due Nov 18");
  });
});

const view = (idx: number, kind: "email" | "call" | "checkin", state: StepView["state"], at: string | null = null): StepView => ({
  step: { id: `s${idx}`, campaign_id: "c", idx, kind, offset_days: 0, offset_kind: "business", subject: "", variants: [], body_source: "variants" }, state, at,
});
const STEPS = [view(0, "email", "sent", "2026-11-18T09:00:00.000Z"), view(1, "email", "pending"), view(2, "call", "upcoming"), view(3, "email", "upcoming")];

describe("step titles and words", () => {
  it("numbers the emails in order and leaves the call unnumbered", () => {
    expect([0, 1, 2, 3].map((i) => stepTitle(STEPS, i))).toEqual(["Email 1", "Email 2", "Call", "Email 3"]);
    expect(stepTitle(STEPS, 9)).toBe("Step 10");
  });
  it("says a passed call is on the owner's follow-up list instead of sent", () => {
    expect(stepStatusText(view(2, "call", "sent"), NOW)).toBe("On your follow-up list");
    expect(stepStatusText(view(0, "email", "sent", "2026-11-18T09:00:00.000Z"), NOW)).toBe("Sent Nov 18");
    expect(stepStatusText(view(1, "email", "pending"), NOW)).toBe("Waiting for your OK");
  });
  it("labels messages by direction and a failed or in-flight send", () => {
    expect(messageLabel({ direction: "in", status: "received" })).toBe("Received");
    expect(messageLabel({ direction: "out", status: "sent" })).toBe("Sent");
    expect(messageLabel({ direction: "out", status: "failed" })).toBe("Failed");
    expect(messageLabel({ direction: "out", status: "sending" })).toBe("Sending");
  });
  it("keeps the start confirmation up only while Email 1 is waiting for the owner", () => {
    expect(showStartedNotice(true, [view(0, "email", "pending"), view(1, "email", "upcoming")])).toBe(true);
    expect(showStartedNotice(true, [view(0, "email", "sent", "2026-11-18T09:00:00.000Z"), view(1, "email", "upcoming")])).toBe(false);
    expect(showStartedNotice(true, [view(0, "email", "skipped")])).toBe(false);
    expect(showStartedNotice(false, [view(0, "email", "pending")])).toBe(false);
    expect(showStartedNotice(true, [])).toBe(false);
  });
  it("offers every campaign but the archived ones", () => {
    expect(pickableCampaigns([{ id: "a", status: "testing" }, { id: "b", status: "archived" }, { id: "c", status: "active" }]).map((c) => c.id)).toEqual(["a", "c"]);
  });
});
