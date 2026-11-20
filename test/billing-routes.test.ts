import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeInvoice } from "../src/worker/billing/draft";
import { draftChangeOrder } from "../src/worker/changeorders/service";
import { signChangeOrder } from "../src/worker/db/changeOrders";
import { activeHolds } from "../src/worker/db/holds";
import { getInvoice, getInvoiceByRef, markInvoice } from "../src/worker/db/invoices";
import { saveSettings } from "../src/worker/db/settings";
import { insertOutbound, markSent } from "../src/worker/db/messages";
import { getSubscription } from "../src/worker/db/subscriptions";
import { insertTasks } from "../src/worker/db/tasks";
import { insertEntry } from "../src/worker/db/time";
import { setMailDeps } from "../src/worker/mail/deps";
import worker from "../src/worker/index";
import { activeSub, heldClient, openInvoice, plannedSubs, prepareDispatch, seedDraft, seedSignedProject } from "./fixtures/billing";
import { clientSig, seal } from "./fixtures/changeorders";
import { readyToSend } from "./fixtures/documents";
import { newTask, seedProject } from "./fixtures/projects";
import { KEY, SECRET } from "./fixtures/stripe";

let cookie = "";
let errors: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await readyToSend();
  await saveSettings(env.DB, { billing_config: "{}" });
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

const owner = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });
const json = async (method: string, path: string, body?: unknown) => { const r = await owner(method, path, body); return { status: r.status, body: await r.json<any>() }; };
const waiting = async (invoiceId: string) =>
  (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'invoice.send' AND status = 'pending' AND json_extract(payload, '$.invoiceId') = ?`).bind(invoiceId).all<{ id: string }>()).results;

describe("billing routes", () => {
  it("each route answers 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/billing/summary"], ["GET", "/billing/invoices"], ["POST", "/billing/invoices/x/propose"], ["POST", "/billing/invoices/x/discard"], ["POST", "/billing/invoices/x/void"],
      ["POST", "/change-orders/x/invoice"], ["POST", "/projects/x/invoices/hourly"], ["GET", "/billing/subscriptions"], ["POST", "/billing/subscriptions/x/start"],
      ["PATCH", "/billing/subscriptions/x", { endAction: "none" }], ["POST", "/billing/subscriptions/x/cancel", { confirmEarlyExit: true }],
      ["GET", "/billing/holds"], ["POST", "/billing/holds/x/lift"], ["GET", "/billing/stripe-status"],
    ];
    for (const [m, p, b] of calls) expect((await owner(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });

  describe("summary", () => {
    it("counts mrr from active and past_due subscriptions only", async () => {
      const before = (await json("GET", "/billing/summary")).body;
      expect(Object.keys(before).sort()).toEqual(["heldClients", "mrrCents", "openCents", "overdueCents"]);
      const a = await activeSub(), p = await activeSub({ status: "past_due" });
      const link = await plannedSubs(["care"]); // planned: not counted
      await env.DB.prepare(`UPDATE subscriptions SET status = 'link_sent' WHERE id = ?`).bind(link.subs[0].id).run();
      const gone = await activeSub();
      await env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE id = ?`).bind(gone.sub.id).run();
      const rehearsal = await activeSub(); // a test row is active but is not money
      await env.DB.prepare(`UPDATE subscriptions SET test = 1 WHERE id = ?`).bind(rehearsal.sub.id).run();
      const after = (await json("GET", "/billing/summary")).body;
      expect(after.mrrCents - before.mrrCents).toBe(a.sub.monthlyCents + p.sub.monthlyCents);
    });

    it("sums what is open, what is overdue, and how many clients are held", async () => {
      const before = (await json("GET", "/billing/summary")).body;
      const fresh = await openInvoice((await seedDraft()).invoice);              // due in the future: open, not overdue
      const late = await openInvoice((await seedDraft()).invoice);               // due long ago: open and overdue
      const paid = await openInvoice((await seedDraft()).invoice);
      const draft = (await seedDraft()).invoice;                                // never sent: counts nowhere
      const test = await openInvoice((await seedDraft({ test: true })).invoice); // a test copy counts nowhere
      await markInvoice(env.DB, fresh.id, { dueOn: "2099-01-01" });
      await markInvoice(env.DB, late.id, { dueOn: "2020-01-01" });
      await markInvoice(env.DB, test.id, { dueOn: "2020-01-01" });
      await markInvoice(env.DB, paid.id, { status: "paid", paidAt: "2026-12-01T00:00:00.000Z" });
      await prepareDispatch();
      const held = await heldClient();
      await markInvoice(env.DB, held.invoice.id, { dueOn: "2099-01-01" });
      const after = (await json("GET", "/billing/summary")).body;
      expect(draft.status).toBe("draft");
      expect(after.openCents - before.openCents).toBe(fresh.amountCents + late.amountCents + held.invoice.amountCents);
      expect(after.overdueCents - before.overdueCents).toBe(late.amountCents);
      expect(after.heldClients).toBe(1);
    });
  });

  describe("invoices", () => {
    it("lists by status, kind, business and project, and refuses a status that does not exist", async () => {
      const s = await seedSignedProject();
      const mine = (await seedDraft({ seed: s as never, kind: "milestone" })).invoice;
      const other = (await seedDraft()).invoice;
      const all = (await json("GET", "/billing/invoices")).body.invoices.map((i: any) => i.id);
      expect(all).toEqual(expect.arrayContaining([mine.id, other.id]));
      const byBusiness = (await json("GET", `/billing/invoices?businessId=${s.businessId}`)).body.invoices;
      expect(byBusiness.map((i: any) => i.id)).toEqual([mine.id]);
      expect((await json("GET", `/billing/invoices?businessId=${s.businessId}&kind=hourly`)).body.invoices).toEqual([]);
      expect((await json("GET", `/billing/invoices?businessId=${s.businessId}&status=open`)).body.invoices).toEqual([]);
      expect((await json("GET", `/billing/invoices?businessId=${s.businessId}&status=draft&kind=milestone`)).body.invoices).toHaveLength(1);
      const noProject = (await json("GET", `/billing/invoices?projectId=${s.project.id}`)).body.invoices;
      expect(noProject).toEqual([]); // the draft hangs off the document, not the project
      const bad = await json("GET", "/billing/invoices?status=nonsense");
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBeTruthy();
    });

    it("propose puts a draft up for approval, makes a new approval when the old one is gone, and refuses a paid invoice with a 409", async () => {
      expect((await json("POST", "/billing/invoices/nope/propose")).status).toBe(404);
      const d = (await seedDraft()).invoice;
      const first = await json("POST", `/billing/invoices/${d.id}/propose`);
      expect(first.status).toBe(200);
      expect(first.body.approval).toMatchObject({ kind: "invoice.send", status: "pending" });
      expect(await waiting(d.id)).toHaveLength(1);
      // Again: the same approval.
      expect((await json("POST", `/billing/invoices/${d.id}/propose`)).body.approval.id).toBe(first.body.approval.id);
      // The waiting approval was rejected (or dropped): proposing again makes a new one.
      await env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE id = ?`).bind(first.body.approval.id).run();
      const again = await json("POST", `/billing/invoices/${d.id}/propose`);
      expect(again.status).toBe(200);
      expect(again.body.approval.id).not.toBe(first.body.approval.id);
      expect(await waiting(d.id)).toHaveLength(1);

      const paid = await openInvoice((await seedDraft()).invoice);
      await markInvoice(env.DB, paid.id, { status: "paid", paidAt: "2026-12-01T00:00:00.000Z" });
      const refused = await json("POST", `/billing/invoices/${paid.id}/propose`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("This invoice is paid, not a draft.");
    });

    it("discard throws a draft away, and voiding what was sent says in a plain sentence what is missing", async () => {
      expect((await json("POST", "/billing/invoices/nope/discard")).status).toBe(404);
      expect((await json("POST", "/billing/invoices/nope/void")).status).toBe(404);
      const d = (await seedDraft()).invoice;
      await proposeInvoice(env as never, d.id);
      const out = await json("POST", `/billing/invoices/${d.id}/discard`);
      expect(out.status).toBe(200);
      expect(out.body.invoice).toMatchObject({ id: d.id, status: "void" });
      expect(await waiting(d.id)).toHaveLength(0);

      const open = await openInvoice((await seedDraft()).invoice);
      const sent = await json("POST", `/billing/invoices/${open.id}/discard`);
      expect(sent.status).toBe(409);
      expect(sent.body.error).toMatch(/voided, not discarded/);

      const draft = (await seedDraft()).invoice;
      expect((await json("POST", `/billing/invoices/${draft.id}/void`)).body.error).toMatch(/discard it instead/);
      // No Stripe key in this environment: the sentence says so, and the invoice is untouched.
      const noKey = await json("POST", `/billing/invoices/${open.id}/void`);
      expect(noKey.status).toBe(409);
      expect(noKey.body.error).toMatch(/Stripe is not set up/);
      expect((await getInvoice(env.DB, open.id))!.status).toBe("open");
    });

    it("a body with a field it does not know is a 400", async () => {
      const d = (await seedDraft()).invoice;
      const r = await json("POST", `/billing/invoices/${d.id}/propose`, { sneaky: true });
      expect(r.status).toBe(400);
      expect((await getInvoice(env.DB, d.id))!.status).toBe("draft");
    });
  });

  describe("change order and hourly invoices", () => {
    const base = { title: "Add a gallery page", summary: "Twelve job photos.", reason: "The client asked.", sourceType: "logan" as const };
    async function signedOrder(test = false) {
      const s = await seedProject({ test });
      const co = await seal(await draftChangeOrder(env as never, { ...base, projectId: s.project.id, hours: 2 }));
      expect(await signChangeOrder(env.DB, co.id, clientSig(co.contentSha256!), "2026-12-06T09:00:00.000Z")).toBe("signed");
      return { ...s, id: co.id };
    }

    it("drafts the invoice of a signed change order and puts it up for approval, once", async () => {
      expect((await json("POST", "/change-orders/nope/invoice")).status).toBe(404);
      const s = await signedOrder();
      const r = await json("POST", `/change-orders/${s.id}/invoice`);
      expect(r.status).toBe(200);
      expect(r.body.invoice).toMatchObject({ kind: "change_order", ref: `co:${s.id}`, status: "draft", changeOrderId: s.id });
      expect(r.body.approval).toMatchObject({ kind: "invoice.send", status: "pending" });
      const again = await json("POST", `/change-orders/${s.id}/invoice`);
      expect(again.status).toBe(200);
      expect(again.body.invoice.id).toBe(r.body.invoice.id);
      expect(again.body.approval.id).toBe(r.body.approval.id);
    });

    it("a change order whose invoice was voided answers 409, not success, and makes no new invoice", async () => {
      const s = await signedOrder();
      const made = (await json("POST", `/change-orders/${s.id}/invoice`)).body.invoice;
      await markInvoice(env.DB, made.id, { status: "void" });
      const r = await json("POST", `/change-orders/${s.id}/invoice`);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("The invoice for this change order was voided, so it is not made again.");
      expect((await getInvoiceByRef(env.DB, `co:${s.id}`))!.status).toBe("void");
    });

    it("a refusal of the service (a test order, an unsigned one) is a 409 with its sentence", async () => {
      const test = await signedOrder(true);
      const r = await json("POST", `/change-orders/${test.id}/invoice`);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("A test change order is not invoiced.");
    });

    it("bills a project's finished time once, and says so when there is none", async () => {
      expect((await json("POST", "/projects/nope/invoices/hourly")).status).toBe(404);
      const s = await seedSignedProject();
      const none = await json("POST", `/projects/${s.project.id}/invoices/hourly`);
      expect(none.status).toBe(409);
      expect(none.body.error).toMatch(/no finished billable time/i);
      const [task] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId)]);
      await insertEntry(env.DB, { taskId: task.id, projectId: s.project.id, businessId: s.businessId, startedAt: "2026-12-03T17:00:00.000Z", endedAt: "2026-12-03T17:40:00.000Z", minutes: 40, billable: true, note: "", source: "manual" });
      const r = await json("POST", `/projects/${s.project.id}/invoices/hourly`);
      expect(r.status).toBe(201);
      expect(r.body.invoice).toMatchObject({ kind: "hourly", status: "draft", projectId: s.project.id });
      expect(r.body.approval).toMatchObject({ kind: "invoice.send", status: "pending" });
      expect((await json("POST", `/projects/${s.project.id}/invoices/hourly`)).status).toBe(409); // the time is on the invoice now
    });
  });

  describe("subscriptions", () => {
    it("lists them without the client's link token, and filters by status", async () => {
      const a = await activeSub();
      await env.DB.prepare(`UPDATE subscriptions SET token = 'secret-link-token' WHERE id = ?`).bind(a.sub.id).run();
      const all = await json("GET", "/billing/subscriptions");
      expect(all.status).toBe(200);
      expect(all.body.subscriptions.map((s: any) => s.id)).toContain(a.sub.id);
      expect(JSON.stringify(all.body)).not.toContain("secret-link-token");
      const active = (await json("GET", "/billing/subscriptions?status=active")).body.subscriptions;
      expect(active.every((s: any) => s.status === "active")).toBe(true);
      expect((await json("GET", "/billing/subscriptions?status=nonsense")).status).toBe(400);
    });

    it("flags a stranded link_sent row as linkLost, and not a mailed one, with no token in the payload", async () => {
      const strand = async (mail: "failed" | "sent") => {
        const p = await plannedSubs(["local_seo"]);
        const sub = p.subs[0];
        const approval = (await json("POST", `/billing/subscriptions/${sub.id}/start`)).body.approval;
        await env.DB.prepare(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?`).bind(mail === "sent" ? "approved" : "rejected", "2026-12-01T10:00:00.000Z", approval.id).run();
        const id = crypto.randomUUID();
        expect(await insertOutbound(env.DB, id, { mailbox: "main", businessId: p.businessId, enrollmentId: null, stepIndex: null, approvalId: approval.id, messageId: `<${id}@x>`, inReplyTo: null, to: "pat@ace.test", subject: "Link", text: "x", now: "2026-12-01T10:00:00.000Z" })).toBe(true);
        if (mail === "sent") await markSent(env.DB, id, "2026-12-01T10:00:01.000Z"); else await env.DB.prepare(`UPDATE messages SET status = 'failed' WHERE id = ?`).bind(id).run();
        await env.DB.prepare(`UPDATE subscriptions SET status = 'link_sent', token = ? WHERE id = ?`).bind(`secret-link-token-${mail}`, sub.id).run();
        return sub.id as string;
      };
      const lost = await strand("failed"), mailed = await strand("sent");
      const { body } = await json("GET", "/billing/subscriptions");
      const byId = (id: string) => body.subscriptions.find((s: any) => s.id === id);
      expect(byId(lost).linkLost).toBe(true);
      expect(byId(mailed).linkLost).toBe(false);
      expect(body.subscriptions.filter((s: any) => s.status !== "link_sent").every((s: any) => s.linkLost === false)).toBe(true);
      expect(JSON.stringify(body)).not.toContain("secret-link-token");
    });

    it("Start billing proposes a kickoff subscription, and refuses one that does not start at kickoff", async () => {
      expect((await json("POST", "/billing/subscriptions/nope/start")).status).toBe(404);
      const seo = await plannedSubs(["local_seo"]);
      const r = await json("POST", `/billing/subscriptions/${seo.subs[0].id}/start`);
      expect(r.status).toBe(200);
      expect(r.body.approval).toMatchObject({ kind: "subscription.start", status: "pending" });
      const care = await plannedSubs(["website_subscription"]);
      const refused = await json("POST", `/billing/subscriptions/${care.subs[0].id}/start`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/kickoff/);
    });

    it("sets what happens at the end of the term, and 404s before 400", async () => {
      expect((await json("PATCH", "/billing/subscriptions/nope", { endAction: "none" })).status).toBe(404);
      expect((await json("PATCH", "/billing/subscriptions/nope", { endAction: "bogus" })).status).toBe(404); // unknown id first
      const a = await activeSub();
      expect((await json("PATCH", `/billing/subscriptions/${a.sub.id}`, { endAction: "bogus" })).status).toBe(400);
      expect((await json("PATCH", `/billing/subscriptions/${a.sub.id}`, { endAction: "none", extra: 1 })).status).toBe(400);
      const ok = await json("PATCH", `/billing/subscriptions/${a.sub.id}`, { endAction: "none" });
      expect(ok.status).toBe(200);
      expect(ok.body.subscription.endAction).toBe("none");
      await env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE id = ?`).bind(a.sub.id).run();
      const over = await json("PATCH", `/billing/subscriptions/${a.sub.id}`, { endAction: "convert_to_care" });
      expect(over.status).toBe(409);
      expect(over.body.error).toMatch(/already over|cannot change/);
    });

    it("an unconfirmed cancel is 409 with the balance, and changes nothing", async () => {
      expect((await json("POST", "/billing/subscriptions/nope/cancel", { confirmEarlyExit: true })).status).toBe(404);
      const a = await activeSub({ termEndsOn: "2099-12-20" });
      const r = await json("POST", `/billing/subscriptions/${a.sub.id}/cancel`, {});
      expect(r.status).toBe(409);
      expect(r.body.earlyExitCents).toBeGreaterThan(0);
      expect(r.body.earlyExitCents % a.sub.monthlyCents).toBe(0);
      expect(r.body.error).toMatch(/early-exit balance/);
      expect((await getSubscription(env.DB, a.sub.id))!.status).toBe("active");
      // Confirmed, but this environment has no Stripe key: a sentence, and still nothing changed.
      const noKey = await json("POST", `/billing/subscriptions/${a.sub.id}/cancel`, { confirmEarlyExit: true });
      expect(noKey.status).toBe(409);
      expect(noKey.body.error).toMatch(/Stripe is not set up/);
      expect((await getSubscription(env.DB, a.sub.id))!.status).toBe("active");
      expect((await json("POST", `/billing/subscriptions/${a.sub.id}/cancel`, { confirmEarlyExit: "yes" })).status).toBe(400);
    });

    it("a subscription that never became active is cancelled with no balance and no Stripe", async () => {
      const p = await plannedSubs(["care"]);
      const r = await json("POST", `/billing/subscriptions/${p.subs[0].id}/cancel`, {});
      expect(r.status).toBe(200);
      expect(r.body.subscription.status).toBe("cancelled");
      expect(r.body.invoice).toBeNull();
    });
  });

  describe("holds", () => {
    it("lists open holds and lifts one by hand, sending the waiting Claude step", async () => {
      await prepareDispatch();
      const c = await heldClient();
      const list = await json("GET", "/billing/holds");
      expect(list.status).toBe(200);
      expect(list.body.holds).toHaveLength(1);
      expect(list.body.holds[0]).toMatchObject({ businessId: c.businessId, invoiceId: c.invoice.id, businessName: expect.any(String) });
      const id = list.body.holds[0].id;
      expect((await json("POST", "/billing/holds/nope/lift")).status).toBe(404);
      const lifted = await json("POST", `/billing/holds/${id}/lift`);
      expect(lifted.status).toBe(200);
      expect(await activeHolds(env.DB, c.businessId)).toEqual([]);
      expect((await json("POST", `/billing/holds/${id}/lift`)).status).toBe(409); // already lifted
    });
  });

  describe("stripe-status", () => {
    it("says what is set up and never contains a key", async () => {
      const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
      const ask = async (e: Record<string, unknown>) => {
        const res = await worker.fetch(new Request("https://x/api/billing/stripe-status", { headers: { cookie } }), { ...env, ...e } as never, ctx);
        return { status: res.status, text: await res.text() };
      };
      await saveSettings(env.DB, { documents_config: "{}" });
      const set = await ask({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET });
      expect(set.status).toBe(200);
      expect(JSON.parse(set.text)).toEqual({ mode: "test", webhookSecretSet: true, clientBaseSet: true, legalReviewed: false });
      expect(set.text).not.toContain(KEY);
      expect(set.text).not.toContain(SECRET);
      expect(set.text).not.toContain("SECRETKEYVALUE");
      const live = await ask({ STRIPE_SECRET_KEY: "sk_live_LIVEKEYVALUE456", STRIPE_WEBHOOK_SECRET: undefined, CLIENT_LINK_BASE: undefined });
      expect(JSON.parse(live.text)).toEqual({ mode: "live", webhookSecretSet: false, clientBaseSet: false, legalReviewed: false });
      expect(live.text).not.toContain("LIVEKEYVALUE");
      const none = await ask({ STRIPE_SECRET_KEY: undefined });
      expect(JSON.parse(none.text).mode).toBeNull();
      await saveSettings(env.DB, { documents_config: JSON.stringify({ legalReviewedAt: "2026-11-01T00:00:00.000Z", legalReviewer: "A. Lawyer" }) });
      expect(JSON.parse((await ask({ STRIPE_SECRET_KEY: KEY })).text).legalReviewed).toBe(true);
      await saveSettings(env.DB, { documents_config: "{}" });
    });
  });

  describe("billing_config in settings", () => {
    const put = (billing_config: string) => json("PUT", "/settings", { billing_config });

    it("a bad billing_config is 400 with the field named and nothing is saved", async () => {
      const bad = await put(JSON.stringify({ netDays: 0 }));
      expect(bad.status).toBe(400);
      expect(bad.body.fields).toContain("billing_config");
      expect(bad.body.error).toMatch(/netDays/);
      const order = await put(JSON.stringify({ reminderOffsets: [3, 0] }));
      expect(order.status).toBe(400);
      expect(order.body.error).toBe("Reminders must come in order, each later than the one before");
      const notJson = await put("nope");
      expect(notJson.status).toBe(400);
      expect(notJson.body.fields).toContain("billing_config");
      expect((await json("GET", "/settings")).body.settings.billing_config).toBe("{}");
    });

    it("a good one is saved whole, with the defaults filled in", async () => {
      const ok = await put(JSON.stringify({ netDays: 10 }));
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body.billing_config)).toEqual({ netDays: 10, reminderOffsets: [-3, 0, 3, 7], pauseAfterDays: 14, termNoticeDays: 30 });
      expect(JSON.parse((await json("GET", "/settings")).body.settings.billing_config).netDays).toBe(10);
      expect((await put("")).status).toBe(200);
    });
  });
});
