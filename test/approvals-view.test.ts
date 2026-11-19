import { describe, expect, it } from "vitest";
import { approvalLink, approvalsLine, draftedByLabel, groupApprovals, parsePayloadText, spendLine, type ApprovalItem } from "../src/client/approvalsView";

const item = (id: string, kind: string, created_at: string): ApprovalItem => ({
  id, kind, label: kind === "lead.note" ? "Lead note" : "Email draft", title: id, preview: "p", payload: {},
  record_type: null, record_id: null, drafted_by: "job", status: "pending", error: null, decision_note: null, created_at, decided_at: null,
});

describe("approvals view helpers", () => {
  it("groups by kind, oldest item first within and across groups", () => {
    const g = groupApprovals([
      item("c", "lead.note", "2026-11-03T00:00:00Z"),
      item("a", "email.send", "2026-11-02T00:00:00Z"),
      item("b", "lead.note", "2026-11-01T00:00:00Z"),
    ]);
    expect(g.map((x) => x.kind)).toEqual(["lead.note", "email.send"]);
    expect(g[0].label).toBe("Lead note");
    expect(g[0].items.map((i) => i.id)).toEqual(["b", "c"]);
    expect(groupApprovals([])).toEqual([]);
  });
  it("says how many things are waiting", () => {
    expect(approvalsLine(0)).toBe("Nothing waiting for you.");
    expect(approvalsLine(1)).toBe("1 thing waiting for your OK.");
    expect(approvalsLine(3)).toBe("3 things waiting for your OK.");
  });
  it("words the spend line per level, in whole dollars", () => {
    expect(spendLine({ spentUsd: 7.2, limitUsd: 150, level: "ok" })).toBe("$7 of $150 this month");
    expect(spendLine({ spentUsd: 125.6, limitUsd: 150, level: "warn" })).toBe("$126 of $150 — over 80%, optional jobs pause at the cap");
    expect(spendLine({ spentUsd: 151, limitUsd: 150, level: "capped" })).toBe("$151 of $150 — cap reached, optional jobs paused");
  });
  it("names who drafted an item", () => {
    expect(draftedByLabel("job")).toBe("Drafted by a job");
    expect(draftedByLabel("mcp")).toBe("Drafted by Claude");
    expect(draftedByLabel("logan")).toBe("Drafted by you");
  });
  it("parses an edited payload as JSON and reports bad JSON", () => {
    expect(parsePayloadText('{"note":"hi"}')).toEqual({ ok: true, value: { note: "hi" } });
    const bad = parsePayloadText("{nope");
    expect(bad.ok).toBe(false);
  });
});

describe("approval links", () => {
  it("a video publish approval opens the lead's video editor", () => {
    const a = { ...item("v", "video.publish", "2026-11-01T00:00:00Z"), record_type: "lead", record_id: "biz-1" };
    expect(approvalLink(a)).toEqual({ to: "/leads/biz-1/video", label: "Watch and edit the video" });
    expect(approvalLink({ ...a, record_id: null })).toBeNull();
    expect(approvalLink({ ...item("n", "lead.note", "2026-11-01T00:00:00Z"), record_type: "lead", record_id: "biz-1" })).toBeNull();
  });
});
