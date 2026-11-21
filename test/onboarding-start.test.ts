import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { listActivity } from "../src/worker/db/activity";
import { getBusiness } from "../src/worker/db/businesses";
import { getDeal } from "../src/worker/db/deals";
import { createDraft, getDocument, signDocument } from "../src/worker/db/documents";
import { insertInvoice, type InvoiceRow } from "../src/worker/db/invoices";
import { createOnboarding, getOnboarding, getOnboardingForDeal, hasOnboarding, listItems } from "../src/worker/db/onboardings";
import { onInvoicePaid } from "../src/worker/documents/deposit";
import type { Env } from "../src/worker/env";
import type { ProposalContent } from "../src/worker/documents/proposal";
import { setMailDeps } from "../src/worker/mail/deps";
import { createWelcomeApproval } from "../src/worker/approvals/onboardingWelcome";
import { startOnboarding } from "../src/worker/onboarding/start";
import { OWNER_EMAIL, SENT_AT, clientSig, proposal, readyToSend, seedDeal, sendDraft } from "./fixtures/documents";

const FAR = "2099-01-01T00:00:00.000Z";
const BASE = "https://clients.hellositeline.test";
const SUBJECT = "Welcome. Here is how we get started";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

const pkg = (key: ProposalContent["packages"][number]["key"], name: string): ProposalContent["packages"][number] => ({ key, version: 1, name, priceLine: "$1,000", includes: [] });
const BUILD = [pkg("starter_site", "Starter Site"), pkg("care", "Care")];
const LIGHT = [pkg("quick_fix", "Quick Fix")];

/** A signed proposal with its (unpaid-in-the-document, paid-at-Stripe) deposit invoice, for a real or test deal. */
async function seed(o: { test?: boolean; packages?: ProposalContent["packages"]; contactEmail?: string; signed?: boolean } = {}) {
  const s = await seedDeal();
  const base = proposal();
  const content: ProposalContent = { ...base, packages: o.packages ?? BUILD, header: { ...base.header, contactEmail: o.contactEmail ?? base.header.contactEmail } };
  const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content, test: o.test });
  const { doc, hash } = await sendDraft(draft.id, content, { expiresAt: FAR });
  if (o.signed !== false) expect(await signDocument(env.DB, doc.id, clientSig(hash), "2026-12-02T09:00:00.000Z")).toBe("signed");
  const invoice = await insertInvoice(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: "cus_1",
    stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, amountCents: 199850, hostedUrl: "https://invoice.stripe.com/i/x",
  });
  return { ...s, doc: (await getDocument(env.DB, doc.id))!, invoice };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

const activity = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
/** The lead notes this feature writes (the deal side of a payment writes its own). */
const skipNotes = async (businessId: string) => (await activity(businessId, "note")).filter((n) => n.startsWith("onboarding not started:"));
const welcomes = async (dealId: string) => (await env.DB.prepare(`SELECT * FROM approvals WHERE kind = 'onboarding.welcome' AND record_id = ? ORDER BY created_at`).bind(dealId).all<{ id: string; status: string; title: string; preview: string; payload: string; record_type: string; drafted_by: string }>()).results;
const pay = (s: Seeded, e: Env = env as Env) => onInvoicePaid(e, s.invoice as InvoiceRow);

describe("starting onboarding at payment", () => {
  it("a paid real deposit starts one onboarding and one welcome approval", async () => {
    const mail = await readyToSend();
    const s = await seed();
    await pay(s);

    const o = (await getOnboardingForDeal(env.DB, s.dealId))!;
    expect(o).toMatchObject({ businessId: s.businessId, dealId: s.dealId, documentId: s.doc.id, kind: "build", test: false, welcomeSentAt: null });
    expect((await listItems(env.DB, o.id)).map((i) => i.key)).toEqual([
      "logo_files", "brand_text", "homepage_text", "homepage_photos", "service_page_text", "service_photos",
      "access_hosting", "access_dns", "access_registrar", "access_admin", "access_gbp", "access_analytics", "about_text", "team_photos", "reviews_text", "extra_pages_text", "faq_text", "social_links_text"]);

    const a = await welcomes(s.dealId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: "pending", title: "Send the onboarding welcome to Ace Plumbing", record_type: "deal", drafted_by: "logan" });
    expect(JSON.parse(a[0].payload)).toEqual({ onboardingId: o.id });
    expect(a[0].preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(a[0].preview).toContain(`Subject: ${SUBJECT}`);
    expect(a[0].preview).toContain(`${BASE}/o/${o.token}`);
    expect(a[0].preview).toContain("Welcome video: none yet");

    expect(await activity(s.businessId, "onboarding_started")).toEqual(["SL-ABCDEF v1: build onboarding started"]);
    expect(mail.sent).toEqual([]); // nothing goes to a client before Logan approves
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("won");
  });

  it("a replayed payment starts nothing new", async () => {
    await readyToSend();
    const s = await seed();
    await pay(s);
    await pay(s);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM onboardings WHERE deal_id = ?`).bind(s.dealId).first<{ n: number }>())!.n).toBe(1);
    const o = (await getOnboardingForDeal(env.DB, s.dealId))!;
    expect((await listItems(env.DB, o.id))).toHaveLength(18);
    expect(await welcomes(s.dealId)).toHaveLength(1);
    expect(await activity(s.businessId, "onboarding_started")).toHaveLength(1);

    // Even after the welcome has been decided, a replay does not ask again.
    expect(await approve(env, (await welcomes(s.dealId))[0].id)).toEqual({ ok: true });
    await pay(s);
    expect(await welcomes(s.dealId)).toHaveLength(1);
  });

  it("a test onboarding already on the deal is never reported as the real one", async () => {
    await readyToSend();
    const s = await seed();
    // A test row got there first (made by hand here: the owner's route no longer allows it on a deal with a real proposal).
    const { onboarding: test } = await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: s.doc.id, kind: "build", test: true, items: [] });

    expect(await startOnboarding(env, s.doc)).toBeNull();
    await pay(s); // the payment path says the same, once, and still completes
    await pay(s);
    const notes = (await skipNotes(s.businessId)).filter((n) => /test onboarding already exists/.test(n));
    expect(notes).toEqual(["onboarding not started: a test onboarding already exists on this deal; the real one was not started"]);
    expect(await activity(s.businessId, "onboarding_started")).toEqual([]);
    expect(await welcomes(s.dealId)).toEqual([]);
    expect((await getOnboardingForDeal(env.DB, s.dealId))!.id).toBe(test.id);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("a test document starts no onboarding from payment", async () => {
    await readyToSend();
    const s = await seed({ test: true });
    await pay(s);
    expect(await hasOnboarding(env.DB, s.businessId)).toBe(false);
    expect(await welcomes(s.dealId)).toEqual([]);
    expect(await activity(s.businessId, "onboarding_started")).toEqual([]);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("the manual test start mails only the owner address", async () => {
    const mail = await readyToSend();
    const s = await seed({ test: true });
    const o = (await startOnboarding(env, s.doc, { test: true }))!;
    expect(o.test).toBe(true);
    const a = (await welcomes(s.dealId))[0];
    expect(a.preview).toContain(`To: Logan Irish <${OWNER_EMAIL}>`);
    expect(a.preview).not.toContain("pat@ace.test>,");

    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toBe(`[Test] ${SUBJECT}`);
    expect(mail.sent[0].text).toContain(`${BASE}/o/${o.token}`);
    expect(mail.sent.some((m) => m.to === "pat@ace.test")).toBe(false);
    expect((await getOnboarding(env.DB, o.id))!.welcomeSentAt).toBe(SENT_AT);
  });

  it("a light package set makes only the six access items", async () => {
    await readyToSend();
    const s = await seed({ packages: LIGHT });
    await pay(s);
    const o = (await getOnboardingForDeal(env.DB, s.dealId))!;
    expect(o.kind).toBe("light");
    expect((await listItems(env.DB, o.id)).map((i) => i.key)).toEqual(["access_hosting", "access_dns", "access_registrar", "access_admin", "access_gbp", "access_analytics"]);
    expect(await welcomes(s.dealId)).toHaveLength(1);
    expect(await activity(s.businessId, "onboarding_started")).toEqual(["SL-ABCDEF v1: light onboarding started"]);
  });

  it("no contact email leaves a timeline note and no approval", async () => {
    await readyToSend();
    const s = await seed({ contactEmail: "  " });
    expect(await startOnboarding(env, s.doc)).toBeNull();
    await pay(s);
    expect(await hasOnboarding(env.DB, s.businessId)).toBe(false);
    expect(await welcomes(s.dealId)).toEqual([]);
    expect(await skipNotes(s.businessId)).toEqual(["onboarding not started: the proposal has no contact email"]);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
  });

  it("a document that is not signed starts nothing", async () => {
    await readyToSend();
    const s = await seed({ signed: false });
    expect(s.doc.status).toBe("sent");
    expect(await startOnboarding(env, s.doc)).toBeNull();
    expect(await hasOnboarding(env.DB, s.businessId)).toBe(false);
    expect(await skipNotes(s.businessId)).toEqual(["onboarding not started: the proposal is sent, not signed"]);
  });

  it("no CLIENT_LINK_BASE leaves a note and the payment still completes", async () => {
    await readyToSend();
    const s = await seed();
    await pay(s, { ...env, CLIENT_LINK_BASE: undefined } as Env);
    expect(await hasOnboarding(env.DB, s.businessId)).toBe(false);
    expect(await welcomes(s.dealId)).toEqual([]);
    const notes = await skipNotes(s.businessId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^onboarding not started: .*CLIENT_LINK_BASE/);
    expect((await getDocument(env.DB, s.doc.id))!.paidAt).toBeTruthy();
    expect((await getDeal(env.DB, s.dealId))!.stage).toBe("won");
    expect((await getBusiness(env.DB, s.businessId))!.lead_status).toBe("won");
  });

  it("a failure while starting is noted and never breaks the payment", async () => {
    await readyToSend();
    const s = await seed();
    const real = env.DB;
    const broken = new Proxy(real, {
      get(t, p) {
        if (p === "prepare") return (sql: string) => { if (/INSERT INTO onboardings\b/.test(sql)) throw new Error("disk on fire"); return t.prepare(sql); };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await expect(pay(s, { ...env, DB: broken } as Env)).resolves.toBeUndefined();
    expect((await getDocument(real, s.doc.id))!.paidAt).toBeTruthy();
    expect((await getDeal(real, s.dealId))!.stage).toBe("won");
    expect(await hasOnboarding(real, s.businessId)).toBe(false);
    expect(await skipNotes(s.businessId)).toEqual(["onboarding not started: disk on fire"]);
    expect(errors).toHaveBeenCalled();
  });
});

describe("onboarding.welcome", () => {
  async function waiting(o: Parameters<typeof seed>[0] = {}) {
    const mail = await readyToSend();
    const s = await seed(o);
    await pay(s);
    const o2 = (await getOnboardingForDeal(env.DB, s.dealId))!;
    return { mail, s, onboarding: o2, approvalId: (await welcomes(s.dealId))[0].id };
  }

  it("approving the welcome mails once, sets due dates and logs once", async () => {
    const { mail, s, onboarding, approvalId } = await waiting();
    expect(await approve(env, approvalId)).toEqual({ ok: true });

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("pat@ace.test");
    expect(mail.sent[0].subject).toBe(SUBJECT);
    expect(mail.sent[0].from.email).toBe("logan@main.test");
    expect(mail.sent[0].text).toContain("Hi Pat,");
    expect(mail.sent[0].text).toContain(`${BASE}/o/${onboarding.token}`);
    expect(mail.sent[0].text).not.toContain("/p/");

    const o = (await getOnboarding(env.DB, onboarding.id))!;
    expect(o).toMatchObject({ welcomeSentAt: SENT_AT, questionnaireDueAt: "2026-12-03T17:00:00.000Z", lastClientActivityAt: SENT_AT });
    const items = await listItems(env.DB, onboarding.id);
    expect(items.filter((i) => i.phase === 1).every((i) => i.dueAt === "2026-12-08T17:00:00.000Z")).toBe(true);
    expect(items.filter((i) => i.phase === 2).every((i) => i.dueAt === "2026-12-15T17:00:00.000Z")).toBe(true);
    expect(await activity(s.businessId, "onboarding_welcome")).toEqual(["Welcome mailed to pat@ace.test"]);
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(approvalId).first<{ status: string }>())!.status).toBe("approved");
  });

  it("approving twice sends once", async () => {
    const { mail, s, onboarding, approvalId } = await waiting();
    expect(await approve(env, approvalId)).toEqual({ ok: true });
    expect(await approve(env, approvalId)).toMatchObject({ ok: false, status: 409 });
    expect(mail.sent).toHaveLength(1);
    expect(await activity(s.businessId, "onboarding_welcome")).toHaveLength(1);
    expect((await getOnboarding(env.DB, onboarding.id))!.welcomeSentAt).toBe(SENT_AT);
  });

  it("a retry after a sent mail does not send again and still finishes the due dates", async () => {
    const { mail, s, onboarding, approvalId } = await waiting();
    expect(await approve(env, approvalId)).toEqual({ ok: true });
    // The crash this models: the mail went out, then recording it failed, so the approval went back to pending.
    await env.DB.prepare(`UPDATE onboardings SET welcome_sent_at = NULL, questionnaire_due_at = NULL WHERE id = ?`).bind(onboarding.id).run();
    await env.DB.prepare(`UPDATE onboarding_items SET due_at = NULL WHERE onboarding_id = ?`).bind(onboarding.id).run();
    await env.DB.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ?`).bind(approvalId).run();

    expect(await approve(env, approvalId)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getOnboarding(env.DB, onboarding.id))).toMatchObject({ welcomeSentAt: SENT_AT, questionnaireDueAt: "2026-12-03T17:00:00.000Z" });
    expect((await listItems(env.DB, onboarding.id)).every((i) => i.dueAt !== null)).toBe(true);
    expect(await activity(s.businessId, "onboarding_welcome")).toHaveLength(1);
  });

  it("the video link set after the approval was made is in the mail that goes", async () => {
    const { mail, onboarding, approvalId } = await waiting();
    await env.DB.prepare(`UPDATE onboardings SET welcome_video_url = ? WHERE id = ?`).bind("https://videos.example.com/hello", onboarding.id).run();
    expect(await approve(env, approvalId)).toEqual({ ok: true });
    expect(mail.sent[0].text).toContain("https://videos.example.com/hello");
  });

  it("the preview shows the video link when there is one", async () => {
    await readyToSend();
    const s = await seed();
    const o = (await startOnboarding(env, s.doc))!;
    await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'onboarding.welcome'`).run();
    await env.DB.prepare(`UPDATE onboardings SET welcome_video_url = ? WHERE id = ?`).bind("https://videos.example.com/hello", o.id).run();
    const a = await createWelcomeApproval(env, (await getOnboarding(env.DB, o.id))!);
    expect(a.preview).toContain("Welcome video: https://videos.example.com/hello");
  });

  it("a second createWelcomeApproval returns the waiting one", async () => {
    const { onboarding, approvalId, s } = await waiting();
    const again = await createWelcomeApproval(env, onboarding);
    expect(again.id).toBe(approvalId);
    expect(await welcomes(s.dealId)).toHaveLength(1);
  });

  it("refuses, and sends nothing, when the main mailbox is switched off", async () => {
    const { mail, onboarding, approvalId } = await waiting();
    await env.DB.prepare(`UPDATE mailboxes SET enabled = 0 WHERE key = 'main'`).run();
    const r = await approve(env, approvalId);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/main mailbox cannot send/);
    expect(mail.sent).toEqual([]);
    expect((await getOnboarding(env.DB, onboarding.id))!.welcomeSentAt).toBeNull();
  });

  it("the welcome link is the client link for the onboarding token on /o/", async () => {
    const { mail, onboarding, approvalId } = await waiting();
    expect(onboarding.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await approve(env, approvalId)).toEqual({ ok: true });
    const links = mail.sent[0].text.match(/https?:\/\/\S+/g) ?? [];
    expect(links).toEqual([`${BASE}/o/${onboarding.token}`]);
  });
});

describe("onboarding.welcome and onboarding.nudge through the MCP tool", () => {
  let rpcId = 0;
  const call = async (name: string, args: unknown) => {
    const r = await SELF.fetch("https://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-mcp-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await r.text();
    return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  };
  const count = async (kind: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = ?`).bind(kind).first<{ n: number }>())!.n;

  for (const kind of ["onboarding.welcome", "onboarding.nudge"]) {
    it(`${kind} cannot be proposed through the MCP tool`, async () => {
      const before = await count(kind);
      const j = await call("propose_approval", { kind, title: "Send a mail", preview: "Harmless text", payload: { onboardingId: "any-onboarding" }, record_type: "deal", record_id: "d1" });
      expect(j.result.isError).toBe(true);
      expect(j.result.content[0].text).toContain(kind);
      expect(j.result.content[0].text).toMatch(/app proposes it itself/);
      expect(await count(kind)).toBe(before);
    });
  }
});
