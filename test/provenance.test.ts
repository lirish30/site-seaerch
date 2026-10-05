import { describe, it, expect } from "vitest";
import { withProvenance, urgencyOf, isStale } from "../src/worker/audit/provenance";
import type { Finding, Severity } from "../src/worker/types";

const f = (over: Partial<Finding> = {}): Finding => ({
  code: "no_h1", category: "technical", severity: "nice", points: 1, evidence: "e", recommendation: "r", source: "rule", ...over });
const sev = (severity: Severity, n = 1): Finding[] => Array.from({ length: n }, () => f({ severity }));

const NOW = new Date("2026-10-04T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("withProvenance", () => {
  it("stamps observed_at and confidence without mutating the input", () => {
    const input = [f({ source: "rule" }), f({ source: "ai", code: "ai_x" })];
    const out = withProvenance(input, "2026-10-04T00:00:00.000Z");
    expect(out.map((x) => x.observed_at)).toEqual(["2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z"]);
    expect(out.map((x) => x.confidence)).toEqual(["high", "medium"]);
    expect(input[0].observed_at).toBeUndefined();
    expect(input[0].confidence).toBeUndefined();
    expect(out[0]).not.toBe(input[0]);
  });

  it("keeps an existing observed_at and confidence", () => {
    const [o] = withProvenance([f({ observed_at: "2026-01-01T00:00:00.000Z", confidence: "low" })], "2026-10-04T00:00:00.000Z");
    expect(o.observed_at).toBe("2026-01-01T00:00:00.000Z");
    expect(o.confidence).toBe("low");
  });
});

describe("urgencyOf", () => {
  it("is 0 for no findings", () => expect(urgencyOf([])).toBe(0));
  it("weights severities", () => {
    expect(urgencyOf(sev("critical"))).toBe(30);
    expect(urgencyOf([...sev("critical", 2), ...sev("important")])).toBe(72);
  });
  it("caps at 100", () => expect(urgencyOf(sev("critical", 10))).toBe(100));
});

describe("isStale", () => {
  const audit = daysAgo(1);
  it("flags a finding observed 45 days ago", () => expect(isStale(f({ observed_at: daysAgo(45) }), audit, NOW)).toBe(true));
  it("does not flag one observed 5 days ago", () => expect(isStale(f({ observed_at: daysAgo(5) }), audit, NOW)).toBe(false));
  it("falls back to the audit created_at, never to now", () => {
    expect(isStale(f(), daysAgo(90), NOW)).toBe(true);
    expect(isStale(f(), daysAgo(2), NOW)).toBe(false);
  });
  it("honours a custom window", () => expect(isStale(f({ observed_at: daysAgo(10) }), audit, NOW, 7)).toBe(true));
});
