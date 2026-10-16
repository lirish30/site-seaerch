import { describe, expect, it } from "vitest";
import {
  CUSTOM_GROUP, TYPE_TOTAL, activeGroup, etaText, meterView, parseCustomResults, perLeadText, startFailureText, startedText, summaryRows, visibleGroups,
} from "../src/client/newSearchView";

describe("parseCustomResults", () => {
  it("takes whole numbers, rounds down and caps at 200", () => {
    expect(parseCustomResults("75")).toBe(75);
    expect(parseCustomResults(" 12.9 ")).toBe(12);
    expect(parseCustomResults("999")).toBe(200);
  });
  it("is null for blank, zero, negative or non-numeric text", () => {
    for (const raw of ["", "  ", "0", "-5", "abc", "0.4"]) expect(parseCustomResults(raw)).toBeNull();
  });
});

describe("perLeadText", () => {
  it("shows cents, and 'under $0.01' when the cost rounds to nothing", () => {
    expect(perLeadText(2.2795, 50)).toBe("$0.05");
    expect(perLeadText(0.0045, 50)).toBe("under $0.01");
  });
});

describe("etaText", () => {
  it("asks for a type first", () => expect(etaText(0, 50)).toBe("Pick a business type to see the time"));
  it("rounds to whole minutes and uses the singular", () => {
    expect(etaText(3, 200)).toMatch(/^Takes about \d+ minutes$/);
    expect(etaText(1, 1)).toBe("Takes about 1 minute");
  });
});

describe("summaryRows", () => {
  const base = { location: "Boise, ID", count: 4, maxResults: 200, quickScan: true, repeat: true, every: 30 };
  it("describes a full form", () => {
    expect(summaryRows(base).map((r) => r.value)).toEqual(["Boise, ID", "4 types", "Up to 800", "Quick scan first", "Every 30 days"]);
  });
  it("says what is missing, and what is off", () => {
    const v = summaryRows({ ...base, location: "  ", count: 1, quickScan: false, repeat: false }).map((r) => r.value);
    expect(v).toEqual(["Not set", "1 type", "Up to 200", "Full scan", "Off"]);
    expect(summaryRows({ ...base, count: 0 }).slice(1, 3).map((r) => r.value)).toEqual(["None yet", "None yet"]);
  });
});

describe("meterView", () => {
  it("splits the bar into spent and still-running, and says the search fits", () => {
    const m = meterView({ estUsd: 4, spent: 30, inFlightUsd: 15, limit: 150, ok: true }, 4, 1);
    expect(m).toMatchObject({ label: "$30.00 of $150", spentPct: 20, flightPct: 10, over: false, note: "+ $15.00 in searches still running · this search fits" });
  });
  it("flags a search that would pass the limit", () => {
    const m = meterView({ estUsd: 4, spent: 140, limit: 150, ok: true }, 12, 3);
    expect(m.over).toBe(true);
    expect(m.note).toBe("this search would go over your limit");
  });
  it("never lets the two bar parts pass 100%, and keeps cents on a fractional limit", () => {
    const m = meterView({ estUsd: 1, spent: 90, inFlightUsd: 30, limit: 100.5, ok: false }, 0, 0);
    expect(m.spentPct + m.flightPct).toBeLessThanOrEqual(100);
    expect(m.label).toBe("$90.00 of $100.50");
    expect(m.note).toBe("+ $30.00 in searches still running");
  });
  it("handles a zero limit", () => expect(meterView({ estUsd: 1, spent: 0, limit: 0, ok: false }, 1, 1).spentPct).toBe(0));
});

describe("visibleGroups / activeGroup", () => {
  it("lists every group with its types when there is no filter", () => {
    const g = visibleGroups([], "");
    expect(g[0].name).toBe("Home & trade services");
    expect(g.reduce((n, x) => n + x.types.length, 0)).toBe(TYPE_TOTAL);
  });
  it("keeps only matching types and drops empty groups", () => {
    const g = visibleGroups([], "school");
    expect(g.length).toBeGreaterThan(0);
    for (const x of g) for (const t of x.types) expect(t.toLowerCase()).toContain("school");
    expect(g.map((x) => x.name)).toContain("Education");
    expect(g.map((x) => x.name)).not.toContain("Auto");
  });
  it("puts the user's own types in a Custom group at the end", () => {
    const g = visibleGroups(["axe throwing"], "");
    expect(g[g.length - 1]).toEqual({ name: CUSTOM_GROUP, types: ["axe throwing"] });
    expect(visibleGroups(["axe throwing"], "plumber").map((x) => x.name)).not.toContain(CUSTOM_GROUP);
  });
  it("falls back to the first group when the picked one has no matches", () => {
    const g = visibleGroups([], "school");
    expect(activeGroup(g, "Education")?.name).toBe("Education");
    expect(activeGroup(g, "Auto")?.name).toBe(g[0].name);
    expect(activeGroup([], "Auto")).toBeUndefined();
  });
});

describe("start messages", () => {
  it("lists what failed and adds the spend-limit sentence only when it was hit", () => {
    expect(startFailureText(["plumber (spend limit)"], true)).toBe("Couldn't start: plumber (spend limit). This would go over your monthly spend limit.");
    expect(startFailureText(["roofer (boom)"], false)).toBe("Couldn't start: roofer (boom).");
    expect(startFailureText([], false)).toBe("");
  });
  it("pluralises the started count", () => {
    expect(startedText(1)).toMatch(/^Started 1 search\./);
    expect(startedText(3)).toMatch(/^Started 3 searches\./);
  });
});
