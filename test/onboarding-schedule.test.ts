import { describe, expect, it } from "vitest";
import type { Onboarding, OnboardingItem } from "../src/worker/db/onboardings";
import { PHASE_DUE_DAYS, QUESTIONNAIRE_DUE_DAYS, REMINDER_DAYS, SILENCE_DAYS, dueDatesFor, nudgesDue, silentDays, stageOf } from "../src/worker/onboarding/schedule";

const DAY = 86_400_000, HOUR = 3_600_000;
const T0 = new Date("2026-11-02T17:00:00.000Z");
const iso = (d: Date) => d.toISOString();
const ago = (now: Date, ms: number) => iso(new Date(now.getTime() - ms));

const onb = (over: Partial<Onboarding> = {}): Onboarding => ({
  id: "o1", businessId: "b", dealId: "d", documentId: "doc", kind: "build", test: false, token: "t", revokedAt: null, welcomeVideoUrl: null,
  welcomeSentAt: iso(T0), questionnaireDueAt: null, questionnaireSubmittedAt: null, kickoffAt: null, lastClientActivityAt: iso(T0), closedAt: null,
  createdAt: iso(T0), updatedAt: iso(T0), ...over,
});
const item = (over: Partial<OnboardingItem> = {}): OnboardingItem => ({
  id: "i1", onboardingId: "o1", key: "logo_files", label: "Logo", instructions: "x", kind: "files", phase: 1, dueAt: null, status: "waiting", textValue: null, custom: false,
  position: 0, updatedAt: iso(T0), ...over,
});
const at = (ms: number) => new Date(T0.getTime() + ms);
const TZ = "America/Los_Angeles";

describe("constants", () => {
  it("are the agreed numbers", () => {
    expect([...REMINDER_DAYS]).toEqual([2, 4, 7, 10]);
    expect(QUESTIONNAIRE_DUE_DAYS).toBe(2);
    expect(PHASE_DUE_DAYS).toEqual({ 1: 7, 2: 14 });
    expect(SILENCE_DAYS).toBe(14);
  });
});

describe("stageOf", () => {
  it("stage is welcome until the welcome is sent", () => {
    expect(stageOf(onb({ welcomeSentAt: null, lastClientActivityAt: null }), [item()], T0)).toBe("welcome");
    expect(stageOf(onb(), [item()], T0)).toBe("questionnaire");
  });

  it("collecting after the questionnaire is submitted while items wait", () => {
    expect(stageOf(onb({ questionnaireSubmittedAt: iso(T0) }), [item()], at(DAY))).toBe("collecting");
  });

  it("complete when closed, or submitted with nothing waiting", () => {
    expect(stageOf(onb({ closedAt: iso(T0) }), [item()], at(DAY))).toBe("complete");
    expect(stageOf(onb({ questionnaireSubmittedAt: iso(T0) }), [item({ status: "received" }), item({ id: "i2", status: "not_applicable" })], at(DAY))).toBe("complete");
    expect(stageOf(onb({ kind: "light", questionnaireSubmittedAt: iso(T0) }), [], at(DAY))).toBe("complete");
    expect(stageOf(onb({ questionnaireSubmittedAt: null }), [], at(DAY))).toBe("questionnaire");
  });

  it("13 days 23 hours of silence is not waiting and 14 days is", () => {
    expect(stageOf(onb(), [item()], at(14 * DAY - HOUR))).toBe("questionnaire");
    expect(stageOf(onb(), [item()], at(14 * DAY))).toBe("waiting_on_client");
    const sub = onb({ questionnaireSubmittedAt: iso(T0) });
    expect(stageOf(sub, [item()], at(14 * DAY - HOUR))).toBe("collecting");
    expect(stageOf(sub, [item()], at(14 * DAY))).toBe("waiting_on_client");
  });

  it("a write 3 days ago resets silence", () => {
    const now = at(20 * DAY);
    const o = onb({ lastClientActivityAt: ago(now, 3 * DAY) });
    expect(silentDays(o, now)).toBe(3);
    expect(stageOf(o, [item()], now)).toBe("questionnaire");
    expect(silentDays(onb(), now)).toBe(20);
  });
});

describe("silentDays", () => {
  it("is whole days, 0 before the welcome, and never negative", () => {
    expect(silentDays(onb({ welcomeSentAt: null, lastClientActivityAt: null }), at(30 * DAY))).toBe(0);
    expect(silentDays(onb(), at(2 * DAY - 1))).toBe(1);
    expect(silentDays(onb(), at(-DAY))).toBe(0);
  });

  it("counts from the welcome when the client has not written yet", () => {
    expect(silentDays(onb({ lastClientActivityAt: null }), at(5 * DAY))).toBe(5);
  });
});

describe("dueDatesFor", () => {
  it("dueDatesFor gives questionnaire +2 days and phases +7/+14", () => {
    const d = dueDatesFor(new Date("2026-11-02T17:00:00.000Z"));
    expect(d.questionnaireDueAt).toBe("2026-11-04T17:00:00.000Z");
    expect(d.phaseDue[1]).toBe("2026-11-09T17:00:00.000Z");
    expect(d.phaseDue[2]).toBe("2026-11-16T17:00:00.000Z");
  });
});

describe("nudgesDue reminders", () => {
  const reminders = (o: Onboarding, items: OnboardingItem[], now: Date) => nudgesDue(o, items, now, TZ).filter((n) => n.kind === "reminder");

  it("reminder level 1 is due at 2 days, level 4 at 10", () => {
    const o = onb(), its = [item()];
    expect(reminders(o, its, at(2 * DAY - HOUR))).toEqual([]);
    expect(reminders(o, its, at(2 * DAY)).map((n) => n.level)).toEqual([1]);
    expect(reminders(o, its, at(4 * DAY)).map((n) => n.level)).toEqual([1, 2]);
    expect(reminders(o, its, at(7 * DAY)).map((n) => n.level)).toEqual([1, 2, 3]);
    expect(reminders(o, its, at(10 * DAY - HOUR)).map((n) => n.level)).toEqual([1, 2, 3]);
    expect(reminders(o, its, at(10 * DAY)).map((n) => n.level)).toEqual([1, 2, 3, 4]);
    const n = reminders(o, its, at(2 * DAY))[0];
    expect(n.fridayOf).toBeNull();
    expect(n.key).toBe(`reminder:1:${iso(T0)}`);
  });

  it("a client write changes the reminder key so the ladder restarts", () => {
    const now = at(10 * DAY);
    const before = reminders(onb(), [item()], now).map((n) => n.key);
    expect(before.length).toBe(4);
    const wrote = onb({ lastClientActivityAt: ago(now, 1 * DAY) });
    expect(reminders(wrote, [item()], now)).toEqual([]);
    const later = at(12 * DAY);
    const after = reminders(wrote, [item()], later).map((n) => n.key);
    expect(after).toEqual([`reminder:1:${wrote.lastClientActivityAt}`]);
    expect(after.every((k) => !before.includes(k))).toBe(true);
  });

  it("no nudge once complete", () => {
    const now = at(30 * DAY);
    expect(nudgesDue(onb({ closedAt: iso(T0) }), [item()], now, TZ)).toEqual([]);
    expect(nudgesDue(onb({ questionnaireSubmittedAt: iso(T0) }), [item({ status: "received" })], now, TZ)).toEqual([]);
  });

  it("no nudge before the welcome is sent", () => {
    expect(nudgesDue(onb({ welcomeSentAt: null, lastClientActivityAt: null }), [item()], at(30 * DAY), TZ)).toEqual([]);
  });

  it("still nudges while waiting_on_client", () => {
    expect(reminders(onb(), [item()], at(15 * DAY)).length).toBe(4);
  });
});

describe("nudgesDue fridays", () => {
  const fridays = (o: Onboarding, items: OnboardingItem[], now: Date, tz = TZ) => nudgesDue(o, items, now, tz).filter((n) => n.kind === "friday");
  // 2026-11-20 is a Friday. Los Angeles is UTC-8 in November.
  const o = onb({ welcomeSentAt: "2026-11-02T17:00:00.000Z", lastClientActivityAt: "2026-11-19T20:00:00.000Z" });

  it("friday in Los Angeles at 23:30 Thursday UTC-8 is not Friday and 00:30 Friday is", () => {
    expect(fridays(o, [item()], new Date("2026-11-20T07:30:00.000Z"))).toEqual([]);
    const f = fridays(o, [item()], new Date("2026-11-20T08:30:00.000Z"));
    expect(f).toEqual([{ key: "friday:2026-11-20", kind: "friday", level: null, fridayOf: "2026-11-20" }]);
    // Still Friday there at 23:30 local, which is Saturday in UTC.
    expect(fridays(o, [item()], new Date("2026-11-21T07:30:00.000Z")).map((n) => n.key)).toEqual(["friday:2026-11-20"]);
    expect(fridays(o, [item()], new Date("2026-11-21T08:30:00.000Z"))).toEqual([]);
  });

  it("the same instant is a different day in another zone", () => {
    const t = new Date("2026-11-21T03:00:00.000Z"); // Friday evening in Los Angeles, Saturday in UTC and Auckland
    expect(fridays(o, [item()], t).map((n) => n.key)).toEqual(["friday:2026-11-20"]);
    expect(fridays(o, [item()], t, "UTC")).toEqual([]);
    expect(fridays(o, [item()], t, "Pacific/Auckland")).toEqual([]);
  });

  it("is due for an unsubmitted questionnaire even with no items, and not otherwise when nothing waits", () => {
    const now = new Date("2026-11-20T20:00:00.000Z");
    expect(fridays(onb({ ...o, kind: "light" }), [], now).length).toBe(1);
    expect(fridays({ ...o, questionnaireSubmittedAt: "2026-11-19T00:00:00.000Z" }, [item()], now).length).toBe(1);
    expect(fridays({ ...o, questionnaireSubmittedAt: "2026-11-19T00:00:00.000Z" }, [item({ status: "received" })], now)).toEqual([]);
  });

  it("no friday nudge before the welcome or once closed", () => {
    const now = new Date("2026-11-20T20:00:00.000Z");
    expect(fridays({ ...o, welcomeSentAt: null }, [item()], now)).toEqual([]);
    expect(fridays({ ...o, closedAt: "2026-11-19T00:00:00.000Z" }, [item()], now)).toEqual([]);
  });

  it("an invalid zone does not throw", () => {
    expect(() => nudgesDue(o, [item()], new Date("2026-11-20T20:00:00.000Z"), "Not/AZone")).not.toThrow();
  });
});
