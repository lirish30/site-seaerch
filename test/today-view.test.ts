import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import type { TodayItem } from "../src/client/types";
import { actionErrorText, actionPath, doneLabel, dueLabel, snoozeButtonLabel, snoozeLabel, SNOOZE_DAYS, TODAY_KIND_LABEL, withoutItem } from "../src/client/todayView";

const item = (kind: TodayItem["kind"], businessId: string): TodayItem =>
  ({ id: `${kind}:${businessId}`, kind, businessId, businessName: businessId, reason: "r", due: null, priority: 1 });

describe("today view helpers", () => {
  it("labels every kind", () => {
    expect(Object.keys(TODAY_KIND_LABEL).sort()).toEqual(["draft_unsent", "follow_up_due", "promising_quick_scan", "stalled_deal"]);
    expect(TODAY_KIND_LABEL.follow_up_due).toBe("Follow-up");
  });
  it("offers snooze for 1, 3 and 7 days, all inside the API's 1-30", () => {
    expect([...SNOOZE_DAYS]).toEqual([1, 3, 7]);
    expect(SNOOZE_DAYS.every((d) => d >= 1 && d <= 30)).toBe(true);
    expect(snoozeButtonLabel(1)).toBe("1 day");
    expect(snoozeButtonLabel(3)).toBe("3 days");
    expect(snoozeLabel("Ace Plumbing", 3)).toBe("Snooze Ace Plumbing for 3 days");
    expect(doneLabel("Ace Plumbing")).toBe("Mark done: Ace Plumbing");
  });
  it("formats a due date without shifting the calendar day, and gives null for none or garbage", () => {
    expect(dueLabel("2026-10-01")).toBe("Due Oct 1, 2026");
    expect(dueLabel("2026-10-01T00:00:00.000Z")).toBe("Due Oct 1, 2026");
    expect(dueLabel(null)).toBeNull();
    expect(dueLabel("soon")).toBeNull();
  });
  it("shows the API's message for an ApiError and a fixed fallback otherwise", () => {
    expect(actionErrorText(new ApiError(500, "boom"), "done")).toBe("boom");
    expect(actionErrorText(new TypeError("Failed to fetch"), "done")).toBe("Couldn't mark that done.");
    expect(actionErrorText("x", "snooze")).toBe("Couldn't snooze that.");
  });
  it("removes just the one item, keeping order, and returns the same array when it is absent", () => {
    const a = item("follow_up_due", "1"), b = item("stalled_deal", "1"), c = item("follow_up_due", "2");
    expect(withoutItem([a, b, c], a.id)).toEqual([b, c]);
    const list = [a, b];
    expect(withoutItem(list, "nope")).toBe(list);
  });
  it("builds the action URL from the kind and an encoded business id", () => {
    expect(actionPath(item("draft_unsent", "abc-1"), "done")).toBe("/today/draft_unsent/abc-1/done");
    expect(actionPath(item("draft_unsent", "a/b"), "snooze")).toBe("/today/draft_unsent/a%2Fb/snooze");
  });
});
