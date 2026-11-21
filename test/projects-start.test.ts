import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, setPaid, signDocument } from "../src/worker/db/documents";
import { insertInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { getOnboardingForDeal } from "../src/worker/db/onboardings";
import { listProjects, setProjectStatus, type Project } from "../src/worker/db/projects";
import { ensureSeedSops, setTemplateActive } from "../src/worker/db/sops";
import { listTasks } from "../src/worker/db/tasks";
import { onInvoicePaid } from "../src/worker/documents/deposit";
import type { ProposalContent } from "../src/worker/documents/proposal";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests, onProjectDone, onTasksChanged, runProjectDone } from "../src/worker/projects/hooks";
import { dispatchOnTasksChanged } from "../src/worker/projects/dispatch";
import { ProjectStartError, startCareWhenDone, startDeferredCare, startProjects, startProjectsForPaidDocuments, startTestProject } from "../src/worker/projects/start";
import { SOP_STEP_KIND } from "../src/worker/queue/sopStep";
import "../src/worker/queue/kinds";
import { clientSig, proposal, seedDeal, sendDraft } from "./fixtures/documents";
import { KEY } from "./fixtures/stripe";
import { resetProjectWork } from "./fixtures/projects";

const e = env as Env;
const FAR = "2099-01-01T00:00:00.000Z";
const NOW = new Date("2026-12-03T10:00:00.000Z");

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  clearProjectHooksForTests();
  onTasksChanged(dispatchOnTasksChanged);
  onProjectDone(startCareWhenDone);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await env.DB.prepare(`UPDATE sop_templates SET active = 1`).run();
});
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); });

type Pkg = ProposalContent["packages"][number];
const pkg = (key: Pkg["key"], name: string): Pkg => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });
const STARTER = pkg("starter_site", "Starter Site");
const CARE = pkg("care", "Care");
const SEO = pkg("local_seo", "Local SEO");
const QUICK = pkg("quick_fix", "Quick Fix");

/** A signed proposal with its deposit invoice, for a real or test deal. */
async function seed(o: { test?: boolean; packages?: Pkg[]; careDeclined?: boolean; clientName?: string } = {}) {
  const s = await seedDeal();
  const base = proposal();
  const content: ProposalContent = {
    ...base, packages: o.packages ?? [STARTER, CARE], careDeclined: o.careDeclined ?? false, header: { ...base.header, clientName: o.clientName ?? base.header.clientName },
  };
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
const pay = (s: Seeded, x: Env = e) => onInvoicePaid(x, s.invoice as InvoiceRow);
const projectsOf = async (businessId: string) => (await listProjects(env.DB, { businessId })).sort((a, b) => a.templateKey!.localeCompare(b.templateKey!));
const keysOf = async (businessId: string) => (await projectsOf(businessId)).map((p) => p.templateKey);
const lines = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const jobs = async () => (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ?`).bind(SOP_STEP_KIND).all()).results;
const seoNotes = async (businessId: string) => (await lines(businessId, "note")).filter((n) => /no SOP/.test(n));

describe("starting projects at payment", () => {
  it("a paid Starter proposal starts one build project with its onboarding linked and Claude steps queued", async () => {
    const s = await seed({ packages: [STARTER] });
    await pay(s);
    const [p] = await projectsOf(s.businessId);
    expect(await projectsOf(s.businessId)).toHaveLength(1);
    const o = await getOnboardingForDeal(env.DB, s.dealId);
    expect(o).not.toBeNull();
    expect(p).toMatchObject({
      kind: "build", name: "Ace Plumbing: Website build", status: "active", test: false, templateKey: "BUILD", templateVersion: 1, careDeferred: false,
      documentId: s.doc.id, dealId: s.dealId, onboardingId: o!.id,
    });
    const tasks = await listTasks(env.DB, p.id);
    expect(tasks.length).toBeGreaterThan(10);
    expect(tasks.every((t) => t.isStep)).toBe(true);
    expect((await jobs()).length).toBeGreaterThan(0);
    expect(tasks.some((t) => t.status === "in_progress" && t.claudeTaskId)).toBe(true);
    expect(await lines(s.businessId, "project_started")).toEqual(["Ace Plumbing: Website build started (SL-ABCDEF v1)"]);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("a replayed payment starts nothing new", async () => {
    const s = await seed({ packages: [STARTER] });
    await pay(s);
    const before = await jobs();
    const [p] = await projectsOf(s.businessId);
    const taskCount = (await listTasks(env.DB, p.id)).length;
    await pay(s);
    expect(await projectsOf(s.businessId)).toHaveLength(1);
    expect(await listTasks(env.DB, p.id)).toHaveLength(taskCount);
    expect(await jobs()).toHaveLength(before.length);
    expect(await lines(s.businessId, "project_started")).toHaveLength(1);
  });

  it("a build plus Care starts the build and defers Care, and finishing the build starts CARE-0 once", async () => {
    const s = await seed();
    await pay(s);
    const [build] = await projectsOf(s.businessId);
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
    expect(build.careDeferred).toBe(true);

    // The build finishes (the task service marks it done and runs the done hooks).
    const done = await setProjectStatus(env.DB, build.id, "done");
    await runProjectDone(e, done);
    await runProjectDone(e, done);
    const after = await projectsOf(s.businessId);
    expect(after.map((p) => p.templateKey)).toEqual(["BUILD", "CARE-0"]);
    const care = after[1];
    expect(care).toMatchObject({ kind: "care_onboarding", name: "Ace Plumbing: Care onboarding", documentId: s.doc.id, test: false, careDeferred: false, status: "active" });
    expect((await listTasks(env.DB, care.id)).length).toBeGreaterThan(5);
    expect(await lines(s.businessId, "project_started")).toHaveLength(2);
  });

  it("Care alone starts CARE-0 now", async () => {
    const s = await seed({ packages: [CARE] });
    await pay(s);
    expect(await keysOf(s.businessId)).toEqual(["CARE-0"]);
    const [p] = await projectsOf(s.businessId);
    expect(p).toMatchObject({ kind: "care_onboarding", careDeferred: false });
    expect((await listTasks(env.DB, p.id)).length).toBeGreaterThan(5);
  });

  it("careDeclined starts no Care project", async () => {
    const s = await seed({ packages: [STARTER], careDeclined: true });
    await pay(s);
    const [build] = await projectsOf(s.businessId);
    expect(build.careDeferred).toBe(false);
    await runProjectDone(e, await setProjectStatus(env.DB, build.id, "done"));
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
  });

  it("Quick Fix starts QUICKFIX only", async () => {
    const s = await seed({ packages: [QUICK] });
    await pay(s);
    const ps = await projectsOf(s.businessId);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: "quick_fix", templateKey: "QUICKFIX", name: "Ace Plumbing: Quick fix", careDeferred: false });
  });

  it("Local SEO alone leaves one timeline note and no project", async () => {
    const s = await seed({ packages: [SEO] });
    await pay(s);
    await pay(s);
    expect(await projectsOf(s.businessId)).toEqual([]);
    expect(await seoNotes(s.businessId)).toEqual(["SL-ABCDEF v1: no SOP for Local SEO yet, so no project was started for it"]);
    expect(await lines(s.businessId, "project_started")).toEqual([]);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("an option with build, Care and Local SEO starts BUILD, defers Care and notes the SEO", async () => {
    const s = await seed({ packages: [STARTER, CARE, SEO] });
    await pay(s);
    const ps = await projectsOf(s.businessId);
    expect(ps.map((p) => p.templateKey)).toEqual(["BUILD"]);
    expect(ps[0].careDeferred).toBe(true);
    expect(await seoNotes(s.businessId)).toEqual(["SL-ABCDEF v1: no SOP for Local SEO yet, so no project was started for it"]);
  });

  it("a test document starts no project from payment", async () => {
    const s = await seed({ test: true, packages: [STARTER] });
    await pay(s);
    expect(await projectsOf(s.businessId)).toEqual([]);
    expect(await lines(s.businessId, "project_started")).toEqual([]);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("startTestProject makes a test project that queues nothing", async () => {
    const s = await seed({ test: true, packages: [STARTER, CARE] });
    const made = await startTestProject(e, s.dealId);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ test: true, templateKey: "BUILD", careDeferred: true, status: "active" });
    expect((await listTasks(env.DB, made[0].id)).length).toBeGreaterThan(10);
    expect(await jobs()).toEqual([]);
    expect((await listTasks(env.DB, made[0].id)).every((t) => t.status === "todo")).toBe(true);
    // Again changes nothing.
    await startTestProject(e, s.dealId);
    expect(await projectsOf(s.businessId)).toHaveLength(1);
  });

  it("startTestProject refuses a deal whose signed proposal is real, or that has none", async () => {
    const real = await seed({ packages: [STARTER] });
    await expect(startTestProject(e, real.dealId)).rejects.toBeInstanceOf(ProjectStartError);
    await expect(startTestProject(e, real.dealId)).rejects.toThrow(/real/);
    const none = await seedDeal();
    await expect(startTestProject(e, none.dealId)).rejects.toThrow(/no signed proposal/);
    expect(await projectsOf(real.businessId)).toEqual([]);
  });

  it("a missing template does not break the payment", async () => {
    const s = await seed({ packages: [STARTER, CARE] });
    await ensureSeedSops(env.DB);
    await setTemplateActive(env.DB, "BUILD", false);
    await pay(s);
    // Build has no template, so Care is not waiting on anything and starts now.
    expect(await keysOf(s.businessId)).toEqual(["CARE-0"]);
    expect((await seoNotes(s.businessId)).join("|")).toContain("no SOP for Starter Site yet");
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("an error while starting projects is logged without the key and the payment is still recorded", async () => {
    const s = await seed({ packages: [STARTER] });
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          if (/INSERT INTO projects/.test(sql)) throw new Error(`boom ${KEY}`);
          return target.prepare(sql);
        };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    await pay(s, { ...e, DB: db, STRIPE_SECRET_KEY: KEY } as Env);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
    expect(await projectsOf(s.businessId)).toEqual([]);
    const logged = errors.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(logged).toContain("projects were not started");
    expect(logged).toContain("boom [key]");
    expect(logged).not.toContain(KEY);
    // Logan sees it on the lead's timeline, with the next step, and without the key.
    const notes = (await lines(s.businessId, "note")).filter((n) => /projects were not started/.test(n));
    expect(notes).toEqual(["SL-ABCDEF v1: projects were not started: boom [key]. Use Start projects on the deal, or wait for the daily sweep."]);
  });

  it("a failed note about a failed start still lets the payment be recorded", async () => {
    const s = await seed({ packages: [STARTER] });
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          if (/INSERT INTO projects/.test(sql)) throw new Error("boom");
          if (/INSERT INTO activity/.test(sql)) return { bind: (...a: unknown[]) => { if (a.some((x) => typeof x === "string" && x.includes("projects were not started"))) throw new Error("no notes today"); return target.prepare(sql).bind(...a); } };
          return target.prepare(sql);
        };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    await pay(s, { ...e, DB: db } as Env);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("no onboarding for the deal still starts the project with onboardingId null", async () => {
    const s = await seed({ packages: [STARTER] });
    const made = await startProjects(e, s.doc, { now: NOW });
    expect(await getOnboardingForDeal(env.DB, s.dealId)).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ onboardingId: null, startedAt: NOW.toISOString() });
    expect((await listTasks(env.DB, made[0].id)).length).toBeGreaterThan(10);
  });

  it("a crash between the project and its steps heals on the next start", async () => {
    const s = await seed({ packages: [QUICK] });
    const [first] = await startProjects(e, s.doc);
    await env.DB.prepare(`DELETE FROM tasks WHERE project_id = ?`).bind(first.id).run();
    const [again] = await startProjects(e, s.doc);
    expect(again.id).toBe(first.id);
    expect((await listTasks(env.DB, first.id)).length).toBeGreaterThan(3);
    await startProjects(e, s.doc);
    expect(await projectsOf(s.businessId)).toHaveLength(1);
  });

  it("the client name from lead data is cleaned and clipped in the project name", async () => {
    const s = await seed({ packages: [QUICK], clientName: `  Ace‮ Plumbing ${"x".repeat(200)}` });
    const [p] = await startProjects(e, s.doc);
    expect(p.name.startsWith("Ace Plumbing xxx")).toBe(true);
    expect(p.name.endsWith(": Quick fix")).toBe(true);
    expect(p.name).not.toMatch(/‮/);
    expect(p.name.length).toBeLessThanOrEqual(80 + ": Quick fix".length);
  });

  it("startDeferredCare does nothing for a cancelled primary, and nothing for one that is not done", async () => {
    const s = await seed();
    await pay(s);
    const [build] = await projectsOf(s.businessId);
    expect(await startDeferredCare(e, build)).toBeNull(); // still active
    const cancelled = await setProjectStatus(env.DB, build.id, "cancelled");
    expect(await startDeferredCare(e, cancelled)).toBeNull();
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
  });

  it("startDeferredCare returns the Care project once the primary is done, and the same one again", async () => {
    const s = await seed();
    await pay(s);
    const [build] = await projectsOf(s.businessId);
    const done = await setProjectStatus(env.DB, build.id, "done");
    const care = (await startDeferredCare(e, done)) as Project;
    expect(care.templateKey).toBe("CARE-0");
    expect((await startDeferredCare(e, done))!.id).toBe(care.id);
    expect(await projectsOf(s.businessId)).toHaveLength(2);
  });

  it("a replay after the primary is already done hands over Care once", async () => {
    const s = await seed();
    const [build] = await startProjects(e, s.doc);
    expect(build.careDeferred).toBe(true);
    await setProjectStatus(env.DB, build.id, "done"); // finished, but the done hook never ran
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
    const again = await startProjects(e, s.doc);
    expect(again.map((p) => p.templateKey)).toEqual(["BUILD", "CARE-0"]);
    await startProjects(e, s.doc);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "CARE-0"]);
  });

  it("two starts at the same moment leave one project with one set of steps", async () => {
    const s = await seed({ packages: [STARTER] });
    const [a, b] = await Promise.all([startProjects(e, s.doc), startProjects(e, s.doc)]);
    expect(a[0].id).toBe(b[0].id);
    const ps = await projectsOf(s.businessId);
    expect(ps).toHaveLength(1);
    const tasks = await listTasks(env.DB, ps[0].id);
    expect(new Set(tasks.map((t) => t.stepKey)).size).toBe(tasks.length);
    expect(tasks.length).toBeGreaterThan(10);
    expect(await lines(s.businessId, "project_started")).toHaveLength(1);
  });

  it("the seeds are not inserted again on every start", async () => {
    const s = await seed({ packages: [QUICK] });
    await startProjects(e, s.doc);
    await env.DB.prepare(`UPDATE sop_templates SET name = 'Edited' WHERE key = 'CARE-4'`).run();
    await startProjects(e, s.doc);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM sop_templates`).first<{ n: number }>())!.n).toBe(7);
    await env.DB.prepare(`UPDATE sop_templates SET name = 'Care monthly report' WHERE key = 'CARE-4'`).run();
  });
});

describe("startProjectsForPaidDocuments", () => {
  it("starts projects for real paid documents with none, ignoring test, unpaid and started ones, and a replay creates nothing", async () => {
    await startProjectsForPaidDocuments(e, NOW); // clear any paid document an earlier test left without a project
    const stuck = await seed({ packages: [STARTER, CARE] });
    await setPaid(env.DB, stuck.doc.id, "2026-12-03T09:00:00.000Z");
    const stuckQuick = await seed({ packages: [QUICK] });
    await setPaid(env.DB, stuckQuick.doc.id, "2026-12-03T09:00:00.000Z");
    const unpaid = await seed({ packages: [QUICK] });
    const testDoc = await seed({ test: true, packages: [QUICK] });
    await setPaid(env.DB, testDoc.doc.id, "2026-12-03T09:00:00.000Z");
    const started = await seed({ packages: [QUICK] });
    await setPaid(env.DB, started.doc.id, "2026-12-03T09:00:00.000Z");
    await startProjects(e, started.doc);
    const startedBefore = await projectsOf(started.businessId);
    const seoOnly = await seed({ packages: [SEO] });
    await setPaid(env.DB, seoOnly.doc.id, "2026-12-03T09:00:00.000Z");

    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(2);
    expect(await keysOf(stuck.businessId)).toEqual(["BUILD"]);
    expect(await keysOf(stuckQuick.businessId)).toEqual(["QUICKFIX"]);
    expect(await projectsOf(unpaid.businessId)).toEqual([]);
    expect(await projectsOf(testDoc.businessId)).toEqual([]);
    expect(await projectsOf(seoOnly.businessId)).toEqual([]);
    expect((await projectsOf(started.businessId)).map((p) => p.id)).toEqual(startedBefore.map((p) => p.id));
    expect((await projectsOf(stuck.businessId))[0].careDeferred).toBe(true);

    // A replay finds nothing new (the Local SEO sale is looked at again but starts nothing and notes nothing twice).
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(0);
    expect(await projectsOf(stuck.businessId)).toHaveLength(1);
    expect(await lines(stuck.businessId, "project_started")).toHaveLength(1);
    expect(await seoNotes(seoOnly.businessId)).toHaveLength(1);
  });

  it("one document that fails does not stop the others, and says so on its timeline", async () => {
    await startProjectsForPaidDocuments(e, NOW);
    const bad = await seed({ packages: [QUICK] });
    await setPaid(env.DB, bad.doc.id, "2026-12-03T09:00:00.000Z");
    const good = await seed({ packages: [QUICK] });
    await setPaid(env.DB, good.doc.id, "2026-12-03T09:01:00.000Z");
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          if (/INSERT INTO projects/.test(sql)) return { bind: (...a: unknown[]) => { if (a[1] === bad.businessId) throw new Error("boom"); return target.prepare(sql).bind(...a); } };
          return target.prepare(sql);
        };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    expect(await startProjectsForPaidDocuments({ ...e, DB: db } as Env, NOW)).toBe(1);
    expect(await projectsOf(bad.businessId)).toEqual([]);
    expect(await keysOf(good.businessId)).toEqual(["QUICKFIX"]);
    expect((await lines(bad.businessId, "note")).some((n) => /projects were not started: boom/.test(n))).toBe(true);
    // The next call, with the database well again, starts it.
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(1);
    expect(await keysOf(bad.businessId)).toEqual(["QUICKFIX"]);
  });
});

describe("startProjectsForPaidDocuments: starvation and partial starts", () => {
  const paid = async (o: Parameters<typeof seed>[0], at: string) => {
    const s = await seed(o);
    await setPaid(env.DB, s.doc.id, at);
    return s;
  };
  const checked = async (docId: string) => (await env.DB.prepare(`SELECT projects_checked_at AS c FROM documents WHERE id = ?`).bind(docId).first<{ c: string | null }>())!.c;

  it("documents that can never get a project take their turn and then wait, so a later one is not starved", async () => {
    await startProjectsForPaidDocuments(e, NOW); // clear any paid document an earlier test left without a project
    const seoA = await paid({ packages: [SEO] }, "2026-12-03T09:00:00.000Z");
    const seoB = await paid({ packages: [SEO] }, "2026-12-03T09:01:00.000Z");
    const seoC = await paid({ packages: [SEO] }, "2026-12-03T09:02:00.000Z");
    const quick = await paid({ packages: [QUICK] }, "2026-12-03T09:03:00.000Z");
    // Other tests of this file leave paid documents that never get a project; they would take part in the rotation, so set them aside.
    await env.DB.prepare(`UPDATE documents SET paid_at = NULL WHERE id NOT IN (?, ?, ?, ?)`).bind(seoA.doc.id, seoB.doc.id, seoC.doc.id, quick.doc.id).run();

    // The window holds two: the two oldest are looked at (and start nothing), and marked as looked at.
    expect(await startProjectsForPaidDocuments(e, NOW, { limit: 2 })).toBe(0);
    expect(await checked(seoA.doc.id)).toBe(NOW.toISOString());
    expect(await checked(seoB.doc.id)).toBe(NOW.toISOString());
    expect(await checked(quick.doc.id)).toBeNull();
    expect(await projectsOf(quick.businessId)).toEqual([]);

    // The next call takes the ones not yet looked at first, so the Quick Fix starts.
    const later = new Date(NOW.getTime() + 86_400_000);
    expect(await startProjectsForPaidDocuments(e, later, { limit: 2 })).toBe(1);
    expect(await keysOf(quick.businessId)).toEqual(["QUICKFIX"]);
    expect(await checked(seoC.doc.id)).toBe(later.toISOString());

    // Then the oldest look comes round again: A and B before C.
    await startProjectsForPaidDocuments(e, new Date(later.getTime() + 86_400_000), { limit: 2 });
    expect(await checked(seoA.doc.id)).toBe(new Date(later.getTime() + 86_400_000).toISOString());
    expect(await checked(seoC.doc.id)).toBe(later.toISOString());
    expect(await seoNotes(seoA.businessId)).toHaveLength(1); // the "no SOP" line is still written once
  });

  it("a document that fails is retried by the very next call when it is the only one", async () => {
    await startProjectsForPaidDocuments(e, NOW);
    const bad = await paid({ packages: [QUICK] }, "2026-12-03T09:00:00.000Z");
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          if (/INSERT INTO projects/.test(sql)) return { bind: () => { throw new Error("boom"); } };
          return target.prepare(sql);
        };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    expect(await startProjectsForPaidDocuments({ ...e, DB: db } as Env, NOW)).toBe(0);
    expect(await checked(bad.doc.id)).toBe(NOW.toISOString());
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(1);
  });

  it("a project made without its steps (a start that died half-way) gets them from the sweep", async () => {
    await startProjectsForPaidDocuments(e, NOW);
    await ensureSeedSops(env.DB);
    const s = await paid({ packages: [QUICK] }, "2026-12-03T09:00:00.000Z");
    const { createProject } = await import("../src/worker/db/projects");
    const { project } = await createProject(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.doc.id, onboardingId: null, kind: "quick_fix", name: "Ace Plumbing: Quick fix", test: false,
      templateKey: "QUICKFIX", templateVersion: 1, careDeferred: false, startedAt: "2026-12-03T09:00:00.000Z",
    });
    expect(await listTasks(env.DB, project.id)).toEqual([]);

    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(1);
    expect((await projectsOf(s.businessId)).map((p) => p.id)).toEqual([project.id]); // the same project, not a second one
    expect((await listTasks(env.DB, project.id)).length).toBeGreaterThan(0);
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(0); // healed: nothing more to do
  });

  it("a finished or cancelled project with no tasks is left alone, and so is a project that has its steps", async () => {
    await startProjectsForPaidDocuments(e, NOW);
    await ensureSeedSops(env.DB);
    const { createProject } = await import("../src/worker/db/projects");
    const make = async (status: "done" | "cancelled" | "active") => {
      const s = await paid({ packages: [QUICK] }, "2026-12-03T09:00:00.000Z");
      const { project } = await createProject(env.DB, {
        businessId: s.businessId, dealId: s.dealId, documentId: s.doc.id, onboardingId: null, kind: "quick_fix", name: "Quick fix", test: false, templateKey: "QUICKFIX", templateVersion: 1,
        careDeferred: false, startedAt: "2026-12-03T09:00:00.000Z",
      });
      if (status !== "active") await setProjectStatus(env.DB, project.id, status);
      return project;
    };
    const done = await make("done"), cancelled = await make("cancelled");
    const full = await paid({ packages: [QUICK] }, "2026-12-03T09:00:00.000Z");
    await startProjects(e, full.doc);
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(0);
    expect(await listTasks(env.DB, done.id)).toEqual([]);
    expect(await listTasks(env.DB, cancelled.id)).toEqual([]);
  });
});

describe("a Care project that was deferred and never started (F2)", () => {
  /** A real paid proposal (build plus Care) whose build is finished but whose done hook never made the Care project; every other paid document is set aside. */
  async function finishedBuildWithoutCare() {
    await startProjectsForPaidDocuments(e, NOW);
    const s = await seed();
    await setPaid(env.DB, s.doc.id, "2026-12-03T09:00:00.000Z");
    await env.DB.prepare(`UPDATE documents SET paid_at = NULL WHERE id != ?`).bind(s.doc.id).run();
    const [build] = await startProjects(e, s.doc);
    expect(build.careDeferred).toBe(true);
    await setProjectStatus(env.DB, build.id, "done"); // finished; the hook lost to a crash or an error
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
    return s;
  }
  const careNotes = async (businessId: string) => (await lines(businessId, "note")).filter((n) => /Care was not started/.test(n));

  it("the daily sweep starts CARE-0, once", async () => {
    const s = await finishedBuildWithoutCare();
    expect(await startProjectsForPaidDocuments(e, NOW)).toBe(1);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "CARE-0"]);
    const care = (await projectsOf(s.businessId))[1];
    expect((await listTasks(env.DB, care.id)).length).toBeGreaterThan(5);
    expect(await startProjectsForPaidDocuments(e, new Date(NOW.getTime() + 86_400_000))).toBe(0);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "CARE-0"]);
    expect(await lines(s.businessId, "project_started")).toHaveLength(2);
  });

  it("a build that is still active, or cancelled, or whose Care is declined, makes the sweep start no Care", async () => {
    await startProjectsForPaidDocuments(e, NOW);
    const active = await seed();
    await setPaid(env.DB, active.doc.id, "2026-12-03T09:00:00.000Z");
    const cancelled = await seed();
    await setPaid(env.DB, cancelled.doc.id, "2026-12-03T09:00:00.000Z");
    await env.DB.prepare(`UPDATE documents SET paid_at = NULL WHERE id NOT IN (?, ?)`).bind(active.doc.id, cancelled.doc.id).run();
    await startProjects(e, active.doc);
    const [b] = await startProjects(e, cancelled.doc);
    await setProjectStatus(env.DB, b.id, "cancelled");
    await startProjectsForPaidDocuments(e, NOW);
    expect(await keysOf(active.businessId)).toEqual(["BUILD"]);
    expect(await keysOf(cancelled.businessId)).toEqual(["BUILD"]);
  });

  it("a Care start that fails leaves one note on the timeline, and the next sweep heals it", async () => {
    const s = await finishedBuildWithoutCare();
    await env.DB.prepare(`CREATE TRIGGER test_fail BEFORE INSERT ON projects WHEN NEW.kind = 'care_onboarding' BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`).run();
    try {
      await startProjectsForPaidDocuments(e, NOW);
      await startProjectsForPaidDocuments(e, new Date(NOW.getTime() + 86_400_000));
    } finally { await env.DB.prepare(`DROP TRIGGER IF EXISTS test_fail`).run(); }
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
    expect(await careNotes(s.businessId)).toHaveLength(1); // the same line twice is written once
    expect((await careNotes(s.businessId))[0]).not.toMatch(/hiccup/);
    expect(await startProjectsForPaidDocuments(e, new Date(NOW.getTime() + 2 * 86_400_000))).toBe(1);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "CARE-0"]);
  });

  it("a done hook that fails leaves the note too, and the sweep heals it", async () => {
    const s = await seed();
    const [build] = await startProjects(e, s.doc);
    await setPaid(env.DB, s.doc.id, "2026-12-03T09:00:00.000Z");
    const done = await setProjectStatus(env.DB, build.id, "done");
    await env.DB.prepare(`CREATE TRIGGER test_fail BEFORE INSERT ON projects WHEN NEW.kind = 'care_onboarding' BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`).run();
    try { await runProjectDone(e, done); } finally { await env.DB.prepare(`DROP TRIGGER IF EXISTS test_fail`).run(); }
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
    expect(await careNotes(s.businessId)).toHaveLength(1);
    await env.DB.prepare(`UPDATE documents SET paid_at = NULL WHERE id != ?`).bind(s.doc.id).run();
    await startProjectsForPaidDocuments(e, NOW);
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "CARE-0"]);
  });

  it("a deactivated CARE-0 template leaves one note, however many sweeps look, and starts Care when it is switched back on", async () => {
    const s = await finishedBuildWithoutCare();
    await setTemplateActive(env.DB, "CARE-0", false);
    expect(await startDeferredCare(e, (await projectsOf(s.businessId))[0])).toBeNull();
    await startProjectsForPaidDocuments(e, NOW);
    await startProjectsForPaidDocuments(e, new Date(NOW.getTime() + 86_400_000));
    expect(await keysOf(s.businessId)).toEqual(["BUILD"]);
    const notes = await careNotes(s.businessId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/CARE-0/);
    await setTemplateActive(env.DB, "CARE-0", true);
    await startProjectsForPaidDocuments(e, new Date(NOW.getTime() + 2 * 86_400_000));
    expect(await keysOf(s.businessId)).toEqual(["BUILD", "CARE-0"]);
  });
});
