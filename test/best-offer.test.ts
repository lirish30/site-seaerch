import { describe, it, expect } from "vitest";
import { bestOffer, serviceMatchesFinding } from "../src/worker/services/best-offer";
import type { Finding, Service } from "../src/worker/types";

const svc = (key: string, o: Partial<Service> = {}): Service => ({
  id: key, key, name: key, category: "c", summary: "", deliverables: [], prerequisites: [], first_engagement: null,
  finding_codes: [], finding_categories: [], is_specialty: false, active: true, sort: 0, ...o,
});
const fnd = (code: string, severity: Finding["severity"], o: Partial<Finding> = {}): Finding =>
  ({ code: code as Finding["code"], category: "technical", severity, points: 5, evidence: code, recommendation: "", source: "rule", ...o });

const hosting = svc("hosting-maintenance", { finding_codes: ["slow_mobile", "slow_lcp", "layout_shift"], finding_categories: ["speed"], sort: 170 });
const cro = svc("conversion-rate-optimization", { finding_codes: ["no_contact_path", "no_cta", "cro:*"], finding_categories: ["cro"], sort: 320 });
const web = svc("web-design-development", { finding_codes: ["dated_build"], finding_categories: ["design"], sort: 120 });
const catalog = [web, hosting, cro];

describe("serviceMatchesFinding", () => {
  it("matches an exact code", () => expect(serviceMatchesFinding(hosting, fnd("slow_lcp", "nice"))).toBe(true));
  it("matches a trailing-* prefix", () => {
    expect(serviceMatchesFinding(cro, fnd("cro:abc", "nice"))).toBe(true);
    expect(serviceMatchesFinding(cro, fnd("crx:abc", "nice"))).toBe(false);
  });
  it("falls back to category", () => expect(serviceMatchesFinding(cro, fnd("ai_x", "nice", { category: "cro" }))).toBe(true));
  it("does not match an unrelated finding", () => expect(serviceMatchesFinding(hosting, fnd("no_cta", "nice"))).toBe(false));
});

describe("bestOffer", () => {
  it("picks hosting & maintenance for slow-site findings", () => {
    const r = bestOffer([fnd("slow_mobile", "critical"), fnd("slow_lcp", "important")], catalog)!;
    expect(r.service.key).toBe("hosting-maintenance");
    expect(r.because.map((f) => f.code)).toEqual(["slow_mobile", "slow_lcp"]);
  });
  it("picks CRO for booking-path findings", () => {
    expect(bestOffer([fnd("no_contact_path", "critical"), fnd("no_cta", "important")], catalog)!.service.key).toBe("conversion-rate-optimization");
  });
  it("matches an ai_ finding to CRO through its category", () => {
    expect(bestOffer([fnd("ai_x", "important", { category: "cro" })], catalog)!.service.key).toBe("conversion-rate-optimization");
  });
  it("a specialty service beats a non-specialty one with an equal match", () => {
    const plain = svc("a", { finding_codes: ["no_cta"], sort: 1 }), spec = svc("b", { finding_codes: ["no_cta"], is_specialty: true, sort: 2 });
    expect(bestOffer([fnd("no_cta", "important")], [plain, spec])!.service.key).toBe("b");
  });
  it("breaks ties by sort", () => {
    const first = svc("first", { finding_codes: ["no_cta"], sort: 1 }), second = svc("second", { finding_codes: ["no_cta"], sort: 2 });
    expect(bestOffer([fnd("no_cta", "important")], [second, first])!.service.key).toBe("first");
  });
  it("never returns an inactive service", () => {
    const off = { ...hosting, active: false };
    expect(bestOffer([fnd("slow_mobile", "critical")], [off, web])).toBeNull();
    expect(bestOffer([fnd("slow_mobile", "critical"), fnd("dated_build", "nice")], [off, web])!.service.key).toBe("web-design-development");
  });
  it("counts low-confidence findings at half weight", () => {
    const hostingLow = [fnd("slow_mobile", "important", { confidence: "low" }), fnd("slow_lcp", "important", { confidence: "low" })];
    const croOne = [fnd("no_cta", "important")];
    // hosting 1+1 = 2 vs cro 2: a tie, so sort decides
    expect(bestOffer([...hostingLow, ...croOne], [{ ...hosting }, { ...cro }])!.service.key).toBe("hosting-maintenance");
    // cro 2 + 0.5 now beats hosting 2
    expect(bestOffer([...hostingLow, ...croOne, fnd("no_contact_path", "nice", { confidence: "low" })], [{ ...hosting }, { ...cro }])!.service.key)
      .toBe("conversion-rate-optimization");
  });
  it("treats a finding with no confidence as full weight", () => {
    // one legacy important (2) on cro vs one low important (1) on hosting
    expect(bestOffer([fnd("no_cta", "important"), fnd("slow_mobile", "important", { confidence: "low" })], [hosting, cro])!.service.key)
      .toBe("conversion-rate-optimization");
  });
  it("caps because at 5, most severe first", () => {
    const fs = [fnd("slow_mobile", "nice"), fnd("slow_lcp", "nice"), fnd("layout_shift", "critical"), fnd("slow_mobile", "important"),
      fnd("slow_lcp", "important"), fnd("layout_shift", "nice"), fnd("slow_mobile", "important", { points: 9 })];
    const r = bestOffer(fs, [hosting])!;
    expect(r.because).toHaveLength(5);
    expect(r.because[0].severity).toBe("critical");
    expect(r.because.slice(1, 4).every((f) => f.severity === "important")).toBe(true);
  });
  it("falls back to the legacy offer's service when nothing matches", () => {
    const r = bestOffer([fnd("no_nav", "nice")], [...catalog, svc("seo", { sort: 10 })], "performance")!;
    expect(r.service.key).toBe("hosting-maintenance");
    expect(r.because).toEqual([]);
    expect(r.legacyOffer).toBe("performance");
  });
  it("falls back to the legacy offer with no findings at all", () => {
    expect(bestOffer([], catalog, "conversion")!.service.key).toBe("conversion-rate-optimization");
  });
  it("returns null with no match and no usable legacy offer", () => {
    expect(bestOffer([], catalog)).toBeNull();
    expect(bestOffer([fnd("no_nav", "nice")], catalog, null)).toBeNull();
    expect(bestOffer([], [{ ...hosting, active: false }], "performance")).toBeNull();
  });
});
