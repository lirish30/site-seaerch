import { describe, expect, it } from "vitest";
import { chartBars, criteriaRows, footerLines, monthAbbr, monthName, plural, serviceBadge, shortDate, shortPlaceId, signatureLine, sinceLabel, spendPercent, suppressionBadge, usageRows, usageTotal, usd, visibleServices } from "../src/client/settingsView";
import type { Service } from "../src/client/types";

const svc = (o: Partial<Service>): Service => ({ id: o.name ?? "x", key: o.name ?? "x", name: "S", category: "Websites", summary: "", deliverables: [], prerequisites: [], first_engagement: null,
  finding_codes: [], finding_categories: [], is_specialty: false, active: true, sort: 0, ...o });
const list = [svc({ name: "Web Design", is_specialty: true }), svc({ name: "Hosting", active: false }), svc({ name: "Local SEO", category: "Search", summary: "Maps ranking" })];

describe("services page", () => {
  it("counts services and specialties for the header badge", () => {
    expect(serviceBadge(list)).toBe("3 services · 1 specialty");
    expect(serviceBadge([])).toBe("0 services · 0 specialties");
  });
  it("filters by the search box and Active only, keeping catalog order and dropping empty categories", () => {
    expect(visibleServices(list, "", false).map((g) => [g.category, g.services.length, g.all.length])).toEqual([["Websites", 2, 2], ["Search", 1, 1]]);
    expect(visibleServices(list, "", true).map((g) => [g.category, g.services.map((s) => s.name)])).toEqual([["Websites", ["Web Design"]], ["Search", ["Local SEO"]]]);
    expect(visibleServices(list, "maps", false).map((g) => g.category)).toEqual(["Search"]);
    expect(visibleServices(list, "  HOST ", false)[0].services.map((s) => s.name)).toEqual(["Hosting"]);
    expect(visibleServices(list, "nothing", false)).toEqual([]);
  });
});

describe("fit profile card", () => {
  const p = { industries: [], geos: [], platforms: [], min_reviews: null, min_rating: null };
  it("shows only the criteria that are set, with readable platform names", () => {
    expect(criteriaRows(p)).toEqual([]);
    expect(criteriaRows({ ...p, industries: ["plumber"], platforms: ["godaddy", "wordpress"], min_reviews: 1000, min_rating: 4.5 })).toEqual([
      { label: "Industries", items: ["plumber"] }, { label: "Platforms", items: ["GoDaddy", "WordPress"] },
      { label: "Reviews", items: ["1,000 or more"] }, { label: "Rating", items: ["4.5★ or higher"] }]);
    expect(criteriaRows({ ...p, min_reviews: 0 })).toEqual([{ label: "Reviews", items: ["0 or more"] }]);
  });
});

describe("suppressions table", () => {
  it("words the header badge and shortens a place id", () => {
    expect(suppressionBadge([{ kind: "domain" }, { kind: "domain" }])).toBe("2 domains");
    expect(suppressionBadge([{ kind: "domain" }, { kind: "place_id" }])).toBe("1 domain · 1 listing");
    expect(shortPlaceId("ChIJx7aaaaaaaaaa4qQ")).toBe("ChIJx7a…a4qQ");
    expect(shortPlaceId("short")).toBe("short");
  });
  it("formats the added date in UTC", () => {
    expect(shortDate("2026-09-03T23:59:00.000Z")).toBe("Sep 3");
    expect(shortDate("nope")).toBe("");
  });
});

describe("usage page", () => {
  it("lists the paid services in a fixed order with zeros, and the optional one only when used", () => {
    const rows = usageRows([{ service: "claude", units: 148, est_cost_usd: 24.1 }, { service: "brightdata", units: 62, est_cost_usd: 12.4 }]);
    expect(rows.map((r) => [r.label, r.calls, r.cost])).toEqual([
      ["Google Maps listings (Bright Data)", 62, 12.4], ["AI reviews & drafts (Claude)", 148, 24.1], ["Browser checks", 0, 0], ["Google PageSpeed", 0, 0]]);
    expect(usageRows([{ service: "claude_cro", units: 2, est_cost_usd: 0.5 }]).map((r) => r.service)).toContain("claude_cro");
    expect(usageRows([{ service: "newthing", units: 1, est_cost_usd: 1 }]).at(-1)?.service).toBe("newthing");
    expect(usageTotal(rows)).toEqual({ calls: 210, cost: 36.5 });
  });
  it("formats dollars and the share of the limit, uncapped", () => {
    expect(usd(41.2)).toBe("$41.20"); expect(usd(1234.5)).toBe("$1,234.50");
    expect(spendPercent(41.2, 150)).toBe(27);
    expect(spendPercent(200, 100)).toBe(200);
    expect(spendPercent(0, 0)).toBe(0); expect(spendPercent(1, 0)).toBe(100);
  });
  it("names months in UTC", () => {
    expect(monthName("2026-10")).toBe("October"); expect(monthAbbr("2026-05")).toBe("May");
  });
  it("scales chart bars to the tallest month, with a stub for a month without spend", () => {
    const bars = chartBars([{ month: "2026-05", est_cost_usd: 22 }, { month: "2026-06", est_cost_usd: 96 }, { month: "2026-07", est_cost_usd: 0 }, { month: "2026-08", est_cost_usd: 0.2 }]);
    expect(bars.map((b) => [b.label, b.value, b.height])).toEqual([["May", "$22", 23], ["Jun", "$96", 101], ["Jul", "$0", 2], ["Aug", "$0", 4]]);
    expect(chartBars([{ month: "2026-05", est_cost_usd: 0 }])[0].height).toBe(2);
  });
});

describe("google and footer", () => {
  it("shows the connect date, with the year only when it isn't this year", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    expect(sinceLabel("2026-09-01T00:00:00Z", now)).toBe("Sep 1");
    expect(sinceLabel("2025-12-30T00:00:00Z", now)).toBe("Dec 30, 2025");
  });
  it("builds the footer preview from the two lines and the signature from name and role", () => {
    expect(footerLines(" 1 Main St ", "")).toEqual(["1 Main St"]);
    expect(footerLines("", "  ")).toEqual([]);
    expect(signatureLine("Logan Irish", "Front-end developer")).toBe("Logan Irish · Front-end developer");
    expect(signatureLine("", "Dev")).toBe("Dev");
    expect(plural(1, "domain")).toBe("1 domain");
  });
});
