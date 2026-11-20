import { describe, expect, it } from "vitest";
import { approvalLink, approvalsLine, canBulkApprove, draftedByLabel, groupApprovals, parsePayloadText, spendLine, type ApprovalItem } from "../src/client/approvalsView";

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
  it("a proposal approval opens its deal", () => {
    const a = { ...item("p", "proposal.send", "2026-11-01T00:00:00Z"), record_type: "deal", record_id: "deal-1" };
    expect(approvalLink(a)).toEqual({ to: "/deals/deal-1", label: "Open the proposal" });
    expect(approvalLink({ ...a, record_id: null })).toBeNull();
  });
  it("an onboarding welcome opens its deal, where the video link is added", () => {
    const a = { ...item("w", "onboarding.welcome", "2026-11-01T00:00:00Z"), record_type: "deal", record_id: "deal-1" };
    expect(approvalLink(a)).toEqual({ to: "/deals/deal-1", label: "Open the onboarding" });
    expect(approvalLink({ ...a, record_type: "lead" })).toBeNull();
  });
});

describe("approvalLink for a reminder", () => {
  it("an onboarding reminder or Friday update opens its deal", () => {
    const a = { ...item("n", "onboarding.nudge", "2026-11-01T00:00:00Z"), record_type: "deal", record_id: "deal-9" };
    expect(approvalLink(a)).toEqual({ to: "/deals/deal-9", label: "Open the onboarding" });
    expect(approvalLink({ ...a, record_type: "lead" })).toBeNull();
    expect(approvalLink({ ...a, record_id: null })).toBeNull();
  });
});

describe("approvalLink for projects", () => {
  it("a step Claude did opens the project that holds it, whether the approval points at the task or the project", () => {
    const a = { ...item("s", "sop.review", "2026-11-01T00:00:00Z"), record_type: "task", record_id: "task-1" };
    expect(approvalLink(a)).toEqual({ to: "/tasks/task-1", label: "Open the step" });
    expect(approvalLink({ ...a, record_type: "project", record_id: "p-1" })).toEqual({ to: "/projects/p-1", label: "Open the project" });
    expect(approvalLink({ ...a, record_type: "deal" })).toBeNull();
    expect(approvalLink({ ...a, record_id: null })).toBeNull();
  });
  it("a change order to send opens its project on the change orders tab", () => {
    const a = { ...item("c", "change_order.send", "2026-11-01T00:00:00Z"), record_type: "project", record_id: "p-2" };
    expect(approvalLink(a)).toEqual({ to: "/projects/p-2?tab=change-orders", label: "Open the change order" });
    expect(approvalLink({ ...a, record_type: "lead" })).toBeNull();
    expect(approvalLink({ ...a, record_id: null })).toBeNull();
  });
  it("the id is escaped in the path", () => {
    expect(approvalLink({ ...item("c", "change_order.send", "2026-11-01T00:00:00Z"), record_type: "project", record_id: "a/b" })?.to).toBe("/projects/a%2Fb?tab=change-orders");
  });
});

describe("canBulkApprove", () => {
  it("a change order is sent on its own: he has read it and the legal gate has passed", () => {
    expect(canBulkApprove("change_order.send")).toBe(false);
  });
  it("a video is never published by an approve-all: it is watched and approved on its own", () => {
    expect(canBulkApprove("video.publish")).toBe(false);
    expect(canBulkApprove("proposal.send")).toBe(false);
  });
  it("the onboarding welcome is approved on its own: the preview asks Logan to add a video link first", () => {
    expect(canBulkApprove("onboarding.welcome")).toBe(false);
  });
  it("a step Claude did is approved on its own: Logan looks at the work first", () => {
    expect(canBulkApprove("sop.review")).toBe(false);
  });
  it("an invoice and a subscription link go to a client with their own amount and date, so each is approved on its own", () => {
    expect(canBulkApprove("invoice.send")).toBe(false);
    expect(canBulkApprove("subscription.start")).toBe(false);
  });
  it("everything else can be approved as a group", () => {
    for (const k of ["email.send", "lead.note", "lead.status"]) expect(canBulkApprove(k), k).toBe(true);
  });
});
