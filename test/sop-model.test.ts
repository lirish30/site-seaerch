import { describe, it, expect } from "vitest";
import { SopTemplateInputSchema, unmetRequirements, validateTemplate, OWNER_LABEL, type SopStep, type SopTemplateInput, type TaskStatus } from "../src/worker/sop/model";

const step = (key: string, o: Partial<SopStep> = {}): SopStep => ({
  key, phaseKey: "p1", phaseTitle: "Phase one", position: Number(key.replace(/\D/g, "")) || 1, title: `Step ${key}`, owner: "claude", estMinutes: 10, doneWhen: "It is done.",
  docTemplate: null, emailTemplate: null, requires: [], milestone: null, clientSummary: null, skippable: false, ...o,
});
const tpl = (steps: SopStep[], o: Partial<SopTemplateInput> = {}): SopTemplateInput => ({
  key: "T1", name: "Test", kind: "project", cadence: null, cadenceDay: null, appliesTo: ["starter_site"], active: true, steps, ...o,
});

describe("validateTemplate", () => {
  it("a clean template has no problems", () => {
    expect(validateTemplate(tpl([step("1"), step("2", { requires: ["1"] }), step("3", { requires: ["1", "2"] })]))).toEqual([]);
  });

  it("a requires cycle is a problem", () => {
    const problems = validateTemplate(tpl([step("1", { requires: ["3"] }), step("2", { requires: ["1"] }), step("3", { requires: ["2"] })]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/loop/);
  });

  it("requires an unknown key is a problem", () => {
    const problems = validateTemplate(tpl([step("1", { requires: ["9"] })]));
    expect(problems).toEqual(["Step 1 requires 9, which is not a step in this template."]);
  });

  it("a step that requires itself is a problem", () => {
    expect(validateTemplate(tpl([step("1", { requires: ["1"] })]))).toEqual(["Step 1 requires itself."]);
  });

  it("a duplicate step key is a problem", () => {
    const problems = validateTemplate(tpl([step("1"), step("1", { position: 2 })]));
    expect(problems).toContain("The step key 1 is used twice.");
  });

  it("two steps with one milestone is a problem", () => {
    const problems = validateTemplate(tpl([step("1", { milestone: "design_approved" }), step("2", { milestone: "design_approved" })]));
    expect(problems).toEqual(["The milestone design_approved is on more than one step (1, 2)."]);
    expect(validateTemplate(tpl([step("1", { milestone: "design_approved" }), step("2", { milestone: "site_finished" })]))).toEqual([]);
  });

  it("a milestone on a recurring template is a problem", () => {
    const problems = validateTemplate(tpl([step("1", { milestone: "site_finished" })], { kind: "recurring", cadence: "monthly", cadenceDay: 5 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/recurring template cannot have a milestone/);
  });

  it("positions that do not strictly increase are a problem", () => {
    expect(validateTemplate(tpl([step("1", { position: 2 }), step("2", { position: 2 })]))).toHaveLength(1);
    expect(validateTemplate(tpl([step("1", { position: 5 }), step("2", { position: 3 })]))).toHaveLength(1);
  });

  it("a recurring template needs a cadence and a weekly one needs a weekday 1 to 7", () => {
    const rec = (o: Partial<SopTemplateInput>) => tpl([step("1")], { kind: "recurring", ...o });
    expect(validateTemplate(rec({ cadence: null }))[0]).toMatch(/needs a cadence/);
    expect(validateTemplate(rec({ cadence: "weekly", cadenceDay: null }))[0]).toMatch(/weekday/);
    expect(validateTemplate(rec({ cadence: "weekly", cadenceDay: 8 }))[0]).toMatch(/weekday/);
    expect(validateTemplate(rec({ cadence: "weekly", cadenceDay: 0 }))[0]).toMatch(/weekday/);
    expect(validateTemplate(rec({ cadence: "weekly", cadenceDay: 7 }))).toEqual([]);
    expect(validateTemplate(rec({ cadence: "monthly", cadenceDay: 29 }))[0]).toMatch(/day of the month/);
    expect(validateTemplate(rec({ cadence: "monthly", cadenceDay: 28 }))).toEqual([]);
    expect(validateTemplate(tpl([step("1")], { cadence: "weekly", cadenceDay: 3 }))[0]).toMatch(/Only a recurring/);
    for (const bad of [rec({ cadence: null }), rec({ cadence: "weekly", cadenceDay: 8 }), rec({ cadence: "monthly", cadenceDay: 0 })]) {
      expect(SopTemplateInputSchema.safeParse(bad).success).toBe(false);
    }
    expect(SopTemplateInputSchema.safeParse(rec({ cadence: "weekly", cadenceDay: 3 })).success).toBe(true);
  });
});

describe("SopTemplateInputSchema", () => {
  const ok = () => tpl([step("1")]);
  it("accepts a clean template", () => {
    expect(SopTemplateInputSchema.safeParse(ok()).success).toBe(true);
  });

  it("holds the length and range caps", () => {
    const bad = (t: SopTemplateInput) => SopTemplateInputSchema.safeParse(t).success;
    expect(bad(tpl([step("1")], { key: "has space" }))).toBe(false);
    expect(bad(tpl([step("1")], { key: "x".repeat(21) }))).toBe(false);
    expect(bad(tpl([step("1")], { name: "n".repeat(81) }))).toBe(false);
    expect(bad(tpl([step("1", { title: "t".repeat(121) })]))).toBe(false);
    expect(bad(tpl([step("1", { title: "t".repeat(120) })]))).toBe(true);
    expect(bad(tpl([step("1", { doneWhen: "d".repeat(301) })]))).toBe(false);
    expect(bad(tpl([step("1", { estMinutes: 601 })]))).toBe(false);
    expect(bad(tpl([step("1", { estMinutes: -1 })]))).toBe(false);
    expect(bad(tpl([step("1", { estMinutes: 1.5 })]))).toBe(false);
    expect(bad(tpl([step("1", { clientSummary: "c".repeat(81) })]))).toBe(false);
    expect(bad(tpl([step("1", { clientSummary: "c".repeat(80) })]))).toBe(true);
    expect(bad(tpl([step("1", { owner: "someone" as unknown as "claude" })]))).toBe(false);
    expect(bad(tpl([step("1")], { appliesTo: ["not_a_package" as unknown as "care"] }))).toBe(false);
    const many = Array.from({ length: 121 }, (_, i) => step(String(i + 1)));
    expect(bad(tpl(many))).toBe(false);
    expect(bad(tpl(many.slice(0, 120)))).toBe(true);
  });
});

describe("unmetRequirements", () => {
  const t = (stepKey: string | null, status: TaskStatus, o: { skippable?: boolean; title?: string } = {}) => ({
    stepKey, title: o.title ?? `Title ${stepKey}`, status, skippable: o.skippable ?? false,
  });

  it("counts done, counts skipped only when skippable, and names a missing key", () => {
    const tasks = [
      t("a", "done"), t("b", "skipped", { skippable: true }), t("c", "skipped"), t("d", "todo"), t("e", "in_review"), t("f", "locked"), t("g", "waiting_client"), t(null, "done"),
    ];
    expect(unmetRequirements(["a", "b"], tasks)).toEqual([]);
    expect(unmetRequirements(["a", "c", "d", "e", "f", "g"], tasks)).toEqual(["Title c", "Title d", "Title e", "Title f", "Title g"]);
    expect(unmetRequirements(["a", "zzz"], tasks)).toEqual(["zzz"]);
    expect(unmetRequirements([], tasks)).toEqual([]);
  });
});

describe("OWNER_LABEL", () => {
  it("labels every owner tag", () => {
    expect(OWNER_LABEL).toEqual({ claude: "Claude", logan: "Logan", claude_drafts: "Claude drafts → Logan approves" });
  });
});
