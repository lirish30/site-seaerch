import { describe, expect, it } from "vitest";
import { VIDEO_CAPTION, dayLabel, editsLine, hours, renewalLine, siteDetails, uptimeLine, type PublicReportSite } from "../src/client/careReportPageView";

const site = (over: Partial<Parameters<typeof uptimeLine>[0]> = {}) => ({ uptimePercent: 99.9, coveredDays: 29, monitoredSince: "2026-11-02", ...over });

describe("hours", () => {
  it("reads minutes as hours and minutes", () => {
    expect(hours(100)).toBe("1 h 40 min");
    expect(hours(60)).toBe("1 h");
    expect(hours(45)).toBe("45 min");
    expect(hours(0)).toBe("0 min");
    expect(hours(125)).toBe("2 h 5 min");
    expect(hours(600)).toBe("10 h");
  });
  it("never reads a bad number as anything but 0 min", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) expect(hours(bad)).toBe("0 min");
    expect(hours(59.6)).toBe("1 h");
  });
});

describe("uptimeLine", () => {
  it("is the figure and the days it is from", () => {
    expect(uptimeLine(site())).toBe("99.9% uptime over 29 days");
    expect(uptimeLine(site({ uptimePercent: 100, coveredDays: 1 }))).toBe("100% uptime over 1 day");
    expect(uptimeLine(site({ uptimePercent: 0, coveredDays: 3 }))).toBe("0% uptime over 3 days");
  });
  it("without a figure it says since when it has been watched", () => {
    expect(uptimeLine(site({ uptimePercent: null, monitoredSince: "2026-11-14" }))).toBe("monitored since 14 Nov");
    expect(uptimeLine(site({ uptimePercent: null, monitoredSince: "2026-12-01" }))).toBe("monitored since 1 Dec");
  });
  it("with neither the line is left out, never 0% or 100%", () => {
    expect(uptimeLine(site({ uptimePercent: null, monitoredSince: null }))).toBeNull();
    expect(uptimeLine(site({ uptimePercent: null, monitoredSince: "garbage" }))).toBeNull();
  });
});

describe("editsLine", () => {
  const edits = (usedMinutes: number, allowanceMinutes: number, state: "ok" | "warn" | "over" = "ok") => ({ usedMinutes, allowanceMinutes, state, requestsDone: 2 });
  it("is used of allowed", () => {
    expect(editsLine(edits(30, 60))).toBe("30 min of 1 h");
    expect(editsLine(edits(0, 60))).toBe("0 min of 1 h");
  });
  it("over the allowance reads the real figure, never 100%", () => {
    const line = editsLine(edits(100, 60, "over"));
    expect(line).toBe("1 h 40 min of 1 h");
    expect(line).not.toMatch(/%/);
  });
  it("with no allowance it says only what was used", () => {
    expect(editsLine(edits(45, 0))).toBe("45 min used");
  });
  it("is null when the client has no edit hours", () => {
    expect(editsLine(null)).toBeNull();
  });
});

describe("dayLabel", () => {
  it("is the day and the short month, from the calendar date as it is (no zone)", () => {
    expect(dayLabel("2026-12-20")).toBe("20 Dec");
    expect(dayLabel("2027-01-05")).toBe("5 Jan");
    expect(dayLabel("nope")).toBeNull();
  });
});

describe("renewalLine", () => {
  it("names what renews and for which site", () => {
    expect(renewalLine({ what: "certificate", domain: "ace.com", on: "2026-12-20" })).toEqual({ title: "ace.com: security certificate", date: "20 Dec" });
    expect(renewalLine({ what: "domain", domain: "ace.com", on: "2027-01-05" })).toEqual({ title: "ace.com: domain name", date: "5 Jan" });
    expect(renewalLine({ what: "subscription_term", domain: null, on: "2027-01-15" })).toEqual({ title: "Your care plan term ends", date: "15 Jan" });
    expect(renewalLine({ what: "annual_renewal", domain: null, on: "2027-01-15" })).toEqual({ title: "Annual renewal", date: "15 Jan" });
  });
});

describe("siteDetails", () => {
  const s = (over: Partial<PublicReportSite> = {}): PublicReportSite => ({ domain: "ace.com", uptimePercent: 99.9, coveredDays: 30, monitoredSince: "2026-10-03", incidents: 0, longestOutageMinutes: null, updatesApplied: 4, updatesRolledBack: 0, updatesTracked: true, backups: 2, speedScore: 81, ...over });
  it("lists only what was measured, in plain words", () => {
    expect(siteDetails(s())).toEqual([
      { label: "Uptime", value: "99.9% uptime over 30 days" },
      { label: "Downtime", value: "No downtime recorded" },
      { label: "Updates", value: "4 applied" },
      { label: "Backups", value: "2 taken" },
      { label: "Mobile speed", value: "81 out of 100" },
    ]);
  });
  it("says what went wrong, with the real counts", () => {
    const d = siteDetails(s({ incidents: 2, longestOutageMinutes: 12, updatesRolledBack: 1, speedScore: null }));
    expect(d).toContainEqual({ label: "Downtime", value: "Went down 2 times; the longest was about 12 min" });
    expect(d).toContainEqual({ label: "Updates", value: "4 applied, 1 undone because it caused a problem" });
    expect(d.map((x) => x.label)).not.toContain("Mobile speed");
  });
  it("leaves the uptime row out when it has nothing to say, and says no downtime plainly when days were checked", () => {
    const d = siteDetails(s({ uptimePercent: null, monitoredSince: null, coveredDays: 3, incidents: 0, updatesApplied: 0, backups: 0, speedScore: null }));
    expect(d).toEqual([{ label: "Downtime", value: "No downtime recorded" }, { label: "Updates", value: "None applied this month" }]);
  });
  it("never says no downtime for a month with no checked day, and says nothing about updates for a site no update run covered", () => {
    const d = siteDetails(s({ uptimePercent: null, monitoredSince: null, coveredDays: 0, incidents: 0, updatesApplied: 0, updatesTracked: false, backups: 0, speedScore: null }));
    expect(d).toEqual([{ label: "Downtime", value: "Not measured this month" }]);
    expect(JSON.stringify(d)).not.toMatch(/no downtime|none applied/i);
    // An outage is a measurement even when no day counted, and an untracked site's zero updates are not shown as "0 applied".
    expect(siteDetails(s({ uptimePercent: null, monitoredSince: null, coveredDays: 0, incidents: 1, longestOutageMinutes: 30, updatesApplied: 0, updatesTracked: false, backups: 0, speedScore: null })))
      .toEqual([{ label: "Downtime", value: "Went down once; the longest was about 30 min" }]);
  });
  it("one incident is once", () => {
    expect(siteDetails(s({ incidents: 1, longestOutageMinutes: null }))).toContainEqual({ label: "Downtime", value: "Went down once" });
  });
});

describe("VIDEO_CAPTION", () => {
  it("is a short summary and promises no length", () => {
    expect(VIDEO_CAPTION).toBe("A short summary");
  });
});
