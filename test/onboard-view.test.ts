import { describe, expect, it } from "vitest";
import {
  canSubmit, checkFile, createPacer, dueLabel, formatBytes, groupByPhase, itemLocked, itemStateLabel, progressLabel, progressPercent, SETTLED_MESSAGE, writeOutcome, LOGIN_MESSAGE,
} from "../src/client/onboardView";

const LA = "America/Los_Angeles";

describe("dueLabel", () => {
  const now = new Date("2026-11-19T18:00:00Z");

  it("dueLabel in the booking zone near midnight", () => {
    // 23:30 on Dec 4 in Los Angeles is already Dec 5 in UTC: the label follows the owner's zone, not the browser's or UTC.
    expect(dueLabel("2026-12-05T07:30:00Z", now, LA)).toBe("Due Fri, Dec 4");
    expect(dueLabel("2026-12-05T08:30:00Z", now, LA)).toBe("Due Sat, Dec 5");
    expect(dueLabel("2026-12-05T07:30:00Z", now, "UTC")).toBe("Due Sat, Dec 5");
  });

  it("is not overdue until the due day has ended in that zone", () => {
    expect(dueLabel("2026-12-04T20:00:00Z", new Date("2026-12-05T07:59:00Z"), LA)).toBe("Due Fri, Dec 4");
    expect(dueLabel("2026-12-04T20:00:00Z", new Date("2026-12-05T08:01:00Z"), LA)).toBe("Overdue by 1 day");
  });

  it("overdue is plural-correct", () => {
    const due = "2026-12-04T20:00:00Z";
    expect(dueLabel(due, new Date("2026-12-05T20:00:00Z"), LA)).toBe("Overdue by 1 day");
    expect(dueLabel(due, new Date("2026-12-06T20:00:00Z"), LA)).toBe("Overdue by 2 days");
    expect(dueLabel(due, new Date("2027-01-04T20:00:00Z"), LA)).toBe("Overdue by 31 days");
  });

  it("says there is no date for nothing, for rubbish and for an unknown zone it still answers", () => {
    expect(dueLabel(null, now, LA)).toBe("No date yet");
    expect(dueLabel("", now, LA)).toBe("No date yet");
    expect(dueLabel("not a date", now, LA)).toBe("No date yet");
    expect(dueLabel("2026-12-05T07:30:00Z", now, "Not/AZone")).toMatch(/^Due \w{3}, Dec \d+$/);
  });
});

describe("itemLocked", () => {
  it("an accepted or not-needed item, or any item on a read-only page, takes no more from the client", () => {
    expect(itemLocked({ status: "accepted" }, false)).toBe(true);
    expect(itemLocked({ status: "not_applicable" }, false)).toBe(true);
    expect(itemLocked({ status: "waiting" }, true)).toBe(true);
    expect(itemLocked({ status: "waiting" }, false)).toBe(false);
    expect(itemLocked({ status: "received" }, false)).toBe(false);
  });
  it("a text write refused because the item is settled says so, in words that name no one's text", () => {
    const o = writeOutcome(409, { error: "this item is already settled" }, null, "text");
    expect(o).toEqual({ kind: "locked", message: SETTLED_MESSAGE });
    expect(SETTLED_MESSAGE).toMatch(/already reviewed/);
    // a closed onboarding keeps its own words
    expect(writeOutcome(409, { error: "this onboarding is closed" }, null, "text")).toMatchObject({ kind: "locked", message: "This onboarding is closed" });
  });
});

describe("itemStateLabel", () => {
  it("says each state in plain words", () => {
    expect(itemStateLabel("waiting")).toBe("Waiting on you");
    expect(itemStateLabel("received")).toBe("Received");
    expect(itemStateLabel("accepted")).toBe("Accepted");
    expect(itemStateLabel("not_applicable")).toBe("Not needed");
  });
});

describe("progressLabel", () => {
  it("reads as a count", () => {
    expect(progressLabel({ done: 2, total: 7 })).toBe("2 of 7 done");
    expect(progressLabel({ done: 7, total: 7 })).toBe("7 of 7 done");
  });

  it("progressLabel at 0 of 0 is not NaN", () => {
    const label = progressLabel({ done: 0, total: 0 });
    expect(label).not.toMatch(/NaN|undefined/);
    expect(progressPercent({ done: 0, total: 0 })).toBe(0);
  });

  it("keeps the bar between 0 and 100", () => {
    expect(progressPercent({ done: 1, total: 4 })).toBe(25);
    expect(progressPercent({ done: 9, total: 4 })).toBe(100);
    expect(progressPercent({ done: -1, total: 4 })).toBe(0);
  });
});

describe("canSubmit", () => {
  const q = (id: string, required: boolean) => ({ id, label: id, type: "short" as const, required, kinds: ["build" as const] });
  const base = { questions: [q("a", true), q("b", true), q("c", false)], answers: {} as Record<string, string>, dueAt: null, submittedAt: null };

  it("canSubmit lists missing required ids", () => {
    expect(canSubmit(base)).toEqual({ ok: false, missing: ["a", "b"] });
    expect(canSubmit({ ...base, answers: { a: "x" } })).toEqual({ ok: false, missing: ["b"] });
  });

  it("treats a blank or whitespace-only answer as missing, and ignores optional questions", () => {
    expect(canSubmit({ ...base, answers: { a: "   ", b: "\n\t" } }).missing).toEqual(["a", "b"]);
    expect(canSubmit({ ...base, answers: { a: "x", b: "y" } })).toEqual({ ok: true, missing: [] });
  });
});

describe("groupByPhase", () => {
  const item = (id: string, phase: 1 | 2) => ({ id, phase });

  it("groupByPhase puts phase 1 first and drops empty groups", () => {
    const groups = groupByPhase([item("a", 2), item("b", 1), item("c", 2), item("d", 1)]);
    expect(groups.map((g) => g.phase)).toEqual([1, 2]);
    expect(groups[0].title).toBe("First: homepage and one service page");
    expect(groups[1].title).toBe("Then: the rest of the site");
    expect(groups[0].items.map((i) => i.id)).toEqual(["b", "d"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(groupByPhase([item("a", 2)]).map((g) => g.phase)).toEqual([2]);
    expect(groupByPhase([item("a", 1)]).map((g) => g.phase)).toEqual([1]);
    expect(groupByPhase([])).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(5.25 * 1024 * 1024)).toBe("5.3 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });

  it("never prints NaN or a negative size", () => {
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Infinity)).toBe("0 B");
  });
});

describe("checkFile", () => {
  const f = (name: string, size = 1000) => ({ name, size });

  it("accepts the allowed types, in any letter case", () => {
    for (const n of ["a.jpg", "a.JPEG", "a.png", "a.webp", "a.gif", "a.HEIC", "a.pdf", "a.docx", "a.txt", "my.logo.final.png"]) expect(checkFile(f(n), 0), n).toBeNull();
  });

  it("refuses other types with a clear message that names the file", () => {
    for (const n of ["a.svg", "a.exe", "a.zip", "a.html", "noextension", "a.", ".png.exe", "a.doc"]) expect(checkFile(f(n), 0), n).toMatch(/isn't a type we accept/);
    expect(checkFile(f("logo.svg"), 0)).toContain("logo.svg");
  });

  it("refuses a file over 20 MB and an empty one, and the eleventh file", () => {
    expect(checkFile(f("a.png", 20 * 1024 * 1024), 0)).toBeNull();
    expect(checkFile(f("a.png", 20 * 1024 * 1024 + 1), 0)).toMatch(/20 MB/);
    expect(checkFile(f("a.png", 0), 0)).toMatch(/empty/);
    expect(checkFile(f("a.png"), 9)).toBeNull();
    expect(checkFile(f("a.png"), 10)).toMatch(/10 files/);
  });

  it("shortens a very long file name in the message", () => {
    expect((checkFile(f(`${"x".repeat(300)}.svg`), 0) ?? "").length).toBeLessThan(250);
  });
});

describe("writeOutcome", () => {
  it("is ok for a 2xx", () => {
    expect(writeOutcome(200, null, null, "text")).toEqual({ kind: "ok" });
  });

  it("asks to try again, later, for a dropped connection, a 429 and a 5xx", () => {
    expect(writeOutcome(0, null, null, "text")).toMatchObject({ kind: "retry" });
    expect(writeOutcome(500, null, null, "text")).toMatchObject({ kind: "retry" });
    expect(writeOutcome(503, null, null, "answers")).toMatchObject({ kind: "retry" });
    const r = writeOutcome(429, null, "20", "answers");
    expect(r).toMatchObject({ kind: "retry", afterMs: 20000 });
  });

  it("keeps the retry wait sane: a default, a floor and a ceiling", () => {
    expect(writeOutcome(429, null, null, "text")).toMatchObject({ afterMs: 15000 });
    expect(writeOutcome(429, null, "0", "text")).toMatchObject({ afterMs: 5000 });
    expect(writeOutcome(429, null, "99999", "text")).toMatchObject({ afterMs: 60000 });
    expect(writeOutcome(429, null, "soon", "text")).toMatchObject({ afterMs: 15000 });
  });

  it("says a login in an answer is refused, naming the fields and never anything typed", () => {
    const r = writeOutcome(422, { error: "x", fields: ["a", "b"] }, null, "answers");
    expect(r).toMatchObject({ kind: "rejected", fields: ["a", "b"] });
    expect((r as { message: string }).message).toMatch(/password/i);
  });

  it("gives a 400 with fields as a rejection and keeps only string ids", () => {
    const r = writeOutcome(400, { fields: ["a", 4, null, "b"] }, null, "answers");
    expect(r).toMatchObject({ kind: "rejected", fields: ["a", "b"] });
  });

  it("treats a 409 as locked and a 404 as gone", () => {
    expect(writeOutcome(409, { error: "this onboarding is closed" }, null, "answers")).toMatchObject({ kind: "locked", message: "This onboarding is closed" });
    expect(writeOutcome(409, null, null, "submit")).toMatchObject({ kind: "locked" });
    expect(writeOutcome(404, null, null, "text")).toEqual({ kind: "gone" });
  });

  it("explains a file that is too big or the wrong type", () => {
    expect(writeOutcome(413, null, null, "file")).toMatchObject({ kind: "rejected", message: expect.stringMatching(/20 MB/) });
    expect(writeOutcome(415, null, null, "file")).toMatchObject({ kind: "rejected", message: expect.stringMatching(/accept/) });
  });

  it("does not trust a long or non-text server message", () => {
    const long = writeOutcome(409, { error: "z".repeat(500) }, null, "file") as { message: string };
    expect(long.message.length).toBeLessThanOrEqual(200);
    expect(writeOutcome(409, { error: 5 }, null, "file")).toMatchObject({ kind: "locked", message: expect.any(String) });
  });
});

describe("createPacer", () => {
  function fakeClock() {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
  }

  it("runs the first job at once and spaces the next ones by the gap, in order", async () => {
    const clock = fakeClock();
    const paced = createPacer(2500, clock);
    const order: number[] = [];
    const jobs = [1, 2, 3].map((n) => paced(async () => { order.push(n); return n; }));
    expect(await Promise.all(jobs)).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(clock.sleeps).toEqual([2500, 2500]);
  });

  it("does not wait when the gap has already passed, and one failing job does not stop the line", async () => {
    const clock = fakeClock();
    const paced = createPacer(2500, clock);
    await expect(paced(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await paced(async () => "after")).toBe("after");
    expect(clock.sleeps).toEqual([2500]);
    await clock.sleep(5000);
    expect(await paced(async () => "later")).toBe("later");
    expect(clock.sleeps).toEqual([2500, 5000]);
  });
});

describe("a refused secret-shaped answer", () => {
  it("one neutral message for every refused write, whatever the item or question is", () => {
    for (const kind of ["text", "answers", "file", "submit"] as const) {
      expect(writeOutcome(422, { error: "invalid body", fields: ["item1"] }, null, kind)).toEqual({ kind: "rejected", message: LOGIN_MESSAGE, fields: ["item1"] });
    }
    expect(LOGIN_MESSAGE).toBe("This looks like it has a password, key or login in it. Please take that part out and write the rest in your own words. We'll ask for access a safer way.");
    expect(LOGIN_MESSAGE).toMatch(/password/);
    expect(LOGIN_MESSAGE).toMatch(/key/);
    expect(LOGIN_MESSAGE).toMatch(/login/);
    expect(LOGIN_MESSAGE).toMatch(/take that part out/);
    expect(LOGIN_MESSAGE).not.toMatch(/company|service|provider|DNS|token|payload/i);
  });
});
