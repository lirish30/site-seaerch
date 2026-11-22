import { describe, expect, it } from "vitest";
import { dayInZone, memoView, revokeQuestion, type MemoRow } from "../src/client/strategyMemoView";

// The owner's Strategy memo section (Plan 16, Task 10): which button shows when, and what the status says. Plain values in, plain text out.
const TZ = "America/Los_Angeles";
let n = 0;
const row = (over: Partial<MemoRow> = {}): MemoRow => ({
  id: `m${++n}`, version: n, status: "collecting", test: false, createdAt: "2026-12-01T17:00:00.000Z", readyAt: null, sentAt: null, viewCount: 0, firstViewedAt: null, link: null, body: null, approvalId: null, ...over,
});
const sent = (over: Partial<MemoRow> = {}) => row({ status: "sent", readyAt: "2026-12-01T18:00:00.000Z", sentAt: "2026-12-02T03:30:00.000Z", link: "https://clients.example/y/tok", ...over });

describe("dayInZone", () => {
  it("is the day in the owner's zone, not in UTC", () => {
    expect(dayInZone("2026-12-02T03:30:00.000Z", TZ)).toBe("2026-12-01");
    expect(dayInZone("2026-12-02T03:30:00.000Z", "UTC")).toBe("2026-12-02");
  });
  it("is null for a time that cannot be read, or a zone that does not exist", () => {
    expect(dayInZone("nope", TZ)).toBeNull();
    expect(dayInZone(null, TZ)).toBeNull();
    expect(dayInZone("2026-12-02T03:30:00.000Z", "Not/AZone")).toBeNull();
  });
});

describe("memoView: nothing yet", () => {
  it("offers the draft button and nothing else when there is no memo", () => {
    expect(memoView([], TZ)).toEqual({ latest: null, status: null, draft: true, tryAgain: false, revoke: false, link: null, test: false });
  });
});

describe("memoView: which button shows when", () => {
  it("collecting: Try again, no Draft, no Revoke, no link; Claude is writing it", () => {
    const v = memoView([row({ status: "collecting" })], TZ);
    expect(v).toMatchObject({ status: "Claude is writing it", draft: false, tryAgain: true, revoke: false, link: null });
  });

  it("ready: Revoke, no Draft (one open memo at a time), no Try again; waiting for the owner's approval on the Home page", () => {
    const v = memoView([row({ status: "ready", readyAt: "2026-12-01T18:00:00.000Z" })], TZ);
    expect(v).toMatchObject({ status: "Waiting for your approval — it is on the Home page", draft: false, tryAgain: false, revoke: true, link: null });
  });

  it("sent: Revoke and the link, and Draft again because no memo is open; says when it was sent and how often it was opened", () => {
    expect(memoView([sent()], TZ)).toMatchObject({ status: "Sent 1 Dec, not opened yet", draft: true, tryAgain: false, revoke: true, link: "https://clients.example/y/tok" });
    expect(memoView([sent({ viewCount: 1 })], TZ).status).toBe("Sent 1 Dec, opened 1 time");
    expect(memoView([sent({ viewCount: 3 })], TZ).status).toBe("Sent 1 Dec, opened 3 times");
  });

  it("sent with no link the page can show (no client link base): no link, still Revoke", () => {
    expect(memoView([sent({ link: null })], TZ)).toMatchObject({ revoke: true, link: null });
  });

  it("revoked: Draft, nothing else; says Revoked", () => {
    expect(memoView([row({ status: "revoked", link: null })], TZ)).toMatchObject({ status: "Revoked", draft: true, tryAgain: false, revoke: false, link: null });
  });

  it("cancelled: Draft, nothing else; says Cancelled", () => {
    expect(memoView([row({ status: "cancelled" })], TZ)).toMatchObject({ status: "Cancelled", draft: true, tryAgain: false, revoke: false, link: null });
  });

  it("never shows a link for a memo that is not sent, even when the row carries one", () => {
    for (const status of ["collecting", "ready", "revoked", "cancelled"] as const) expect(memoView([row({ status, link: "https://clients.example/y/tok" })], TZ).link, status).toBeNull();
  });

  it("a test memo says so", () => {
    expect(memoView([row({ test: true })], TZ).test).toBe(true);
    expect(memoView([row()], TZ).test).toBe(false);
  });
});

describe("memoView: several memos", () => {
  it("is about the newest, whatever order the rows come in", () => {
    const old = sent({ version: 1, link: "https://clients.example/y/old" });
    const newest = row({ version: 2, status: "collecting" });
    expect(memoView([old, newest], TZ).latest?.version).toBe(2);
    expect(memoView([newest, old], TZ).latest?.version).toBe(2);
    expect(memoView([old, newest], TZ)).toMatchObject({ status: "Claude is writing it", tryAgain: true, revoke: false, draft: false });
  });

  it("an older sent memo does not take the Draft button away from a newer revoked one, and an open memo hides it whatever else is there", () => {
    expect(memoView([row({ version: 2, status: "revoked" }), sent({ version: 1 })], TZ).draft).toBe(true);
    expect(memoView([row({ version: 2, status: "ready" }), sent({ version: 1 })], TZ).draft).toBe(false);
  });
});

describe("memoView: the date", () => {
  it("says Sent without a day when the time cannot be read", () => {
    expect(memoView([sent({ sentAt: null })], TZ).status).toBe("Sent, not opened yet");
  });
});

describe("revokeQuestion", () => {
  it("says what happens: a sent memo's link stops working even for the client, a ready memo is dropped before anything is mailed", () => {
    expect(revokeQuestion(sent())).toMatch(/link will stop working, even for the client who has it/);
    expect(revokeQuestion(row({ status: "ready" }))).toMatch(/nothing is mailed/i);
  });
});
