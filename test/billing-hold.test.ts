import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { liftManually, sweepHolds } from "../src/worker/billing/hold";
import { renderPauseNotice } from "../src/worker/billing/mail";
import { onAnyInvoicePaid } from "../src/worker/billing/paid";
import { planSubscriptions } from "../src/worker/billing/subscriptions";
import { voidSentInvoice } from "../src/worker/billing/discard";
import { createApproval } from "../src/worker/db/approvals";
import { listActivity } from "../src/worker/db/activity";
import { getDocument } from "../src/worker/db/documents";
import { activeHolds, isOnHold, placeHold } from "../src/worker/db/holds";
import { attachStripeInvoice, getInvoice, insertMirroredInvoice, markInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { insertOutbound, markSent } from "../src/worker/db/messages";
import { addCadence, createProject, setProjectStatus } from "../src/worker/db/projects";
import { saveSettings } from "../src/worker/db/settings";
import { ensureSeedSops } from "../src/worker/db/sops";
import { listSubscriptions } from "../src/worker/db/subscriptions";
import { getTask, insertTasks, listComments, listTasks } from "../src/worker/db/tasks";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { dispatchReady, requestClaudeStep } from "../src/worker/projects/dispatch";
import { generateRecurring } from "../src/worker/projects/sweep";
import { completeTask as completeStep, startTask, TaskStateError } from "../src/worker/projects/service";
import { buildBundle } from "../src/worker/queue/bundle";
import { completeTask as finishJob, getTask as getJob, markTaskStale } from "../src/worker/queue/db";
import { failedJobCount, SOP_STEP_KIND } from "../src/worker/queue/sopStep";
import "../src/worker/queue/kinds";
import { seedDraft, seedSubscriptionDoc } from "./fixtures/billing";
import { claimById } from "./fixtures/draftTask";
import { readyToSend } from "./fixtures/documents";
import { newTask, resetProjectWork, seedProject } from "./fixtures/projects";
import { KEY, stripeApi } from "./fixtures/stripe";

const e = env as Env;
const E_TEST = { ...env, STRIPE_SECRET_KEY: KEY } as Env;
// 10:00 on the given day in Los Angeles (winter: UTC-8).
const at = (day: string) => new Date(`${day}T18:00:00.000Z`);
const DUE = "2027-01-20";
const PAUSE_DAY = "2027-02-03"; // DUE plus the default 14 days
const LINK = "https://invoice.stripe.com/i/abc";
const NOW = new Date("2026-12-10T12:00:00.000Z");

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mail = await readyToSend();
  await resetProjectWork();
  await ensureSeedSops(env.DB);
  await env.DB.prepare(`UPDATE sop_templates SET active = 1`).run();
  await saveSettings(env.DB, { billing_config: "{}" });
  // The sweep reads every open invoice and a hold covers a whole business, and the tests of a file share storage: leftovers are put out of the way.
  await env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE status IN ('open', 'failed')`).run();
  await env.DB.prepare(`UPDATE billing_holds SET lifted_at = '2026-01-01T00:00:00.000Z', lifted_by = 'manual' WHERE lifted_at IS NULL`).run();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); setStripeFetchForTests(null); });

/** The mail clock, with the same recording sender, so a notice's "days overdue" reads from the day given. */
const clock = (day: string) => setMailDeps({ smtp: async (_mb, _pw, msg) => { mail.sent.push(msg); }, now: () => at(day) });

/** The original `invoice.send` approval of an invoice and the mail it sent, in the state given. */
async function sendApproval(inv: InvoiceRow, mailStatus: "sent" | "sending" | "failed" | null) {
  const a = await createApproval(env.DB, { kind: "invoice.send", title: "Send invoice", preview: "", payload: { invoiceId: inv.id }, record_type: "business", record_id: inv.businessId, drafted_by: "logan" });
  await env.DB.prepare(`UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?`).bind("2027-01-13T10:00:00.000Z", a.id).run();
  if (mailStatus) {
    const id = crypto.randomUUID();
    expect(await insertOutbound(env.DB, id, { mailbox: "main", businessId: inv.businessId, enrollmentId: null, stepIndex: null, approvalId: a.id, messageId: `<${id}@x>`, inReplyTo: null, to: "pat@ace.test", subject: "Invoice", text: "x", now: "2027-01-13T10:00:00.000Z" })).toBe(true);
    if (mailStatus === "sent") await markSent(env.DB, id, "2027-01-13T10:00:01.000Z");
    if (mailStatus === "failed") await env.DB.prepare(`UPDATE messages SET status = 'failed' WHERE id = ?`).bind(id).run();
  }
  return a;
}

type SeedArg = NonNullable<NonNullable<Parameters<typeof seedDraft>[0]>["seed"]>;
type Client = { businessId: string; dealId: string; documentId: string | null };
/** A real milestone invoice for a client, sent the way the send approval leaves it: open, due `dueOn`, its mail sent (unless `mailed` says otherwise). */
async function sent(s: Client, o: { dueOn?: string | null; test?: boolean; mailed?: "sent" | "sending" | "failed" | null } = {}) {
  const d = await seedDraft({ seed: s as SeedArg, test: o.test ?? false });
  expect(await attachStripeInvoice(env.DB, d.invoice.id, { stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: LINK, dueOn: o.dueOn === undefined ? DUE : o.dueOn, now: "2027-01-13T10:00:00.000Z" })).toBe(true);
  const invoice = (await getInvoice(env.DB, d.invoice.id))!;
  await sendApproval(invoice, o.mailed === undefined ? "sent" : o.mailed);
  return invoice;
}

/** A real client with a real active project holding one Claude step, and (when asked) an overdue invoice. */
async function client(o: { project?: "build" | "care" } = {}) {
  const s = o.project === "care" ? await seedProject({ kind: "care_onboarding", templateKey: "CARE-0" }) : await seedProject();
  const [step] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { stepKey: "a", owner: "claude", title: "Write the homepage draft" })]);
  return { ...s, step };
}
type C = Awaited<ReturnType<typeof client>>;
/** The client's invoice goes 14 days past due and the sweep places its hold: the state every enforcement test starts from. */
async function held(c: Client) {
  const invoice = await sent(c);
  expect(await sweepHolds(e, at(PAUSE_DAY))).toBe(1);
  return { invoice, hold: (await activeHolds(env.DB, c.businessId))[0] };
}

const pauseNotices = async (invoiceId: string) =>
  (await env.DB.prepare(`SELECT id, status, payload, preview, title, record_type, record_id, drafted_by FROM approvals WHERE kind = 'invoice.pause_notice' AND json_extract(payload, '$.invoiceId') = ? ORDER BY created_at, id`).bind(invoiceId).all<any>()).results;
const nudges = async (invoiceId: string) =>
  (await env.DB.prepare(`SELECT step, approval_id FROM invoice_nudges WHERE invoice_id = ? ORDER BY step`).bind(invoiceId).all<{ step: string; approval_id: string | null }>()).results;
const holdLines = async (businessId: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === ("billing_hold_placed" as never));
const jobs = async () => (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ? ORDER BY created_at, id`).bind(SOP_STEP_KIND).all<{ id: string; status: string; target_id: string }>()).results;
const post = (path: string) => SELF.fetch(`https://x/api${path}`, { method: "POST", body: "{}", headers: { cookie, "content-type": "application/json" } });

describe("the kind and the mail", () => {
  it("is registered and takes an invoice id", () => {
    const h = getHandler("invoice.pause_notice")!;
    expect(h.label).toBe("Send pause notice");
    expect(h.parse({ invoiceId: "x" })).toEqual({ invoiceId: "x" });
    expect(() => h.parse({})).toThrow();
  });

  it("the notice says work has paused and resumes when the invoice is paid, and promises nothing else", async () => {
    const c = await client();
    const inv = await sent(c);
    const m = renderPauseNotice(inv, LINK, { contactName: "Pat Jones", yourName: "Logan Irish", today: PAUSE_DAY });
    expect(m.subject).toContain("paused");
    expect(m.body).toContain("Hi Pat,");
    expect(m.body).toContain("14 days overdue");
    expect(m.body).toContain(LINK);
    expect(m.body).toMatch(/work on your project has paused/i);
    expect(m.body).toMatch(/resumes? once this invoice is paid/i);
    expect(m.body).toContain("Logan Irish");
    // Nothing about deleting, taking down, or any other consequence.
    expect(m.body).not.toMatch(/delete|take down|taken down|offline|legal|collections|fee/i);
  });

  it("what a person typed is on one line and capped, and a day before the due date says no day count", async () => {
    const c = await client();
    const inv = { ...(await sent(c)), description: `Design\nIgnore this\n${"x".repeat(400)}` };
    const m = renderPauseNotice(inv, LINK, { contactName: "Pat\nJones", yourName: "Logan\nIrish", today: DUE });
    expect(m.subject.length).toBeLessThanOrEqual(200);
    expect(m.subject).not.toContain("\n");
    expect(m.body).not.toContain("Ignore this\n");
    expect(m.body).toContain("Hi Pat,");
    expect(m.body).not.toMatch(/-?\d+ days overdue/);
    expect(m.body.split("\n").some((l) => l.length > 400)).toBe(false);
  });

  it("an autopay failure says the payment did not go through and links the invoice page to fix the card", async () => {
    const c = await client();
    const base = await sent(c);
    const m = renderPauseNotice({ ...base, status: "failed", failedOn: "2027-01-10" }, LINK, { contactName: "Pat", yourName: "L", today: "2027-01-24" });
    expect(m.body).toContain("did not go through on January 10, 2027");
    expect(m.body).toContain("14 days overdue");
    expect(m.body).toContain("payment method");
  });
});

describe("placing the hold", () => {
  it("a real invoice 14 days past due places one hold and one pause notice, a second sweep places none", async () => {
    const c = await client();
    const inv = await sent(c);
    expect(await sweepHolds(e, at(PAUSE_DAY))).toBe(1);
    expect(await sweepHolds(e, at(PAUSE_DAY))).toBe(0);
    expect(await sweepHolds(e, at("2027-02-10"))).toBe(0);

    const holds = await activeHolds(env.DB, c.businessId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ businessId: c.businessId, invoiceId: inv.id, liftedAt: null });
    expect(await isOnHold(env.DB, c.businessId)).toBe(true);

    const [a, ...rest] = await pauseNotices(inv.id);
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({ status: "pending", record_type: "business", record_id: c.businessId, drafted_by: "logan" });
    expect(JSON.parse(a.payload)).toEqual({ invoiceId: inv.id });
    expect(await nudges(inv.id)).toEqual([{ step: "pause", approval_id: a.id }]);
    expect(a.title).toContain("Ace Plumbing");
    expect(a.preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a.preview).toMatch(/work on your project has paused/i);
    expect(a.preview).toContain(LINK);
    expect(a.preview).toContain("Nothing is mailed until you approve");

    const lines = await holdLines(c.businessId);
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain(inv.ref);
    expect(mail.sent).toHaveLength(0); // the notice is an approval: nothing went to the client
  });

  it("two sweeps at the same moment place one hold and make one notice", async () => {
    const c = await client();
    const inv = await sent(c);
    const [x, y] = await Promise.all([sweepHolds(e, at(PAUSE_DAY)), sweepHolds(e, at(PAUSE_DAY))]);
    expect(x + y).toBe(1);
    expect(await activeHolds(env.DB, c.businessId)).toHaveLength(1);
    expect(await pauseNotices(inv.id)).toHaveLength(1);
    expect(await holdLines(c.businessId)).toHaveLength(1);
  });

  it("13 days past due places none", async () => {
    const c = await client();
    const inv = await sent(c);
    expect(await sweepHolds(e, at("2027-02-02"))).toBe(0);
    expect(await activeHolds(env.DB, c.businessId)).toEqual([]);
    expect(await nudges(inv.id)).toEqual([]);
    expect(await pauseNotices(inv.id)).toEqual([]);
  });

  it("the pause day follows the setting", async () => {
    await saveSettings(env.DB, { billing_config: JSON.stringify({ pauseAfterDays: 10 }) });
    const c = await client();
    await sent(c);
    expect(await sweepHolds(e, at("2027-01-29"))).toBe(0);
    expect(await sweepHolds(e, at("2027-01-30"))).toBe(1);
  });

  it("a test invoice places none", async () => {
    const c = await client();
    const inv = await sent(c, { test: true });
    expect(await sweepHolds(e, at("2027-03-01"))).toBe(0);
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
    expect(await nudges(inv.id)).toEqual([]);
  });

  it("a draft, paid, void or uncollectible invoice places none", async () => {
    const c = await client();
    const draft = await seedDraft({ seed: c as SeedArg });
    const paid = await sent(c), voided = await sent(c), lost = await sent(c);
    await markInvoice(env.DB, paid.id, { status: "paid", paidAt: "2027-01-15T10:00:00.000Z" });
    await markInvoice(env.DB, voided.id, { status: "void" });
    await markInvoice(env.DB, lost.id, { status: "uncollectible" });
    expect(await sweepHolds(e, at("2027-03-01"))).toBe(0);
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
    for (const x of [draft.invoice, paid, voided, lost]) expect(await nudges(x.id)).toEqual([]);
  });

  it("an open invoice with no due date places none", async () => {
    const c = await client();
    await sent(c, { dueOn: null });
    expect(await sweepHolds(e, at("2027-03-01"))).toBe(0);
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
  });

  it("an invoice whose original mail never went places no hold, and holds once it did", async () => {
    // Open and dated (Stripe made it) but the mail failed and the approval was dropped: the client never got the link, so their work must not stop.
    const c = await client();
    const none = await sent(c, { mailed: null });
    const failed = await sent(c, { mailed: "failed" });
    const stuck = await sent(c, { mailed: "sending" });
    expect(await sweepHolds(e, at("2027-03-01"))).toBe(0);
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
    for (const x of [none, failed, stuck]) { expect(await nudges(x.id)).toEqual([]); expect(await pauseNotices(x.id)).toEqual([]); }
    await env.DB.prepare(`UPDATE messages SET status = 'sent', sent_at = '2027-02-26T10:00:00.000Z' WHERE approval_id IN (SELECT id FROM approvals WHERE kind = 'invoice.send' AND json_extract(payload, '$.invoiceId') = ?)`).bind(failed.id).run();
    expect(await sweepHolds(e, at("2027-03-01"))).toBe(1);
    expect((await activeHolds(env.DB, c.businessId)).map((h) => h.invoiceId)).toEqual([failed.id]);
  });

  it("a mirrored failed subscription invoice holds from failed_on, with no invoice.send mail behind it", async () => {
    const s = await seedSubscriptionDoc({ keys: ["website_subscription"] });
    await planSubscriptions(E_TEST, (await getDocument(env.DB, s.documentId))!);
    const sub = (await listSubscriptions(env.DB, { businessId: s.businessId }))[0];
    const { invoice } = await insertMirroredInvoice(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: null, subscriptionId: sub.id, kind: "subscription", ref: `stripe:in_${crypto.randomUUID().slice(0, 8)}`, test: false,
      description: "Website Subscription: monthly", lines: [{ description: "Website Subscription: monthly", amountCents: 29700 }], stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`,
      hostedUrl: "https://invoice.stripe.com/i/sub", dueOn: null, failedOn: null, now: "2027-01-05T10:00:00.000Z",
    });
    expect(await markInvoice(env.DB, invoice.id, { status: "failed", failedOn: "2027-01-10" }, { failedOnOnce: true })).toBe(true);
    expect(await sweepHolds(e, at("2027-01-23"))).toBe(0); // 13 days after it failed
    expect(await sweepHolds(e, at("2027-01-24"))).toBe(1);
    expect(await isOnHold(env.DB, s.businessId)).toBe(true);
    const [a] = await pauseNotices(invoice.id);
    expect(a.preview).toContain("https://invoice.stripe.com/i/sub");
    expect(a.preview).toContain("payment method");
  });

  it("a hold lifted by hand is not placed again by the next sweep", async () => {
    const c = await client();
    const { hold } = await held(c);
    await liftManually(e, hold.id, at(PAUSE_DAY));
    expect(await sweepHolds(e, at("2027-02-10"))).toBe(0);
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
  });
});

describe("enforcement", () => {
  it("a held client: dispatchReady queues nothing and Ask Claude is refused with a plain sentence", async () => {
    const c = await client();
    await held(c);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await jobs()).toEqual([]);
    expect(await getTask(env.DB, c.step.id)).toMatchObject({ status: "todo", claudeTaskId: null });

    const direct = await requestClaudeStep(e, c.step.id).catch((x) => x);
    expect(direct).toBeInstanceOf(TaskStateError);
    expect((direct as Error).message).toMatch(/unpaid invoice/);
    const r = await post(`/tasks/${c.step.id}/ask-claude`);
    expect(r.status).toBe(409);
    expect((await r.json<{ error: string }>()).error).toMatch(/unpaid invoice/);
    expect(await jobs()).toEqual([]);
    expect(await getTask(env.DB, c.step.id)).toMatchObject({ status: "todo" });
  });

  it("a held client: send-back is refused the same way and the review card is left waiting", async () => {
    const c = await client();
    await held(c);
    await env.DB.prepare(`UPDATE tasks SET status = 'in_review' WHERE id = ?`).bind(c.step.id).run();
    const r = await post(`/tasks/${c.step.id}/send-back`);
    expect(r.status).toBe(409);
    expect((await r.json<{ error: string }>()).error).toMatch(/unpaid invoice/);
    expect(await jobs()).toEqual([]);
  });

  it("another client is not held back", async () => {
    const a = await client(), b = await client();
    await held(a);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    expect((await getTask(env.DB, b.step.id))!.status).toBe("in_progress");
    expect((await getTask(env.DB, a.step.id))!.status).toBe("todo");
  });

  it("a held client: generateRecurring makes no task, also for a finished Care project", async () => {
    const build = await seedProject();
    await addCadence(env.DB, build.project.id, "CARE-1");
    const care = await seedProject({ kind: "care_onboarding", templateKey: "CARE-0" });
    await setProjectStatus(env.DB, care.project.id, "done"); // a finished Care onboarding stays live: only the hold can stop it
    await addCadence(env.DB, care.project.id, "CARE-4");
    await held(build);
    await held(care);
    expect(await generateRecurring(e, NOW)).toBe(0);
    expect((await listTasks(env.DB, build.project.id)).filter((t) => t.cadenceKey)).toEqual([]);
    expect((await listTasks(env.DB, care.project.id)).filter((t) => t.cadenceKey)).toEqual([]);
    // Lifted, the same sweep makes them.
    for (const h of await activeHolds(env.DB)) await liftManually(e, h.id, NOW);
    expect(await generateRecurring(e, NOW)).toBe(2);
  });

  it("a held client: an in-flight Claude result is stale and the step is handed back", async () => {
    const c = await client();
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    const job = await claimById((await getTask(env.DB, c.step.id))!.claudeTaskId!);
    await held(c); // the invoice went 14 days overdue while Claude was working
    expect(await finishJob(e, job.id, { summary: "Drafted the homepage and saved it as home-v1." })).toEqual({ ok: true });
    expect((await getJob(env.DB, job.id))!.status).toBe("stale");
    expect(await getTask(env.DB, c.step.id)).toMatchObject({ status: "todo", claudeTaskId: null, reviewApprovalId: null });
    const comments = await listComments(env.DB, c.step.id);
    expect(comments.map((x) => x.author)).toEqual(["system"]); // no Claude comment applied
    expect(comments[0].body).toMatch(/unpaid invoice/);
    expect(await failedJobCount(env.DB, c.step.id)).toBe(0); // not Claude's failure
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
  });

  it("a held client: a job built after the hold is stale and the step is handed back, and it goes again once the hold lifts", async () => {
    const c = await client();
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    const job = await claimById((await getTask(env.DB, c.step.id))!.claudeTaskId!);
    const { hold } = await held(c);
    expect(await buildBundle(e, job)).toHaveProperty("stale");
    expect(await getTask(env.DB, c.step.id)).toMatchObject({ status: "todo", claudeTaskId: null });
    await markTaskStale(env.DB, job.id, "the client has an unpaid invoice");
    await liftManually(e, hold.id, NOW);
    expect((await getTask(env.DB, c.step.id))!.status).toBe("in_progress"); // the lift dispatched it
  });

  it("a held client: a retry of a job that already saved its step as done is stale and does not finish anything again", async () => {
    const c = await client();
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 1 });
    const job = await claimById((await getTask(env.DB, c.step.id))!.claudeTaskId!);
    await env.DB.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).bind(c.step.id).run(); // the first attempt saved it, then died
    await held(c);
    expect(await finishJob(e, job.id, { summary: "Drafted the homepage." })).toEqual({ ok: true });
    expect((await getJob(env.DB, job.id))!.status).toBe("stale");
  });

  it("a project started for an already-held client dispatches nothing", async () => {
    const first = await client();
    await held(first);
    // A second project (a change order's, or a new proposal's) for the same client, with a ready Claude step.
    const { project } = await createProject(env.DB, {
      businessId: first.businessId, dealId: first.dealId, documentId: null, onboardingId: null, kind: "build", name: "Second build", test: false,
      templateKey: "BUILD", templateVersion: 1, careDeferred: false, startedAt: "2027-02-04T10:00:00.000Z",
    });
    const [step] = await insertTasks(env.DB, [newTask(project.id, first.businessId, { stepKey: "z", owner: "claude" })]);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    expect(await getTask(env.DB, step.id)).toMatchObject({ status: "todo" });
    expect(await jobs()).toEqual([]);
  });

  it("a held client's tasks can still be worked by hand", async () => {
    const c = await client();
    const [mine] = await insertTasks(env.DB, [newTask(c.project.id, c.businessId, { stepKey: "m", owner: "logan", title: "Call the client", position: 5 })]);
    await held(c);
    expect((await startTask(e, mine.id, NOW)).status).toBe("in_progress");
    expect((await completeStep(e, mine.id, { by: "logan", now: NOW })).status).toBe("done");
    // Logan can also finish Claude's step himself.
    expect((await completeStep(e, c.step.id, { by: "logan", now: NOW })).status).toBe("done");
    expect(await jobs()).toEqual([]);
  });
});

describe("lifting the hold", () => {
  it("two overdue invoices: paying one keeps the hold, paying both lifts it and dispatch resumes without another sweep", async () => {
    const c = await client();
    const one = await sent(c), two = await sent(c);
    expect(await sweepHolds(e, at(PAUSE_DAY))).toBe(2);
    expect(await activeHolds(env.DB, c.businessId)).toHaveLength(2);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });

    await markInvoice(env.DB, one.id, { status: "paid", paidAt: "2027-02-04T10:00:00.000Z" });
    await onAnyInvoicePaid(e, (await getInvoice(env.DB, one.id))!);
    expect((await activeHolds(env.DB, c.businessId)).map((h) => h.invoiceId)).toEqual([two.id]);
    expect(await isOnHold(env.DB, c.businessId)).toBe(true);
    expect(await jobs()).toEqual([]);
    expect((await getTask(env.DB, c.step.id))!.status).toBe("todo");

    await markInvoice(env.DB, two.id, { status: "paid", paidAt: "2027-02-05T10:00:00.000Z" });
    await onAnyInvoicePaid(e, (await getInvoice(env.DB, two.id))!);
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
    expect((await getTask(env.DB, c.step.id))!.status).toBe("in_progress"); // no sweep ran: paying dispatched it
    expect(await jobs()).toHaveLength(1);
  });

  it("voiding the overdue invoice lifts its hold", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const c = await client();
    const { invoice } = await held(c);
    await voidSentInvoice(E_TEST, invoice.id);
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
    expect((await getTask(env.DB, c.step.id))!.status).toBe("in_progress"); // the void dispatched it: no sweep needed
    expect(await jobs()).toHaveLength(1);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 }); // and a sweep after it finds nothing more to send
  });

  it("Logan lifting a hold resumes dispatch", async () => {
    const c = await client();
    const { hold } = await held(c);
    expect(await dispatchReady(e, NOW)).toEqual({ queued: 0 });
    await liftManually(e, hold.id, at("2027-02-04"));
    expect(await isOnHold(env.DB, c.businessId)).toBe(false);
    const row = await env.DB.prepare(`SELECT lifted_at, lifted_by FROM billing_holds WHERE id = ?`).bind(hold.id).first<{ lifted_at: string; lifted_by: string }>();
    expect(row).toEqual({ lifted_at: at("2027-02-04").toISOString(), lifted_by: "manual" });
    expect((await getTask(env.DB, c.step.id))!.status).toBe("in_progress"); // dispatched by the lift itself, no sweep
    // Lifting again, or an unknown hold, changes nothing and does not throw.
    await liftManually(e, hold.id, at("2027-02-05"));
    await liftManually(e, "nope", at("2027-02-05"));
    expect((await env.DB.prepare(`SELECT lifted_at FROM billing_holds WHERE id = ?`).bind(hold.id).first<{ lifted_at: string }>())!.lifted_at).toBe(at("2027-02-04").toISOString());
  });
});

describe("approving the pause notice", () => {
  it("mails the client the fixed notice once, with the days overdue from the mail clock", async () => {
    const c = await client();
    const { invoice } = await held(c);
    const [a] = await pauseNotices(invoice.id);
    clock("2027-02-05");
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("pat@ace.test");
    expect(mail.sent[0].subject).not.toMatch(/^\[Test\]/);
    expect(mail.sent[0].text).toContain("16 days overdue");
    expect(mail.sent[0].text).toMatch(/work on your project has paused/i);
    expect(mail.sent[0].text).toContain(LINK);
    expect((await listActivity(env.DB, c.businessId)).some((x) => x.kind === "note" && /pause notice sent/.test(x.detail ?? ""))).toBe(true);
    expect(await isOnHold(env.DB, c.businessId)).toBe(true); // sending the notice does not change the hold
  });

  it("approving a pause notice after the hold lifted mails nothing", async () => {
    const c = await client();
    const { invoice, hold } = await held(c);
    const [a] = await pauseNotices(invoice.id);
    await liftManually(e, hold.id, at("2027-02-04"));
    clock("2027-02-05");
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect((await listActivity(env.DB, c.businessId)).some((x) => x.kind === "note" && /pause notice not sent.*already lifted/.test(x.detail ?? ""))).toBe(true);
  });

  it("approving it after the invoice was paid mails nothing", async () => {
    const c = await client();
    const { invoice } = await held(c);
    const [a] = await pauseNotices(invoice.id);
    await markInvoice(env.DB, invoice.id, { status: "paid", paidAt: "2027-02-04T10:00:00.000Z" });
    await onAnyInvoicePaid(e, (await getInvoice(env.DB, invoice.id))!);
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
  });

  it("a test invoice's notice goes to the owner only, with [Test] on the subject", async () => {
    const c = await client();
    const inv = await sent(c, { test: true });
    expect(await placeHold(env.DB, { businessId: c.businessId, invoiceId: inv.id, now: at(PAUSE_DAY).toISOString() })).toBe(true);
    const a = await createApproval(env.DB, { kind: "invoice.pause_notice", title: "Send pause notice", preview: "", payload: { invoiceId: inv.id }, record_type: "business", record_id: c.businessId, drafted_by: "logan" });
    clock(PAUSE_DAY);
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("logan@siteline.test");
    expect(mail.sent[0].subject.startsWith("[Test] ")).toBe(true);
  });

  it("an invoice that is no longer open or failed is not mailed", async () => {
    const c = await client();
    const { invoice } = await held(c);
    const [a] = await pauseNotices(invoice.id);
    await markInvoice(env.DB, invoice.id, { status: "uncollectible" });
    expect(await approve(e, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
  });
});
