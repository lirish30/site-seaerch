import { describe, it, expect } from "vitest";
import { BIZ_MODELS, modelsText } from "../src/worker/cro/models";
import { CATALOG, catalogById, catalogFits, catalogText } from "../src/worker/cro/catalog";
import { BIZ_MODEL_KEYS, REC_AREAS } from "../src/worker/cro/types";

describe("business models and catalog", () => {
  it("covers every model with a close rate in (0, 1]", () => {
    for (const k of BIZ_MODEL_KEYS) {
      expect(BIZ_MODELS[k].closeRate).toBeGreaterThan(0);
      expect(BIZ_MODELS[k].closeRate).toBeLessThanOrEqual(1);
    }
    expect(modelsText()).toContain("lead_gen_phone");
  });

  it("has at least 40 unique, well-formed catalog items", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length);
    for (const c of CATALOG) expect(REC_AREAS).toContain(c.area);
  });

  it("filters by model", () => {
    expect(catalogFits("html_menu", "walk_in")).toBe(true);
    expect(catalogFits("html_menu", "lead_gen_phone")).toBe(false);
    expect(catalogFits("header_cta", "ecommerce")).toBe(true);
    expect(catalogFits("nope", "ecommerce")).toBe(false);
    expect(catalogById("guest_checkout")!.area).toBe("forms");
    expect(catalogText("walk_in")).toContain("html_menu");
    expect(catalogText("lead_gen_phone")).not.toContain("html_menu");
  });
});
