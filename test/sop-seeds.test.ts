import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSeedSops, getTemplate, listTemplates, saveTemplate } from "../src/worker/db/sops";
import { SEED_SOPS } from "../src/worker/sop/seeds";
import { SopTemplateInputSchema, validateTemplate } from "../src/worker/sop/model";

const build = () => SEED_SOPS.find((t) => t.key === "BUILD")!;
const BANNED = /webfor|josh|\bhall\b|course|web kit|pait|divi\b|loom|linear\b/i;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
});

describe("SEED_SOPS", () => {
  it("every seed passes validateTemplate", () => {
    expect(SEED_SOPS.map((t) => t.key)).toEqual(["BUILD", "QUICKFIX", "CARE-0", "CARE-1", "CARE-4", "CARE-5", "CARE-3"]);
    for (const t of SEED_SOPS) {
      expect(validateTemplate(t), t.key).toEqual([]);
      const parsed = SopTemplateInputSchema.safeParse(t);
      expect(parsed.success, t.key).toBe(true);
    }
  });

  it("BUILD has nine phases and between 45 and 60 steps", () => {
    const b = build();
    expect(b).toMatchObject({ name: "Website build", kind: "project", appliesTo: ["starter_site", "growth_site", "website_subscription"] });
    expect(b.steps.length).toBeGreaterThanOrEqual(45);
    expect(b.steps.length).toBeLessThanOrEqual(60);
    const phases = [...new Set(b.steps.map((s) => s.phaseTitle))];
    expect(phases).toEqual(["Collect", "Plan", "Design", "Initial review", "Build out", "QA and final review", "Launch", "Handoff", "Care offer"]);
    // Each phase title belongs to one phase key and its steps sit together.
    expect(new Set(b.steps.map((s) => s.phaseKey)).size).toBe(9);
  });

  it("go live requires every QA step, the backup and the client OK", () => {
    const b = build();
    const live = b.steps.find((s) => s.key === "7.4")!;
    expect(live.title).toBe("Go live");
    const qa = b.steps.filter((s) => s.phaseTitle === "QA and final review").map((s) => s.key);
    expect(qa.length).toBeGreaterThanOrEqual(9);
    for (const k of qa) expect(live.requires).toContain(k);
    expect(live.requires).toContain("7.2");
    expect(live.requires).toContain("6.8");
    expect(b.steps.find((s) => s.key === "7.2")!.title).toMatch(/backup/i);
  });

  it("design_approved and site_finished are each on exactly one BUILD step", () => {
    const b = build();
    expect(b.steps.filter((s) => s.milestone === "design_approved").map((s) => s.key)).toEqual(["4.5"]);
    expect(b.steps.filter((s) => s.milestone === "site_finished").map((s) => s.key)).toEqual(["6.8"]);
    for (const t of SEED_SOPS.filter((x) => x.key !== "BUILD")) expect(t.steps.some((s) => s.milestone)).toBe(false);
  });

  it("holds the review rule: partial design first, short video, forms early, final review before launch", () => {
    const b = build();
    const text = (k: string) => b.steps.find((s) => s.key === k)!;
    expect(text("3.4").title).toMatch(/home page and one or two inner pages/i);
    expect(text("4.1").doneWhen).toMatch(/five minutes or less/i);
    expect(text("6.8").doneWhen).toMatch(/mid-week/i);
    expect(text("7.3").title).toMatch(/Friday/);
    // Everything after the preview waits for the client's OK on the design.
    expect(text("5.1").requires).toContain("4.5");
    // Forms are built before the other pages, so they can be tested early.
    expect(text("5.2").title).toMatch(/forms/i);
    expect(text("5.3").position).toBeGreaterThan(text("5.2").position);
    expect(text("6.2").title).toMatch(/form/i);
  });

  it("the step that turns client feedback into tasks is Logan's, since Claude must not start it before feedback exists", () => {
    expect(build().steps.find((s) => s.key === "4.3")).toMatchObject({ owner: "logan", title: "Turn the client's feedback into a task list" });
  });

  it("onboarding is one gate step, not the old collect steps", () => {
    const b = build();
    expect(b.steps[0]).toMatchObject({ key: "1.1", title: "Onboarding collected", owner: "logan" });
    expect(b.steps.some((s) => /welcome|questionnaire|reminder/i.test(s.title))).toBe(false);
  });

  it("about ten BUILD steps carry a client summary", () => {
    const n = build().steps.filter((s) => s.clientSummary).length;
    expect(n).toBeGreaterThanOrEqual(8);
    expect(n).toBeLessThanOrEqual(14);
  });

  it("no seed step title or doneWhen names a course or Webfor", () => {
    for (const t of SEED_SOPS) {
      expect(t.name).not.toMatch(BANNED);
      for (const s of t.steps) {
        for (const text of [s.title, s.doneWhen, s.clientSummary ?? "", s.phaseTitle]) expect(text, `${t.key} ${s.key}`).not.toMatch(BANNED);
      }
    }
  });

  it("every clientSummary is 80 characters or less", () => {
    for (const t of SEED_SOPS) for (const s of t.steps) if (s.clientSummary) expect(s.clientSummary.length, `${t.key} ${s.key}`).toBeLessThanOrEqual(80);
  });

  it("no seed text names a login value or uses an em dash", () => {
    for (const t of SEED_SOPS) for (const s of t.steps) {
      expect(`${s.title} ${s.doneWhen} ${s.clientSummary ?? ""}`, `${t.key} ${s.key}`).not.toMatch(/—|–/);
    }
  });

  it("QUICKFIX is one phase of about eight steps ending in a review request", () => {
    const q = SEED_SOPS.find((t) => t.key === "QUICKFIX")!;
    expect(q).toMatchObject({ name: "Quick fix", appliesTo: ["quick_fix"] });
    expect(new Set(q.steps.map((s) => s.phaseKey)).size).toBe(1);
    expect(q.steps).toHaveLength(8);
    expect(q.steps.at(-1)!.title).toMatch(/review/i);
  });

  it("the care templates have the steps and cadence from the brief", () => {
    const c0 = SEED_SOPS.find((t) => t.key === "CARE-0")!;
    expect(c0).toMatchObject({ name: "Care onboarding", kind: "project", appliesTo: ["care", "care_plus", "care_fallback"] });
    expect(c0.steps).toHaveLength(9);
    const c1 = SEED_SOPS.find((t) => t.key === "CARE-1")!;
    expect(c1).toMatchObject({ name: "Care weekly update", kind: "recurring", cadence: "weekly", cadenceDay: 3 });
    expect(c1.steps).toHaveLength(6);
    const c4 = SEED_SOPS.find((t) => t.key === "CARE-4")!;
    expect(c4).toMatchObject({ name: "Care monthly report", kind: "recurring", cadence: "monthly", cadenceDay: 5 });
    expect(c4.steps).toHaveLength(6);
    const c5 = SEED_SOPS.find((t) => t.key === "CARE-5")!;
    expect(c5).toMatchObject({ name: "Care incident", kind: "project", cadence: null, active: true, appliesTo: ["care", "care_plus", "care_fallback"] });
    expect(c5.steps.map((s) => [s.title, s.owner])).toEqual([["Contain it", "claude"], ["Restore or clean up", "claude_drafts"], ["Tell the client", "claude_drafts"], ["Write the post-incident note", "claude_drafts"]]);
    const c3 = SEED_SOPS.find((t) => t.key === "CARE-3")!;
    expect(c3).toMatchObject({ name: "Care edit request", kind: "project", cadence: null, active: true, appliesTo: ["care", "care_plus", "care_fallback"] });
    expect(c3.steps.map((s) => [s.title, s.owner])).toEqual([
      ["Log the request", "claude"], ["Check the scope", "claude_drafts"], ["Make the change and take before and after pictures", "claude"],
      ["Approve, publish and reply", "claude_drafts"], ["Log the minutes", "claude"],
    ]);
  });
});

describe("ensureSeedSops", () => {
  it("ensureSeedSops inserts seven and a second call inserts none", async () => {
    expect(await ensureSeedSops(env.DB)).toBe(7);
    expect(await ensureSeedSops(env.DB)).toBe(0);
    const all = await listTemplates(env.DB);
    expect(all.map((t) => t.key)).toEqual(["BUILD", "QUICKFIX", "CARE-0", "CARE-1", "CARE-4", "CARE-5", "CARE-3"]);
    expect(all.every((t) => t.version === 1 && t.active)).toBe(true);
    for (const seed of SEED_SOPS) {
      const stored = all.find((t) => t.key === seed.key)!;
      expect(stored.steps, seed.key).toEqual(seed.steps);
      expect(stored.appliesTo).toEqual(seed.appliesTo);
    }
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sop_template_steps`).first<{ n: number }>();
    expect(rows!.n).toBe(SEED_SOPS.reduce((n, t) => n + t.steps.length, 0));
  });

  it("an edited seed is not overwritten by ensureSeedSops", async () => {
    await ensureSeedSops(env.DB);
    const b = (await getTemplate(env.DB, "BUILD"))!;
    await saveTemplate(env.DB, { ...b, name: "My build", steps: b.steps.slice(0, 3).map((s) => ({ ...s, requires: [] })) });
    expect(await ensureSeedSops(env.DB)).toBe(0);
    const after = (await getTemplate(env.DB, "BUILD"))!;
    expect(after).toMatchObject({ name: "My build", version: 2 });
    expect(after.steps).toHaveLength(3);
  });

  it("a missing seed is put back without touching the others", async () => {
    await ensureSeedSops(env.DB);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sop_template_steps WHERE template_id = (SELECT id FROM sop_templates WHERE key = 'QUICKFIX')`),
      env.DB.prepare(`DELETE FROM sop_templates WHERE key = 'QUICKFIX'`),
    ]);
    expect(await ensureSeedSops(env.DB)).toBe(1);
    expect((await getTemplate(env.DB, "QUICKFIX"))!.steps).toHaveLength(8);
    expect((await getTemplate(env.DB, "BUILD"))!.version).toBe(1);
  });
});
