import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { activeHolds } from "../src/worker/db/holds";
import { getInvoice, getInvoiceForDocument, listInvoices, type InvoiceRow } from "../src/worker/db/invoices";
import { listProjects } from "../src/worker/db/projects";
import { getSubscription, listSubscriptions } from "../src/worker/db/subscriptions";
import { getDocument } from "../src/worker/db/documents";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import { setPdfRendererForTests } from "../src/worker/documents/signed";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import type { Option } from "../src/worker/sales/options";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { refEvent } from "./fixtures/billing";
import { E, deliver, signedDeal } from "./fixtures/close";
import { OWNER_EMAIL, PROPOSAL_OPTIONS, REVIEWED_CONFIG, readyToSend, stubPdfRenderer } from "./fixtures/documents";
import { resetProjectWork } from "./fixtures/projects";
import { KEY, SECRET, invoiceEvent, stripeApi } from "./fixtures/stripe";

// Billing, end to end, through the entry points the app really uses: the signed Stripe webhook, the owner's routes under /api, the approvals route, the client's public /s/ and /c/
// pages, the MCP tools and the daily cron, with the world replaced by fakes (Stripe, the mail transport, the PDF browser) and the clock (a fixed calendar in Los Angeles, UTC-8 in winter
// and UTC-7 in summer). One long story, told in order; every stage asserts what it should have changed and what it must not have.
const BASE = "https://clients.hellositeline.test";
const CLIENT_MAIL = "pat@acme.test";
const ctx = () => createExecutionContext();
const SENT = "2026-12-01T17:00:00.000Z"; // Tue 1 Dec 09:00 in Los Angeles: the day the proposals are sent
const at = (iso: string) => vi.setSystemTime(new Date(iso));
/** 09:30 in Los Angeles (winter time) on a calendar date. */
const morning = (d: string) => at(`${d}T17:30:00.000Z`);
const cron = async (d: string) => { morning(d); await runScheduled(E, DAILY_CRON, new Date()); };

/** Website Subscription with Care, as the proposal builder makes it (a site always carries a Care line). */
const WEBSITE_OPTIONS: Option[] = [
  ...PROPOSAL_OPTIONS.filter((o) => o.id !== "b"),
  { id: "b", label: "Website Subscription", tagline: "A site on a plan", items: [{ key: "website_subscription" }, { key: "care" }], recommended: true },
];

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
let cookie = "";
let cookieAt = 0;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(SENT);
  await resetProjectWork();
  await env.DB.batch(["onboarding_nudges", "onboarding_files", "onboarding_answers", "onboarding_items", "onboardings", "approvals", "billing_holds", "invoice_nudges"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  // The sweeps read every open invoice and subscription, and the tests of a file share storage: leftovers from other files' tests are put out of the way.
  await env.DB.batch([
    env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE status IN ('open', 'failed')`),
    env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE status IN ('planned', 'proposed', 'link_sent', 'active', 'past_due')`),
  ]);
  mail = await readyToSend();
  setMailDeps({ ...getMailDeps(), now: () => new Date() }); // the mail transport's clock is the test's clock
  stubPdfRenderer();
  cookie = ""; cookieAt = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailDeps(null); setPdfRendererForTests(null); setStripeFetchForTests(null);
});

/** The owner's browser: the session cookie (a session lasts 30 days, and this story lasts years, so Logan signs in again when the old one has run out). */
async function signIn() {
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]; cookieAt = Date.now();
}
const owner = async (method: string, path: string, body?: unknown) => {
  if (!cookie || Date.now() - cookieAt > 25 * 86_400_000 || Date.now() < cookieAt) await signIn();
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
};
const ok = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await owner(method, path, body);
  expect(r.status, `${method} ${path} ${r.status}`).toBe(status);
  return (await r.json()) as T;
};
/** The client's browser: no cookie, only the link. */
const clientCall = (kind: "c" | "s", token: string, method: string, path = "", body?: unknown) =>
  worker.fetch(new Request(`https://x/api/public/${kind}/${token}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }), E, ctx());

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
  project: { id: string; kind: string; status: string; templateKey: string; careDeferred: boolean; name: string };
  tasks: TaskView[]; milestones: { milestone: string; reachedAt: string }[];
  changeOrders: { id: string; status: string; paidAt: string | null; link: string | null; content: { reference: string; title: string; priceCents: number } }[];
}
const project = (id: string) => ok<ProjectView>("GET", `/projects/${id}`);
const projectsOf = async (businessId: string) => (await listProjects(env.DB, { businessId })).sort((a, b) => a.templateKey!.localeCompare(b.templateKey!));
const step = (v: ProjectView, key: string) => v.tasks.find((t) => t.stepKey === key)!;

/** Finishes the project's steps through POST /tasks/:id/complete in step order (the way Logan would work down the list), up to and including `through`. */
async function walk(projectId: string, o: { through?: string } = {}): Promise<string[]> {
  const steps = (await project(projectId)).tasks.filter((t) => t.isStep).sort((a, b) => a.position - b.position);
  const closed = new Set(steps.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.stepKey));
  const out: string[] = [];
  for (const t of steps) {
    if (closed.has(t.stepKey) || t.requires.some((r) => !closed.has(r))) continue;
    const r = await owner("POST", `/tasks/${t.id}/complete`);
    expect(r.status, `complete ${t.stepKey} ${t.title}`).toBe(200);
    closed.add(t.stepKey); out.push(t.stepKey!);
    if (t.stepKey === o.through) break;
  }
  return out;
}

/** Every sop.step job with the step it is for. */
const jobs = async (businessId: string) => (await env.DB.prepare(
  `SELECT c.id, c.status, t.step_key AS stepKey, t.project_id AS projectId, t.change_order_id AS changeOrderId
     FROM claude_tasks c JOIN tasks t ON t.id = c.target_id WHERE c.kind = 'sop.step' AND t.business_id = ? ORDER BY c.created_at, c.id`,
).bind(businessId).all<{ id: string; status: string; stepKey: string | null; projectId: string; changeOrderId: string | null }>()).results;
const activity = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 400)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const approvals = (kind: string, o: { status?: string; invoiceId?: string; subscriptionId?: string } = {}) => env.DB.prepare(
  `SELECT id, status, title, preview, payload FROM approvals WHERE kind = ? ${o.status ? "AND status = ?" : ""} ${o.invoiceId ? "AND json_extract(payload, '$.invoiceId') = ?" : ""} ${o.subscriptionId ? "AND json_extract(payload, '$.subscriptionId') = ?" : ""} ORDER BY created_at, id`,
).bind(kind, ...[o.status, o.invoiceId, o.subscriptionId].filter((x): x is string => !!x)).all<{ id: string; status: string; title: string; preview: string; payload: string }>().then((r) => r.results);
const approveOver = async (id: string) => {
  const r = await owner("POST", `/approvals/${id}/approve`, {});
  const body = await r.json();
  expect({ status: r.status, body }).toEqual({ status: 200, body: { ok: true } });
};
const invoicesOf = (businessId: string, kinds?: InvoiceRow["kind"][]) => listInvoices(env.DB, { businessId, ...(kinds ? { kinds } : {}) });
const subsOf = async (businessId: string) => (await listSubscriptions(env.DB, { businessId })).sort((x, y) => x.packageKey.localeCompare(y.packageKey));

/** Pays a deal's deposit with the signed event Stripe would send. */
const payDeposit = async (docId: string) => {
  const event = invoiceEvent("invoice.paid", (await getInvoiceForDocument(env.DB, docId))!);
  expect(await deliver(event)).toBe(200);
  return event;
};
/** Approves the one waiting `invoice.send` approval of an invoice (the invoice is made at Stripe and mailed), and answers the invoice as it stands then. */
async function sendInvoice(invoiceId: string): Promise<InvoiceRow> {
  const [waiting, ...more] = await approvals("invoice.send", { status: "pending", invoiceId });
  expect(more, "one waiting approval per invoice").toEqual([]);
  expect(waiting, "an invoice.send approval is waiting").toBeTruthy();
  await approveOver(waiting.id);
  return (await getInvoice(env.DB, invoiceId))!;
}
const linkIn = (text: string, kind: "c" | "s"): string => new RegExp(`${BASE.replace(/\./g, "\\.")}/${kind}/([A-Za-z0-9_-]+)`).exec(text)![1];

describe("billing, end to end", () => {
  it("a paid Growth + Care proposal is invoiced, reminded, held and released; Care is billed by subscription; a change order is paid; a Website Subscription converts and another is left early", async () => {
    // Three signed proposals on the first of December: a Growth site with Care (Ace Plumbing), and two Website Subscriptions with Care (Bay Roofing, Cove Bakery).
    const a = await signedDeal({ name: "Ace Plumbing", optionId: "c" });
    const b = await signedDeal({ name: "Bay Roofing", optionId: "b", options: WEBSITE_OPTIONS });
    const c = await signedDeal({ name: "Cove Bakery", optionId: "b", options: WEBSITE_OPTIONS });
    mail.sent.length = 0;

    // The fake Stripe from here on: customers, invoices, products and Checkout sessions are made as asked; a Checkout stays open until the test completes it.
    const completed = new Set<string>();
    const stripeSubscriptionOf = new Map<string, string>(); // checkout session id -> the Stripe subscription it makes
    const stripe = stripeApi({
      session: (id) => (completed.has(id) ? { id, status: "complete", payment_status: "paid", subscription: stripeSubscriptionOf.get(id), customer: "cus_1" } : { id, status: "open", payment_status: "unpaid", subscription: null }),
    });
    setStripeFetchForTests(stripe.f);

    // Settings > Billing says what is set up, and never a key or a secret.
    const status = await owner("GET", "/billing/stripe-status");
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toEqual({ mode: "test", webhookSecretSet: true, clientBaseSet: true, legalReviewed: true });
    expect(statusText).not.toContain(KEY);
    expect(statusText).not.toContain(SECRET);

    // ---- Wed 2 Dec: the deposit is paid by webhook. The subscription is planned (Care starts when the site launches), the project started, and nothing is mailed.
    at("2026-12-02T18:00:00.000Z");
    const depositEvent = await payDeposit(a.docId);
    const docA = (await getDocument(env.DB, a.docId))!;
    expect(docA.paidAt).not.toBeNull();
    const [designMs, finishedMs] = [docA.content.schedule.milestones.find((m) => m.dueOn === "design_approved")!, docA.content.schedule.milestones.find((m) => m.dueOn === "site_finished")!];
    expect([designMs.amountCents, finishedMs.amountCents]).toEqual([expect.any(Number), expect.any(Number)]);
    const planned = await subsOf(a.businessId);
    expect(planned.map((s) => [s.packageKey, s.status, s.startsWhen, s.endAction, s.test])).toEqual([["care", "planned", "launch", "none", false]]);
    const aBuild = (await projectsOf(a.businessId)).map((p) => [p.templateKey, p.status, p.careDeferred]);
    expect(aBuild).toEqual([["BUILD", "active", true]]);
    const build = (await projectsOf(a.businessId))[0];
    expect(await invoicesOf(a.businessId, ["milestone"])).toEqual([]);
    expect(mail.sent).toEqual([]);
    // The other two clients pay too (their sites are built later).
    at("2026-12-03T18:00:00.000Z");
    await payDeposit(b.docId);
    await payDeposit(c.docId);
    expect((await subsOf(b.businessId)).map((s) => [s.packageKey, s.status, s.startsWhen, s.endAction, s.termMonths])).toEqual([["care", "planned", "launch", "none", null], ["website_subscription", "planned", "launch", "convert_to_care", 24]]);

    // ---- Mon 7 Dec: BUILD reaches design_approved. One draft invoice for the 30%, one approval; nothing exists at Stripe and nothing is mailed.
    at("2026-12-07T18:00:00.000Z");
    await walk(build.id, { through: "4.5" });
    const [design, ...extra] = await invoicesOf(a.businessId, ["milestone"]);
    expect(extra).toEqual([]);
    expect(design).toMatchObject({ status: "draft", amountCents: designMs.amountCents, stripeInvoiceId: null, projectId: build.id, ref: `milestone:${a.docId}:design_approved`, test: false });
    expect(design.lines).toEqual([{ description: `Design approved (${docA.content.header.reference})`, amountCents: designMs.amountCents }]);
    expect((await approvals("invoice.send", { status: "pending" })).map((x) => JSON.parse(x.payload))).toEqual([{ invoiceId: design.id }]);
    expect(stripe.made).toEqual({ customers: 0, invoices: 0, items: 0 });
    expect(mail.sent).toEqual([]);

    // Approved: one invoice at Stripe, due in a week, and one mail with Stripe's link.
    const sentDesign = await sendInvoice(design.id);
    expect(sentDesign).toMatchObject({ status: "open", dueOn: "2026-12-14", stripeInvoiceId: expect.stringMatching(/^in_/), hostedUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//) });
    expect(stripe.made.invoices).toBe(1);
    expect(stripe.made.items).toBe(1);
    const madeCall = stripe.creates().find((x) => new URL(x.url).pathname === "/v1/invoices")!;
    expect(madeCall.headers["idempotency-key"]).toBe(`inv:${design.ref}:invoice`); // a retry after a half-finished attempt replays instead of duplicating
    expect(madeCall.form.get("metadata[ref]")).toBe(design.ref);
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([[CLIENT_MAIL, expect.stringContaining("Design approved")]]);
    expect(mail.sent[0].text).toContain(sentDesign.hostedUrl!);
    expect(await activity(a.businessId, "invoice_sent")).toHaveLength(1);

    // ---- The paid webhook arrives twice (Stripe retries): one invoice_paid, the same row, nothing else.
    at("2026-12-08T18:00:00.000Z");
    const paidEvent = refEvent("invoice.paid", sentDesign);
    expect(await deliver(paidEvent)).toBe(200);
    expect(await deliver(paidEvent)).toBe(200); // the same event again
    expect(await deliver(refEvent("invoice.paid", sentDesign))).toBe(200); // a different event for the same payment
    expect(await getInvoice(env.DB, design.id)).toMatchObject({ status: "paid", mismatch: null });
    expect(await activity(a.businessId, "invoice_paid")).toHaveLength(1);
    // The cron reconciles: nothing is drafted twice, nothing proposed again, no reminder for a paid invoice.
    const before = { invoices: (await invoicesOf(a.businessId)).length, sends: (await approvals("invoice.send")).length, mails: mail.sent.length };
    await cron("2026-12-08");
    await cron("2026-12-08");
    expect({ invoices: (await invoicesOf(a.businessId)).length, sends: (await approvals("invoice.send")).length, mails: mail.sent.length }).toEqual(before);
    expect(await approvals("invoice.reminder")).toEqual([]);
    expect(stripe.made.invoices).toBe(1);

    // ---- Tue 8 Dec: site_finished (the client's OK to launch) drafts the last 30%, which is approved, sent and then left unpaid.
    at("2026-12-08T19:00:00.000Z");
    await walk(build.id, { through: "6.8" });
    const finishing = (await invoicesOf(a.businessId, ["milestone"])).filter((i) => i.id !== design.id);
    expect(finishing).toHaveLength(1);
    expect(finishing[0]).toMatchObject({ status: "draft", amountCents: finishedMs.amountCents, ref: `milestone:${a.docId}:site_finished` });
    const lastInvoice = await sendInvoice(finishing[0].id);
    expect(lastInvoice).toMatchObject({ status: "open", dueOn: "2026-12-15" });
    expect(stripe.made.invoices).toBe(2);
    expect(mail.sent).toHaveLength(2);
    expect((await invoicesOf(a.businessId, ["milestone"])).length).toBe(2); // the cron-free path made no extra

    // ---- Wed 9 Dec: the site launches and the build is finished. Care onboarding starts, and the Care subscription is proposed (first charge: launch day) with one approval.
    at("2026-12-09T18:00:00.000Z");
    await walk(build.id);
    expect((await project(build.id)).project.status).toBe("done");
    const careProject = (await projectsOf(a.businessId)).find((p) => p.templateKey === "CARE-0")!;
    expect(careProject).toMatchObject({ kind: "care_onboarding", status: "active" });
    const [careSub] = await subsOf(a.businessId);
    expect(careSub).toMatchObject({ status: "proposed", firstChargeOn: "2026-12-09", monthlyCents: 12900 });
    const [subStart, ...moreStarts] = await approvals("subscription.start", { status: "pending", subscriptionId: careSub.id });
    expect(moreStarts).toEqual([]);
    expect(subStart.preview).toContain("$129");
    await walk(careProject.id);
    expect((await project(careProject.id)).project.status).toBe("done");
    // The client's Care link goes out (approved), and the client does not open it for a while.
    mail.sent.length = 0;
    await approveOver(subStart.id);
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    const careToken = linkIn(mail.sent[0].text, "s");
    expect((await getSubscription(env.DB, careSub.id))).toMatchObject({ status: "link_sent", token: careToken });
    await cron("2026-12-09");
    const weekly = async () => (await project(careProject.id)).tasks.filter((t) => t.cadenceKey === "CARE-1").map((t) => t.periodKey);
    expect(await weekly()).toEqual(["2026-W50"]);

    // ---- The invoice for the last 30% is due Tue 15 Dec and nobody pays. The cron runs every morning from three days before it is due to fourteen days after (18 days): the reminder
    // ladder (offsets -3, 0, +3, +7) drafts each step once, Logan approves each, and on day +14 the hold is placed and one pause notice drafted.
    const ladder: Record<string, number> = { "2026-12-12": 1, "2026-12-15": 2, "2026-12-18": 3, "2026-12-22": 4 };
    let steps = 0;
    for (let n = 0; n < 18; n++) {
      const day = new Date(Date.parse("2026-12-12T12:00:00.000Z") + n * 86_400_000).toISOString().slice(0, 10);
      mail.sent.length = 0;
      await cron(day);
      await cron(day); // a second run at the same moment adds nothing
      const waitingReminders = await approvals("invoice.reminder", { status: "pending", invoiceId: lastInvoice.id });
      if (ladder[day]) {
        steps++;
        expect(waitingReminders.map((r) => JSON.parse(r.payload).step), day).toEqual([ladder[day]]);
        expect(waitingReminders[0].preview).toContain(`Reminder ${ladder[day]} of 4.`);
        await approveOver(waitingReminders[0].id);
        expect(mail.sent.map((m) => m.to), day).toEqual([CLIENT_MAIL]);
        expect(mail.sent[0].text).toContain(lastInvoice.hostedUrl!);
      } else {
        expect(waitingReminders, day).toEqual([]);
        expect(mail.sent, day).toEqual([]);
      }
      expect((await approvals("invoice.reminder", { invoiceId: lastInvoice.id })).length, day).toBe(steps);
      expect(await activeHolds(env.DB, a.businessId), day).toHaveLength(day === "2026-12-29" ? 1 : 0);
    }
    expect(steps).toBe(4);
    // Day +14 (Tue 29 Dec): the hold is in place with its one pause notice (an approval), no fifth reminder.
    const [hold] = await activeHolds(env.DB, a.businessId);
    expect(hold).toMatchObject({ invoiceId: lastInvoice.id, businessId: a.businessId, liftedAt: null, placedAt: "2026-12-29T17:30:00.000Z" });
    const notices = await approvals("invoice.pause_notice", { invoiceId: lastInvoice.id });
    expect(notices.map((n) => n.status)).toEqual(["pending"]);
    expect(await activity(a.businessId, "billing_hold_placed")).toHaveLength(1);
    expect((await ok<{ holds: { id: string; invoiceId: string }[] }>("GET", "/billing/holds")).holds.map((h) => [h.id, h.invoiceId])).toEqual([[hold.id, lastInvoice.id]]);
    expect(await ok("GET", "/billing/summary")).toMatchObject({ heldClients: 1, openCents: finishedMs.amountCents, overdueCents: finishedMs.amountCents });
    expect((await approvals("invoice.reminder", { invoiceId: lastInvoice.id })).map((r) => r.status)).toEqual(Array(4).fill("approved"));
    mail.sent.length = 0;
    await approveOver(notices[0].id);
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    expect(await activeHolds(env.DB, a.businessId)).toHaveLength(1); // telling the client changes nothing about the hold

    // ---- While held: a Claude step is not dispatched (not on the tasks-changed hook, not on the sweep, not by Ask Claude) and the finished Care project makes no recurring task.
    expect(await weekly()).toEqual(["2026-W50", "2026-W51", "2026-W52", "2026-W53"]); // made on the Mondays before the hold
    const careView = await project(careProject.id);
    const reopened = step(careView, "1.2");
    expect(reopened).toMatchObject({ status: "done", owner: "claude_drafts" });
    const claudeJobs = (await jobs(a.businessId)).length;
    await ok("POST", `/tasks/${reopened.id}/reopen`);
    expect(step(await project(careProject.id), "1.2")).toMatchObject({ status: "todo", claudeTaskId: null });
    expect((await jobs(a.businessId)).length).toBe(claudeJobs);
    const ask = await owner("POST", `/tasks/${reopened.id}/ask-claude`, {});
    expect(ask.status).toBe(409);
    expect(((await ask.json()) as { error: string }).error).toMatch(/unpaid invoice/);
    for (const day of ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-04"]) await cron(day);
    expect((await jobs(a.businessId)).length).toBe(claudeJobs);
    expect(step(await project(careProject.id), "1.2").status).toBe("todo");
    expect(await weekly()).toEqual(["2026-W50", "2026-W51", "2026-W52", "2026-W53"]); // no 2027-W01 while held
    const monthly = async () => (await project(careProject.id)).tasks.filter((t) => t.cadenceKey === "CARE-4").map((t) => t.periodKey);
    expect(await monthly()).toEqual(["2026-12"]); // no 2027-01 while held
    expect(await approvals("invoice.pause_notice", { invoiceId: lastInvoice.id })).toHaveLength(1);
    expect(await approvals("invoice.reminder", { invoiceId: lastInvoice.id })).toHaveLength(4);

    // ---- Mon 4 Jan, 10:00: the client pays. The paid webhook lifts the hold and the waiting Claude step is dispatched in the same request, before any cron.
    at("2027-01-04T18:00:00.000Z");
    expect(await deliver(refEvent("invoice.paid", lastInvoice))).toBe(200);
    expect(await getInvoice(env.DB, lastInvoice.id)).toMatchObject({ status: "paid" });
    expect(await activeHolds(env.DB, a.businessId)).toEqual([]);
    expect(await env.DB.prepare(`SELECT lifted_by AS by FROM billing_holds WHERE invoice_id = ?`).bind(lastInvoice.id).first()).toEqual({ by: "payment" });
    const resumed = (await jobs(a.businessId)).filter((j) => j.stepKey === "1.2" && j.projectId === careProject.id);
    expect(resumed.at(-1)).toMatchObject({ status: "pending" });
    expect((await jobs(a.businessId)).length).toBe(claudeJobs + 1);
    expect(step(await project(careProject.id), "1.2")).toMatchObject({ status: "in_progress" });
    expect(await deliver(refEvent("invoice.paid", lastInvoice))).toBe(200); // a replay queues nothing more
    expect((await jobs(a.businessId)).length).toBe(claudeJobs + 1);
    // The next cron makes the recurring work that was held back, once.
    await cron("2027-01-04");
    await cron("2027-01-04");
    expect(await weekly()).toEqual(["2026-W50", "2026-W51", "2026-W52", "2026-W53", "2027-W01"]);
    expect(await monthly()).toEqual(["2026-12", "2027-01"]);
    // Everything on a paid invoice stops: no more reminders, no new hold.
    expect(await approvals("invoice.reminder", { status: "pending" })).toEqual([]);
    expect(await activeHolds(env.DB, a.businessId)).toEqual([]);

    // ---- Mon 4 Jan, 11:00: the client opens the Care link from the mail (the stable page) and sets up payment. The page shows what is signed and nothing internal.
    at("2027-01-04T19:00:00.000Z");
    expect((await clientCall("s", "short-token", "GET")).status).toBe(404);
    expect((await clientCall("s", "A".repeat(43), "GET")).status).toBe(404); // well formed, unknown: the same answer
    const pageRes = await clientCall("s", careToken, "GET");
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("cache-control")).toContain("no-store");
    const page = (await pageRes.json()) as Record<string, unknown>;
    expect(page).toEqual({ clientName: "Ace Plumbing", planName: "Care", monthlyCents: 12900, firstChargeOn: "2026-12-09", chargedNow: true, termMonths: null, state: "ready" });
    // `?done=1` is only a query string: it never activates anything or changes what the page says.
    expect(await (await worker.fetch(new Request(`https://x/api/public/s/${careToken}?done=1`), E, ctx())).json()).toMatchObject({ state: "ready" });
    // Checkout: one session at Stripe, stored before the link is given out; a second click is the same page, never a second subscription.
    const start = await clientCall("s", careToken, "POST", "/checkout");
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(stripe.more.sessions).toBe(1);
    const sessionId = (await getSubscription(env.DB, careSub.id))!.stripeCheckoutSessionId!;
    expect(url).toContain(sessionId);
    expect(await (await clientCall("s", careToken, "POST", "/checkout")).json()).toEqual({ url });
    expect(stripe.more.sessions).toBe(1);
    const sessionCall = stripe.creates().find((x) => new URL(x.url).pathname === "/v1/checkout/sessions")!;
    expect(sessionCall.form.get("mode")).toBe("subscription");
    expect(sessionCall.form.get("client_reference_id")).toBe(careSub.id);
    expect(sessionCall.headers["idempotency-key"]).toBe(`checkout:${careSub.id}:2027-01-04`);
    expect(sessionCall.form.has("subscription_data[trial_end]")).toBe(false); // the first charge date is past, so the card is charged at Checkout
    expect(await subsOf(a.businessId)).toMatchObject([{ status: "link_sent" }]);

    // The client pays on Stripe's page. checkout.session.completed activates it (twice is the same as once); the page now says active and a click is refused.
    stripeSubscriptionOf.set(sessionId, "sub_ace_care"); completed.add(sessionId);
    const completedEvent = { id: "evt_ace_checkout", type: "checkout.session.completed", data: { object: { id: sessionId, mode: "subscription", status: "complete", payment_status: "paid", client_reference_id: careSub.id, subscription: "sub_ace_care", customer: "cus_ace", livemode: false } } };
    expect(await deliver(completedEvent)).toBe(200);
    expect(await deliver(completedEvent)).toBe(200);
    expect(await deliver({ ...completedEvent, id: "evt_ace_checkout_2" })).toBe(200);
    expect(await getSubscription(env.DB, careSub.id)).toMatchObject({ status: "active", stripeSubscriptionId: "sub_ace_care", stripeCustomerId: "cus_ace", termEndsOn: null, activatedAt: "2027-01-04T19:00:00.000Z" });
    expect(await (await clientCall("s", careToken, "GET")).json()).toMatchObject({ state: "active" });
    expect((await clientCall("s", careToken, "POST", "/checkout")).status).toBe(409);
    expect(stripe.more.sessions).toBe(1);
    // Stripe's first invoice (paid at Checkout) is mirrored, once, as a paid subscription invoice.
    const cycle = (id: string, over: Record<string, unknown> = {}) => ({
      id, object: "invoice", subscription: "sub_ace_care", customer: "cus_ace", currency: "usd", amount_due: 12900, amount_paid: 0, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, livemode: false, ...over,
    });
    const event = (type: string, object: Record<string, unknown>) => ({ id: `evt_${type.replace(/\./g, "_")}_${String(object.id)}_${Math.random().toString(36).slice(2, 8)}`, type, data: { object } });
    expect(await deliver(event("invoice.paid", cycle("in_ace_c1", { amount_paid: 12900 })))).toBe(200);
    const monthlyInvoices = async () => (await invoicesOf(a.businessId, ["subscription"])).sort((x, y) => x.ref.localeCompare(y.ref)).map((i) => [i.ref, i.status, i.amountCents, i.failedOn]);
    expect(await monthlyInvoices()).toEqual([["stripe:in_ace_c1", "paid", 12900, null]]);

    // ---- Thu 4 Feb: the next month's card payment fails (past due), and Stripe's retry two days later succeeds (active again). The failed invoice is the first thing the ladder counts from.
    at("2027-02-04T18:00:00.000Z");
    expect(await deliver(event("invoice.payment_failed", cycle("in_ace_c2", { due_date: Math.floor(Date.now() / 1000) })))).toBe(200);
    expect(await monthlyInvoices()).toEqual([["stripe:in_ace_c1", "paid", 12900, null], ["stripe:in_ace_c2", "failed", 12900, "2027-02-04"]]);
    expect(await getSubscription(env.DB, careSub.id)).toMatchObject({ status: "past_due" });
    expect((await ok<{ mrrCents: number }>("GET", "/billing/summary")).mrrCents).toBe(12900); // a past-due subscription still counts
    await cron("2027-02-04"); // the day it failed is day 0 of the ladder: one reminder is drafted, for the owner to approve
    expect((await approvals("invoice.reminder", { status: "pending" })).map((r) => JSON.parse(r.payload).step)).toEqual([2]);
    expect(await activeHolds(env.DB, a.businessId)).toEqual([]);
    at("2027-02-06T18:00:00.000Z");
    expect(await deliver(event("invoice.paid", cycle("in_ace_c2", { amount_paid: 12900 })))).toBe(200);
    expect(await monthlyInvoices()).toEqual([["stripe:in_ace_c1", "paid", 12900, null], ["stripe:in_ace_c2", "paid", 12900, "2027-02-04"]]);
    expect(await getSubscription(env.DB, careSub.id)).toMatchObject({ status: "active" });
    // The reminder that was waiting is approved after the payment: nothing is mailed, and the timeline says why.
    mail.sent.length = 0;
    await approveOver((await approvals("invoice.reminder", { status: "pending" }))[0].id);
    expect(mail.sent).toEqual([]);
    expect((await activity(a.businessId, "note")).some((n) => /reminder 2 not sent: .* is paid, so nothing was mailed/.test(n))).toBe(true);
    await cron("2027-02-06");
    expect(await approvals("invoice.reminder", { status: "pending" })).toEqual([]);

    // ---- Mon 8 Feb: a small piece of extra work. Claude flags it over MCP and Logan approves the draft; the order is sent through an approval and the client signs it on their phone.
    at("2027-02-08T18:00:00.000Z");
    const flagged = await mcp("propose_approval", {
      kind: "change_order.draft", title: "Draft a change order: gallery page", preview: "Pat asked for a gallery page by email.",
      payload: { projectId: careProject.id, title: "Add a gallery page", summary: "A page of twelve job photos.", reason: "Pat asked for it by email.", hours: 2, source: "email", },
    });
    expect(flagged.result.isError).toBeUndefined();
    await approveOver((JSON.parse(flagged.result.content[0].text) as { id: string }).id);
    const [order] = (await project(careProject.id)).changeOrders;
    expect(order).toMatchObject({ status: "draft" });
    const lockedTask = (await project(careProject.id)).tasks.find((t) => t.changeOrderId === order.id)!;
    expect(lockedTask).toMatchObject({ status: "locked", owner: "logan" });
    await ok("PATCH", `/tasks/${lockedTask.id}`, { owner: "claude" });
    mail.sent.length = 0;
    await approveOver((await ok<{ approval: { id: string } }>("POST", `/change-orders/${order.id}/send`)).approval.id);
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    const coToken = linkIn(mail.sent[0].text, "c");
    at("2027-02-08T20:00:00.000Z");
    const coPage = (await (await clientCall("c", coToken, "GET")).json()) as { state: string; contentSha256: string };
    expect(coPage.state).toBe("open");
    expect((await clientCall("c", coToken, "POST", "/sign", { name: "Pat Jones", consent: true, authority: true, sha256: coPage.contentSha256 })).status).toBe(200);
    // Signing drafts its invoice and puts it up for approval, and unlocks nothing: the tasks wait for the money.
    const [coInvoice, ...coMore] = await invoicesOf(a.businessId, ["change_order"]);
    expect(coMore).toEqual([]);
    expect(coInvoice).toMatchObject({
      status: "draft", amountCents: order.content.priceCents, ref: `co:${order.id}`, changeOrderId: order.id, projectId: careProject.id, stripeInvoiceId: null,
      lines: [{ description: `${order.content.reference}: ${order.content.title}`, amountCents: order.content.priceCents }],
    });
    expect((await approvals("invoice.send", { status: "pending" })).map((x) => JSON.parse(x.payload))).toEqual([{ invoiceId: coInvoice.id }]);
    expect((await project(careProject.id)).tasks.find((t) => t.id === lockedTask.id)!.status).toBe("locked");
    expect((await jobs(a.businessId)).some((j) => j.changeOrderId === order.id)).toBe(false);
    // Approved: one Stripe invoice (kind change_order) and one mail. Signing the order twice and the cron change nothing.
    const invoicesAtStripe = stripe.made.invoices;
    mail.sent.length = 0;
    const sentCo = await sendInvoice(coInvoice.id);
    expect(sentCo).toMatchObject({ status: "open", dueOn: "2027-02-15" });
    expect(stripe.made.invoices).toBe(invoicesAtStripe + 1);
    expect(mail.sent.map((m) => [m.to, m.text.includes(sentCo.hostedUrl!)])).toEqual([[CLIENT_MAIL, true]]);
    expect((await clientCall("c", coToken, "POST", "/sign", { name: "Pat Jones", consent: true, authority: true, sha256: coPage.contentSha256 })).status).toBeLessThan(500);
    await cron("2027-02-08");
    expect((await invoicesOf(a.businessId, ["change_order"])).length).toBe(1);
    expect(await approvals("invoice.send", { status: "pending" })).toEqual([]);
    const summary = await ok<{ openCents: number; heldClients: number }>("GET", "/billing/summary");
    expect(summary).toMatchObject({ openCents: order.content.priceCents, heldClients: 0 });
    expect((await ok<{ invoices: { id: string }[] }>("GET", "/billing/invoices?kind=change_order&status=open")).invoices.map((i) => i.id)).toEqual([coInvoice.id]);

    // Paid by webhook: the order is marked paid and its task unlocks once and goes to Claude; a replay, and a second event for the same payment, unlock nothing again.
    at("2027-02-09T18:00:00.000Z");
    const coPaid = refEvent("invoice.paid", sentCo);
    expect(await deliver(coPaid)).toBe(200);
    expect(await deliver(coPaid)).toBe(200);
    expect(await deliver(refEvent("invoice.paid", sentCo))).toBe(200);
    expect(await getInvoice(env.DB, coInvoice.id)).toMatchObject({ status: "paid" });
    expect((await project(careProject.id)).changeOrders[0].paidAt).toBeTruthy();
    expect((await project(careProject.id)).tasks.find((t) => t.id === lockedTask.id)).toMatchObject({ status: "in_progress", owner: "claude" });
    expect((await jobs(a.businessId)).filter((j) => j.changeOrderId === order.id)).toHaveLength(1);
    expect((await ok<{ comments: { body: string }[] }>("GET", `/tasks/${lockedTask.id}`)).comments.filter((x) => /Unlocked/.test(x.body))).toHaveLength(1);
    // invoice_paid is logged once per payment of the milestone and subscription kinds (two milestones and two months); a change order is logged as a change order, and a deposit as the deposit.
    expect(await activity(a.businessId, "invoice_paid")).toHaveLength(4);

    // ---- Mon 15 Feb: the two Website Subscription sites launch. Each client's Website Subscription (24 months, billed from launch day: its deposit was the setup fee) and its Care are proposed.
    at("2027-02-15T18:00:00.000Z");
    const launched = async (client: { businessId: string }) => {
      const [bld] = await projectsOf(client.businessId);
      expect(bld).toMatchObject({ templateKey: "BUILD", status: "active" });
      await walk(bld.id);
      expect((await project(bld.id)).project.status).toBe("done");
      return bld.id;
    };
    await launched(b); await launched(c);
    const [bCare, bWeb] = await subsOf(b.businessId);
    const [cCare, cWeb] = await subsOf(c.businessId);
    expect([bWeb, cWeb].map((x) => [x.packageKey, x.status, x.firstChargeOn, x.monthlyCents, x.termMonths, x.termEndsOn, x.endAction])).toEqual(Array(2).fill(["website_subscription", "proposed", "2027-02-15", 29700, 24, null, "convert_to_care"]));
    expect([bCare, cCare].map((x) => [x.packageKey, x.status, x.firstChargeOn, x.monthlyCents])).toEqual(Array(2).fill(["care", "proposed", "2027-02-15", 12900]));
    expect((await approvals("subscription.start", { status: "pending" })).length).toBe(4);

    /** The client's side of one subscription: Logan approves the link, the client opens it, starts Checkout and pays, and Stripe's webhook activates it. Returns the client's token. */
    const subscribe = async (sub: typeof bWeb, stripeId: string, customer: string) => {
      mail.sent.length = 0;
      await approveOver((await approvals("subscription.start", { status: "pending", subscriptionId: sub.id }))[0].id);
      expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
      const token = linkIn(mail.sent[0].text, "s");
      expect(await (await clientCall("s", token, "GET")).json()).toMatchObject({ state: "ready", monthlyCents: sub.monthlyCents, termMonths: sub.termMonths });
      const { url: checkoutUrl } = (await (await clientCall("s", token, "POST", "/checkout")).json()) as { url: string };
      const session = (await getSubscription(env.DB, sub.id))!.stripeCheckoutSessionId!;
      expect(checkoutUrl).toContain(session);
      stripeSubscriptionOf.set(session, stripeId); completed.add(session);
      expect(await deliver({ id: `evt_checkout_${stripeId}`, type: "checkout.session.completed", data: { object: { id: session, mode: "subscription", status: "complete", payment_status: "paid", client_reference_id: sub.id, subscription: stripeId, customer, livemode: false } } })).toBe(200);
      expect(await (await clientCall("s", token, "GET")).json()).toMatchObject({ state: "active" });
      return token;
    };
    const sessionsBefore = stripe.more.sessions;
    await subscribe(bCare, "sub_bay_care", "cus_bay");
    const bWebToken = await subscribe(bWeb, "sub_bay_web", "cus_bay");
    await subscribe(cWeb, "sub_cove_web", "cus_cove");
    expect(stripe.more.sessions).toBe(sessionsBefore + 3);
    // Its first charge is launch day, so the card is charged at Checkout (no trial) and the page says so.
    const webSession = stripe.creates().filter((x) => new URL(x.url).pathname === "/v1/checkout/sessions").find((x) => x.form.get("client_reference_id") === bWeb.id)!;
    expect(webSession.form.has("subscription_data[trial_end]")).toBe(false);
    expect(await (await clientCall("s", bWebToken, "GET")).json()).toMatchObject({ state: "active", firstChargeOn: "2027-02-15", chargedNow: true, termMonths: 24 });
    // The term ends two years after the first charge.
    expect(await getSubscription(env.DB, bWeb.id)).toMatchObject({ status: "active", stripeSubscriptionId: "sub_bay_web", termEndsOn: "2029-02-15", endAction: "convert_to_care" });
    expect(await getSubscription(env.DB, cWeb.id)).toMatchObject({ status: "active", termEndsOn: "2029-02-15" });
    expect(await getSubscription(env.DB, bCare.id)).toMatchObject({ status: "active", termEndsOn: null });
    expect((await ok<{ mrrCents: number }>("GET", "/billing/summary")).mrrCents).toBe(12900 + 29700 + 12900 + 29700);

    // ---- Mon 22 Mar: Cove Bakery wants out five weeks after launch. Leaving early owes the whole months left in the term: the first answer is a refusal with the balance, nothing is cancelled.
    at("2027-03-22T18:00:00.000Z");
    const stripeCallsBefore = stripe.calls.length;
    const refused = await owner("POST", `/billing/subscriptions/${cWeb.id}/cancel`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ earlyExitCents: 22 * 29700, error: expect.stringContaining("$6,534") }); // 22 whole months from 22 Mar 2027 to 15 Feb 2029
    expect(await getSubscription(env.DB, cWeb.id)).toMatchObject({ status: "active" });
    expect(stripe.calls.length).toBe(stripeCallsBefore);
    expect(await invoicesOf(c.businessId, ["early_exit"])).toEqual([]);
    // Confirmed: Stripe is told to stop at the end of the paid period, the balance is drafted as an invoice for approval, and the subscription is cancelled.
    const cancelled = await ok<{ subscription: { status: string }; invoice: InvoiceRow }>("POST", `/billing/subscriptions/${cWeb.id}/cancel`, { confirmEarlyExit: true });
    expect(cancelled.subscription.status).toBe("cancelled");
    expect(cancelled.invoice).toMatchObject({ kind: "early_exit", status: "draft", amountCents: 22 * 29700, ref: `early_exit:${cWeb.id}`, subscriptionId: cWeb.id });
    const stop = stripe.creates().find((x) => new URL(x.url).pathname === "/v1/subscriptions/sub_cove_web")!;
    expect(stop.form.get("cancel_at_period_end")).toBe("true");
    expect(stop.headers["idempotency-key"]).toBe(`cancel:${cWeb.id}`);
    expect((await approvals("invoice.send", { status: "pending" })).map((x) => JSON.parse(x.payload))).toEqual([{ invoiceId: cancelled.invoice.id }]);
    const again = await owner("POST", `/billing/subscriptions/${cWeb.id}/cancel`, { confirmEarlyExit: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/already cancelled/);
    expect(await invoicesOf(c.businessId, ["early_exit"])).toHaveLength(1);
    // The balance is invoiced when approved, and paid by webhook.
    mail.sent.length = 0;
    const exitInvoice = await sendInvoice(cancelled.invoice.id);
    expect(exitInvoice).toMatchObject({ status: "open", amountCents: 22 * 29700 });
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    expect(await deliver(refEvent("invoice.paid", exitInvoice))).toBe(200);
    expect(await getInvoice(env.DB, exitInvoice.id)).toMatchObject({ status: "paid" });
    expect(await activity(c.businessId, "invoice_paid")).toHaveLength(1);
    // Stripe's own notice that the period ended changes nothing on a row that is already cancelled.
    expect(await deliver(event("customer.subscription.deleted", { id: "sub_cove_web", status: "canceled" }))).toBe(200);
    expect(await getSubscription(env.DB, cWeb.id)).toMatchObject({ status: "cancelled" });

    // ---- Month 24 of Bay Roofing's Website Subscription (its term ends Thu 15 Feb 2029). 31 days before, nothing is said; 30 days before (Tue 16 Jan) the client's term notice is drafted, once,
    // for approval. The same document already has a live Care plan, so the Website Subscription simply ends at the term and Care carries on at its own price; the notice quotes that price.
    const stopCalls = () => stripe.creates().filter((x) => x.url.endsWith("/v1/subscriptions/sub_bay_web"));
    await cron("2029-01-15");
    expect(await approvals("subscription.term_notice")).toEqual([]);
    await cron("2029-01-16");
    await cron("2029-01-16");
    const [notice, ...moreNotices] = await approvals("subscription.term_notice");
    expect(moreNotices).toEqual([]);
    expect(notice).toMatchObject({ status: "pending" });
    expect(JSON.parse(notice.payload)).toEqual({ subscriptionId: bWeb.id });
    expect(notice.preview).toContain("Then: Care continues on its own plan at $129 a month");
    expect((await getSubscription(env.DB, bWeb.id))!.termNoticeSentAt).toBe("2029-01-16T17:30:00.000Z");
    mail.sent.length = 0;
    await approveOver(notice.id);
    expect(mail.sent.map((m) => m.to)).toEqual([CLIENT_MAIL]);
    expect(mail.sent[0].text).toContain("$129");
    expect(await getSubscription(env.DB, bWeb.id)).toMatchObject({ status: "active", packageKey: "website_subscription" }); // a notice changes nothing
    // On the last day the term ends: Stripe is told to stop at the end of the paid period (once, whatever the cron does twice), the row is ended, and the Care row is untouched.
    await cron("2029-02-14");
    expect(await getSubscription(env.DB, bWeb.id)).toMatchObject({ status: "active" });
    expect(stopCalls()).toEqual([]);
    await cron("2029-02-15");
    await cron("2029-02-15");
    expect(await getSubscription(env.DB, bWeb.id)).toMatchObject({ status: "ended", packageKey: "website_subscription", monthlyCents: 29700 });
    expect(await getSubscription(env.DB, bCare.id)).toMatchObject({ status: "active", packageKey: "care", monthlyCents: 12900, stripeSubscriptionId: "sub_bay_care" });
    expect(stopCalls().map((x) => [x.form.get("cancel_at_period_end"), x.headers["idempotency-key"]])).toEqual([["true", `end:${bWeb.id}`]]);
    expect((await activity(b.businessId, "note")).filter((n) => n.startsWith("Website subscription term ended; Care continues on the existing plan"))).toHaveLength(1);
    expect((await ok<{ mrrCents: number }>("GET", "/billing/summary")).mrrCents).toBeGreaterThan(0);
    // Stripe's own notice that it stopped changes nothing: an ended row stays ended, and the Care plan is not cancelled.
    expect(await deliver(event("customer.subscription.deleted", { id: "sub_bay_web", status: "canceled" }))).toBe(200);
    expect(await getSubscription(env.DB, bWeb.id)).toMatchObject({ status: "ended" });
    expect(await getSubscription(env.DB, bCare.id)).toMatchObject({ status: "active" });

    // ---- The deposit's event again, years later, starts nothing: no project, no subscription, no invoice, no approval.
    at("2029-02-16T18:00:00.000Z");
    const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    const was = { projects: await count("projects"), tasks: await count("tasks"), subscriptions: await count("subscriptions"), invoices: await count("invoices"), approvals: await count("approvals"), jobs: await count("claude_tasks") };
    expect(await deliver(depositEvent)).toBe(200);
    expect(await deliver(invoiceEvent("invoice.paid", (await getInvoiceForDocument(env.DB, a.docId))!))).toBe(200);
    expect({ projects: await count("projects"), tasks: await count("tasks"), subscriptions: await count("subscriptions"), invoices: await count("invoices"), approvals: await count("approvals"), jobs: await count("claude_tasks") }).toEqual(was);
    // The owner's list of subscriptions never carries a client's link token.
    const listed = await ok<{ subscriptions: Record<string, unknown>[] }>("GET", "/billing/subscriptions");
    expect(listed.subscriptions.length).toBeGreaterThanOrEqual(5);
    expect(listed.subscriptions.every((x) => !("token" in x))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(careToken);
    // Everything the client was mailed went to the client or to the owner, and only through an approval; nothing in the whole story logged an unexpected error.
    expect(mail.sent.every((m) => m.to === CLIENT_MAIL || m.to === OWNER_EMAIL)).toBe(true);
    expect(errors.mock.calls.map((x: unknown[]) => x.map(String).join(" ").slice(0, 200))).toEqual([]);
  });
});
