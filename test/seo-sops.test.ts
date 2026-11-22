import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, setPaid, signDocument } from "../src/worker/db/documents";
import { insertInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { addCadence, listCadences, listProjects, setProjectStatus, createProject } from "../src/worker/db/projects";
import { ensureSeedSops, getTemplate, listTemplates, templatesForPackages } from "../src/worker/db/sops";
import { getTask, listTasks, patchTask } from "../src/worker/db/tasks";
import { onInvoicePaid } from "../src/worker/documents/deposit";
import type { ProposalContent } from "../src/worker/documents/proposal";
import type { Env } from "../src/worker/env";
import { soldAndPaid } from "../src/worker/money/sold";
import { dispatchReady } from "../src/worker/projects/dispatch";
import { clearProjectHooksForTests } from "../src/worker/projects/hooks";
import { completeTask } from "../src/worker/projects/service";
import { startProjects, startProjectsForPaidDocuments } from "../src/worker/projects/start";
import { generateRecurring } from "../src/worker/projects/sweep";
import { SOP_STEP_KIND } from "../src/worker/queue/sopStep";
import "../src/worker/queue/kinds";
import { tickSeo1 } from "../src/worker/seo/tasks";
import { SEED_SOPS } from "../src/worker/sop/seeds";
import { SopTemplateInputSchema, validateTemplate } from "../src/worker/sop/model";
import { clientSig, proposal, seedDeal, sendDraft } from "./fixtures/documents";
import { resetProjectWork, seedProject, seedSteps } from "./fixtures/projects";

const e = env as Env;
const FAR = "2099-01-01T00:00:00.000Z";
const NOW = new Date("2026-12-03T10:00:00.000Z"); // Los Angeles: 3 December 2026, month 2026-12, quarter 2026-Q4, year 2026
const OLD_KEYS = ["BUILD", "QUICKFIX", "CARE-0", "CARE-1", "CARE-4", "CARE-5", "CARE-3"];
const SEO_KEYS = ["SEO-0", "SEO-1", "SEO-2", "SEO-3"];

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearProjectHooksForTests();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

type Pkg = ProposalContent["packages"][number];
const pkg = (key: Pkg["key"], name: string): Pkg => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });
const STARTER = pkg("starter_site", "Starter Site");
const CARE = pkg("care", "Care");
const SEO = pkg("local_seo", "Local SEO");
const SEO_GROWTH = pkg("local_seo_growth", "Local SEO Growth");

/** A signed proposal with its deposit invoice, for a real or test deal. */
async function seed(o: { test?: boolean; packages: Pkg[] }) {
  const s = await seedDeal();
  const base = proposal();
  const schedule = { ...base.schedule, milestones: [{ id: "deposit", label: "Deposit", dueOn: "signing" as const, amountCents: 199850 }] };
  const content: ProposalContent = { ...base, packages: o.packages, careDeclined: false, schedule };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
  const invoice = await insertInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: "cus_1",
    stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, amountCents: 199850, hostedUrl: "https://invoice.stripe.com/i/x",
  });
  return { ...s, doc: (await getDocument(env.DB, doc.id))!, invoice };
}
type Seeded = Awaited<ReturnType<typeof seed>>;
const pay = (s: Seeded) => onInvoicePaid(e, s.invoice as InvoiceRow);
const projectsOf = async (businessId: string) => (await listProjects(env.DB, { businessId })).sort((a, b) => a.templateKey!.localeCompare(b.templateKey!));
const keysOf = async (businessId: string) => (await projectsOf(businessId)).map((p) => p.templateKey);
const lines = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const jobs = async () => (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ?`).bind(SOP_STEP_KIND).all()).results;
const seo = (key: string) => SEED_SOPS.find((t) => t.key === key)!;

describe("the SEO seeds", () => {
  it("every seed passes validateTemplate and the SOP input schema, and the four new ones come after the old seven", () => {
    expect(SEED_SOPS.map((t) => t.key)).toEqual([...OLD_KEYS, ...SEO_KEYS]);
    for (const t of SEED_SOPS) {
      expect(validateTemplate(t), t.key).toEqual([]);
      expect(SopTemplateInputSchema.safeParse(t).success, t.key).toBe(true);
    }
  });

  it("SEO-0 is a project for both Local SEO packages with the ten steps of the brief, in order", () => {
    const t = seo("SEO-0");
    expect(t).toMatchObject({ name: "Local SEO onboarding", kind: "project", cadence: null, cadenceDay: null, active: true, appliesTo: ["local_seo", "local_seo_growth"] });
    expect(t.steps.map((s) => [s.key, s.requires])).toEqual([
      ["1.1", []], ["1.2", []], ["1.3", []], ["1.4", ["1.3"]], ["1.5", ["1.4"]], ["1.6", ["1.4"]], ["1.7", ["1.6"]], ["1.8", ["1.7"]], ["1.9", ["1.8"]],
    ]);
    const title = (k: string) => t.steps.find((s) => s.key === k)!.title;
    expect(title("1.1")).toMatch(/intake/i);
    expect(title("1.2")).toMatch(/access/i);
    expect(title("1.3")).toMatch(/profile/i);
    expect(title("1.4")).toMatch(/baseline/i);
    expect(title("1.5")).toMatch(/citation/i);
    expect(title("1.5")).toMatch(/competitor/i);
    expect(title("1.6")).toMatch(/keyword/i);
    expect(title("1.7")).toMatch(/90-day/i);
    expect(title("1.8")).toMatch(/fixes/i);
    expect(title("1.9")).toMatch(/AI/);
    const done = (k: string) => t.steps.find((s) => s.key === k)!.doneWhen;
    expect(done("1.4")).toMatch(/snapshot/);
    expect(done("1.4")).toMatch(/name, address and phone/);
    expect(done("1.4")).toMatch(/rank grid/);
    expect(done("1.6")).toMatch(/five to ten/i);
    expect(done("1.9")).toMatch(/top 10 queries/);
    expect(done("1.2")).toMatch(/never the login/);
    expect(t.steps.some((s) => s.milestone)).toBe(false);
  });

  it("SEO-1 is monthly on the 10th with the seven steps of the brief", () => {
    const t = seo("SEO-1");
    expect(t).toMatchObject({ name: "Local SEO monthly cycle", kind: "recurring", cadence: "monthly", cadenceDay: 10, appliesTo: ["local_seo", "local_seo_growth"] });
    expect(t.steps.map((s) => [s.key, s.requires])).toEqual([["1.1", []], ["1.2", []], ["1.3", []], ["1.4", []], ["1.5", []], ["1.6", []], ["1.7", ["1.1"]]]);
    expect(t.steps[0]).toMatchObject({ title: expect.stringMatching(/data/i), owner: "claude" });
    expect(t.steps[1].title).toMatch(/review replies/i);
    expect(t.steps[2].title).toMatch(/posts and photos/i);
    expect(t.steps[3].title).toMatch(/content drafts/i);
    expect(t.steps[4].doneWhen).toMatch(/indexing.*broken pages.*speed.*structured data.*sitemap/i);
    expect(t.steps[5].title).toMatch(/citations/i);
    expect(t.steps[6].title).toMatch(/report/i);
  });

  it("SEO-2 is quarterly and SEO-3 annual, both on the 15th, with three and two steps", () => {
    expect(seo("SEO-2")).toMatchObject({ name: "Local SEO quarterly review", kind: "recurring", cadence: "quarterly", cadenceDay: 15 });
    expect(seo("SEO-2").steps).toHaveLength(3);
    expect(seo("SEO-3")).toMatchObject({ name: "Local SEO annual review", kind: "recurring", cadence: "annual", cadenceDay: 15 });
    expect(seo("SEO-3").steps).toHaveLength(2);
  });

  it("the text is plain: short client lines, no dash characters, no login values, no promise of a position", () => {
    for (const k of SEO_KEYS) for (const s of seo(k).steps) {
      expect(`${s.title} ${s.doneWhen} ${s.clientSummary ?? ""}`, `${k} ${s.key}`).not.toMatch(/—|–|guarantee|first page|#1|password:/i);
      expect(s.doneWhen.length, `${k} ${s.key}`).toBeGreaterThan(0);
      if (s.clientSummary) expect(s.clientSummary.length, `${k} ${s.key}`).toBeLessThanOrEqual(80);
    }
  });

  it("a database that already has the seven old seeds gains the four, without touching the old ones", async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sop_template_steps WHERE template_id IN (SELECT id FROM sop_templates WHERE key LIKE 'SEO-%')`),
      env.DB.prepare(`DELETE FROM sop_templates WHERE key LIKE 'SEO-%'`),
      env.DB.prepare(`UPDATE sop_templates SET name = 'Mine', version = 4 WHERE key = 'CARE-0'`),
    ]);
    expect((await listTemplates(env.DB, { includeInactive: true })).map((t) => t.key)).toEqual(OLD_KEYS);
    expect(await ensureSeedSops(env.DB)).toBe(4);
    expect((await listTemplates(env.DB, { includeInactive: true })).map((t) => t.key)).toEqual([...OLD_KEYS, ...SEO_KEYS]);
    expect(await getTemplate(env.DB, "CARE-0")).toMatchObject({ name: "Mine", version: 4 });
    expect((await getTemplate(env.DB, "SEO-0"))!.steps).toEqual(seo("SEO-0").steps);
    expect(await ensureSeedSops(env.DB)).toBe(0);
  });

  it("only SEO-0 is a project template for the Local SEO packages (SEO-1 to 3 are recurring)", async () => {
    expect((await templatesForPackages(env.DB, ["local_seo"])).map((t) => t.key)).toEqual(["SEO-0"]);
    expect((await templatesForPackages(env.DB, ["local_seo_growth"])).map((t) => t.key)).toEqual(["SEO-0"]);
    expect((await templatesForPackages(env.DB, ["care", "care_plus", "care_fallback"])).map((t) => t.key)).toEqual(["CARE-0"]);
  });
});

describe("starting SEO-0", () => {
  it("a paid Local SEO document makes one custom project with its ten tasks, and no note about a missing SOP", async () => {
    const s = await seed({ packages: [SEO] });
    await pay(s);
    const ps = await projectsOf(s.businessId);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: "custom", templateKey: "SEO-0", name: "Ace Plumbing: Local SEO onboarding", status: "active", careDeferred: false, test: false, documentId: s.doc.id });
    const tasks = await listTasks(env.DB, ps[0].id);
    expect(tasks.map((t) => t.stepKey)).toEqual(seo("SEO-0").steps.map((x) => x.key));
    expect(tasks.every((t) => t.isStep)).toBe(true);
    expect((await lines(s.businessId, "note")).filter((n) => /no SOP/.test(n))).toEqual([]);
    expect(await lines(s.businessId, "project_started")).toHaveLength(1);
  });

  it("Local SEO Growth starts it too", async () => {
    const s = await seed({ packages: [SEO_GROWTH] });
    await pay(s);
    expect(await keysOf(s.businessId)).toEqual(["SEO-0"]);
  });

  it("a Starter build and Local SEO make both, the build first", async () => {
    const s = await seed({ packages: [STARTER, SEO] });
    const started = await startProjects(e, s.doc, { now: NOW });
    expect(started.map((p) => p.templateKey)).toEqual(["BUILD", "SEO-0"]);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "SEO-0"]);
    expect((await projectsOf(s.businessId)).map((p) => p.kind).sort()).toEqual(["build", "custom"]);
    expect((await lines(s.businessId, "note")).filter((n) => /no SOP/.test(n))).toEqual([]);
  });

  it("build, Care and Local SEO: the build waits for nothing of Local SEO, Care still waits for the build, and Local SEO is not part of Care", async () => {
    const s = await seed({ packages: [STARTER, CARE, SEO] });
    await pay(s);
    const ps = await projectsOf(s.businessId);
    expect(ps.map((p) => p.templateKey)).toEqual(["BUILD", "SEO-0"]);
    expect(ps[0].careDeferred).toBe(true);
    expect(ps[1].careDeferred).toBe(false);
  });

  it("Care and Local SEO with no build start both now, as separate projects", async () => {
    const s = await seed({ packages: [CARE, SEO] });
    await pay(s);
    expect(await keysOf(s.businessId)).toEqual(["CARE-0", "SEO-0"]);
  });

  it("Care-only and build-only documents are unchanged", async () => {
    const care = await seed({ packages: [CARE] });
    await pay(care);
    expect(await keysOf(care.businessId)).toEqual(["CARE-0"]);
    const build = await seed({ packages: [STARTER] });
    await pay(build);
    expect(await keysOf(build.businessId)).toEqual(["BUILD"]);
  });

  it("a package with no template still leaves its one note, and no longer names Local SEO", async () => {
    const s = await seed({ packages: [STARTER, SEO, pkg("reviews_addon", "Reviews add-on")] });
    await pay(s);
    await pay(s);
    expect((await lines(s.businessId, "note")).filter((n) => /no SOP/.test(n))).toEqual(["SL-ABCDEF v1: no SOP for Reviews add-on yet, so no project was started for it"]);
  });

  it("running the start again makes nothing new", async () => {
    const s = await seed({ packages: [STARTER, SEO] });
    await pay(s);
    const before = await projectsOf(s.businessId);
    const tasksBefore = await Promise.all(before.map(async (p) => (await listTasks(env.DB, p.id)).length));
    await pay(s);
    await startProjects(e, (await getDocument(env.DB, s.doc.id))!, { now: NOW });
    const after = await projectsOf(s.businessId);
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
    expect(await Promise.all(after.map(async (p) => (await listTasks(env.DB, p.id)).length))).toEqual(tasksBefore);
    expect(await lines(s.businessId, "project_started")).toHaveLength(2);
  });

  it("a test document starts SEO-0 as a test project that queues nothing", async () => {
    const s = await seed({ test: true, packages: [SEO] });
    const started = await startProjects(e, s.doc, { now: NOW });
    expect(started.map((p) => [p.templateKey, p.test])).toEqual([["SEO-0", true]]);
    expect(await jobs()).toEqual([]);
  });

  it("starts for a database that has only the old seven (the missing four are added on the way)", async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sop_template_steps WHERE template_id IN (SELECT id FROM sop_templates WHERE key LIKE 'SEO-%')`),
      env.DB.prepare(`DELETE FROM sop_templates WHERE key LIKE 'SEO-%'`),
    ]);
    const s = await seed({ packages: [SEO] });
    await pay(s);
    expect(await keysOf(s.businessId)).toEqual(["SEO-0"]);
    expect(await getTemplate(env.DB, "SEO-1")).not.toBeNull();
  });

  it("the daily sweep starts SEO-0 for a paid document whose build started but whose Local SEO did not, once", async () => {
    const s = await seed({ packages: [STARTER, SEO] });
    await env.DB.prepare(`UPDATE documents SET paid_at = NULL`).run(); // other tests' documents are not this one's business
    await setPaid(env.DB, s.doc.id, "2026-12-03T09:00:00.000Z");
    // The build started and the Local SEO start died after it.
    await env.DB.prepare(`UPDATE sop_templates SET active = 0 WHERE key = 'SEO-0'`).run();
    await startProjects(e, s.doc, { now: NOW });
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
    await env.DB.prepare(`UPDATE sop_templates SET active = 1 WHERE key = 'SEO-0'`).run();
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(1);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "SEO-0"]);
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(0);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "SEO-0"]);
  });
});

/** A real Local SEO client: the paid document's SEO-0 project and its tasks in step order. */
async function seoClient() {
  const s = await seed({ packages: [SEO] });
  await pay(s);
  const project = (await projectsOf(s.businessId))[0];
  return { ...s, project, tasks: await listTasks(env.DB, project.id) };
}
const finish = async (tasks: { id: string }[], upto = tasks.length) => { for (const t of tasks.slice(0, upto)) await completeTask(e, t.id, { by: "logan", now: NOW }); };
const cadenceKeys = async (projectId: string) => (await listCadences(env.DB)).filter((c) => c.projectId === projectId).map((c) => c.templateKey).sort();

describe("finishing SEO-0", () => {
  it("completing the last step attaches SEO-1, SEO-2 and SEO-3 once, and repeating it attaches nothing", async () => {
    const s = await seoClient();
    await finish(s.tasks, s.tasks.length - 1);
    expect(await cadenceKeys(s.project.id)).toEqual([]);
    await completeTask(e, s.tasks.at(-1)!.id, { by: "logan", now: NOW });
    expect((await listProjects(env.DB, { businessId: s.businessId }))[0]).toMatchObject({ status: "done" });
    expect(await cadenceKeys(s.project.id)).toEqual(["SEO-1", "SEO-2", "SEO-3"]);
    await completeTask(e, s.tasks.at(-1)!.id, { by: "logan", now: NOW });
    await completeTask(e, s.tasks.at(-1)!.id, { by: "logan", now: NOW });
    expect(await cadenceKeys(s.project.id)).toEqual(["SEO-1", "SEO-2", "SEO-3"]);
  });

  it("a finished project of any other template does not get the Local SEO cadences", async () => {
    const o = await seedProject({ bare: true, kind: "custom", templateKey: "SOMETHING" });
    const [step] = await seedSteps(o.project.id, o.businessId, [{ key: "a" }]);
    await completeTask(e, step.id, { by: "logan", now: NOW });
    expect((await listProjects(env.DB, { businessId: o.businessId }))[0].status).toBe("done");
    expect(await cadenceKeys(o.project.id)).toEqual([]);
  });

  it("a finished SEO-0 stays live: the sweep makes the month's SEO-1, the quarter's SEO-2 and the year's SEO-3 task, and Claude is not handed SEO-1", async () => {
    const s = await seoClient();
    await finish(s.tasks);
    expect(await generateRecurring(e, NOW)).toBe(3);
    const mine = (await listTasks(env.DB, s.project.id)).filter((t) => t.cadenceKey);
    expect(mine.map((t) => [t.cadenceKey, t.periodKey]).sort()).toEqual([["SEO-1", "2026-12"], ["SEO-2", "2026-Q4"], ["SEO-3", "2026"]]);
    const one = mine.find((t) => t.cadenceKey === "SEO-1")!;
    expect(one.checklist).toHaveLength(7);
    expect(one.dueOn).toBe("2026-12-10");
    expect(await generateRecurring(e, NOW)).toBe(0);
    await dispatchReady(e, NOW);
    // The annual task is Claude drafting for Logan, so it is handed over like any step; the monthly one never is (its pull, drafts and report have their own jobs).
    const handed = (await jobs()).map((j) => (j as { target_id: string }).target_id);
    expect(handed).toContain(mine.find((t) => t.cadenceKey === "SEO-3")!.id);
    expect(handed).not.toContain(one.id);
  });

  it("a cancelled SEO-0 project stops its recurring work, and a finished one can be cancelled but not paused or reopened", async () => {
    const s = await seoClient();
    await finish(s.tasks);
    expect((await setProjectStatus(env.DB, s.project.id, "paused")).status).toBe("done");
    expect((await setProjectStatus(env.DB, s.project.id, "cancelled")).status).toBe("cancelled");
    expect(await generateRecurring(e, NOW)).toBe(0);
  });

  it("the proposal's money is carried by the build, then SEO-0, then Care, never twice", async () => {
    const s = await seed({ packages: [STARTER, CARE, SEO] });
    await pay(s);
    const seoProject = (await projectsOf(s.businessId)).find((p) => p.templateKey === "SEO-0")!;
    const build = (await projectsOf(s.businessId)).find((p) => p.templateKey === "BUILD")!;
    const buildMoney = await soldAndPaid(e, build, []);
    expect(buildMoney.soldCents).toBeGreaterThan(0);
    expect(await soldAndPaid(e, seoProject, [])).toEqual({ soldCents: 0, paidCents: 0 });
    const alone = await seed({ packages: [SEO] });
    await pay(alone);
    expect((await soldAndPaid(e, (await projectsOf(alone.businessId))[0], [])).soldCents).toBe(buildMoney.soldCents);
    const careAndSeo = await seed({ packages: [CARE, SEO] });
    await pay(careAndSeo);
    const both = await projectsOf(careAndSeo.businessId);
    expect((await soldAndPaid(e, both.find((p) => p.templateKey === "SEO-0")!, [])).soldCents).toBe(buildMoney.soldCents);
    expect((await soldAndPaid(e, both.find((p) => p.templateKey === "CARE-0")!, [])).soldCents).toBe(0);
  });
});

describe("tickSeo1", () => {
  /** A finished SEO-0 client with this month's SEO-1 task. */
  async function withTask() {
    const s = await seoClient();
    await finish(s.tasks);
    await generateRecurring(e, NOW);
    const task = async () => (await listTasks(env.DB, s.project.id)).find((t) => t.cadenceKey === "SEO-1" && t.periodKey === "2026-12")!;
    return { ...s, task };
  }
  const done = (t: { checklist: { done: boolean }[] }) => t.checklist.map((c) => c.done);

  it("ticks 1.1 and 1.7 on the month's task, only those", async () => {
    const s = await withTask();
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.1"], NOW)).toBe(true);
    expect(done(await s.task())).toEqual([true, false, false, false, false, false, false]);
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.7"], NOW)).toBe(true);
    expect(done(await s.task())).toEqual([true, false, false, false, false, false, true]);
  });

  it("ticking twice changes nothing the second time, and never un-ticks anything else", async () => {
    const s = await withTask();
    const t = await s.task();
    await patchTask(env.DB, t.id, { checklist: t.checklist.map((c, i) => ({ ...c, done: i === 1 || i === 3 })) }, NOW.toISOString());
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.1", "1.7"], NOW)).toBe(true);
    expect(done(await s.task())).toEqual([true, true, false, true, false, false, true]);
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.1", "1.7"], NOW)).toBe(false);
    expect(done(await s.task())).toEqual([true, true, false, true, false, false, true]);
  });

  it("does nothing for a done or skipped task, another month or another client", async () => {
    const s = await withTask();
    const t = await s.task();
    expect(await tickSeo1(e, s.businessId, "2026-11", ["1.1"], NOW)).toBe(false);
    expect(await tickSeo1(e, "someone-else", "2026-12", ["1.1"], NOW)).toBe(false);
    await env.DB.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).bind(t.id).run();
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.1"], NOW)).toBe(false);
    expect(done((await getTask(env.DB, t.id))!)).toEqual([false, false, false, false, false, false, false]);
    await env.DB.prepare(`UPDATE tasks SET status = 'skipped' WHERE id = ?`).bind(t.id).run();
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.7"], NOW)).toBe(false);
  });

  it("does nothing when the template was edited so it no longer lines up with the task", async () => {
    const s = await withTask();
    await env.DB.prepare(`DELETE FROM sop_template_steps WHERE key = '1.7' AND template_id = (SELECT id FROM sop_templates WHERE key = 'SEO-1')`).run();
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.7"], NOW)).toBe(false);
    expect(await tickSeo1(e, s.businessId, "2026-12", ["1.1"], NOW)).toBe(false);
  });

  it("swallows an error, logs it and says false", async () => {
    const s = await withTask();
    const broken = { ...e, DB: { prepare: () => { throw new Error("db down"); } } } as unknown as Env;
    expect(await tickSeo1(broken, s.businessId, "2026-12", ["1.1"], NOW)).toBe(false);
    expect(errors).toHaveBeenCalledWith("seo tasks: could not tick the monthly task", "db down");
  });

  it("does not touch a Care task or another template's task of the same month", async () => {
    const s = await withTask();
    await addCadence(env.DB, s.project.id, "SEO-2");
    expect(await tickSeo1(e, s.businessId, "2026-Q4", ["1.1"], NOW)).toBe(false);
    const two = (await listTasks(env.DB, s.project.id)).find((t) => t.cadenceKey === "SEO-2")!;
    expect(done(two)).toEqual([false, false, false]);
  });
});

describe("the project is a normal project in the owner's lists", () => {
  it("createProject for SEO-0 is unique per document, so a second one is the first", async () => {
    const s = await seed({ packages: [SEO] });
    await pay(s);
    const first = (await projectsOf(s.businessId))[0];
    const again = await createProject(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.doc.id, onboardingId: null, kind: "custom", name: "x", test: false, templateKey: "SEO-0", templateVersion: 1, careDeferred: false, startedAt: NOW.toISOString(),
    });
    expect(again.created).toBe(false);
    expect(again.project.id).toBe(first.id);
  });
});
