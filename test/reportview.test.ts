import { describe, expect, it } from "vitest";
import { groupFindings, summaryText, isHttpsLogo } from "../src/client/reportView";

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
});
