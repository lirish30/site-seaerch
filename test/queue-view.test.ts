import { describe, expect, it } from "vitest";
import { QUEUE_HINT, openCount, queueLine, queueRows, reviewPendingNote, type QueueStatus } from "../src/client/queueView";

describe("queueLine", () => {
  it("says Claude has nothing waiting when no task is open", () => {
    expect(queueLine({})).toBe("Claude has nothing waiting.");
    expect(queueLine({ "site.review": { pending: 0, claimed: 0 } })).toBe("Claude has nothing waiting.");
  });
  it("counts pending and claimed together, singular for one", () => {
    expect(queueLine({ "site.review": { pending: 1, claimed: 0 } })).toBe("1 task waiting for a Claude session.");
    expect(queueLine({ "site.review": { pending: 0, claimed: 1 } })).toBe("1 task waiting for a Claude session.");
    expect(queueLine({ "site.review": { pending: 2, claimed: 0 }, "lead.draft": { pending: 0, claimed: 1 } })).toBe("3 tasks waiting for a Claude session.");
  });
});

describe("queue breakdown", () => {
  const status: QueueStatus = {
    counts: { "lead.draft": { pending: 1, claimed: 1 }, "site.review": { pending: 4, claimed: 0 }, "reply.classify": { pending: 0, claimed: 0 }, "x.gone": { pending: 2, claimed: 0 } },
    labels: { "lead.draft": "Write an email draft", "site.review": "Review a website", "reply.classify": "Read a reply" },
    oldestPendingAt: "2026-11-10T00:00:00.000Z",
  };
  it("lists each kind with open work, biggest first, labelled from the response", () => {
    expect(queueRows(status)).toEqual([
      { kind: "site.review", label: "Review a website", pending: 4, claimed: 0 },
      { kind: "lead.draft", label: "Write an email draft", pending: 1, claimed: 1 },
      { kind: "x.gone", label: "x.gone", pending: 2, claimed: 0 },
    ]);
  });
  it("totals the open tasks", () => {
    expect(openCount(status.counts)).toBe(8);
    expect(openCount({})).toBe(0);
  });
  it("has the one-line hint", () => {
    expect(QUEUE_HINT).toBe("Run /work-the-queue in Claude Code to clear them.");
  });
});

describe("reviewPendingNote", () => {
  it("notes a pending AI review only while one is open", () => {
    expect(reviewPendingNote(true)).toBe("AI review pending");
    expect(reviewPendingNote(false)).toBeNull();
    expect(reviewPendingNote(undefined)).toBeNull();
  });
});
