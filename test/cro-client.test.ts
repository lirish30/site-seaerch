import { describe, it, expect } from "vitest";
import {
  effectiveModel, stepIndex, STEP_LABEL, MODE_LABEL, EVIDENCE_FAMILY_LABEL,
  splitRoadmap, neighborOf, parseScenarioForm, scenarioToForm, parseAssumptionsForm, rebuildVisible, rebuildNeedsPatch,
} from "../src/client/cro";
import type { CroItem } from "../src/client/cro";
import { model, ranked } from "./fixtures/cro";

describe("client CRO helpers", () => {
  it("merges overrides over the inferred model", () => {
    expect(effectiveModel({ business_model: model(), model_overrides: { traffic_tier: "high" } } as any)!.traffic_tier).toBe("high");
    expect(effectiveModel({ business_model: null, model_overrides: {} } as any)).toBeNull();
  });
  it("maps steps to stepper positions", () => {
    expect(STEP_LABEL.map(([s]) => s)).toEqual(["capture", "evidence", "model", "pages", "synthesize"]);
    expect(stepIndex("pages")).toBe(3);
    expect(stepIndex("done")).toBe(5);
    expect(MODE_LABEL.fix_measure).toBe("Fix & measure");
  });
  it("labels every evidence family without jargon", () => {
    for (const f of ["cta", "nav", "contact", "form", "flow", "trust", "copy", "martech", "listing", "health"] as const) {
      expect(EVIDENCE_FAMILY_LABEL[f]).toBeTruthy();
      expect(EVIDENCE_FAMILY_LABEL[f]).not.toMatch(/\bcta\b|lcp|cro|pxl/i);
    }
  });
});

const item = (id: string, rank: number, horizon: 30 | 60 | 90, included = true): CroItem =>
  ({ ...ranked({ title: id }), id, cro_audit_id: "a", rank, horizon, included, edited: false, created_at: "2026-01-01" });

describe("splitRoadmap", () => {
  const items = [
    item("a", 1, 30), item("b", 2, 60), item("c", 3, 30), item("d", 4, 30, false), item("e", 5, 30), item("f", 6, 30),
    item("g", 7, 30), item("h", 8, 90), item("i", 9, 30), item("j", 10, 30),
  ];
  const s = splitRoadmap([...items].reverse());
  it("takes the first five included 30-day items in rank order as 'Do this month'", () => {
    expect(s.month.map((i) => i.id)).toEqual(["a", "c", "e", "f", "g"]);
  });
  it("puts everything else included into 30/60/90 columns, still in rank order", () => {
    expect(s.columns[30].map((i) => i.id)).toEqual(["i", "j"]);
    expect(s.columns[60].map((i) => i.id)).toEqual(["b"]);
    expect(s.columns[90].map((i) => i.id)).toEqual(["h"]);
  });
  it("keeps hidden items out of the roadmap but returns them", () => {
    expect(s.hidden.map((i) => i.id)).toEqual(["d"]);
  });
  it("finds the neighbour to swap ranks with, across the month/30-day boundary", () => {
    const byId = (id: string) => items.find((i) => i.id === id)!;
    expect(neighborOf(s, byId("a"), -1)).toBeNull();
    expect(neighborOf(s, byId("a"), 1)!.id).toBe("c");
    expect(neighborOf(s, byId("g"), 1)!.id).toBe("i");
    expect(neighborOf(s, byId("i"), -1)!.id).toBe("g");
    expect(neighborOf(s, byId("j"), 1)).toBeNull();
    expect(neighborOf(s, byId("b"), 1)).toBeNull();
    expect(neighborOf(s, byId("d"), 1)).toBeNull();
  });
});

describe("parseScenarioForm", () => {
  const ok = { visitors: "2000", currentRate: "2", targetRate: "3.5", closeRate: "40", dealValue: "900" };
  it("converts percentages to fractions", () => {
    expect(parseScenarioForm(ok)).toEqual({ ok: true, value: { visitors: 2000, currentRate: 0.02, targetRate: 0.035, closeRate: 0.4, dealValue: 900 } });
  });
  it("round-trips stored inputs into the form", () => {
    const f = scenarioToForm({ visitors: 2000, currentRate: 0.02, targetRate: 0.035, closeRate: 0.4, dealValue: 900 });
    expect(f).toEqual(ok);
  });
  it("rejects blanks, non-numbers, negatives and out-of-range rates", () => {
    expect(parseScenarioForm({ ...ok, visitors: "" }).ok).toBe(false);
    expect(parseScenarioForm({ ...ok, visitors: "abc" }).ok).toBe(false);
    expect(parseScenarioForm({ ...ok, visitors: "-1" }).ok).toBe(false);
    expect(parseScenarioForm({ ...ok, dealValue: "-5" }).ok).toBe(false);
    expect(parseScenarioForm({ ...ok, closeRate: "101" }).ok).toBe(false);
    expect(parseScenarioForm({ ...ok, currentRate: "-0.1" }).ok).toBe(false);
    expect(parseScenarioForm({ ...ok, dealValue: "Infinity" }).ok).toBe(false);
    expect(parseScenarioForm({ ...ok, visitors: "2000000000" }).ok).toBe(false);
  });
});

describe("parseAssumptionsForm", () => {
  const m = model();
  const same = { model: m.model, primary: m.primary_conversion, tier: m.traffic_tier, low: String(m.deal_value_band.low), high: String(m.deal_value_band.high), cycle: m.sales_cycle.label };
  it("sends only the fields that changed", () => {
    expect(parseAssumptionsForm(same, m)).toEqual({ ok: true, value: {} });
    expect(parseAssumptionsForm({ ...same, tier: "high", primary: "  Book a visit " }, m))
      .toEqual({ ok: true, value: { traffic_tier: "high", primary_conversion: "Book a visit" } });
    expect(parseAssumptionsForm({ ...same, low: "500" }, m))
      .toEqual({ ok: true, value: { deal_value_band: { low: 500, high: m.deal_value_band.high } } });
  });
  it("rejects bad values", () => {
    expect(parseAssumptionsForm({ ...same, primary: "  " }, m).ok).toBe(false);
    expect(parseAssumptionsForm({ ...same, cycle: "" }, m).ok).toBe(false);
    expect(parseAssumptionsForm({ ...same, low: "2000", high: "100" }, m).ok).toBe(false);
    expect(parseAssumptionsForm({ ...same, low: "x" }, m).ok).toBe(false);
    expect(parseAssumptionsForm({ ...same, high: "-1" }, m).ok).toBe(false);
  });
});

describe("rebuild button decision", () => {
  const m = model();
  const same = { model: m.model, primary: m.primary_conversion, tier: m.traffic_tier, low: String(m.deal_value_band.low), high: String(m.deal_value_band.high), cycle: m.sales_cycle.label };
  it("shows when the form differs from the saved assumptions", () => {
    expect(rebuildVisible(parseAssumptionsForm({ ...same, tier: "high" }, m), false)).toBe(true);
  });
  it("shows when the form is invalid, so the problem can be reported", () => {
    expect(rebuildVisible(parseAssumptionsForm({ ...same, primary: "" }, m), false)).toBe(true);
  });
  it("hides when nothing changed and no rebuild is owed", () => {
    expect(rebuildVisible(parseAssumptionsForm(same, m), false)).toBe(false);
  });
  it("stays visible when edits were saved but the rebuild was refused (nothing differs any more)", () => {
    expect(rebuildVisible(parseAssumptionsForm(same, m), true)).toBe(true);
  });
  it("only saves assumptions first when there is something to save", () => {
    expect(rebuildNeedsPatch({})).toBe(false);
    expect(rebuildNeedsPatch({ traffic_tier: "high" })).toBe(true);
  });
});
