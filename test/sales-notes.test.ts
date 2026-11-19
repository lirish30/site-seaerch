import { describe, it, expect } from "vitest";
import { DiscoveryNotesSchema, emptyNotes, hasNotes, monthlyAtStakeCents, type DiscoveryNotes } from "../src/worker/sales/notes";

const notes = (o: Partial<DiscoveryNotes> = {}): DiscoveryNotes => ({ ...emptyNotes(), ...o });

describe("monthlyAtStakeCents", () => {
  it("monthlyAtStake needs both owner numbers", () => {
    expect(monthlyAtStakeCents(notes({ avgJobValueCents: 40000, missedJobsPerMonth: 5 }))).toBe(200000);
    expect(monthlyAtStakeCents(notes({ avgJobValueCents: 40000, missedJobsPerMonth: null }))).toBeNull();
    expect(monthlyAtStakeCents(notes({ avgJobValueCents: null, missedJobsPerMonth: 5 }))).toBeNull();
    expect(monthlyAtStakeCents(notes())).toBeNull();
  });

  it("zero or missing job value gives null", () => {
    expect(monthlyAtStakeCents(notes({ avgJobValueCents: 0, missedJobsPerMonth: 5 }))).toBeNull();
    expect(monthlyAtStakeCents(notes({ avgJobValueCents: 40000, missedJobsPerMonth: 0 }))).toBeNull();
    expect(monthlyAtStakeCents(notes({ avgJobValueCents: null, missedJobsPerMonth: null }))).toBeNull();
  });
});

describe("DiscoveryNotesSchema", () => {
  const ok = (o: Record<string, unknown> = {}) => DiscoveryNotesSchema.safeParse({ ...emptyNotes(), ...o }).success;

  it("notes reject an answer number outside 1–10", () => {
    expect(ok({ answers: [{ n: 0, text: "x" }] })).toBe(false);
    expect(ok({ answers: [{ n: 11, text: "x" }] })).toBe(false);
    expect(ok({ answers: [{ n: 1.5, text: "x" }] })).toBe(false);
    expect(ok({ answers: [{ n: 1, text: "x" }, { n: 10, text: "y" }] })).toBe(true);
  });

  it("holds the other limits: one answer per question, text 2000, three goals, three states, the two owner numbers", () => {
    expect(ok({ answers: [{ n: 2, text: "a" }, { n: 2, text: "b" }] })).toBe(false);
    expect(ok({ answers: [{ n: 2, text: "x".repeat(2001) }] })).toBe(false);
    expect(ok({ goals: ["a", "b", "c", "d"] })).toBe(false);
    expect(ok({ goals: ["x".repeat(201)] })).toBe(false);
    expect(ok({ currentState: ["a", "b", "c", "d"] })).toBe(false);
    expect(ok({ avgJobValueCents: 10_000_001 })).toBe(false);
    expect(ok({ avgJobValueCents: 10_000_000 })).toBe(true);
    expect(ok({ avgJobValueCents: 12.5 })).toBe(false);
    expect(ok({ missedJobsPerMonth: 1001 })).toBe(false);
    expect(ok({ missedJobsPerMonth: -1 })).toBe(false);
    expect(ok({ decisionMakers: "x".repeat(301) })).toBe(false);
    expect(ok({ platform: "squarespace" })).toBe(false);
    expect(ok({ callHeldAt: "not a date" })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
  });
});

describe("hasNotes", () => {
  it("is true only when Logan wrote an answer (the owner's own words are what a recap is built from)", () => {
    expect(hasNotes(null)).toBe(false);
    expect(hasNotes(notes())).toBe(false);
    expect(hasNotes(notes({ answers: [{ n: 1, text: "   " }], goals: ["a goal"] }))).toBe(false);
    expect(hasNotes(notes({ answers: [{ n: 1, text: "water heaters" }] }))).toBe(true);
  });
});
