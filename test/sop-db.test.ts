import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSeedSops, getTemplate, listTemplates, saveTemplate, setTemplateActive, SopInputError, templatesForPackages } from "../src/worker/db/sops";
import type { SopStep, SopTemplateInput } from "../src/worker/sop/model";

const step = (key: string, o: Partial<SopStep> = {}): SopStep => ({
  key, phaseKey: "p1", phaseTitle: "Phase one", position: Number(key) || 1, title: `Step ${key}`, owner: "claude", estMinutes: 10, doneWhen: "It is done.",
  docTemplate: null, emailTemplate: null, requires: [], milestone: null, clientSummary: null, skippable: false, ...o,
});
const tpl = (o: Partial<SopTemplateInput> = {}): SopTemplateInput => ({
  key: "T1", name: "Test template", kind: "project", cadence: null, cadenceDay: null, appliesTo: ["starter_site"], active: true,
  steps: [step("1"), step("2", { requires: ["1"], milestone: "design_approved", clientSummary: "We are on it", skippable: true, docTemplate: "doc-a", emailTemplate: "mail-a" })], ...o,
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
});

describe("saveTemplate", () => {
  it("inserts then replaces steps and bumps version", async () => {
    const a = await saveTemplate(env.DB, tpl());
    expect(a).toMatchObject({ key: "T1", name: "Test template", kind: "project", cadence: null, cadenceDay: null, appliesTo: ["starter_site"], version: 1, active: true });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(a.steps.map((s) => s.key)).toEqual(["1", "2"]);
    expect(a.steps[1]).toEqual(step("2", { requires: ["1"], milestone: "design_approved", clientSummary: "We are on it", skippable: true, docTemplate: "doc-a", emailTemplate: "mail-a" }));

    const b = await saveTemplate(env.DB, tpl({ name: "Renamed", steps: [step("1"), step("3", { title: "Third" }), step("4", { requires: ["3"] })] }));
    expect(b.id).toBe(a.id);
    expect(b.version).toBe(2);
    expect(b.name).toBe("Renamed");
    expect(b.steps.map((s) => s.key)).toEqual(["1", "3", "4"]);
    expect((await getTemplate(env.DB, "T1"))!.steps).toHaveLength(3);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sop_template_steps`).first<{ n: number }>();
    expect(left!.n).toBe(3);
    expect((await listTemplates(env.DB))).toHaveLength(1);
  });

  it("saveTemplate with problems throws SopInputError and changes nothing", async () => {
    await saveTemplate(env.DB, tpl());
    const cyc = tpl({ name: "Bad", steps: [step("1", { requires: ["2"] }), step("2", { requires: ["1"] })] });
    const err = await saveTemplate(env.DB, cyc).catch((e) => e);
    expect(err).toBeInstanceOf(SopInputError);
    expect((err as SopInputError).problems.length).toBeGreaterThan(0);
    const after = (await getTemplate(env.DB, "T1"))!;
    expect(after.version).toBe(1);
    expect(after.name).toBe("Test template");
    expect(after.steps.map((s) => s.key)).toEqual(["1", "2"]);

    // A template that fails the schema (a recurring one with no cadence) is refused too, and a new key is not created.
    await expect(saveTemplate(env.DB, tpl({ key: "T2", kind: "recurring" }))).rejects.toBeInstanceOf(SopInputError);
    expect(await getTemplate(env.DB, "T2")).toBeNull();
  });

  it("saves a recurring template with its cadence", async () => {
    const t = await saveTemplate(env.DB, tpl({ key: "R1", kind: "recurring", cadence: "weekly", cadenceDay: 3, steps: [step("1")] }));
    expect(t).toMatchObject({ kind: "recurring", cadence: "weekly", cadenceDay: 3 });
  });
});

describe("listTemplates and setTemplateActive", () => {
  it("an inactive template is not returned", async () => {
    await saveTemplate(env.DB, tpl());
    await saveTemplate(env.DB, tpl({ key: "T2", appliesTo: ["starter_site", "care"] }));
    expect((await listTemplates(env.DB)).map((t) => t.key)).toEqual(["T1", "T2"]);
    expect(await setTemplateActive(env.DB, "T1", false)).toBe(true);
    expect((await listTemplates(env.DB)).map((t) => t.key)).toEqual(["T2"]);
    expect((await listTemplates(env.DB, { includeInactive: true })).map((t) => t.key)).toEqual(["T1", "T2"]);
    expect((await templatesForPackages(env.DB, ["starter_site"])).map((t) => t.key)).toEqual(["T2"]);
    expect((await getTemplate(env.DB, "T1"))!.active).toBe(false);
    expect(await setTemplateActive(env.DB, "T1", true)).toBe(true);
    expect((await getTemplate(env.DB, "T1"))!.version).toBe(1);
    expect(await setTemplateActive(env.DB, "nope", true)).toBe(false);
    expect(await getTemplate(env.DB, "nope")).toBeNull();
  });
});

describe("templatesForPackages", () => {
  beforeEach(async () => { await ensureSeedSops(env.DB); });

  it('templatesForPackages(["starter_site","care"]) returns BUILD and CARE-0', async () => {
    expect((await templatesForPackages(env.DB, ["starter_site", "care"])).map((t) => t.key)).toEqual(["BUILD", "CARE-0"]);
  });

  it("quick_fix alone returns QUICKFIX", async () => {
    expect((await templatesForPackages(env.DB, ["quick_fix"])).map((t) => t.key)).toEqual(["QUICKFIX"]);
  });

  it("local_seo alone returns SEO-0, and no packages return nothing", async () => {
    expect((await templatesForPackages(env.DB, ["local_seo"])).map((t) => t.key)).toEqual(["SEO-0"]);
    expect(await templatesForPackages(env.DB, [])).toEqual([]);
  });

  it("a recurring template is never returned for a package", async () => {
    const keys = (await templatesForPackages(env.DB, ["care", "care_plus", "care_fallback"])).map((t) => t.key);
    expect(keys).toEqual(["CARE-0"]);
  });
});
