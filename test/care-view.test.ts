import { describe, expect, it } from "vitest";
import { bandLabel, bandOfScore, bandTone, formatUptime, healthChipText, healthLabel, incidentLine, siteStateLabel, sortCare } from "../src/client/careView";
import type { CareRow, IncidentView, SiteMonitoringView } from "../src/worker/monitoring/fleet";

const NOW = new Date("2026-11-21T20:00:00Z");
const minsBefore = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const incident = (over: Partial<IncidentView> = {}): IncidentView => ({
  id: "i1", siteId: "s1", domain: "example.com", kind: "down", openedAt: minsBefore(47), closedAt: null, detail: "HTTP 503", ...over,
});

const site = (over: Partial<SiteMonitoringView> = {}): SiteMonitoringView => ({
  siteId: "s1", domain: "example.com", monitored: true, monitorable: true, up: true, slow: false, lastCheckedAt: NOW.toISOString(), uptime30: 100, checks30: 50, domainExpiresOn: null, ...over,
});

const row = (name: string, score: number, id = name): CareRow => ({
  businessId: id, name, careLabel: null, mrrCents: 0, uptime30: null, grade: { grade: null, note: "", setAt: null, suggested: "B", reasons: [] }, sites: [], openIncidents: [],
  health: { score, band: score >= 80 ? "good" : score >= 60 ? "watch" : "at_risk", reasons: [], hasData: true },
});

describe("healthLabel", () => {
  it("is the score, and says so when there are no checks yet", () => {
    expect(healthLabel({ score: 82, band: "good", hasData: true })).toBe("Health 82");
    expect(healthLabel({ score: 82, band: "good", hasData: false })).toBe("Health 82 · no checks yet");
  });
});

describe("bandLabel", () => {
  it("names each band in words", () => {
    expect(bandLabel("good")).toBe("Good");
    expect(bandLabel("watch")).toBe("Watch");
    expect(bandLabel("at_risk")).toBe("At risk");
  });
});

describe("bandOfScore", () => {
  it("puts 80 and up in good, 60 to 79 in watch, under 60 at risk", () => {
    expect(bandOfScore(100)).toBe("good");
    expect(bandOfScore(80)).toBe("good");
    expect(bandOfScore(79)).toBe("watch");
    expect(bandOfScore(60)).toBe("watch");
    expect(bandOfScore(59)).toBe("at_risk");
    expect(bandOfScore(0)).toBe("at_risk");
  });
});

describe("healthChipText", () => {
  it("says the band in words after the score, so colour never carries it alone", () => {
    expect(healthChipText({ score: 90, band: "good", hasData: true })).toBe("Health 90 · good");
    expect(healthChipText({ score: 70, band: "watch", hasData: true })).toBe("Health 70 · watch");
    expect(healthChipText({ score: 40, band: "at_risk", hasData: true })).toBe("Health 40 · at risk");
  });
  it("keeps the no-checks note before the band", () => {
    expect(healthChipText({ score: 90, band: "good", hasData: false })).toBe("Health 90 · no checks yet · good");
    expect(healthChipText({ score: 70, band: "watch", hasData: false })).toBe("Health 70 · no checks yet · watch");
    expect(healthChipText({ score: 40, band: "at_risk", hasData: false })).toBe("Health 40 · no checks yet · at risk");
  });
});

describe("bandTone", () => {
  it("maps good to ok, watch to warn and at risk to bad", () => {
    expect(bandTone("good")).toBe("ok");
    expect(bandTone("watch")).toBe("warn");
    expect(bandTone("at_risk")).toBe("bad");
  });
});

describe("formatUptime", () => {
  it("never shows 0% for no checks", () => {
    expect(formatUptime(null)).toBe("No checks yet");
    expect(formatUptime(0)).toBe("0%");
  });
  it("shows one decimal, and a whole number when it is whole", () => {
    expect(formatUptime(99.75)).toBe("99.8%");
    expect(formatUptime(99.5)).toBe("99.5%");
    expect(formatUptime(100)).toBe("100%");
  });
});

describe("incidentLine", () => {
  it("says how long a site has been down, and why", () => {
    expect(incidentLine(incident(), NOW)).toBe("Down for 47 minutes: HTTP 503");
    expect(incidentLine(incident({ openedAt: minsBefore(185) }), NOW)).toBe("Down for 3 hours 5 minutes: HTTP 503");
    expect(incidentLine(incident({ openedAt: minsBefore(60) }), NOW)).toBe("Down for 1 hour: HTTP 503");
    expect(incidentLine(incident({ openedAt: minsBefore(1) }), NOW)).toBe("Down for 1 minute: HTTP 503");
    expect(incidentLine(incident({ openedAt: minsBefore(0), detail: "could not connect" }), NOW)).toBe("Down for less than a minute: could not connect");
    expect(incidentLine(incident({ openedAt: minsBefore(26 * 60) }), NOW)).toBe("Down for 1 day 2 hours: HTTP 503");
  });
  it("never goes negative when the clock is a little behind", () => {
    expect(incidentLine(incident({ openedAt: minsBefore(-5) }), NOW)).toBe("Down for less than a minute: HTTP 503");
  });
  it("words a closed outage with its length and the time it came back in the zone given", () => {
    const closedAt = new Date(NOW.getTime() - 60_000).toISOString();
    const line = incidentLine(incident({ openedAt: minsBefore(48), closedAt }), NOW, "America/Los_Angeles");
    expect(line).toBe("Was down 47 minutes, back at Nov 21, 11:59 AM");
    expect(incidentLine(incident({ openedAt: minsBefore(48), closedAt }), NOW, "UTC")).toBe("Was down 47 minutes, back at Nov 21, 7:59 PM");
  });
  it("shows a domain sentence as the server gave it, with a capital letter", () => {
    expect(incidentLine(incident({ kind: "domain_expiring", detail: "domain expires in 12 days" }), NOW)).toBe("Domain expires in 12 days");
    expect(incidentLine(incident({ kind: "domain_expiring", detail: "domain expired 3 days ago" }), NOW)).toBe("Domain expired 3 days ago");
    expect(incidentLine(incident({ kind: "domain_expiring", detail: "domain expiry warning", closedAt: NOW.toISOString() }), NOW)).toBe("Domain expiry warning");
  });
});

describe("siteStateLabel", () => {
  it("has one plain phrase for each of the six states", () => {
    expect(siteStateLabel(site())).toBe("Up");
    expect(siteStateLabel(site({ slow: true }))).toBe("Slow");
    expect(siteStateLabel(site({ up: false }))).toBe("Down");
    expect(siteStateLabel(site({ up: null, lastCheckedAt: null }))).toBe("Not checked yet");
    expect(siteStateLabel(site({ monitored: false, monitorable: false, up: null }))).toBe("Can't be monitored");
    expect(siteStateLabel(site({ monitored: false, up: true }))).toBe("Monitoring off");
  });
  it("says monitoring is off even when an old check was down", () => {
    expect(siteStateLabel(site({ monitored: false, up: false }))).toBe("Monitoring off");
  });
});

describe("sortCare", () => {
  it("puts the worst score first and breaks ties by name", () => {
    const out = sortCare([row("Zed", 90), row("Bea", 40), row("Amy", 90), row("Cal", 70)]);
    expect(out.map((r) => r.name)).toEqual(["Bea", "Cal", "Amy", "Zed"]);
  });
  it("ignores case in names and is stable for equal rows", () => {
    const out = sortCare([row("bea", 50, "1"), row("Bea", 50, "2"), row("Amy", 50, "3")]);
    expect(out.map((r) => r.businessId)).toEqual(["3", "1", "2"]);
  });
  it("does not change the list it was given", () => {
    const input = [row("B", 90), row("A", 10)];
    const copy = [...input];
    const out = sortCare(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });
});
