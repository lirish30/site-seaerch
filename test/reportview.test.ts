import { describe, expect, it } from "vitest";
import { groupFindings, summaryText, isHttpsLogo, isReportToken, shareState, senderInitials, emailLabel, senderLine, hasSender, senderTitle, expiryText, basedOnText, longDate } from "../src/client/reportView";

const f = (severity: "high" | "medium" | "low", evidence: string) => ({ severity, evidence });

describe("reportView", () => {
  it("groups findings high -> low, dropping empty groups and keeping order", () => {
    const g = groupFindings([f("low", "l1"), f("high", "h1"), f("low", "l2"), f("high", "h2")]);
    expect(g.map((x) => x.severity)).toEqual(["high", "low"]);
    expect(g[0].items).toEqual(["h1", "h2"]);
    expect(g[1].items).toEqual(["l1", "l2"]);
    expect(groupFindings([])).toEqual([]);
  });
  it("summarises counts in plain English", () => {
    expect(summaryText({ high: 1, medium: 2, low: 0 })).toBe("3 things worth a look");
    expect(summaryText({ high: 0, medium: 1, low: 0 })).toBe("1 thing worth a look");
    expect(summaryText({ high: 0, medium: 0, low: 0 })).toBe("");
  });
  it("only accepts https logos", () => {
    expect(isHttpsLogo("https://x.com/a.png")).toBe(true);
    expect(isHttpsLogo("http://x.com/a.png")).toBe(false);
    expect(isHttpsLogo("javascript:alert(1)")).toBe(false);
    expect(isHttpsLogo("")).toBe(false);
  });
  it("recognises well-formed report tokens only", () => {
    expect(isReportToken("A".repeat(43))).toBe(true);
    expect(isReportToken("a-_".repeat(14) + "a")).toBe(true);
    expect(isReportToken("A".repeat(42))).toBe(false);
    expect(isReportToken("A".repeat(44))).toBe(false);
    expect(isReportToken("A".repeat(42) + "/")).toBe(false);
    expect(isReportToken("")).toBe(false);
    expect(isReportToken(undefined)).toBe(false);
  });
  it("derives share-link UI state so any active link can be revoked", () => {
    const r = { token: "t", url: "/r/t", expiresAt: "x" };
    expect(shareState(null, 0)).toEqual({ canRevoke: false, revokeLabel: "Revoke link", olderText: null });
    expect(shareState(r, 0)).toEqual({ canRevoke: true, revokeLabel: "Revoke link", olderText: null });
    expect(shareState(null, 1)).toEqual({ canRevoke: true, revokeLabel: "Revoke all", olderText: "1 older link still active" });
    expect(shareState(r, 2)).toEqual({ canRevoke: true, revokeLabel: "Revoke all", olderText: "2 older links still active" });
  });
  const sender = (o: Partial<{ name: string; businessName: string; email: string; logoUrl: string }> = {}) => ({ name: "", businessName: "", email: "", logoUrl: "", ...o });
  it("derives sender avatar, label and line from whatever the sender filled in", () => {
    expect(senderInitials(sender({ name: "Logan Irish" }))).toBe("LI");
    expect(senderInitials(sender({ name: "Cher" }))).toBe("CH");
    expect(senderInitials(sender({ name: "Mary Ann van Dyke" }))).toBe("MD");
    expect(senderInitials(sender({ businessName: "Irish Web Studio" }))).toBe("IS");
    expect(senderInitials(sender({ email: "lirish30@gmail.com" }))).toBe("LI");
    expect(senderInitials(sender())).toBe("?");
    expect(emailLabel(sender({ name: "Logan Irish" }))).toBe("Email Logan");
    expect(emailLabel(sender({ email: "a@b.co" }))).toBe("Email us");
    expect(senderLine(sender({ businessName: "Irish Web Studio", email: "a@b.co" }))).toBe("Irish Web Studio · a@b.co");
    expect(senderLine(sender({ email: "a@b.co" }))).toBe("a@b.co");
    expect(senderLine(sender())).toBe("");
    expect(hasSender(sender())).toBe(false);
    expect(hasSender(sender({ email: "a@b.co" }))).toBe(true);
    expect(senderTitle(sender({ name: "Logan", businessName: "Irish Web" }))).toBe("Irish Web");
    expect(senderTitle(sender({ name: "Logan" }))).toBe("Logan");
  });
  it("words the dates and the audited site", () => {
    expect(longDate("2026-10-13T15:00:00.000Z")).toBe("October 13, 2026");
    expect(longDate("nope")).toBe("");
    expect(expiryText("2026-11-14T12:00:00.000Z", new Date("2026-10-15T00:00:00Z"))).toBe("Private link · expires Nov 14");
    expect(expiryText("2027-01-05T12:00:00.000Z", new Date("2026-10-15T00:00:00Z"))).toBe("Private link · expires Jan 5, 2027");
    expect(expiryText("garbage")).toBe("Private link");
    expect(basedOnText({ website: "acme.com", auditedAt: "2026-10-13T15:00:00.000Z" })).toBe("Based on an automated check of acme.com on October 13, 2026.");
    expect(basedOnText({ website: "", auditedAt: "2026-10-13T15:00:00.000Z" })).toBe("Based on an automated check on October 13, 2026.");
  });
});
