import { describe, expect, it } from "vitest";
import { actionItemLines, changeOrderLines, countsLine, followupState, meetilyLine, meetingRow } from "../src/client/meetingsView";
import type { MeetingListItem } from "../src/worker/routes/meetings";
import type { MeetingSummary } from "../src/worker/meetings/summary";

const item = (over: Partial<MeetingListItem> = {}): MeetingListItem => ({
  id: "m1", title: "Kickoff call", startedAt: "2026-12-01T17:00:00.000Z", endedAt: "2026-12-01T17:30:00.000Z", status: "summarized",
  summary: "We agreed the scope for the new site.", actionItems: 2, changeOrders: 1, followupSent: false, ...over,
});

const summary = (over: Partial<MeetingSummary> = {}): MeetingSummary => ({
  summary: "We agreed the scope.", decisions: [],
  actionItems: [{ title: "Send the logo files", owner: "client", dueOn: "2026-12-05" }, { title: "Draft the sitemap", owner: "logan", dueOn: null }],
  possibleChangeOrders: [{ title: "Add a store", summary: "Sell prints", reason: "Not in scope", hours: 12 }, { title: "Blog setup", summary: "s", reason: "r", hours: 1 }],
  followUp: { subject: "Recap", body: "Thanks." }, generatedAt: "2026-12-01T20:00:00.000Z", ...over,
});

describe("meetingRow", () => {
  it("shows a summarized meeting with its one-line summary and the time in Pacific with the zone named", () => {
    expect(meetingRow(item())).toEqual({ title: "Kickoff call", when: "Tue, Dec 1, 9:00 AM PST", status: "Summarized", headline: "We agreed the scope for the new site." });
  });

  it("says a received meeting has no summary yet", () => {
    const r = meetingRow(item({ status: "received", summary: null, actionItems: 0, changeOrders: 0 }));
    expect(r.status).toBe("Waiting for its summary");
    expect(r.headline).toBe("No summary yet. It is queued for Claude.");
  });

  it("says a failed meeting needs another go", () => {
    const r = meetingRow(item({ status: "failed", summary: null, actionItems: 0, changeOrders: 0 }));
    expect(r.status).toBe("Summary failed");
    expect(r.headline).toBe("The summary did not run. Use Summarize again.");
  });

  it("falls back for an untitled meeting and a summarized one with no readable line", () => {
    expect(meetingRow(item({ title: "  " })).title).toBe("Untitled meeting");
    expect(meetingRow(item({ summary: null })).headline).toBe("Summarized.");
  });
});

describe("countsLine", () => {
  it("counts action items and possible change orders, in the singular too", () => {
    expect(countsLine(item())).toBe("2 action items, 1 possible change order");
    expect(countsLine(item({ actionItems: 1, changeOrders: 3 }))).toBe("1 action item, 3 possible change orders");
  });
  it("says so when there is nothing, and is empty for a meeting with no summary", () => {
    expect(countsLine(item({ actionItems: 0, changeOrders: 0 }))).toBe("No action items or change orders");
    expect(countsLine(item({ status: "received", summary: null, actionItems: 0, changeOrders: 0 }))).toBe("");
  });
});

describe("actionItemLines", () => {
  it("names who does each and the due day when there is one", () => {
    expect(actionItemLines(summary())).toEqual(["Client: Send the logo files (due 5 Dec 2026)", "Logan: Draft the sitemap"]);
  });
  it("is empty when there are none", () => {
    expect(actionItemLines(summary({ actionItems: [] }))).toEqual([]);
  });
});

describe("changeOrderLines", () => {
  it("gives each possible change order its hours and says a draft waits in Home as an approval", () => {
    expect(changeOrderLines(summary())).toEqual([
      "Add a store: about 12 hours. A draft is waiting in Home as an approval.",
      "Blog setup: about 1 hour. A draft is waiting in Home as an approval.",
    ]);
  });
  it("is empty when the meeting asked for nothing extra", () => {
    expect(changeOrderLines(summary({ possibleChangeOrders: [] }))).toEqual([]);
  });
});

describe("followupState", () => {
  const s = summary();
  it("is Not drafted without a summary", () => expect(followupState({ summary: null, followupSentAt: null, followupPending: false })).toBe("Not drafted"));
  it("is Not drafted when a summary exists but no approval is waiting and nothing was sent", () => expect(followupState({ summary: s, followupSentAt: null, followupPending: false })).toBe("Not drafted"));
  it("is Waiting for your approval while its approval is pending", () => expect(followupState({ summary: s, followupSentAt: null, followupPending: true })).toBe("Waiting for your approval"));
  it("is Sent once it went, whatever else is true", () => expect(followupState({ summary: s, followupSentAt: "2026-12-01T21:00:00.000Z", followupPending: true })).toBe("Sent"));
});

describe("meetilyLine", () => {
  const at = "2026-12-01T17:05:00.000Z";
  it("says no sync has run yet", () => expect(meetilyLine({ lastSyncAt: null, lastStatus: null, pending: false })).toBe("Meetily: no sync yet."));
  it("shows the last sync time in Pacific", () => expect(meetilyLine({ lastSyncAt: at, lastStatus: "done", pending: false })).toBe("Meetily: last sync Tue, Dec 1, 9:05 AM PST."));
  it("says a sync is waiting for the Mac", () => {
    expect(meetilyLine({ lastSyncAt: at, lastStatus: "pending", pending: true })).toBe("Meetily: last sync Tue, Dec 1, 9:05 AM PST. A sync is waiting for your Mac.");
    expect(meetilyLine({ lastSyncAt: null, lastStatus: "pending", pending: true })).toBe("Meetily: no sync yet. A sync is waiting for your Mac.");
  });
  it("says the last one failed", () => expect(meetilyLine({ lastSyncAt: at, lastStatus: "failed", pending: false })).toBe("Meetily: the last sync failed (Tue, Dec 1, 9:05 AM PST)."));
});
