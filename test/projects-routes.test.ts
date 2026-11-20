import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewApproval } from "../src/worker/approvals/sopReview";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, setPaid, signDocument } from "../src/worker/db/documents";
import { insertInvoice, markInvoice } from "../src/worker/db/invoices";
import { markSent, signChangeOrder } from "../src/worker/db/changeOrders";
import { getProject, markProjectDone, setProjectStatus } from "../src/worker/db/projects";
import { ensureSeedSops, getTemplate, saveTemplate } from "../src/worker/db/sops";
import { getSettings, saveSettings } from "../src/worker/db/settings";
import { getTask, insertTasks, listComments, listTasks, setTaskStatus } from "../src/worker/db/tasks";
import { insertEntry } from "../src/worker/db/time";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { SOP_STEP_KIND } from "../src/worker/queue/sopStep";
import { setMailDeps } from "../src/worker/mail/deps";
import "../src/worker/queue/kinds";
import { clientSig as coSig, content as coContent, sendOrder } from "./fixtures/changeorders";
import { clientSig, proposal, seedDeal, sendDraft } from "./fixtures/documents";
import { newTask, resetProjectWork, seedProject, seedSteps, T0 } from "./fixtures/projects";

const BASE = "https://clients.hellositeline.test";
const FAR = "2099-01-01T00:00:00.000Z";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await env.DB.prepare(`UPDATE settings SET work_config = '{}' WHERE id = 1`).run();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/** The owner's browser: the session cookie. */
const owner = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });
const json = async (method: string, path: string, body?: unknown) => { const r = await owner(method, path, body); return { status: r.status, body: await r.json<any>() }; };
const getApproval = (id: string) => env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<{ id: string; status: string; decision_note: string | null }>();
const jobs = async () => (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ? ORDER BY created_at, id`).bind(SOP_STEP_KIND).all<{ id: string; status: string; target_id: string }>()).results;

/** A trigger that makes one kind of write fail, to model a database that hiccups part-way through a request. */
async function failing<T>(trigger: string, fn: () => Promise<T>): Promise<T> {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS test_fail`).run();
  await env.DB.prepare(`CREATE TRIGGER test_fail ${trigger}`).run();
  try { return await fn(); } finally { await env.DB.prepare(`DROP TRIGGER IF EXISTS test_fail`).run(); }
}

describe("project routes: sessions", () => {
  it("every route is 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/projects"], ["GET", "/projects/x"], ["POST", "/projects", { businessId: "x", name: "n" }], ["PATCH", "/projects/x", { status: "paused" }],
      ["POST", "/projects/x/tasks", { title: "t" }], ["POST", "/projects/x/sop/push", { confirm: true }], ["POST", "/deals/x/projects/start"], ["POST", "/deals/x/projects/test"],
      ["GET", "/tasks/x"], ["PATCH", "/tasks/x", { title: "t" }], ["POST", "/tasks/x/start"], ["POST", "/tasks/x/complete"], ["POST", "/tasks/x/skip", { reason: "no need" }],
      ["POST", "/tasks/x/reopen"], ["POST", "/tasks/x/waiting", { on: true }], ["POST", "/tasks/x/comment", { body: "hi" }], ["POST", "/tasks/x/ask-claude"],
      ["POST", "/tasks/x/send-back"], ["POST", "/tasks/x/move", { toPosition: 0 }], ["DELETE", "/tasks/x"], ["GET", "/me/tasks"],
    ];
    for (const [m, p, b] of calls) expect((await owner(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });

  it("an unknown id is 404 on every route that takes one", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/projects/nope"], ["PATCH", "/projects/nope", { status: "paused" }], ["POST", "/projects/nope/tasks", { title: "t" }], ["POST", "/projects/nope/sop/push", { confirm: true }],
      ["POST", "/deals/nope/projects/start"], ["POST", "/deals/nope/projects/test"], ["GET", "/tasks/nope"], ["PATCH", "/tasks/nope", { title: "t" }], ["POST", "/tasks/nope/start"],
      ["POST", "/tasks/nope/complete"], ["POST", "/tasks/nope/skip", { reason: "no need" }], ["POST", "/tasks/nope/reopen"], ["POST", "/tasks/nope/waiting", { on: true }],
      ["POST", "/tasks/nope/comment", { body: "hi" }], ["POST", "/tasks/nope/ask-claude"], ["POST", "/tasks/nope/send-back"], ["POST", "/tasks/nope/move", { toPosition: 0 }],
      ["DELETE", "/tasks/nope"], ["POST", "/projects", { businessId: "nope", name: "n" }],
    ];
    for (const [m, p, b] of calls) expect((await owner(m, p, b)).status, `${m} ${p}`).toBe(404);
  });
});

describe("GET /projects", () => {
  it("lists projects with the client name, the task counts and the waiting flag, and filters by status", async () => {
    const a = await seedProject({ bare: true, name: "Alpha" });
    await seedSteps(a.project.id, a.businessId, [{ key: "1" }, { key: "2" }]);
    const b = await seedProject({ bare: true, name: "Beta" });
    await setProjectStatus(env.DB, b.project.id, "paused", { reason: "x" });
    const all = await json("GET", "/projects");
    expect(all.status).toBe(200);
    const alpha = all.body.projects.find((p: any) => p.id === a.project.id);
    expect(alpha).toMatchObject({ name: "Alpha", status: "active", openTasks: 2, doneTasks: 0, waitingOnClient: false });
    expect(typeof alpha.businessName).toBe("string");
    const paused = await json("GET", "/projects?status=paused");
    expect(paused.body.projects.map((p: any) => p.id)).toEqual([b.project.id]);
    const two = await json("GET", "/projects?status=active,paused");
    expect(two.body.projects.map((p: any) => p.id).sort()).toEqual([a.project.id, b.project.id].sort());
    expect((await json("GET", "/projects?status=bogus")).status).toBe(400);
    expect((await json("GET", `/projects?businessId=${a.businessId}`)).body.projects.map((p: any) => p.id)).toEqual([a.project.id]);
  });
});

describe("GET /projects/:id", () => {
  it("carries profit with the cost rate applied and never the token of a change order", async () => {
    // A real proposal with two milestones, a paid deposit invoice, a work rate of $60 an hour, 90 minutes logged.
    const s = await seedDeal();
    const content: ProposalContent = { ...proposal(), schedule: { ...proposal().schedule, milestones: [
      { id: "m1", label: "Deposit at signing", dueOn: "signing", amountCents: 100000 }, { id: "m2", label: "Site finished", dueOn: "site_finished", amountCents: 50000 },
    ] } };
    const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content });
    const { createProject } = await import("../src/worker/db/projects");
    const { project } = await createProject(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, onboardingId: null, kind: "build", name: "Ace: Website build", test: false, templateKey: "BUILD", templateVersion: 1, careDeferred: false, startedAt: T0 });
    const inv = await insertInvoice(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: "cus_1", stripeInvoiceId: "in_1", amountCents: 100000, hostedUrl: "https://stripe.test/i" });
    await markInvoice(env.DB, inv.id, { status: "paid", paidAt: T0 });
    await saveSettings(env.DB, { work_config: JSON.stringify({ costRateCentsPerHour: 6000 }) });
    const [task] = await insertTasks(env.DB, [newTask(project.id, s.businessId, { stepKey: "1", title: "Do it", billable: true })]);
    await insertEntry(env.DB, { taskId: task.id, projectId: project.id, businessId: s.businessId, startedAt: T0, endedAt: "2026-12-03T11:30:00.000Z", minutes: 90, billable: true, note: "", source: "manual" });
    await insertEntry(env.DB, { taskId: task.id, projectId: project.id, businessId: s.businessId, startedAt: "2026-12-04T10:00:00.000Z", endedAt: "2026-12-04T10:30:00.000Z", minutes: 30, billable: false, note: "", source: "manual" });

    // A sent order (with a token), a signed one (with the client's address and browser), and a draft.
    const { createChangeOrderDraft } = await import("../src/worker/db/changeOrders");
    const mk = async (title: string) => (await createChangeOrderDraft(env.DB, { projectId: project.id, businessId: s.businessId, dealId: s.dealId, test: false, sourceType: "logan", originApprovalId: null, referenceBase: "SL-ABCDEF-BUILD", content: coContent({ title }) })).changeOrder;
    const draft = await mk("Draft one");
    const sent = (await sendOrder(await mk("Sent one"))).co;
    const toSign = await sendOrder(await mk("Signed one"));
    expect(await signChangeOrder(env.DB, toSign.co.id, coSig(toSign.hash), "2026-12-06T09:00:00.000Z")).toBe("signed");

    const r = await json("GET", `/projects/${project.id}`);
    expect(r.status).toBe(200);
    expect(r.body.project).toMatchObject({ id: project.id, name: "Ace: Website build", status: "active" });
    expect(r.body.time).toEqual({ actualMinutes: 120, billableMinutes: 90 });
    // cost = 120 minutes at $60 = $120; sold = 1000 + 500 + the signed order's $250; paid = the deposit
    expect(r.body.profit).toEqual({ soldCents: 175000, paidCents: 100000, costCents: 12000, marginSoldCents: 163000, marginPaidCents: 88000, effectiveHourlyCents: 50000 });
    expect(r.body.waitingOnClient).toBe(false);
    expect(r.body.milestones).toEqual([]);
    expect(r.body.tasks).toHaveLength(1);
    expect(r.body.taskMinutes).toEqual({ [task.id]: 120 });

    const byTitle = (t: string) => r.body.changeOrders.find((c: any) => c.content.title === t);
    expect(byTitle("Sent one").link).toBe(`${BASE}/c/${sent.token}`);
    expect(byTitle("Draft one").link).toBeNull();
    expect(byTitle("Signed one").status).toBe("signed");
    expect(byTitle("Draft one").id).toBe(draft.id);
    const text = JSON.stringify(r.body);
    // the sent order's token is in its link and nowhere else; the signed order has no link, so its token is nowhere
    expect(text.split(sent.token!)).toHaveLength(2);
    expect(text).not.toContain(toSign.co.token!);
    expect(text).not.toContain(`"token"`);
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("TestBrowser");
    expect(text).not.toContain("I agree to sign electronically");
    for (const c of r.body.changeOrders) for (const k of ["token", "signerIp", "signerUserAgent", "consentText"]) expect(c, k).not.toHaveProperty(k);
  });

  it("names the template the project was made from, or null for a custom project", async () => {
    await ensureSeedSops(env.DB);
    const s = await seedProject({ templateKey: "BUILD" });
    const t = await getTemplate(env.DB, "BUILD");
    expect((await json("GET", `/projects/${s.project.id}`)).body.template).toEqual({ key: "BUILD", name: t!.name, version: t!.version });
    const custom = await seedProject({ bare: true, templateKey: null, kind: "custom" });
    const r = await json("GET", `/projects/${custom.project.id}`);
    expect(r.body.template).toBeNull();
    expect(r.body.profit).toMatchObject({ soldCents: 0, paidCents: 0, costCents: 0 });
  });
});

describe("creating and changing a project", () => {
  it("custom project create and PATCH status to paused stores the reason", async () => {
    const s = await seedProject({ bare: true });
    const made = await json("POST", "/projects", { businessId: s.businessId, name: "  Logo refresh \n" });
    expect(made.status).toBe(201);
    expect(made.body.project).toMatchObject({ businessId: s.businessId, name: "Logo refresh", kind: "custom", status: "active", templateKey: null, dealId: null, documentId: null, test: false });
    const id = made.body.project.id;
    expect((await json("POST", "/projects", { businessId: s.businessId, name: "" })).status).toBe(400);
    expect((await json("POST", "/projects", { businessId: s.businessId, name: "x".repeat(121) })).status).toBe(400);
    expect((await json("POST", "/projects", { businessId: s.businessId, name: "ok", extra: 1 })).status).toBe(400);

    const paused = await json("PATCH", `/projects/${id}`, { status: "paused", pausedReason: "Waiting for the client's logo" });
    expect(paused.status).toBe(200);
    expect(paused.body.project).toMatchObject({ status: "paused", pausedReason: "Waiting for the client's logo" });
    expect((await getProject(env.DB, id))!.pausedReason).toBe("Waiting for the client's logo");
    const back = await json("PATCH", `/projects/${id}`, { status: "active" });
    expect(back.body.project).toMatchObject({ status: "active", pausedReason: null });
    expect((await json("PATCH", `/projects/${id}`, { status: "done" })).status).toBe(400);
    expect((await json("PATCH", `/projects/${id}`, {})).status).toBe(400);
  });

  it("resuming a paused project dispatches its ready Claude steps", async () => {
    const s = await seedProject({ bare: true });
    await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "a", owner: "claude", title: "Claude's step" })]);
    await setProjectStatus(env.DB, s.project.id, "paused", { reason: "invoice overdue" });
    expect(await jobs()).toEqual([]);
    expect((await json("PATCH", `/projects/${s.project.id}`, { status: "active" })).status).toBe(200);
    expect(await jobs()).toHaveLength(1);
  });

  it("done and cancelled projects refuse reopening", async () => {
    const done = await seedProject({ bare: true });
    await markProjectDone(env.DB, done.project.id, T0);
    const cancelled = await seedProject({ bare: true });
    expect((await json("PATCH", `/projects/${cancelled.project.id}`, { status: "cancelled" })).body.project.status).toBe("cancelled");
    for (const id of [done.project.id, cancelled.project.id]) {
      for (const status of ["active", "paused", "cancelled"]) {
        const r = await json("PATCH", `/projects/${id}`, { status });
        expect(r.status, `${id} ${status}`).toBe(409);
        expect(typeof r.body.error).toBe("string");
      }
    }
    expect((await getProject(env.DB, done.project.id))!.status).toBe("done");
    expect((await getProject(env.DB, cancelled.project.id))!.status).toBe("cancelled");
  });

  it("adds an ad hoc task that is not a step, and refuses a login in its title", async () => {
    const s = await seedProject({ bare: true });
    const r = await json("POST", `/projects/${s.project.id}/tasks`, { title: "Call the printer", owner: "logan", estMinutes: 30, billable: true, dueOn: "2026-12-24" });
    expect(r.status).toBe(201);
    expect(r.body.task).toMatchObject({ title: "Call the printer", isStep: false, owner: "logan", estMinutes: 30, billable: true, dueOn: "2026-12-24", status: "todo", projectId: s.project.id });
    expect((await json("POST", `/projects/${s.project.id}/tasks`, { title: "" })).status).toBe(400);
    expect((await json("POST", `/projects/${s.project.id}/tasks`, { title: "t", requires: ["nope"] })).status).toBe(409);
    expect((await json("POST", `/projects/${s.project.id}/tasks`, { title: "password: hunter2hunter2" })).status).toBe(400);
    await setProjectStatus(env.DB, s.project.id, "cancelled");
    expect((await json("POST", `/projects/${s.project.id}/tasks`, { title: "late" })).status).toBe(409);
  });
});

describe("task actions", () => {
  async function gated() {
    const s = await seedProject({ bare: true });
    const t = await seedSteps(s.project.id, s.businessId, [{ key: "1", title: "Get the logo" }, { key: "2", title: "Place the logo", requires: ["1"] }]);
    return { ...s, a: t[0], b: t[1] };
  }

  it("complete on a gated step is 409 with blockedBy titles, and works once the gate is met", async () => {
    const s = await gated();
    const r = await json("POST", `/tasks/${s.b.id}/complete`);
    expect(r.status).toBe(409);
    expect(r.body.blockedBy).toEqual(["Get the logo"]);
    expect(r.body.error).toContain("Get the logo");
    const start = await json("POST", `/tasks/${s.b.id}/start`);
    expect(start.status).toBe(409);
    expect(start.body.blockedBy).toEqual(["Get the logo"]);
    expect((await json("POST", `/tasks/${s.a.id}/complete`)).body.task).toMatchObject({ status: "done" });
    expect((await json("POST", `/tasks/${s.b.id}/complete`)).body.task).toMatchObject({ status: "done" });
  });

  it("skip without a reason is 400, and a step with a reason is skipped with the reason as a note", async () => {
    const s = await gated();
    expect((await json("POST", `/tasks/${s.a.id}/skip`, {})).status).toBe(400);
    expect((await json("POST", `/tasks/${s.a.id}/skip`)).status).toBe(400);
    expect((await json("POST", `/tasks/${s.a.id}/skip`, { reason: "no" })).status).toBe(400);
    expect((await getTask(env.DB, s.a.id))!.status).toBe("todo");
    const ok = await json("POST", `/tasks/${s.a.id}/skip`, { reason: "The client has no logo" });
    expect(ok.status).toBe(200);
    expect(ok.body.task.status).toBe("skipped");
    expect((await listComments(env.DB, s.a.id)).map((c) => c.body)).toEqual(["Skipped: The client has no logo"]);
    // a skipped step that is not skippable does not satisfy the gate
    expect((await json("POST", `/tasks/${s.b.id}/complete`)).status).toBe(409);
  });

  it("start, waiting, reopen and move answer with the task", async () => {
    const s = await gated();
    expect((await json("POST", `/tasks/${s.a.id}/start`)).body.task.status).toBe("in_progress");
    expect((await json("POST", `/tasks/${s.a.id}/waiting`, { on: true })).body.task.status).toBe("waiting_client");
    expect((await json("POST", `/tasks/${s.a.id}/waiting`, { on: false })).body.task.status).toBe("in_progress");
    expect((await json("POST", `/tasks/${s.a.id}/waiting`, {})).body.task.status).toBe("waiting_client");
    expect((await json("POST", `/tasks/${s.a.id}/complete`)).body.task.status).toBe("done");
    expect((await json("POST", `/tasks/${s.a.id}/reopen`)).body.task.status).toBe("todo");
    expect((await json("POST", `/tasks/${s.a.id}/reopen`)).body.task.status).toBe("todo");
    expect((await json("POST", `/tasks/${s.a.id}/complete`)).status).toBe(200);
    // a locked task cannot be started
    await setTaskStatus(env.DB, s.b.id, "locked", { now: T0 });
    expect((await json("POST", `/tasks/${s.b.id}/start`)).status).toBe(409);
    // move
    const moved = await json("POST", `/tasks/${s.b.id}/move`, { toPosition: 0 });
    expect(moved.status).toBe(200);
    expect(moved.body.tasks.map((t: any) => t.id)).toEqual([s.b.id, s.a.id]);
    expect((await json("POST", `/tasks/${s.b.id}/move`, { toPosition: -1 })).status).toBe(400);
    expect((await json("POST", `/tasks/${s.b.id}/move`, { toPosition: "first" })).status).toBe(400);
  });

  it("GET and PATCH a task, with its comments and time", async () => {
    const s = await gated();
    expect((await json("POST", `/tasks/${s.a.id}/comment`, { body: "The logo is in the shared folder" })).status).toBe(201);
    expect((await json("POST", `/tasks/${s.a.id}/comment`, { body: "" })).status).toBe(400);
    expect((await json("POST", `/tasks/${s.a.id}/comment`, {})).status).toBe(400);
    const cred = await json("POST", `/tasks/${s.a.id}/comment`, { body: "password: hunter2hunter2" });
    expect(cred.status).toBe(400);
    expect(JSON.stringify(cred.body)).not.toContain("hunter2");
    const got = await json("GET", `/tasks/${s.a.id}`);
    expect(got.status).toBe(200);
    expect(got.body.task.id).toBe(s.a.id);
    expect(got.body.comments).toEqual([{ id: expect.any(String), author: "logan", body: "The logo is in the shared folder", createdAt: expect.any(String) }]);
    expect(got.body.time).toMatchObject({ actualMinutes: 0, billableMinutes: 0, entries: [] });

    const patched = await json("PATCH", `/tasks/${s.a.id}`, { title: "Collect the logo", estMinutes: 45, doneWhen: "A vector logo is in the folder", checklist: [{ text: "SVG", done: false }] });
    expect(patched.body.task).toMatchObject({ title: "Collect the logo", estMinutes: 45, checklist: [{ text: "SVG", done: false }] });
    expect((await json("PATCH", `/tasks/${s.a.id}`, { title: "" })).status).toBe(400);
    expect((await json("PATCH", `/tasks/${s.a.id}`, { estMinutes: 601 })).status).toBe(400);
    expect((await json("PATCH", `/tasks/${s.a.id}`, { dueOn: "2026-13-45" })).status).toBe(400);
    expect((await json("PATCH", `/tasks/${s.a.id}`, { color: "red" })).status).toBe(400);
    expect((await json("PATCH", `/tasks/${s.a.id}`, {})).status).toBe(400);
    // requirements must exist and must not loop
    expect((await json("PATCH", `/tasks/${s.a.id}`, { requires: ["zzz"] })).status).toBe(409);
    const loop = await json("PATCH", `/tasks/${s.a.id}`, { requires: ["2"] });
    expect(loop.status).toBe(409);
    expect(loop.body.error).toMatch(/loop/);
  });

  it("delete of a started task is 409, and a fresh unused one goes", async () => {
    const s = await gated();
    const extra = (await json("POST", `/projects/${s.project.id}/tasks`, { title: "Scratch" })).body.task;
    await json("POST", `/tasks/${s.a.id}/start`);
    const r = await json("DELETE", `/tasks/${s.a.id}`);
    expect(r.status).toBe(409);
    expect(typeof r.body.error).toBe("string");
    expect(await getTask(env.DB, s.a.id)).not.toBeNull();
    // another step requires b's predecessor... a never-started step that others require is refused too
    const needed = await json("DELETE", `/tasks/${s.a.id}`);
    expect(needed.status).toBe(409);
    expect((await json("DELETE", `/tasks/${extra.id}`)).body).toEqual({ ok: true });
    expect(await getTask(env.DB, extra.id)).toBeNull();
  });

  it("a database error after the step was saved is a 500 that says to repeat the request, and repeating it finishes the job", async () => {
    const s = await seedProject({ bare: true });
    const [a] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "1", milestone: "design_approved", title: "Client OK on the design" })]);
    const r = await failing(`BEFORE INSERT ON project_milestones BEGIN SELECT RAISE(ABORT, 'disk hiccup at /var/db'); END`, () => json("POST", `/tasks/${a.id}/complete`));
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/saved/i);
    expect(r.body.error).toMatch(/repeat/i);
    expect(JSON.stringify(r.body)).not.toMatch(/hiccup|var\/db|SQLITE|trigger/i);
    expect((await getTask(env.DB, a.id))!.status).toBe("done");
    const again = await json("POST", `/tasks/${a.id}/complete`);
    expect(again.status).toBe(200);
    expect((await json("GET", `/projects/${s.project.id}`)).body.milestones).toEqual([{ milestone: "design_approved", reachedAt: expect.any(String) }]);
  });

  it("a database error that left the step as it was does not claim it was saved", async () => {
    const s = await seedProject({ bare: true });
    const [a] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "1" })]);
    const r = await failing(`BEFORE UPDATE ON tasks WHEN NEW.status = 'skipped' BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`, () => json("POST", `/tasks/${a.id}/skip`, { reason: "Not needed here" }));
    expect(r.status).toBe(500);
    expect(r.body.error).not.toMatch(/was saved/i);
    expect(r.body.error).toMatch(/try again/i);
    expect(JSON.stringify(r.body)).not.toMatch(/hiccup/);
    expect((await getTask(env.DB, a.id))!.status).toBe("todo");
  });

  it("a skip whose finishing work failed says it was saved, and a repeat finishes it", async () => {
    const s = await seedProject({ bare: true });
    const [a] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "1", milestone: "site_finished", skippable: true })]);
    const [b] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "2", position: 1 })]);
    await json("POST", `/tasks/${b.id}/complete`);
    const r = await failing(`BEFORE UPDATE ON projects WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'disk hiccup'); END`, () => json("POST", `/tasks/${a.id}/skip`, { reason: "Handled by hand" }));
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/saved.*repeat/i);
    expect((await getTask(env.DB, a.id))!.status).toBe("skipped");
    expect((await json("POST", `/tasks/${a.id}/skip`, { reason: "Handled by hand" })).status).toBe(200);
    expect((await getProject(env.DB, s.project.id))!.status).toBe("done");
  });
});

describe("Claude from the task routes", () => {
  it("a task of a test project can ask Claude and a real one is queued by dispatch", async () => {
    const test = await seedProject({ bare: true, test: true });
    const [tt] = await seedSteps(test.project.id, test.businessId, [{ key: "1", owner: "claude" }]);
    expect(await jobs()).toEqual([]);
    const asked = await json("POST", `/tasks/${tt.id}/ask-claude`, { note: "Use the blue from the logo" });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ queued: true, task: { status: "in_progress" } });
    expect((await jobs()).map((j) => j.target_id)).toEqual([tt.id]);
    expect((await listComments(env.DB, tt.id)).map((c) => [c.author, c.body])).toEqual([["logan", "Use the blue from the logo"]]);
    // asking twice asks for nothing new
    expect((await json("POST", `/tasks/${tt.id}/ask-claude`)).body.queued).toBe(false);
    expect(await jobs()).toHaveLength(1);

    // A real project: finishing Logan's step is what sends Claude's next one, nobody pressed Ask Claude.
    await resetProjectWork();
    const real = await seedProject({ bare: true });
    const [first, second] = await seedSteps(real.project.id, real.businessId, [{ key: "1", owner: "logan" }, { key: "2", owner: "claude", requires: ["1"] }]);
    expect(await jobs()).toEqual([]);
    await json("POST", `/tasks/${first.id}/complete`);
    expect((await jobs()).map((j) => j.target_id)).toEqual([second.id]);
    expect((await getTask(env.DB, second.id))!.status).toBe("in_progress");
  });

  it("ask-claude refuses a finished step and a note that is a login, and queues nothing", async () => {
    const s = await seedProject({ bare: true, test: true });
    const [a, b] = await seedSteps(s.project.id, s.businessId, [{ key: "1", owner: "claude" }, { key: "2", owner: "claude" }]);
    await json("POST", `/tasks/${a.id}/complete`);
    expect((await json("POST", `/tasks/${a.id}/ask-claude`)).status).toBe(409);
    const cred = await json("POST", `/tasks/${b.id}/ask-claude`, { note: "password: hunter2hunter2" });
    expect(cred.status).toBe(400);
    expect(JSON.stringify(cred.body)).not.toContain("hunter2");
    expect(await jobs()).toEqual([]);
  });

  async function inReview() {
    const s = await seedProject({ bare: true, test: true });
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1", owner: "claude_drafts", title: "Draft the brief" }]);
    await setTaskStatus(env.DB, t.id, "in_progress", { now: T0 });
    const approval = await createReviewApproval(env as never, (await getTask(env.DB, t.id))!, { summary: "Here is the brief." });
    await setTaskStatus(env.DB, t.id, "in_review", { from: ["in_progress"], now: T0, reviewApprovalId: approval.id });
    return { ...s, t, approval };
  }

  it("send-back rejects the old review card, clears the link and queues Claude again with the note", async () => {
    const s = await inReview();
    const r = await json("POST", `/tasks/${s.t.id}/send-back`, { note: "Shorter, and lead with the call to action" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ queued: true, task: { status: "in_progress", reviewApprovalId: null } });
    const card = await getApproval(s.approval.id);
    expect(card).toMatchObject({ status: "rejected", decision_note: "sent back" });
    expect((await jobs()).map((j) => j.target_id)).toEqual([s.t.id]);
    expect((await listComments(env.DB, s.t.id)).map((c) => c.body)).toEqual(["Shorter, and lead with the call to action"]);
    // not in review any more: nothing more to send back
    expect((await json("POST", `/tasks/${s.t.id}/send-back`)).status).toBe(409);
  });

  it("send-back with a note that is a login leaves the review card waiting", async () => {
    const s = await inReview();
    const r = await json("POST", `/tasks/${s.t.id}/send-back`, { note: "password: hunter2hunter2" });
    expect(r.status).toBe(400);
    expect((await getApproval(s.approval.id))!.status).toBe("pending");
    expect((await getTask(env.DB, s.t.id))).toMatchObject({ status: "in_review", reviewApprovalId: s.approval.id });
    expect(await jobs()).toEqual([]);
  });

  it("send-back on a step that is not in review is 409", async () => {
    const s = await seedProject({ bare: true, test: true });
    const [t] = await seedSteps(s.project.id, s.businessId, [{ key: "1", owner: "claude" }]);
    expect((await json("POST", `/tasks/${t.id}/send-back`)).status).toBe(409);
  });
});

describe("pushing a project's steps back to its template", () => {
  async function templated() {
    await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
    await ensureSeedSops(env.DB);
    const template = (await getTemplate(env.DB, "CARE-1"))!;
    const s = await seedProject({ bare: true, kind: "care_onboarding", templateKey: "CARE-1", name: "Care" });
    const { instantiateSop } = await import("../src/worker/sop/instantiate");
    const tasks = await instantiateSop(env.DB, { project: s.project, template });
    return { ...s, template, tasks };
  }

  it("saves the instance as the next template version and is 409 for a custom project", async () => {
    const s = await templated();
    const first = s.tasks[0];
    await json("PATCH", `/tasks/${first.id}`, { title: "A better first step" });
    expect((await json("POST", `/projects/${s.project.id}/sop/push`, {})).status).toBe(400);
    expect((await json("POST", `/projects/${s.project.id}/sop/push`, { confirm: false })).status).toBe(400);
    const r = await json("POST", `/projects/${s.project.id}/sop/push`, { confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: s.template.version + 1 });
    const saved = (await getTemplate(env.DB, "CARE-1"))!;
    expect(saved).toMatchObject({ version: s.template.version + 1, name: s.template.name, kind: s.template.kind, cadence: s.template.cadence, cadenceDay: s.template.cadenceDay, appliesTo: s.template.appliesTo, active: s.template.active });
    expect(saved.steps[0].title).toBe("A better first step");
    expect(saved.steps).toHaveLength(s.template.steps.length);

    const custom = await seedProject({ bare: true, kind: "custom", templateKey: null });
    const c = await json("POST", `/projects/${custom.project.id}/sop/push`, { confirm: true });
    expect(c.status).toBe(409);
    expect(typeof c.body.error).toBe("string");
    const missing = await seedProject({ bare: true, kind: "build", templateKey: "GONE" });
    expect((await json("POST", `/projects/${missing.project.id}/sop/push`, { confirm: true })).status).toBe(409);
  });

  it("sop push omits a deleted step and keeps an added one", async () => {
    const s = await templated();
    const last = s.tasks[s.tasks.length - 1];
    // delete the last step (nothing requires it) and add a step of the project's own
    expect((await json("DELETE", `/tasks/${last.id}`)).status).toBe(200);
    await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "9.9", phaseKey: last.phaseKey, phaseTitle: last.phaseTitle, position: last.position + 10, title: "A step Logan added" })]);
    // an ad hoc task is not a step and never goes back
    await json("POST", `/projects/${s.project.id}/tasks`, { title: "One-off errand" });
    const r = await json("POST", `/projects/${s.project.id}/sop/push`, { confirm: true });
    expect(r.status).toBe(200);
    const saved = (await getTemplate(env.DB, "CARE-1"))!;
    const keys = saved.steps.map((x) => x.key);
    expect(keys).not.toContain(last.stepKey);
    expect(keys).toContain("9.9");
    expect(saved.steps.map((x) => x.title)).not.toContain("One-off errand");
    expect(saved.steps).toHaveLength(s.template.steps.length);
    // the instance is not touched
    expect((await listTasks(env.DB, s.project.id)).some((t) => t.title === "One-off errand")).toBe(true);
  });

  it("a push that would make an invalid template is a 400 with the problems and saves nothing", async () => {
    const s = await templated();
    // two steps made to wait on each other
    const [a, b] = s.tasks;
    await env.DB.prepare(`UPDATE tasks SET requires = ? WHERE id = ?`).bind(JSON.stringify([b.stepKey]), a.id).run();
    await env.DB.prepare(`UPDATE tasks SET requires = ? WHERE id = ?`).bind(JSON.stringify([a.stepKey]), b.id).run();
    const r = await json("POST", `/projects/${s.project.id}/sop/push`, { confirm: true });
    expect(r.status).toBe(400);
    expect(r.body.problems.join(" ")).toMatch(/loop/);
    expect((await getTemplate(env.DB, "CARE-1"))!.version).toBe(s.template.version);
  });
});

describe("starting projects from a deal", () => {
  const pkg = (key: ProposalContent["packages"][number]["key"], name: string): ProposalContent["packages"][number] => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });
  async function signedDeal(o: { paid?: boolean; test?: boolean } = {}) {
    const s = await seedDeal();
    const base = proposal();
    const content: ProposalContent = { ...base, packages: [pkg("starter_site", "Starter Site")] };
    const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
    const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
    expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
    if (o.paid) await setPaid(env.DB, doc.id, "2026-12-03T09:00:00.000Z");
    return { ...s, doc: (await getDocument(env.DB, doc.id))! };
  }

  it("start needs a signed, real, paid proposal and is 409 with a plain sentence otherwise", async () => {
    const none = await seedDeal();
    const r0 = await json("POST", `/deals/${none.dealId}/projects/start`);
    expect(r0.status).toBe(409);
    expect(r0.body.error).toMatch(/signed proposal/);
    const unpaid = await signedDeal();
    const r1 = await json("POST", `/deals/${unpaid.dealId}/projects/start`);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatch(/deposit/);
    const test = await signedDeal({ paid: true, test: true });
    expect((await json("POST", `/deals/${test.dealId}/projects/start`)).status).toBe(409);
    const [{ n }] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM projects WHERE business_id IN (?, ?, ?)`).bind(none.businessId, unpaid.businessId, test.businessId).all<{ n: number }>()).results;
    expect(n).toBe(0);
  });

  it("start makes the build project once, and a repeat finds the same one", async () => {
    const s = await signedDeal({ paid: true });
    const r = await json("POST", `/deals/${s.dealId}/projects/start`);
    expect(r.status).toBe(200);
    expect(r.body.projects).toHaveLength(1);
    expect(r.body.projects[0]).toMatchObject({ kind: "build", templateKey: "BUILD", documentId: s.doc.id, dealId: s.dealId, test: false });
    const again = await json("POST", `/deals/${s.dealId}/projects/start`);
    expect(again.body.projects.map((p: any) => p.id)).toEqual(r.body.projects.map((p: any) => p.id));
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM projects WHERE business_id = ?`).bind(s.businessId).first<{ n: number }>())!.n).toBe(1);
    expect((await listActivity(env.DB, s.businessId)).filter((a) => a.kind === "project_started")).toHaveLength(1);
  });

  it("test start works for a test copy and is 409 for a real proposal or none", async () => {
    const test = await signedDeal({ test: true });
    const r = await json("POST", `/deals/${test.dealId}/projects/test`);
    expect(r.status).toBe(201);
    expect(r.body.projects[0]).toMatchObject({ kind: "build", test: true });
    expect(await jobs()).toEqual([]);
    const real = await signedDeal({ paid: true });
    const bad = await json("POST", `/deals/${real.dealId}/projects/test`);
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/real/);
    const none = await seedDeal();
    expect((await json("POST", `/deals/${none.dealId}/projects/test`)).status).toBe(409);
  });
});

describe("GET /me/tasks", () => {
  it("lists Logan's ready and in-review tasks grouped by project, and leaves out blocked, Claude's and finished ones", async () => {
    const a = await seedProject({ bare: true, name: "Alpha" });
    const ta = await seedSteps(a.project.id, a.businessId, [
      { key: "1", title: "Ready one" }, { key: "2", title: "Blocked one", requires: ["1"] }, { key: "3", title: "Claude's", owner: "claude" }, { key: "4", title: "Drafted", owner: "claude_drafts" },
    ]);
    await setTaskStatus(env.DB, ta[3].id, "in_review", { now: T0 });
    const b = await seedProject({ bare: true, name: "Beta" });
    const tb = await seedSteps(b.project.id, b.businessId, [{ key: "1", title: "Under way" }, { key: "2", title: "Finished" }]);
    await setTaskStatus(env.DB, tb[0].id, "in_progress", { now: T0 });
    await setTaskStatus(env.DB, tb[1].id, "done", { now: T0 });
    const paused = await seedProject({ bare: true, name: "Gamma" });
    await seedSteps(paused.project.id, paused.businessId, [{ key: "1", title: "Hidden" }]);
    await setProjectStatus(env.DB, paused.project.id, "paused");

    const r = await json("GET", "/me/tasks");
    expect(r.status).toBe(200);
    const group = (id: string) => r.body.projects.find((p: any) => p.projectId === id);
    expect(group(a.project.id)).toMatchObject({ projectName: "Alpha", businessId: a.businessId, test: false });
    expect(group(a.project.id).tasks.map((t: any) => t.title).sort()).toEqual(["Drafted", "Ready one"]);
    expect(group(b.project.id).tasks.map((t: any) => t.title)).toEqual(["Under way"]);
    expect(group(paused.project.id)).toBeUndefined();
  });
});
