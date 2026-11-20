import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { createDraft, getDocument, signDocument } from "../src/worker/db/documents";
import { getInvoiceForDocument } from "../src/worker/db/invoices";
import { getOnboardingForDeal } from "../src/worker/db/onboardings";
import { listMilestones, listProjects } from "../src/worker/db/projects";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { onMilestone, onProjectDone } from "../src/worker/projects/hooks";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { E, deliver, signedDeal } from "./fixtures/close";
import { OWNER_EMAIL, REVIEWED_CONFIG, clientSig, proposal, readyToSend, seedDeal, sendDraft, stubPdfRenderer } from "./fixtures/documents";
import { invoiceEvent } from "./fixtures/stripe";
import { resetProjectWork } from "./fixtures/projects";

// Projects after the close, through the entry points the app really uses: the Stripe webhook, the owner's routes (tasks, timer, change orders, settings, approvals), the MCP tools
// (propose_approval, next_claude_task, complete_claude_task), the client's change-order page and the daily cron, with the world replaced by fakes (Stripe, the mail transport,
// the PDF browser) and the clock (a fixed calendar: Tuesday 1 December 2026, in Los Angeles, which is UTC-8).
const BASE = "https://clients.hellositeline.test";
const CLIENT_MAIL = "pat@acme.test";
const ctx = () => createExecutionContext();
const SENT = "2026-12-01T17:00:00.000Z"; // Tue 1 Dec 09:00 in Los Angeles: the day the proposals are sent
const at = (iso: string) => vi.setSystemTime(new Date(iso));

/** What the Worker's hooks tell the test (registered once, for this file's Worker). */
const reached: string[] = [];
const finished: string[] = [];
onMilestone(async (_env, p, m) => { reached.push(`${p.templateKey}:${m}`); });
onProjectDone(async (_env, p) => { finished.push(p.templateKey ?? p.kind); });

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
let cookie = "";
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(SENT);
  reached.length = 0; finished.length = 0;
  await resetProjectWork();
  await env.DB.batch(["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "approvals"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  mail = await readyToSend();
  setMailDeps({ ...getMailDeps(), now: () => new Date() }); // the mail transport's clock is the test's clock
  stubPdfRenderer();
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});
afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
  setMailDeps(null); setPdfRendererForTests(null); setStripeFetchForTests(null);
});

/** The owner's browser: the session cookie. */
const owner = (method: string, path: string, body?: unknown) =>
  worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
const ok = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await owner(method, path, body);
  expect(r.status, `${method} ${path} ${r.status}`).toBe(status);
  return (await r.json()) as T;
};
/** The client's browser: no cookie, only the link. */
const clientCall = (token: string, method: string, path = "", body?: unknown) =>
  worker.fetch(new Request(`https://x/api/public/c/${token}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), E, ctx());
const clientOnboarding = (token: string, method: string, path = "", body?: unknown) =>
  worker.fetch(new Request(`https://x/api/public/o/${token}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), E, ctx());

/** The tools Claude Code calls, over MCP. */
let rpcId = 0;
async function mcp(name: string, args: unknown) {
  const r = await SELF.fetch("https://x/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-mcp-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as { result: { isError?: boolean; content: { text: string }[] } };
}

interface TaskView { id: string; stepKey: string | null; title: string; status: string; owner: string; phaseKey: string; position: number; requires: string[]; isStep: boolean; claudeTaskId: string | null; changeOrderId: string | null; cadenceKey: string | null; periodKey: string | null; dueOn: string | null }
interface ProjectView {
  project: { id: string; kind: string; status: string; templateKey: string; careDeferred: boolean; onboardingId: string | null; name: string };
  tasks: TaskView[]; milestones: { milestone: string; reachedAt: string }[]; waitingOnClient: boolean;
  time: { actualMinutes: number }; profit: { soldCents: number; paidCents: number; costCents: number; marginSoldCents: number; marginPaidCents: number; effectiveHourlyCents: number | null };
  changeOrders: { id: string; status: string; paidAt: string | null; test: boolean; link: string | null; content: { reference: string; priceCents: number; hours: number; contactEmail: string } }[];
}
const project = (id: string) => ok<ProjectView>("GET", `/projects/${id}`);
const projectsOf = async (businessId: string) => (await listProjects(env.DB, { businessId })).sort((a, b) => a.templateKey!.localeCompare(b.templateKey!));
const step = (v: ProjectView, key: string) => v.tasks.find((t) => t.stepKey === key)!;

/**
 * Finishes the project's steps through POST /tasks/:id/complete in step order, skipping `skip` and any step that still waits on one that is not finished (the way Logan would work down the list).
 * Stops after `through` when given. Returns the keys finished.
 */
async function walk(projectId: string, o: { through?: string; skip?: string[]; stopBefore?: string } = {}): Promise<string[]> {
  const steps = (await project(projectId)).tasks.filter((t) => t.isStep).sort((a, b) => a.position - b.position);
  const closed = new Set(steps.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.stepKey));
  const out: string[] = [];
  for (const t of steps) {
    if (t.stepKey === o.stopBefore) break;
    if (closed.has(t.stepKey) || o.skip?.includes(t.stepKey!) || t.requires.some((r) => !closed.has(r))) continue;
    const r = await owner("POST", `/tasks/${t.id}/complete`);
    expect(r.status, `complete ${t.stepKey} ${t.title}`).toBe(200);
    closed.add(t.stepKey); out.push(t.stepKey!);
    if (t.stepKey === o.through) break;
  }
  return out;
}

/** Every sop.step job with the step it is for. */
const jobs = async (businessId?: string) => (await env.DB.prepare(
  `SELECT c.id, c.status, t.step_key AS stepKey, t.phase_key AS phaseKey, t.cadence_key AS cadenceKey, t.change_order_id AS changeOrderId, t.project_id AS projectId
     FROM claude_tasks c JOIN tasks t ON t.id = c.target_id WHERE c.kind = 'sop.step' ${businessId ? "AND t.business_id = ?" : ""} ORDER BY c.created_at, c.id`,
).bind(...(businessId ? [businessId] : [])).all<{ id: string; status: string; stepKey: string | null; phaseKey: string; cadenceKey: string | null; changeOrderId: string | null; projectId: string }>()).results;
const activity = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 400)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const approvalRow = (kind: string, recordId?: string) =>
  env.DB.prepare(`SELECT id, status, preview, payload FROM approvals WHERE kind = ? ${recordId ? "AND record_id = ?" : ""} ORDER BY created_at, id`).bind(...(recordId ? [kind, recordId] : [kind])).all<{ id: string; status: string; preview: string; payload: string }>();

/** Pays the deal's deposit: the signed event Stripe would send. */
const pay = async (docId: string) => {
  const event = invoiceEvent("invoice.paid", (await getInvoiceForDocument(env.DB, docId))!);
  expect(await deliver(event)).toBe(200);
  return event;
};
const approveOver = async (id: string) => {
  const r = await owner("POST", `/approvals/${id}/approve`, {});
  const body = await r.json();
  expect({ status: r.status, body }).toEqual({ status: 200, body: { ok: true } });
};

describe("projects, end to end", () => {
  it("a paid Starter + Care proposal runs through the build, the timer, a change order, Care and the daily sweep", async () => {
    const a = await signedDeal({ name: "Ace Plumbing" });
    const b = await signedDeal({ name: "Bay Roofing" });
    mail.sent.length = 0;
    // Settings > Work: an hour of Logan's time costs $60.
    await ok("PUT", "/settings", { work_config: JSON.stringify({ costRateCentsPerHour: 6000 }) });

    // ---- Wed 2 Dec 10:00: the webhook starts the onboarding and ONE build project; Care waits; only first-phase Claude steps are queued. Nothing is mailed.
    at("2026-12-02T18:00:00.000Z");
    const event = await pay(a.docId);
    const onboarding = (await getOnboardingForDeal(env.DB, a.dealId))!;
    const aProjects = await projectsOf(a.businessId);
    expect(aProjects.map((p) => [p.templateKey, p.kind, p.status, p.careDeferred, p.test])).toEqual([["BUILD", "build", "active", true, false]]);
    const build = (await project(aProjects[0].id));
    expect(build.project).toMatchObject({ name: "Ace Plumbing: Website build", onboardingId: onboarding.id });
    expect(build.tasks.length).toBeGreaterThan(40);
    expect(build.tasks.every((t) => t.isStep)).toBe(true);
    expect(build.waitingOnClient).toBe(false);
    // The Claude steps ready now: those of the first phase with nothing to wait on. Nothing from a later phase, though several later steps are Claude's and have no requirement left.
    expect((await jobs(a.businessId)).map((j) => [j.stepKey, j.phaseKey, j.status])).toEqual([["1.2", "collect", "pending"]]);
    expect(step(build, "1.2")).toMatchObject({ status: "in_progress", owner: "claude_drafts" });
    expect(mail.sent).toEqual([]);
    const [welcome] = (await approvalRow("onboarding.welcome", a.dealId)).results;
    await approveOver(welcome.id); // the welcome goes out, so the onboarding runs (and the Friday update can be drafted)
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);

    // ---- Claude does the first step over MCP: next_claude_task claims it, complete_claude_task puts the work in review (a drafts step), Logan's approval finishes it.
    const claimed = await mcp("next_claude_task", {});
    expect(claimed.result.content[0].text).toContain("Get access to the accounts");
    const [job] = await jobs(a.businessId);
    expect((await mcp("complete_claude_task", { id: job.id, result: { summary: "Listed what is needed and where each login is kept (the password manager item names)." } })).result.isError).toBeUndefined();
    expect(step(await project(build.project.id), "1.2").status).toBe("in_review");
    const [review] = (await approvalRow("sop.review")).results;
    expect(review.status).toBe("pending");
    await approveOver(review.id);
    expect(step(await project(build.project.id), "1.2").status).toBe("done");

    // ---- Thu 3 Dec: Logan finishes 1.1 through the owner route; the steps that waited on it go to Claude, the rest of the first phase follows. Still nothing from a later phase.
    at("2026-12-03T18:00:00.000Z");
    await ok("POST", `/tasks/${step(build, "1.1").id}/complete`);
    expect((await jobs(a.businessId)).map((j) => j.stepKey).sort()).toEqual(["1.2", "1.3", "1.4", "1.6"]);
    expect((await walk(build.project.id, { through: "1.6" })).sort()).toEqual(["1.3", "1.4", "1.5", "1.6"]);
    const afterCollect = await project(build.project.id);
    expect(step(afterCollect, "2.1")).toMatchObject({ status: "in_progress", owner: "claude_drafts" }); // the next phase's first step is now Claude's
    // 3.1 is Claude's and has nothing left to wait on (1.2 is done), but the project is still in the "plan" phase, so it waits.
    expect(step(afterCollect, "3.1")).toMatchObject({ status: "todo", owner: "claude_drafts", claudeTaskId: null });
    expect(step(afterCollect, "3.1").requires).toEqual(["1.2"]);
    expect([...new Set((await jobs(a.businessId)).map((j) => j.phaseKey))].sort()).toEqual(["collect", "plan"]);

    // ---- The timer, the manual entry, the week grid and the profit. (Thu 3 Dec 11:00 in Los Angeles.)
    at("2026-12-03T19:00:00.000Z");
    const first = step(afterCollect, "2.2"), second = step(afterCollect, "2.4");
    const t1 = await ok<{ entry: { id: string }; stopped: unknown }>("POST", `/tasks/${first.id}/timer/start`, undefined, 201);
    expect(t1.stopped).toBeNull();
    at("2026-12-03T19:30:00.000Z");
    const t2 = await ok<{ entry: { id: string }; stopped: { id: string; minutes: number; taskId: string } | null }>("POST", `/tasks/${second.id}/timer/start`, undefined, 201);
    expect(t2.stopped).toMatchObject({ id: t1.entry.id, minutes: 30, taskId: first.id }); // starting another saves the first
    expect((await ok<{ entry: { taskId: string } }>("GET", "/time/running")).entry.taskId).toBe(second.id);
    at("2026-12-03T19:50:00.000Z");
    expect((await ok<{ entry: { minutes: number } | null }>("POST", "/timer/stop", {})).entry).toMatchObject({ minutes: 20 });
    expect((await ok<{ entry: unknown }>("GET", "/time/running")).entry).toBeNull();
    await ok("POST", `/tasks/${first.id}/time`, { day: "2026-12-03", minutes: 45, note: "call with the client" }, 201);
    const week = await ok<{ days: string[]; rows: { taskId: string; title: string; minutes: number[]; total: number }[]; dayTotals: number[]; total: number }>("GET", "/time/week?of=2026-12-03");
    expect(week.days).toEqual(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"]); // Monday first
    expect(week.rows.map((r) => [r.taskId, r.total]).sort()).toEqual([[first.id, 75], [second.id, 20]].sort());
    expect(week).toMatchObject({ dayTotals: [0, 0, 0, 95, 0, 0, 0], total: 95 });
    const timed = await project(build.project.id);
    expect(timed.time.actualMinutes).toBe(95);
    const sold = (await getDocument(env.DB, a.docId))!.content.schedule.milestones.reduce((n, m) => n + m.amountCents, 0);
    const deposit = (await getInvoiceForDocument(env.DB, a.docId))!.amountCents;
    expect(sold).toBeGreaterThan(0);
    expect(timed.profit).toEqual({ soldCents: sold, paidCents: deposit, costCents: 9500, marginSoldCents: sold - 9500, marginPaidCents: deposit - 9500, effectiveHourlyCents: Math.round((deposit * 60) / 95) });

    // ---- Fri 4 Dec 09:00: the daily cron drafts the Friday update for approval. It tells the client what finished and what is next in their own words, and no internal step title.
    at("2026-12-04T17:00:00.000Z");
    await runScheduled(E, DAILY_CRON, new Date());
    await runScheduled(E, DAILY_CRON, new Date());
    const fridays = (await approvalRow("onboarding.nudge", a.dealId)).results;
    expect(fridays.map((f) => [f.status, JSON.parse(f.payload).nudgeKey])).toEqual([["pending", "friday:2026-12-04"]]);
    const friday = fridays[0];
    expect(friday.preview).toContain("Done this week:\n- We have what we need from you to start");
    expect(friday.preview).toContain("Coming up next:\n- We're mapping out your pages");
    for (const t of build.tasks) expect(friday.preview, t.title).not.toContain(t.title);
    mail.sent.length = 0;
    await approveOver(friday.id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(CLIENT_MAIL);
    expect(mail.sent[0].text).toContain("Done this week:\n- We have what we need from you to start");
    expect(mail.sent[0].text).toContain("Coming up next:\n- We're mapping out your pages");
    for (const t of build.tasks) expect(mail.sent[0].text, t.title).not.toContain(t.title);

    // ---- Mon 7 Dec: a second client pays (its onboarding then goes quiet); Logan works the build through the design.
    at("2026-12-07T18:00:00.000Z");
    await pay(b.docId);
    const ob = (await getOnboardingForDeal(env.DB, b.dealId))!;
    await approveOver((await approvalRow("onboarding.welcome", b.dealId)).results[0].id);
    const bBuild = (await projectsOf(b.businessId))[0];
    expect(bBuild).toMatchObject({ templateKey: "BUILD", status: "active", onboardingId: ob.id });
    expect((await jobs(b.businessId)).map((j) => j.stepKey)).toEqual(["1.2"]);

    at("2026-12-07T20:00:00.000Z");
    await walk(build.project.id, { through: "4.5" });
    expect((await project(build.project.id)).milestones.map((m) => m.milestone)).toEqual(["design_approved"]);
    await ok("POST", `/tasks/${step(await project(build.project.id), "4.5").id}/complete`); // the same request again records nothing new
    expect((await project(build.project.id)).milestones).toHaveLength(1);
    expect(reached).toEqual(["BUILD:design_approved"]);
    expect(await activity(a.businessId, "project_milestone")).toEqual(["Ace Plumbing: Website build: design approved"]);

    // ---- Tue 8 Dec: QA. Two QA steps are still open, so going live is refused and names them.
    at("2026-12-08T18:00:00.000Z");
    await walk(build.project.id, { through: "6.7", skip: ["6.2", "6.5"] });
    const qa = await project(build.project.id);
    expect(["6.1", "6.3", "6.4", "6.6", "6.7"].map((k) => step(qa, k).status)).toEqual(Array(5).fill("done"));
    expect(["6.2", "6.5", "6.8", "6.9", "7.2"].map((k) => step(qa, k).status)).toEqual(["in_progress", "in_progress", "todo", "todo", "todo"]); // 6.2 and 6.5 are with Claude, who has not finished
    const goLive = await owner("POST", `/tasks/${step(qa, "7.4").id}/complete`);
    expect(goLive.status).toBe(409);
    const refusal = (await goLive.json()) as { error: string; blockedBy: string[] };
    expect(refusal.blockedBy).toEqual(expect.arrayContaining(["Test every form", "Run the speed, accessibility and SEO checks"]));
    expect(refusal.error).toContain("Test every form");
    expect(refusal.error).toContain("Run the speed, accessibility and SEO checks");
    expect(step(await project(build.project.id), "7.4").status).toBe("todo");
    expect(reached).toEqual(["BUILD:design_approved"]); // the site is not finished yet

    // Finish them: the client's OK to launch (6.8) is the site_finished milestone, and then going live works.
    await ok("POST", `/tasks/${step(qa, "6.2").id}/complete`);
    await ok("POST", `/tasks/${step(qa, "6.5").id}/complete`);
    await walk(build.project.id, { through: "7.2" });
    const ready = await project(build.project.id);
    expect(ready.milestones.map((m) => m.milestone).sort()).toEqual(["design_approved", "site_finished"]);
    expect(step(ready, "7.4").status).toBe("todo");
    await ok("POST", `/tasks/${step(ready, "7.4").id}/complete`);
    expect(step(await project(build.project.id), "7.4").status).toBe("done");
    expect([...reached].sort()).toEqual(["BUILD:design_approved", "BUILD:site_finished"]); // each milestone's hooks ran once
    expect((await listMilestones(env.DB, build.project.id)).map((m) => m.milestone).sort()).toEqual(["design_approved", "site_finished"]);
    expect((await activity(a.businessId, "project_milestone")).sort()).toEqual(["Ace Plumbing: Website build: design approved", "Ace Plumbing: Website build: site finished"]);
    // Care is still waiting for the build, and Claude has only been given steps from the phases the project has reached.
    expect((await projectsOf(a.businessId)).map((p) => p.templateKey)).toEqual(["BUILD"]);
    const phases = [...new Set((await jobs(a.businessId)).map((j) => j.phaseKey))];
    expect(phases).not.toContain("handoff");
    expect(phases).not.toContain("care_offer");

    // ---- Wed 9 Dec: the last step. Everything before it first; the project is not done until it is.
    at("2026-12-09T17:00:00.000Z");
    const rest = await project(build.project.id);
    const last = rest.tasks.filter((t) => t.isStep).sort((x, y) => y.position - x.position)[0];
    expect(last.stepKey).toBe("9.3");
    await walk(build.project.id, { stopBefore: "9.3" });
    expect((await project(build.project.id)).project.status).toBe("active");
    expect((await projectsOf(a.businessId)).map((p) => p.templateKey)).toEqual(["BUILD"]);
    expect(finished).toEqual([]);
    await ok("POST", `/tasks/${last.id}/complete`);
    const done = await project(build.project.id);
    expect(done.project.status).toBe("done");
    expect(finished).toEqual(["BUILD"]);
    expect(await activity(a.businessId, "project_done")).toEqual(["Ace Plumbing: Website build finished"]);
    // Care starts now, once: CARE-0, active, with its own first Claude step queued.
    const after = await projectsOf(a.businessId);
    expect(after.map((p) => [p.templateKey, p.kind, p.status, p.careDeferred])).toEqual([["BUILD", "build", "done", true], ["CARE-0", "care_onboarding", "active", false]]);
    const care = await project(after[1].id);
    expect(care.project.name).toBe("Ace Plumbing: Care onboarding");
    expect(care.tasks.length).toBeGreaterThan(5);
    expect((await jobs(a.businessId)).some((j) => j.projectId === care.project.id && j.stepKey === "1.2")).toBe(true);
    // A done build takes no change order (the extra work goes on the Care project, which is open).
    const refused = await owner("POST", `/projects/${build.project.id}/change-orders`, { title: "Too late", hours: 1 });
    expect(refused.status).toBe(409);

    // ---- A small piece of extra work comes up in an email: Claude flags it over MCP, Logan approves the draft.
    const flagged = await mcp("propose_approval", {
      kind: "change_order.draft", title: "Draft a change order: gallery page", preview: "Pat asked for a gallery page by email.",
      payload: { projectId: care.project.id, title: "Add a gallery page", summary: "A page of twelve job photos.", reason: "Pat asked for it by email.", hours: 2, source: "email" },
    });
    expect(flagged.result.isError).toBeUndefined();
    const proposed = JSON.parse(flagged.result.content[0].text) as { id: string; kind: string; status: string };
    expect(proposed).toMatchObject({ kind: "change_order.draft", status: "pending" });
    expect((await project(care.project.id)).changeOrders).toEqual([]); // nothing is drafted until Logan approves
    await approveOver(proposed.id);
    const drafted = (await project(care.project.id)).changeOrders;
    expect(drafted).toHaveLength(1);
    const co = drafted[0];
    expect(co).toMatchObject({ status: "draft", test: false, content: { hours: 2, contactEmail: CLIENT_MAIL } });
    expect(co.content.priceCents).toBe(Math.round(2 * ((await env.DB.prepare(`SELECT price_cents AS p FROM packages WHERE key = 'hourly' ORDER BY version DESC LIMIT 1`).first<{ p: number }>())!.p)));
    expect(co.content.reference).toMatch(/^SL-[A-Z0-9]+-CARE0-CO1$/);
    // Its task is locked, and Logan hands it to Claude (nothing is queued while it is locked).
    const lockedTask = (await project(care.project.id)).tasks.find((t) => t.changeOrderId === co.id)!;
    expect(lockedTask).toMatchObject({ status: "locked", owner: "logan", isStep: false });
    await ok("PATCH", `/tasks/${lockedTask.id}`, { owner: "claude" });
    expect((await jobs(a.businessId)).some((j) => j.changeOrderId === co.id)).toBe(false);

    // ---- Sending it. A TEST order (on a rehearsal project) mails only the owner, even before the lawyer's review is recorded; a REAL one is refused until it is.
    await ok("PUT", "/settings", { documents_config: "{}" });
    const testDeal = await seedDeal();
    const tBase = proposal();
    const tPkg = (key: ProposalContent["packages"][number]["key"], name: string) => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });
    const tContent: ProposalContent = { ...tBase, packages: [tPkg("starter_site", "Starter Site"), tPkg("care", "Care")] };
    const tDraft = await createDraft(env.DB, { dealId: testDeal.dealId, businessId: testDeal.businessId, optionId: "b", content: tContent, test: true });
    const { doc: tDoc, hash: tHash } = await sendDraft(tDraft.id, tContent, { expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(await signDocument(env.DB, tDoc.id, clientSig(tHash), "2026-12-02T09:00:00.000Z")).toBe("signed");
    const rehearsal = await ok<{ projects: { id: string; test: boolean }[] }>("POST", `/deals/${testDeal.dealId}/projects/test`, undefined, 201);
    expect(rehearsal.projects.every((p) => p.test)).toBe(true);
    const claudeJobsBefore = (await jobs()).length;
    const testCo = (await ok<{ changeOrder: { id: string; test: boolean } }>("POST", `/projects/${rehearsal.projects[0].id}/change-orders`, { title: "Rehearsal gallery", hours: 1 }, 201)).changeOrder;
    expect(testCo.test).toBe(true);
    const testSend = (await ok<{ approval: { id: string } }>("POST", `/change-orders/${testCo.id}/send`)).approval;
    mail.sent.length = 0;
    await approveOver(testSend.id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toMatch(/^\[Test\] Change order for /);
    expect(await jobs()).toHaveLength(claudeJobsBefore); // a rehearsal queues nothing for Claude

    const send = (await ok<{ approval: { id: string; kind: string } }>("POST", `/change-orders/${co.id}/send`)).approval;
    expect(send.kind).toBe("change_order.send");
    mail.sent.length = 0;
    const blocked = await owner("POST", `/approvals/${send.id}/approve`, {});
    expect(blocked.status).toBe(502);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Settings > Documents/);
    expect(mail.sent).toEqual([]);
    expect((await project(care.project.id)).changeOrders[0].status).toBe("draft");
    await ok("PUT", "/settings", { documents_config: REVIEWED_CONFIG }); // the review is recorded in Settings > Documents
    await approveOver(send.id);
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    const sentOrder = (await project(care.project.id)).changeOrders[0];
    expect(sentOrder.status).toBe("sent");
    const token = sentOrder.link!.slice(`${BASE}/c/`.length);
    expect(mail.sent[0].text).toContain(`${BASE}/c/${token}`);

    // ---- The client opens it on their phone and signs. The tasks are still locked: signing is not paying.
    at("2026-12-09T19:00:00.000Z");
    const page = (await (await clientCall(token, "GET")).json()) as { state: string; contentSha256: string; payment: string; priceCents: number };
    expect(page).toMatchObject({ state: "open", payment: "none" });
    const signedRes = await clientCall(token, "POST", "/sign", { name: "Pat Jones", consent: true, authority: true, sha256: page.contentSha256 });
    expect(signedRes.status).toBe(200);
    expect(await signedRes.json()).toMatchObject({ state: "signed" });
    expect((await project(care.project.id)).changeOrders[0]).toMatchObject({ status: "signed", paidAt: null });
    expect((await project(care.project.id)).tasks.find((t) => t.id === lockedTask.id)!.status).toBe("locked");
    expect((await jobs(a.businessId)).some((j) => j.changeOrderId === co.id)).toBe(false);
    expect(await activity(a.businessId, "change_order_signed")).toHaveLength(1);

    // ---- Logan marks it paid (the money is in his account): a confirm is needed; the task unlocks once and goes to Claude.
    expect((await owner("POST", `/change-orders/${co.id}/mark-paid`, {})).status).toBe(400);
    expect((await project(care.project.id)).tasks.find((t) => t.id === lockedTask.id)!.status).toBe("locked");
    await ok("POST", `/change-orders/${co.id}/mark-paid`, { confirm: true });
    const unlocked = (await project(care.project.id)).tasks.find((t) => t.id === lockedTask.id)!;
    expect(unlocked).toMatchObject({ status: "in_progress", owner: "claude" });
    expect((await jobs(a.businessId)).filter((j) => j.changeOrderId === co.id)).toHaveLength(1); // Claude dispatch resumed for it
    await ok("POST", `/change-orders/${co.id}/mark-paid`, { confirm: true }); // again: nothing unlocks twice, nothing is queued twice
    expect((await jobs(a.businessId)).filter((j) => j.changeOrderId === co.id)).toHaveLength(1);
    const comments = (await ok<{ comments: { body: string }[] }>("GET", `/tasks/${lockedTask.id}`)).comments.filter((c) => /Unlocked/.test(c.body));
    expect(comments).toHaveLength(1);
    expect((await project(care.project.id)).changeOrders[0].paidAt).toBeTruthy();
    // The project's profit now carries the signed and paid change order (a Care project that follows a build carries no one-time sale of its own).
    expect((await project(care.project.id)).profit).toMatchObject({ soldCents: co.content.priceCents, paidCents: co.content.priceCents });

    // ---- Care is set up: finish CARE-0 through the owner route. A finished Care onboarding is live: its weekly and monthly work attach to it and the change-order task does not hold it open.
    at("2026-12-09T20:00:00.000Z");
    await walk(care.project.id);
    expect((await project(care.project.id)).project.status).toBe("done");
    expect([...finished].sort()).toEqual(["BUILD", "CARE-0"]);
    expect((await env.DB.prepare(`SELECT template_key FROM project_cadences WHERE project_id = ? ORDER BY template_key`).bind(care.project.id).all<{ template_key: string }>()).results.map((r) => r.template_key)).toEqual(["CARE-1", "CARE-4"]);

    // ---- The daily cron on Wed 9 Dec (week 50): one weekly update task, due that Wednesday, and none the second time.
    at("2026-12-09T22:00:00.000Z");
    const weekly = async () => (await project(care.project.id)).tasks.filter((t) => t.cadenceKey === "CARE-1");
    expect(await weekly()).toEqual([]);
    await runScheduled(E, DAILY_CRON, new Date());
    expect((await weekly()).map((t) => [t.periodKey, t.dueOn, t.status, t.title])).toEqual([["2026-W50", "2026-12-09", "todo", "Care weekly update: Week of Dec 7"]]);
    await runScheduled(E, DAILY_CRON, new Date());
    expect(await weekly()).toHaveLength(1);
    expect((await project(care.project.id)).tasks.filter((t) => t.cadenceKey === "CARE-4").map((t) => t.periodKey)).toEqual(["2026-12"]);

    // ---- The same Stripe event again starts nothing: no project, no step, no job, no onboarding, no welcome.
    const was = { projects: await count("projects"), tasks: await count("tasks"), jobs: await count("claude_tasks"), onboardings: await count("onboardings"), approvals: await count("approvals"), orders: await count("change_orders") };
    expect(await deliver(event)).toBe(200);
    expect({ projects: await count("projects"), tasks: await count("tasks"), jobs: await count("claude_tasks"), onboardings: await count("onboardings"), approvals: await count("approvals"), orders: await count("change_orders") }).toEqual(was);
    expect((await projectsOf(a.businessId)).map((p) => p.templateKey)).toEqual(["BUILD", "CARE-0"]);
    expect(await activity(a.businessId, "project_started")).toHaveLength(2);

    // ---- The second client left silent for 14 days: the project shows it is waiting on the client and Claude is given nothing, until the client writes.
    at("2026-12-21T18:00:00.000Z");
    const bView = async () => (await ok<{ projects: { id: string; waitingOnClient: boolean }[] }>("GET", `/projects?businessId=${b.businessId}`)).projects[0];
    expect(await bView()).toMatchObject({ id: bBuild.id, waitingOnClient: true });
    expect((await project(bBuild.id)).waitingOnClient).toBe(true);
    const bJobs = await jobs(b.businessId);
    await ok("POST", `/tasks/${step(await project(bBuild.id), "1.1").id}/complete`); // steps become ready for Claude (1.3, 1.4, 1.6)...
    await runScheduled(E, DAILY_CRON, new Date());
    await runScheduled(E, DAILY_CRON, new Date());
    expect((await jobs(b.businessId)).map((j) => j.id)).toEqual(bJobs.map((j) => j.id)); // ...and none is sent
    const held = await project(bBuild.id);
    expect(["1.3", "1.4", "1.6"].map((k) => [step(held, k).status, step(held, k).claudeTaskId])).toEqual(Array(3).fill(["todo", null]));

    // The client writes: the silence is over, and the next sweep gives Claude the steps that were waiting (the first phase only).
    expect((await clientOnboarding(ob.token, "PUT", "/answers", { answers: { business: "Roofs, gutters and skylights." } })).status).toBe(200);
    expect(await bView()).toMatchObject({ waitingOnClient: false });
    await runScheduled(E, DAILY_CRON, new Date());
    const fresh = (await jobs(b.businessId)).filter((j) => !bJobs.some((o) => o.id === j.id));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((j) => j.projectId === bBuild.id && j.phaseKey === "collect" && ["1.3", "1.4", "1.6"].includes(j.stepKey!))).toBe(true);
    expect((await jobs(b.businessId)).length).toBeLessThanOrEqual(5 + bJobs.length);

    // Nothing in the whole story was mailed to the client without an approval, and no part of it logged an unexpected error.
    expect(mail.sent.every((m) => m.to === CLIENT_MAIL || m.to === OWNER_EMAIL)).toBe(true);
    expect(errors.mock.calls.map((c: unknown[]) => c.map(String).join(" ").slice(0, 200))).toEqual([]);
  });
});
