import { describe, expect, it } from "vitest";
import { ageLabel, topFindings } from "../src/client/evidenceView";

const now = new Date("2026-10-04T12:00:00.000Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

describe("evidenceView", () => {
  it("labels observation age in days", () => {
    expect(ageLabel(ago(0), ago(90), now)).toBe("observed today");
    expect(ageLabel(ago(1), ago(90), now)).toBe("observed 1 day ago");
    expect(ageLabel(ago(45), ago(90), now)).toBe("observed 45 days ago");
  });
  it("a legacy finding is as old as its audit, never today", () => {
    expect(ageLabel(undefined, ago(12), now)).toBe("observed 12 days ago");
    expect(ageLabel(undefined, "not a date", now)).toBe("observation date unknown");
  });
  it("picks the top findings by severity then points, stable otherwise", () => {
    const f = (id: string, severity: "critical" | "important" | "nice", points: number) => ({ id, severity, points });
    const top = topFindings([f("a", "nice", 9), f("b", "important", 5), f("c", "critical", 1), f("d", "important", 8), f("e", "critical", 1)], 4);
    expect(top.map((x) => x.id)).toEqual(["c", "e", "d", "b"]);
  });
});
