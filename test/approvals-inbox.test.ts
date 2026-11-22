import { describe, expect, it } from "vitest";
import type { ApprovalItem } from "../src/client/approvalsView";
import { applyEdits, approveVerb, bucketCounts, bucketOf, fieldValues, groupByBucket, heroOf, kindName, neighbours, previewParts, rowLine, shortWhen } from "../src/client/approvalsInbox";

const item = (id: string, kind: string, created_at: string): ApprovalItem => ({
  id, kind, label: kind, title: id, preview: "p", payload: {}, record_type: null, record_id: null, drafted_by: "job",
  status: "pending", error: null, decision_note: null, created_at, decided_at: null,
});

describe("approvals inbox helpers", () => {
  it("puts kinds in plain buckets, unknown kinds in Other", () => {
    expect(bucketOf("email.send")).toBe("emails");
    expect(bucketOf("invoice.reminder")).toBe("invoices");
    expect(bucketOf("video.publish")).toBe("videos");
    expect(bucketOf("something.new")).toBe("other");
    expect(kindName("invoice.reminder", "Send reminder")).toBe("Payment reminder");
    expect(kindName("something.new", "Do it")).toBe("Do it");
  });

  it("counts buckets in a fixed order and leaves empty ones out", () => {
    const c = bucketCounts([item("a", "video.publish", "1"), item("b", "email.send", "2"), item("c", "ladder.mail", "3")]);
    expect(c.map((x) => [x.key, x.count])).toEqual([["emails", 2], ["videos", 1]]);
  });

  it("groups by bucket, oldest first, and splits off what Approve all may carry", () => {
    const g = groupByBucket([
      item("r", "invoice.reminder", "2026-11-03T00:00:00Z"),
      item("e", "email.send", "2026-11-02T00:00:00Z"),
      item("s", "invoice.send", "2026-11-01T00:00:00Z"),
    ]);
    expect(g.map((x) => x.key)).toEqual(["invoices", "emails"]);
    expect(g[0].items.map((i) => i.id)).toEqual(["s", "r"]);
    expect(g[0].bulk.map((i) => i.id)).toEqual(["r"]); // an invoice is never sent in a batch
    expect(groupByBucket([item("a", "email.send", "1"), item("b", "email.send", "2")], "newest")[0].items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("says what the approve button does", () => {
    expect(approveVerb("email.send")).toBe("Approve and send");
    expect(approveVerb("video.publish")).toBe("Approve and publish");
    expect(approveVerb("change_order.draft")).toBe("Approve and make the draft");
    expect(approveVerb("mystery")).toBe("Approve");
  });

  it("splits an email preview into its header lines and text", () => {
    const p = previewParts("From: a@b.co\nTo: x@y.co\nSubject: Hi there\n\nHello\nworld");
    expect(p.facts).toEqual([{ label: "From", value: "a@b.co" }, { label: "To", value: "x@y.co" }, { label: "Subject", value: "Hi there" }]);
    expect(p.text).toBe("Hello\nworld");
    expect(previewParts("Just text").facts).toEqual([]);
    expect(rowLine("From: a@b.co\nTo: x@y.co\nSubject: Hi\n\nbody")).toBe("To x@y.co · “Hi”");
    expect(rowLine("Line one\n\nline two")).toBe("Line one line two");
  });

  it("reads and puts back the editable fields, and notices when nothing changed", () => {
    const payload = { mailbox: "outreach", to: "x@y.co", subject: "Hi", body: "Hello", includeFooter: true };
    const v = fieldValues("email.send", payload);
    expect(v).toEqual({ to: "x@y.co", subject: "Hi", body: "Hello" });
    expect(applyEdits("email.send", payload, v)).toEqual({ ok: true, value: payload, changed: false });
    const r = applyEdits("email.send", payload, { ...v, subject: "Hello again" });
    expect(r).toEqual({ ok: true, value: { ...payload, subject: "Hello again" }, changed: true });
    expect(applyEdits("email.send", payload, { ...v, body: "  " })).toEqual({ ok: false, error: "Message can't be empty." });
  });

  it("keeps hours a number and drops an empty optional line", () => {
    const co = { projectId: "p", title: "T", summary: "S", reason: "R", hours: 3, source: "email" };
    const r = applyEdits("change_order.draft", co, { ...fieldValues("change_order.draft", co), hours: "2.5" });
    expect(r.ok && (r.value as { hours: number }).hours).toBe(2.5);
    expect(applyEdits("change_order.draft", co, { ...fieldValues("change_order.draft", co), hours: "lots" }).ok).toBe(false);
    const lad = applyEdits("ladder.mail", { ladderId: "l", personalLine: "Hi" }, { personalLine: "" });
    expect(lad).toEqual({ ok: true, value: { ladderId: "l" }, changed: true });
  });

  it("finds an email's video link", () => {
    expect(heroOf({ heroImage: { href: "https://x.co/r/a", alt: "A", src: "s" } })).toEqual({ href: "https://x.co/r/a", alt: "A" });
    expect(heroOf({})).toBeNull();
  });

  it("finds the neighbours for the pager", () => {
    expect(neighbours(["a", "b", "c"], "b")).toEqual({ index: 1, prev: "a", next: "c" });
    expect(neighbours(["a"], "a")).toEqual({ index: 0, prev: null, next: null });
    expect(neighbours(["a"], "z").index).toBe(-1);
  });

  it("writes a short time: clock today, Yesterday, weekday, then the date", () => {
    const now = new Date(2026, 10, 22, 15, 0);
    expect(shortWhen(new Date(2026, 10, 22, 7, 42).toISOString(), now)).toMatch(/7:42\sAM/);
    expect(shortWhen(new Date(2026, 10, 21, 9, 0).toISOString(), now)).toBe("Yesterday");
    expect(shortWhen(new Date(2026, 10, 18, 9, 0).toISOString(), now)).toBe("Wed");
    expect(shortWhen(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe("Nov 2");
    expect(shortWhen("nope", now)).toBe("");
  });
});
