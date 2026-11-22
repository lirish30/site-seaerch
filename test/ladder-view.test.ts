import { describe, expect, it } from "vitest";
import { STEP_LABEL, dueLine, isOpen, linkProblem, ordered, statusTone, statusWord, takesLink, type LadderRow } from "../src/client/ladderView";

const row = (o: Partial<LadderRow>): LadderRow => ({ id: "r", businessId: "b", projectId: null, step: "check_in", dueOn: "2026-12-22", status: "waiting", approvalId: null, link: null, note: "", createdAt: "", doneAt: null, ...o });

describe("ladder view", () => {
  it("names every step and status in plain words", () => {
    expect(Object.values(STEP_LABEL)).toEqual(["Review request", "Testimonial request", "Thank-you package", "Check-in", "Case study post", "December letter"]);
    expect(statusWord("drafted")).toBe("Waiting for your OK");
    expect(statusWord("due")).toBe("Due now");
    expect(statusTone("due")).toBe("warning");
    expect(statusTone("done")).toBe("positive");
  });
  it("only an unfinished step can be closed, and only an undrafted review request takes a link", () => {
    expect(["waiting", "due", "drafted"].every((status) => isOpen(row({ status: status as LadderRow["status"] })))).toBe(true);
    expect(isOpen(row({ status: "done" }))).toBe(false);
    expect(isOpen(row({ status: "skipped" }))).toBe(false);
    expect(takesLink(row({ step: "review_request", status: "waiting" }))).toBe(true);
    expect(takesLink(row({ step: "review_request", status: "drafted" }))).toBe(false);
    expect(takesLink(row({ step: "check_in", status: "waiting" }))).toBe(false);
  });
  it("shows the day, and says past due only for a step still open and not drafted", () => {
    expect(dueLine(row({ dueOn: "2026-12-22" }), "2026-12-01")).toBe("22 Dec 2026");
    expect(dueLine(row({ dueOn: "2026-11-22", status: "due" }), "2026-12-01")).toBe("22 Nov 2026 (past due)");
    expect(dueLine(row({ dueOn: "2026-11-22", status: "done" }), "2026-12-01")).toBe("22 Nov 2026");
  });
  it("checks a typed link the way the server does", () => {
    expect(linkProblem("")).toBeNull();
    expect(linkProblem("https://g.page/r/abc")).toBeNull();
    expect(linkProblem("http://g.page/r/abc")).toBe("The link must be an https address.");
    expect(linkProblem("https://x.test/a b")).toBe("The link must be an https address.");
    expect(linkProblem(`https://g.page/${"a".repeat(300)}`)).toBe("The link is at most 300 characters.");
  });
  it("lists open steps soonest first, then finished ones latest first", () => {
    const rows = [row({ id: "a", dueOn: "2027-03-01", status: "done" }), row({ id: "b", dueOn: "2026-12-22" }), row({ id: "c", dueOn: "2026-11-22", status: "due" }), row({ id: "d", dueOn: "2027-01-01", status: "skipped" })];
    expect(ordered(rows).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
  });
});
