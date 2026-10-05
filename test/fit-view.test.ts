import { describe, expect, it } from "vitest";
import {
  compareFit, criteriaList, draftFromProfile, draftToBody, emptyDraft, fitLabel, fitSummary, friendlyMessage, hasCriteria, NULL_FIT, splitList,
} from "../src/client/fitView";
import type { FitProfile, FitResult } from "../src/client/types";

const fit = (n: number | null): FitResult => (n === null ? NULL_FIT : { fit: n, profile: { id: "p", name: "CRO", service_key: "cro" }, matched: ["industry"], missing: ["geo", "reviews"] });

describe("fit label and summary", () => {
  it("renders a null fit as a dash, never 0, and a real zero as 0", () => {
    expect(fitLabel(fit(null))).toBe("—");
    expect(fitLabel(fit(0))).toBe("0");
    expect(fitLabel(fit(67))).toBe("67");
  });
  it("lists matched and missing criteria by friendly name with the winning profile", () => {
    expect(fitSummary(fit(33))).toBe('Fit 33 against "CRO"\nMatched: Industry\nMissing: Location, Review count');
    expect(criteriaList([])).toBe("none");
  });
  it("explains a null fit instead of showing a number", () => expect(fitSummary(fit(null))).toMatch(/no active fit profile/i));
});

describe("compareFit", () => {
  const sorted = (dir: 1 | -1) => [fit(50), fit(null), fit(90), fit(0), fit(null)].sort((a, b) => compareFit(a, b, dir)).map((f) => f.fit);
  it("puts null last when ascending", () => expect(sorted(1)).toEqual([0, 50, 90, null, null]));
  it("puts null last when descending too", () => expect(sorted(-1)).toEqual([90, 50, 0, null, null]));
  it("treats two nulls as equal", () => expect(compareFit(fit(null), fit(null), -1)).toBe(0));
});

describe("profile draft", () => {
  const profile: FitProfile = { id: "p1", name: "CRO", service_key: "cro", industries: ["dentist", "plumber"], geos: [], platforms: ["wix"], min_reviews: 10, min_rating: null, active: true };
  it("round-trips a profile through the form draft", () => {
    const r = draftToBody(draftFromProfile(profile));
    expect(r).toEqual({ ok: true, body: { name: "CRO", service_key: "cro", industries: ["dentist", "plumber"], geos: [], platforms: ["wix"], min_reviews: 10, min_rating: null } });
  });
  it("splits lists on commas and newlines, trimming and de-duplicating", () => expect(splitList(" a, b\n\nc ,a")).toEqual(["a", "b", "c"]));
  it("asks for a name and a service in plain words", () => {
    expect(draftToBody(emptyDraft("cro"))).toEqual({ ok: false, error: "Give the profile a name." });
    expect(draftToBody({ ...emptyDraft(), name: "   " })).toEqual({ ok: false, error: "Give the profile a name." });
    expect(draftToBody({ ...emptyDraft(), name: "X" })).toEqual({ ok: false, error: "Pick the service this profile is for." });
  });
  it("rejects bad numbers and treats empty numbers as no criterion", () => {
    const d = { ...emptyDraft("cro"), name: "X" };
    expect(draftToBody({ ...d, min_reviews: "2.5" })).toMatchObject({ ok: false });
    expect(draftToBody({ ...d, min_reviews: "-1" })).toMatchObject({ ok: false });
    expect(draftToBody({ ...d, min_rating: "6" })).toMatchObject({ ok: false });
    expect(draftToBody({ ...d, min_rating: "abc" })).toMatchObject({ ok: false });
    expect(draftToBody({ ...d, min_reviews: "0", min_rating: "4.5" })).toMatchObject({ ok: true, body: { min_reviews: 0, min_rating: 4.5 } });
    expect(draftToBody(d)).toMatchObject({ ok: true, body: { min_reviews: null, min_rating: null } });
  });
  it("flags a profile with no criteria", () => {
    const r = draftToBody({ ...emptyDraft("cro"), name: "X" });
    expect(r.ok && hasCriteria(r.body)).toBe(false);
    const r2 = draftToBody({ ...emptyDraft("cro"), name: "X", min_reviews: "0" });
    expect(r2.ok && hasCriteria(r2.body)).toBe(true);
  });
  it("hides raw schema text from server errors but keeps readable ones", () => {
    expect(friendlyMessage("name: String must contain at least 1 character(s)")).toBe("the server rejected those values");
    expect(friendlyMessage("service_key is not a service in the catalog")).toBe("service_key is not a service in the catalog");
  });
});
