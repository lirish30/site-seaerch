import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve, reject } from "../src/worker/approvals/decide";
import { renderSubscriptionLink } from "../src/worker/billing/mail";
import { planSubscriptions, proposeSubscription } from "../src/worker/billing/subscriptions";
import { listActivity } from "../src/worker/db/activity";
import { getDocument } from "../src/worker/db/documents";
import { getByApproval } from "../src/worker/db/messages";
import { getSubscription, insertPlanned, listSubscriptions, markSubscription } from "../src/worker/db/subscriptions";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { isClientToken } from "../src/worker/documents/token";
import { seedSubscriptionDoc } from "./fixtures/billing";
import { OWNER_EMAIL, readyToSend } from "./fixtures/documents";
import { KEY } from "./fixtures/stripe";

const withEnv = (over: Partial<Env>) => ({ ...env, ...over }) as Env;
const E_TEST = withEnv({ STRIPE_SECRET_KEY: KEY });
const LIVE = "sk_live_LIVEKEYVALUE456";
let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); mail = await readyToSend(); });
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

const row = (id: string) => env.DB.prepare(`SELECT status, error FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null }>();

/** A real Care subscription for a fresh client, proposed and waiting for Logan. */
async function proposed(o: { keys?: Parameters<typeof seedSubscriptionDoc>[0]["keys"] } = {}) {
  const s = await seedSubscriptionDoc({ keys: o.keys ?? ["care"] });
  await planSubscriptions(E_TEST, (await getDocument(env.DB, s.documentId))!);
  const sub = (await listSubscriptions(env.DB, { businessId: s.businessId }))[0];
  const a = await proposeSubscription(E_TEST, sub.id, "2027-01-02");
  return { ...s, sub, a };
}

describe("subscription.start approval", () => {
  it("approving mails the /s/ link once and sets link_sent", async () => {
    const { sub, a, businessId } = await proposed();
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    const after = (await getSubscription(env.DB, sub.id))!;
    expect(after.status).toBe("link_sent");
    expect(isClientToken(after.token!)).toBe(true);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test", subject: "Your monthly Care plan for Ace Plumbing" });
    expect(mail.sent[0].text).toContain(`https://clients.hellositeline.test/s/${after.token}`);
    expect(mail.sent[0].text).toContain("$129 a month");
    expect(mail.sent[0].text).toContain("January 2, 2027");
    expect((await getByApproval(env.DB, a.id))!.status).toBe("sent");
    expect((await listActivity(env.DB, businessId)).filter((x) => x.detail?.includes("subscription link sent"))).toHaveLength(1);
    // Nothing was made at Stripe: the link only goes to the client's page.
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, status: 409 });
    expect(mail.sent).toHaveLength(1);
  });

  it("a retry keeps the token and mails once", async () => {
    const { sub, a } = await proposed();
    mail.failures.push(new Error("smtp is down"));
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, error: expect.stringContaining("smtp is down") });
    const mid = (await getSubscription(env.DB, sub.id))!;
    expect(mid.status).toBe("link_sent"); // the move is made before the mail, so the link the mail will carry already works
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect(mail.sent).toHaveLength(0);

    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect((await getSubscription(env.DB, sub.id))!.token).toBe(mid.token);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain(`/s/${mid.token}`);

    // Put back to pending after it was mailed (an approval that failed afterwards): nothing more is mailed.
    await env.DB.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ?`).bind(a.id).run();
    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });

  it("approving without the lawyer's review recorded refuses", async () => {
    const { sub, a } = await proposed();
    const unreviewed = await readyToSend({ reviewed: false });
    const r = await approve(E_TEST, a.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Oregon lawyer") });
    expect((await getSubscription(env.DB, sub.id))!).toMatchObject({ status: "proposed", token: null });
    expect(unreviewed.sent).toHaveLength(0);
  });

  it("refuses without a Stripe key, without a client link base and with the main mailbox off", async () => {
    const { sub, a } = await proposed();
    expect(await approve(withEnv({ STRIPE_SECRET_KEY: undefined }), a.id)).toMatchObject({ ok: false, error: expect.stringContaining("Stripe") });
    expect(await approve(withEnv({ STRIPE_SECRET_KEY: KEY, CLIENT_LINK_BASE: undefined }), a.id)).toMatchObject({ ok: false, error: expect.stringContaining("CLIENT_LINK_BASE") });
    expect(await approve(withEnv({ STRIPE_SECRET_KEY: KEY, CLIENT_LINK_BASE: "http://clients.hellositeline.test" }), a.id)).toMatchObject({ ok: false, error: expect.stringContaining("CLIENT_LINK_BASE") });
    // The cold-email host is never a client's host.
    expect(await approve(withEnv({ STRIPE_SECRET_KEY: KEY, CLIENT_LINK_BASE: env.OUTREACH_LINK_BASE }), a.id)).toMatchObject({ ok: false, error: expect.stringContaining("CLIENT_LINK_BASE") });
    await env.DB.prepare(`UPDATE mailboxes SET enabled = 0 WHERE key = 'main'`).run();
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, error: expect.stringContaining("main mailbox") });
    expect((await getSubscription(env.DB, sub.id))!).toMatchObject({ status: "proposed", token: null });
    expect(mail.sent).toHaveLength(0);
  });

  it("refuses a subscription that is not proposed any more", async () => {
    const { sub, a } = await proposed();
    expect(await markSubscription(env.DB, sub.id, { status: "cancelled" })).toBe(true);
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
    expect(mail.sent).toHaveLength(0);
    expect((await getSubscription(env.DB, sub.id))!.token).toBeNull();
  });

  it("a test subscription goes to the owner only, needs no review, and never through a live key", async () => {
    const s = await seedSubscriptionDoc({ keys: ["care"], test: true });
    const { subscription } = await insertPlanned(env.DB, {
      businessId: s.businessId, documentId: s.documentId, projectId: null, packageKey: "care", packageVersion: 1, monthlyCents: 12900, startsWhen: "signing", firstChargeOn: null,
      termMonths: null, termEndsOn: null, endAction: "none", test: true,
    });
    const a = await proposeSubscription(E_TEST, subscription.id, "2027-01-02");
    const unreviewed = await readyToSend({ reviewed: false });

    expect(await approve(withEnv({ STRIPE_SECRET_KEY: LIVE }), a.id)).toMatchObject({ ok: false, error: expect.stringContaining("test") });
    expect(unreviewed.sent).toHaveLength(0);
    expect((await getSubscription(env.DB, subscription.id))!.token).toBeNull();

    expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
    expect(unreviewed.sent).toHaveLength(1);
    expect(unreviewed.sent[0]).toMatchObject({ to: OWNER_EMAIL, subject: "[Test] Your monthly Care plan for Ace Plumbing" });
    expect((await getSubscription(env.DB, subscription.id))!.status).toBe("link_sent");
  });

  it("a real subscription may go through a test key (a rehearsal), and through a live key", async () => {
    const { sub, a } = await proposed();
    expect(await approve(withEnv({ STRIPE_SECRET_KEY: LIVE }), a.id)).toEqual({ ok: true });
    expect((await getSubscription(env.DB, sub.id))!.status).toBe("link_sent");
  });
});

describe("a link that never reached the client can be put up again", () => {
  it("a failed mail then a rejected approval leaves link_sent with no way back, until it is proposed again", async () => {
    const { sub, a } = await proposed();
    mail.failures.push(new Error("smtp is down"));
    expect(await approve(E_TEST, a.id)).toMatchObject({ ok: false, error: expect.stringContaining("smtp is down") });
    expect((await getSubscription(env.DB, sub.id))!.status).toBe("link_sent"); // the move comes before the mail
    expect(await reject(env.DB, a.id, "not now")).toBe(true);
    expect(mail.sent).toHaveLength(0);

    const again = await proposeSubscription(E_TEST, sub.id, "2027-01-09");
    expect(again.id).not.toBe(a.id);
    expect(again.status).toBe("pending");
    expect(await getSubscription(env.DB, sub.id)).toMatchObject({ status: "proposed", firstChargeOn: "2027-01-09" });
    expect(await approve(E_TEST, again.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain("January 9, 2027");
    expect((await getSubscription(env.DB, sub.id))!.status).toBe("link_sent");
  });

  it("a link that was mailed, or has a Checkout on record, is not put up again", async () => {
    const mailed = await proposed();
    expect(await approve(E_TEST, mailed.a.id)).toEqual({ ok: true });
    await expect(proposeSubscription(E_TEST, mailed.sub.id, "2027-01-09")).rejects.toThrow(/link_sent/);

    const started = await proposed();
    mail.failures.push(new Error("smtp is down"));
    await approve(E_TEST, started.a.id);
    await reject(env.DB, started.a.id, "no");
    await env.DB.prepare(`UPDATE subscriptions SET stripe_checkout_session_id = 'cs_1' WHERE id = ?`).bind(started.sub.id).run();
    await expect(proposeSubscription(E_TEST, started.sub.id, "2027-01-09")).rejects.toThrow(/link_sent/);
  });
});

describe("the first payment the link mail states", () => {
  const clock = (iso: string) => setMailDeps({ smtp: async (_mb, _pw, msg) => { mail.sent.push(msg); }, now: () => new Date(iso) });
  // The first charge is 2 Jan 2027 (noon UTC): within 3 days of the clock the card is taken at Checkout, so no date can be promised.
  const WHEN = "The first payment is taken when you set it up.";
  const cases: [string, string, boolean][] = [
    ["a launch-start row approved a day after its first charge date", "2027-01-03T18:00:00.000Z", true],
    ["a first charge date 1 day ahead", "2027-01-01T18:00:00.000Z", true],
    ["a first charge date 5 days ahead", "2026-12-28T18:00:00.000Z", false],
  ];
  for (const [name, now, atCheckout] of cases) {
    it(`${name}: the mail and the preview say ${atCheckout ? "it is taken at set-up, with no date" : "the date"}`, async () => {
      clock(now);
      const { a } = await proposed();
      for (const text of [a.preview]) {
        expect(text.includes(WHEN), "preview").toBe(atCheckout);
        expect(text.includes("The first payment is on January 2, 2027."), "preview").toBe(!atCheckout);
      }
      expect(await approve(E_TEST, a.id)).toEqual({ ok: true });
      expect(mail.sent[0].text.includes(WHEN), "mail").toBe(atCheckout);
      expect(mail.sent[0].text.includes("The first payment is on January 2, 2027."), "mail").toBe(!atCheckout);
      if (atCheckout) expect(mail.sent[0].text).not.toContain("January 2, 2027");
    });
  }
});

describe("renderSubscriptionLink", () => {
  const sub = { monthlyCents: 29700, firstChargeOn: "2027-01-02", termMonths: 24 as number | null, test: false };

  it("uses fixed words: plan, price, first charge, term, the link", () => {
    const m = renderSubscriptionLink(sub, "https://clients.example/s/TOKEN", { clientName: "Ace Plumbing", contactName: "Pat Jones", yourName: "Logan", planName: "Website Subscription", chargedNow: false });
    expect(m.subject).toBe("Your monthly Website Subscription plan for Ace Plumbing");
    expect(m.body).toBe([
      "Hi Pat,",
      "Here is the link to set up the monthly payment for Ace Plumbing: Website Subscription.",
      "Amount: $297 a month. The first payment is on January 2, 2027. The term is 24 months.",
      "You can set it up online, by card, here:",
      "https://clients.example/s/TOKEN",
      "Reply to this email if you have a question.",
      "Thanks,\nLogan",
    ].join("\n\n"));
  });

  it("leaves out the term of an open-ended plan and the date when there is none", () => {
    const m = renderSubscriptionLink({ ...sub, termMonths: null, firstChargeOn: null }, "https://x/s/T", { clientName: "Ace", contactName: "", yourName: "", planName: "Care", chargedNow: false });
    expect(m.body).toContain("Amount: $297 a month.");
    expect(m.body).not.toContain("term");
    expect(m.body).not.toContain("first payment");
    expect(m.body.startsWith("Hi,")).toBe(true);
    expect(m.body.endsWith("Reply to this email if you have a question.\n\nThanks,")).toBe(true);
  });

  it("says the first payment is taken at set-up, with no date, when the card is charged at Checkout", () => {
    const m = renderSubscriptionLink(sub, "https://x/s/T", { clientName: "Ace", contactName: "Pat", yourName: "Logan", planName: "Care", chargedNow: true });
    expect(m.body).toContain("Amount: $297 a month. The first payment is taken when you set it up. The term is 24 months.");
    expect(m.body).not.toContain("January");
    expect(m.body).not.toContain("bank");
  });

  it("puts what a person typed on one line and caps it", () => {
    const evil = "Ace\r\nBcc: attacker@evil.test\n" + "x".repeat(500);
    const m = renderSubscriptionLink(sub, "https://x/s/T", { clientName: evil, contactName: `Pat\nBcc: a@b.c ${"y".repeat(500)}`, yourName: "Logan\nBcc: z@z.z", planName: `Care ${"z".repeat(500)}`, chargedNow: false });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject.length).toBeLessThanOrEqual(200);
    const lines = m.body.split("\n\n");
    expect(lines[0]).toBe("Hi Pat,");
    for (const l of lines) expect(l.length).toBeLessThan(450);
    expect(m.body).not.toContain("\r");
    // No line of the mail begins with a header-looking name the typed text could have started.
    expect(m.body.split("\n").some((l) => l.startsWith("Bcc:"))).toBe(false);
  });
});
