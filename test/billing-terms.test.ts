import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { addMonths } from "../src/worker/billing/dates";
import { renderTermNotice } from "../src/worker/billing/mail";
import { planSubscriptions } from "../src/worker/billing/subscriptions";
import { EarlyExitError, cancelSubscription, earlyExitCents, setEndAction, sweepTerms } from "../src/worker/billing/terms";
import { listActivity } from "../src/worker/db/activity";
import { getDocument } from "../src/worker/db/documents";
import { listInvoices } from "../src/worker/db/invoices";
import { getPackage } from "../src/worker/db/packages";
import { getSubscription, insertPlanned, listSubscriptions, markSubscription, type Subscription } from "../src/worker/db/subscriptions";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { seedSubscriptionDoc } from "./fixtures/billing";
import { readyToSend } from "./fixtures/documents";
import { KEY, stripeApi, stripeError } from "./fixtures/stripe";

const withEnv = (over: Partial<Env>) => ({ ...env, ...over }) as Env;
const E_TEST = withEnv({ STRIPE_SECRET_KEY: KEY });
const E_LIVE = withEnv({ STRIPE_SECRET_KEY: "sk_live_LIVEKEYVALUE456" });
const E_NONE = withEnv({ STRIPE_SECRET_KEY: undefined });
// 10:00 on the given day in Los Angeles (winter: UTC-8).
const at = (day: string) => new Date(`${day}T18:00:00.000Z`);
const TERM_END = "2028-12-20";

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mail = await readyToSend();
  // The sweep reads every subscription, and the tests of a file share storage: leftovers are put out of the way.
  await env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE status IN ('planned', 'proposed', 'link_sent', 'active', 'past_due')`).run();
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); setStripeFetchForTests(null); });

type Keys = Parameters<typeof seedSubscriptionDoc>[0]["keys"];
/** An active, real subscription for a fresh client, with a Stripe subscription id and its term end. Website Subscription by default (it converts to Care). */
async function active(o: { keys?: Keys; termEndsOn?: string | null; status?: "active" | "link_sent" | "past_due" | "planned" } = {}) {
  const s = await seedSubscriptionDoc({ keys: o.keys ?? ["website_subscription"] });
  await planSubscriptions(E_TEST, (await getDocument(env.DB, s.documentId))!);
  const planned = (await listSubscriptions(env.DB, { businessId: s.businessId }))[0];
  const status = o.status ?? "active";
  if (status !== "planned") {
    expect(await markSubscription(env.DB, planned.id, {
      status, termEndsOn: o.termEndsOn === undefined ? TERM_END : o.termEndsOn, activatedAt: "2026-12-20T10:00:00.000Z",
      ...(status === "active" || status === "past_due" ? { stripeSubscriptionId: `sub_${crypto.randomUUID().slice(0, 8)}`, stripeCustomerId: "cus_1" } : {}),
    }, { from: ["planned"] })).toBe(true);
  }
  return { ...s, sub: (await getSubscription(env.DB, planned.id))! };
}
const stripePosts = (api: ReturnType<typeof stripeApi>) => api.calls.filter((c) => c.method === "POST" && /^\/v1\/subscriptions\//.test(new URL(c.url).pathname));
const noticesFor = async (subscriptionId: string) =>
  (await env.DB.prepare(`SELECT id, status FROM approvals WHERE kind = 'subscription.term_notice' AND json_extract(payload, '$.subscriptionId') = ? ORDER BY created_at, id`).bind(subscriptionId).all<{ id: string; status: string }>()).results;

/** A bare subscription value for the pure function. */
const pure = (o: Partial<Subscription>): Subscription => ({
  id: "s", businessId: "b", documentId: "d", projectId: null, packageKey: "website_subscription", packageVersion: 1, monthlyCents: 29700, startsWhen: "launch", firstChargeOn: "2026-12-20",
  termMonths: 24, termEndsOn: "2028-12-20", endAction: "convert_to_care", status: "active", token: null, stripeCustomerId: null, stripeSubscriptionId: null, stripeCheckoutSessionId: null,
  termNoticeSentAt: null, test: false, createdAt: "", activatedAt: null, cancelledAt: null, ...o,
});

describe("earlyExitCents", () => {
  it("10 months left at $297 is $2,970, none after the term, none with no term", () => {
    expect(earlyExitCents(pure({ termEndsOn: "2027-10-20" }), "2026-12-20")).toBe(10 * 29700);
    expect(earlyExitCents(pure({ termEndsOn: "2027-10-19" }), "2026-12-20")).toBe(9 * 29700); // a part month is not owed
    expect(earlyExitCents(pure({ termEndsOn: "2026-12-20" }), "2026-12-20")).toBe(0);
    expect(earlyExitCents(pure({ termEndsOn: "2026-12-01" }), "2026-12-20")).toBe(0);
    expect(earlyExitCents(pure({ termEndsOn: null, termMonths: null }), "2026-12-20")).toBe(0);
    expect(earlyExitCents(pure({ status: "cancelled" }), "2026-12-20")).toBe(0);
    expect(earlyExitCents(pure({ status: "ended" }), "2026-12-20")).toBe(0);
  });

  it("a term starting on the 31st for 24 months ends on the 31st two years on, and one month later clamps", () => {
    expect(addMonths("2026-01-31", 24)).toBe("2028-01-31");
    expect(addMonths("2026-01-31", 25)).toBe("2028-02-29");
    // Standing on the 31st with the term ending on the 29th of the next (short) month: that is one whole month left.
    expect(earlyExitCents(pure({ termEndsOn: "2028-02-29" }), "2028-01-31")).toBe(29700);
    expect(earlyExitCents(pure({ termEndsOn: "2028-02-28" }), "2028-01-31")).toBe(0);
    expect(earlyExitCents(pure({ termEndsOn: "2028-01-31" }), "2026-01-31")).toBe(24 * 29700);
  });

  it("local seo's six-month first term is an early-exit term too", async () => {
    const s = await active({ keys: ["local_seo"], termEndsOn: "2027-06-20" });
    expect(s.sub).toMatchObject({ packageKey: "local_seo", monthlyCents: 79700, termMonths: 6, endAction: "none" });
    expect(earlyExitCents(s.sub, "2026-12-20")).toBe(6 * 79700);
  });
});

describe("the term notice", () => {
  it("the kind is registered and takes only a subscription id", () => {
    const h = getHandler("subscription.term_notice")!;
    expect(h.label).toBe("Send term notice");
    expect(h.parse({ subscriptionId: "x" })).toEqual({ subscriptionId: "x" });
    expect(() => h.parse({})).toThrow();
  });

  it("is drafted once, 30 days out, even across two sweeps", async () => {
    const s = await active();
    expect(await sweepTerms(E_TEST, at("2028-11-19"))).toEqual({ notices: 0, converted: 0 }); // 31 days out: not yet
    expect(await noticesFor(s.sub.id)).toHaveLength(0);

    expect(await sweepTerms(E_TEST, at("2028-11-20"))).toEqual({ notices: 1, converted: 0 }); // exactly 30 days
    expect(await sweepTerms(E_TEST, at("2028-11-20"))).toEqual({ notices: 0, converted: 0 });
    expect(await sweepTerms(E_TEST, at("2028-11-25"))).toEqual({ notices: 0, converted: 0 });
    const [a, ...rest] = await noticesFor(s.sub.id);
    expect(rest).toHaveLength(0);
    expect((await getSubscription(env.DB, s.sub.id))!.termNoticeSentAt).not.toBeNull();

    const row = (await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(a.id).first<any>())!;
    expect(row).toMatchObject({ kind: "subscription.term_notice", status: "pending", record_type: "business", record_id: s.businessId, drafted_by: "logan" });
    expect(row.preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(row.preview).toContain("December 20, 2028");
    expect(row.preview).toContain("$129 a month");
    expect(row.preview).toContain("Nothing is mailed until you approve");
  });

  it("two sweeps at the same moment draft one approval", async () => {
    const s = await active();
    const r = await Promise.all([sweepTerms(E_TEST, at("2028-11-20")), sweepTerms(E_TEST, at("2028-11-20"))]);
    expect(r.reduce((n, x) => n + x.notices, 0)).toBe(1);
    expect(await noticesFor(s.sub.id)).toHaveLength(1);
  });

  it("a subscription set to none gets no notice and no conversion", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active();
    expect(await setEndAction(env.DB, s.sub.id, "none")).toBe(true);
    expect(await sweepTerms(E_TEST, at("2028-11-20"))).toEqual({ notices: 0, converted: 0 });
    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 0 });
    expect(await noticesFor(s.sub.id)).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
    expect((await getSubscription(env.DB, s.sub.id))).toMatchObject({ packageKey: "website_subscription", endAction: "none", status: "active" });
  });

  it("one that is not active, or has no term end, or does not convert, gets nothing", async () => {
    const linkSent = await active({ status: "link_sent" });
    const open = await active({ termEndsOn: null });
    const care = await active({ keys: ["care"], termEndsOn: "2028-12-20" });
    expect(await sweepTerms(E_TEST, at("2028-11-20"))).toEqual({ notices: 0, converted: 0 });
    for (const x of [linkSent, open, care]) expect(await noticesFor(x.sub.id)).toHaveLength(0);
  });

  it("approving mails the fixed notice once, and nothing when it was switched to none meanwhile", async () => {
    const a1 = await active();
    await sweepTerms(E_TEST, at("2028-11-20"));
    const [n1] = await noticesFor(a1.sub.id);
    expect(await approve(E_TEST, n1.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test", subject: "Your Website Subscription term for Ace Plumbing ends on December 20, 2028" });
    expect(mail.sent[0].text).toContain("$129 a month");
    expect(mail.sent[0].text).toContain("Care");
    expect(mail.sent[0].text).toContain("refresh");
    expect((await listActivity(env.DB, a1.businessId)).filter((x) => x.detail?.includes("term notice sent"))).toHaveLength(1);
    // The approval put back to pending after it was mailed: nothing more goes out.
    await env.DB.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ?`).bind(n1.id).run();
    expect(await approve(E_TEST, n1.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);

    const a2 = await active();
    await sweepTerms(E_TEST, at("2028-11-20"));
    const [n2] = await noticesFor(a2.sub.id);
    await setEndAction(env.DB, a2.sub.id, "none");
    expect(await approve(E_TEST, n2.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1); // no mail for the second

    const a3 = await active();
    await sweepTerms(E_TEST, at("2028-11-20"));
    const [n3] = await noticesFor(a3.sub.id);
    await markSubscription(env.DB, a3.sub.id, { status: "cancelled" }, { from: ["active"] });
    expect(await approve(E_TEST, n3.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1); // cancelled meanwhile: nothing
  });

  it("renders fixed words with the client's text on one line and capped", () => {
    const m = renderTermNotice({ termEndsOn: "2028-12-20" }, { clientName: "Ace\nPlumbing ".repeat(40), contactName: "Pat\nJones", yourName: "Logan", planName: "Website\nSubscription", careMonthlyCents: 12900 });
    expect(m.subject.length).toBeLessThanOrEqual(200);
    expect(m.subject).not.toMatch(/\n/);
    expect(m.body.split("\n\n")[0]).toBe("Hi Pat,");
    expect(m.body).toContain("December 20, 2028");
    expect(m.body).toContain("$129 a month");
    expect(m.body).toContain("reply to this email");
    expect(m.body).not.toMatch(/Ace\nPlumbing/);
  });
});

describe("conversion to Care", () => {
  it("swaps the price once on a replayed sweep and moves the row to Care", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active();
    const care = (await getPackage(env.DB, "care"))!;
    expect(await sweepTerms(E_TEST, at("2028-12-19"))).toEqual({ notices: 1, converted: 0 }); // the day before: only the notice
    expect(stripePosts(api)).toHaveLength(0);

    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 1 });
    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 0 }); // replayed
    expect(await sweepTerms(E_TEST, at("2028-12-21"))).toEqual({ notices: 0, converted: 0 });

    const posts = stripePosts(api);
    expect(posts).toHaveLength(1);
    expect(posts[0].headers["idempotency-key"]).toBe(`convert:${s.sub.id}`);
    expect(new URL(posts[0].url).pathname).toBe(`/v1/subscriptions/${s.sub.stripeSubscriptionId}`);
    expect(posts[0].form.get("proration_behavior")).toBe("none");
    expect(posts[0].form.get("items[0][price_data][unit_amount]")).toBe(String(care.priceCents));
    expect(posts[0].form.get("items[0][price_data][recurring][interval]")).toBe("month");
    expect(posts[0].form.get("items[0][id]")).toBe(`si_${s.sub.stripeSubscriptionId}`);

    const after = (await getSubscription(env.DB, s.sub.id))!;
    expect(after).toMatchObject({ packageKey: "care", packageVersion: care.version, monthlyCents: care.priceCents, endAction: "none", termMonths: null, status: "active", stripeSubscriptionId: s.sub.stripeSubscriptionId });
    const lines = (await listActivity(env.DB, s.businessId)).filter((x) => x.detail?.includes("moved to Care"));
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain("$129 a month");
    expect(earlyExitCents(after, TERM_END)).toBe(0);
  });

  it("converts one whose term ended days ago", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active({ termEndsOn: "2028-12-10" });
    expect(await sweepTerms(E_TEST, at("2028-12-20"))).toEqual({ notices: 0, converted: 1 });
    expect((await getSubscription(env.DB, s.sub.id))!.packageKey).toBe("care");
  });

  it("a Stripe failure leaves the row as it was and is tried again next sweep", async () => {
    let down = true;
    const api = stripeApi({ fail: (c) => (down && c.method === "POST" && /^\/v1\/subscriptions\//.test(new URL(c.url).pathname) ? stripeError("Stripe is down") : null) });
    setStripeFetchForTests(api.f);
    const s = await active();
    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 0 });
    expect(await getSubscription(env.DB, s.sub.id)).toEqual(s.sub);
    expect(errors).toHaveBeenCalled();

    down = false;
    expect(await sweepTerms(E_TEST, at("2028-12-21"))).toEqual({ notices: 0, converted: 1 });
    expect((await getSubscription(env.DB, s.sub.id))).toMatchObject({ packageKey: "care", monthlyCents: 12900, endAction: "none", termMonths: null });
  });

  it("a live key never touches a test row, and no key touches nothing", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const real = await seedSubscriptionDoc({ keys: ["website_subscription"], test: true });
    const { subscription: t } = await insertPlanned(env.DB, {
      businessId: real.businessId, documentId: real.documentId, projectId: null, packageKey: "website_subscription", packageVersion: 1, monthlyCents: 29700, startsWhen: "launch",
      firstChargeOn: null, termMonths: 24, termEndsOn: null, endAction: "convert_to_care", test: true,
    });
    await markSubscription(env.DB, t.id, { status: "active", stripeSubscriptionId: "sub_testrow", termEndsOn: TERM_END }, { from: ["planned"] });
    const r = await active();

    expect(await sweepTerms(E_LIVE, at(TERM_END))).toEqual({ notices: 0, converted: 1 }); // the real row only
    expect(stripePosts(api).map((c) => new URL(c.url).pathname)).toEqual([`/v1/subscriptions/${r.sub.stripeSubscriptionId}`]);
    expect((await getSubscription(env.DB, t.id))).toMatchObject({ packageKey: "website_subscription", endAction: "convert_to_care" });

    const r2 = await active();
    expect(await sweepTerms(E_NONE, at(TERM_END))).toEqual({ notices: 0, converted: 0 }); // Stripe is not set up: the row waits
    expect((await getSubscription(env.DB, r2.sub.id))!.packageKey).toBe("website_subscription");

    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 2 }); // a test key may rehearse any lead (r2 and the test row)
    expect((await getSubscription(env.DB, t.id))!.packageKey).toBe("care");
  });
});

/** A document that sells BOTH the Website Subscription and Care (what a build proposal normally carries): the Website Subscription active and due to convert, Care at its own price. */
async function bothRows(o: { careStatus?: "active" | "cancelled" | "ended"; careCents?: number } = {}) {
  const s = await seedSubscriptionDoc({ keys: ["website_subscription", "care"] });
  await planSubscriptions(E_TEST, (await getDocument(env.DB, s.documentId))!);
  const rows = await listSubscriptions(env.DB, { businessId: s.businessId });
  const site = rows.find((x) => x.packageKey === "website_subscription")!, care = rows.find((x) => x.packageKey === "care")!;
  await markSubscription(env.DB, site.id, { status: "active", stripeSubscriptionId: `sub_${crypto.randomUUID().slice(0, 8)}`, termEndsOn: TERM_END }, { from: ["planned"] });
  const careStatus = o.careStatus ?? "active";
  await env.DB.prepare(`UPDATE subscriptions SET status = ?, monthly_cents = ? WHERE id = ?`).bind(careStatus, o.careCents ?? 9900, care.id).run();
  return { ...s, site: (await getSubscription(env.DB, site.id))!, care: (await getSubscription(env.DB, care.id))! };
}
const priceChanges = (api: ReturnType<typeof stripeApi>) => stripePosts(api).filter((c) => c.form.get("proration_behavior") !== null);
const cancels = (api: ReturnType<typeof stripeApi>) => stripePosts(api).filter((c) => c.form.get("cancel_at_period_end") === "true");

describe("a document that has its own Care subscription", () => {
  it("the notice quotes the existing Care row's price with the end-of-term wording, drafted once", async () => {
    const s = await bothRows({ careCents: 9900 });
    expect(await sweepTerms(E_TEST, at("2028-11-20"))).toEqual({ notices: 1, converted: 0 });
    expect(await sweepTerms(E_TEST, at("2028-11-20"))).toEqual({ notices: 0, converted: 0 });
    const [n, ...rest] = await noticesFor(s.site.id);
    expect(rest).toHaveLength(0);
    const row = (await env.DB.prepare(`SELECT preview FROM approvals WHERE id = ?`).bind(n.id).first<{ preview: string }>())!;
    expect(row.preview).toContain("December 20, 2028");
    expect(row.preview).toContain("Care continues");
    expect(row.preview).toContain("$99 a month");
    expect(row.preview).not.toContain("$129");
    expect(row.preview).not.toContain("moves to Care");

    expect(await approve(E_TEST, n.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain("Care continues");
    expect(mail.sent[0].text).toContain("$99 a month");
    expect(mail.sent[0].text).not.toContain("moves to Care");
  });

  it("at term end it ends the Website Subscription at period end once and Care carries on", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await bothRows();
    errors.mockClear();
    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 1 });
    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 0 }); // replayed
    expect(await sweepTerms(E_TEST, at("2028-12-21"))).toEqual({ notices: 0, converted: 0 });
    const posts = stripePosts(api);
    expect(posts).toHaveLength(1);
    expect(cancels(api)).toHaveLength(1);
    expect(priceChanges(api)).toHaveLength(0);
    expect(posts[0].headers["idempotency-key"]).toBe(`end:${s.site.id}`);
    expect(new URL(posts[0].url).pathname).toBe(`/v1/subscriptions/${s.site.stripeSubscriptionId}`);
    expect(await getSubscription(env.DB, s.site.id)).toMatchObject({ status: "ended", packageKey: "website_subscription" });
    expect(await getSubscription(env.DB, s.care.id)).toEqual(s.care); // Care is untouched
    const lines = (await listActivity(env.DB, s.businessId)).filter((x) => x.detail?.includes("Care continues on the existing plan"));
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain("Website subscription term ended");
    expect(errors).not.toHaveBeenCalled();
  });

  it("a Stripe failure leaves the row unchanged and is tried again next sweep", async () => {
    let down = true;
    const api = stripeApi({ fail: (c) => (down && c.method === "POST" ? stripeError("Stripe is down") : null) });
    setStripeFetchForTests(api.f);
    const s = await bothRows();
    expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 0 });
    expect(await getSubscription(env.DB, s.site.id)).toEqual(s.site);
    down = false;
    expect(await sweepTerms(E_TEST, at("2028-12-21"))).toEqual({ notices: 0, converted: 1 });
    expect((await getSubscription(env.DB, s.site.id))!.status).toBe("ended");
    expect(cancels(api).length).toBeGreaterThanOrEqual(1);
    expect(priceChanges(api)).toHaveLength(0);
  });

  it("a live key never ends a test row", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await bothRows();
    await env.DB.prepare(`UPDATE subscriptions SET test = 1 WHERE id = ?`).bind(s.site.id).run();
    expect(await sweepTerms(E_LIVE, at(TERM_END))).toEqual({ notices: 0, converted: 0 });
    expect(api.calls).toHaveLength(0);
    expect((await getSubscription(env.DB, s.site.id))!.status).toBe("active");
  });

  it("a Care row that is cancelled or ended is no clash for the notice, and the index forces the end path", async () => {
    for (const careStatus of ["cancelled", "ended"] as const) {
      const api = stripeApi(); setStripeFetchForTests(api.f);
      const s = await bothRows({ careStatus });
      expect(await sweepTerms(E_TEST, at("2028-11-20"))).toEqual({ notices: 1, converted: 0 });
      const [n] = await noticesFor(s.site.id);
      const row = (await env.DB.prepare(`SELECT preview FROM approvals WHERE id = ?`).bind(n.id).first<{ preview: string }>())!;
      expect(row.preview).toContain("moves to Care"); // the existing wording, at the catalog price
      expect(row.preview).toContain("$129 a month");

      // The unique index (document, package) still holds the closed Care row, so no swap is possible: the Website Subscription ends instead, and the timeline says why.
      expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 1 });
      expect(cancels(api)).toHaveLength(1);
      expect(priceChanges(api)).toHaveLength(0);
      expect((await getSubscription(env.DB, s.site.id))!.status).toBe("ended");
      expect((await listActivity(env.DB, s.businessId)).filter((x) => x.detail?.includes("is closed, so nothing moved to Care"))).toHaveLength(1);
      expect(await sweepTerms(E_TEST, at(TERM_END))).toEqual({ notices: 0, converted: 0 });
      expect(cancels(api)).toHaveLength(1);
    }
  });
});

describe("cancelling", () => {
  const NOW = at("2026-12-20");
  const ten = "2027-10-20"; // 10 whole months from 2026-12-20

  it("without confirmation refuses with the balance and changes nothing", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active({ termEndsOn: ten });
    const err = await cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: false, now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(EarlyExitError);
    expect(err.cents).toBe(10 * 29700);
    expect(err.message).toContain("$2,970");
    expect(api.calls).toHaveLength(0);
    expect(await getSubscription(env.DB, s.sub.id)).toEqual(s.sub);
    expect(await listInvoices(env.DB, { kinds: ["early_exit"], businessId: s.businessId })).toHaveLength(0);
  });

  it("with confirmation stops at period end and drafts one early-exit invoice for approval", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active({ termEndsOn: ten });
    const r = await cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: true, now: NOW });
    expect(r.subscription).toMatchObject({ id: s.sub.id, status: "cancelled" });
    expect(r.subscription.cancelledAt).toBe(NOW.toISOString());
    const posts = stripePosts(api);
    expect(posts).toHaveLength(1);
    expect(posts[0].form.get("cancel_at_period_end")).toBe("true");
    expect(posts[0].headers["idempotency-key"]).toBe(`cancel:${s.sub.id}`);
    expect(new URL(posts[0].url).pathname).toBe(`/v1/subscriptions/${s.sub.stripeSubscriptionId}`);

    expect(r.invoice).toMatchObject({ kind: "early_exit", ref: `early_exit:${s.sub.id}`, status: "draft", amountCents: 10 * 29700, subscriptionId: s.sub.id, businessId: s.businessId, test: false, documentId: s.documentId });
    expect(r.invoice!.stripeInvoiceId).toBeNull(); // nothing is made at Stripe until the approval
    expect(r.invoice!.lines).toEqual([{ description: expect.stringContaining("10 months"), amountCents: 10 * 29700 }]);
    const invoices = await listInvoices(env.DB, { kinds: ["early_exit"], businessId: s.businessId });
    expect(invoices).toHaveLength(1);
    const approvals = (await env.DB.prepare(`SELECT status FROM approvals WHERE kind = 'invoice.send' AND json_extract(payload, '$.invoiceId') = ?`).bind(invoices[0].id).all()).results;
    expect(approvals).toEqual([{ status: "pending" }]);
    expect(api.creates().filter((c) => new URL(c.url).pathname === "/v1/invoices")).toHaveLength(0);
  });

  it("a stripe failure cancels nothing and drafts nothing; a retry then works once", async () => {
    let down = true;
    const api = stripeApi({ fail: (c) => (down && c.method === "POST" ? stripeError("Stripe is down") : null) });
    setStripeFetchForTests(api.f);
    const s = await active({ termEndsOn: ten });
    await expect(cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: true, now: NOW })).rejects.toThrow("Stripe is down");
    expect(await getSubscription(env.DB, s.sub.id)).toEqual(s.sub);
    expect(await listInvoices(env.DB, { kinds: ["early_exit"], businessId: s.businessId })).toHaveLength(0);
    down = false;
    const r = await cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: true, now: NOW });
    expect(r.subscription.status).toBe("cancelled");
    expect(await listInvoices(env.DB, { kinds: ["early_exit"], businessId: s.businessId })).toHaveLength(1);
    await expect(cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: true, now: NOW })).rejects.toThrow(/already/);
    expect(await listInvoices(env.DB, { kinds: ["early_exit"], businessId: s.businessId })).toHaveLength(1);
  });

  it("after the term it owes nothing and drafts nothing, and still stops at period end", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active({ termEndsOn: "2026-11-20" });
    const r = await cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: false, now: NOW });
    expect(r.invoice).toBeNull();
    expect(r.subscription.status).toBe("cancelled");
    expect(stripePosts(api)).toHaveLength(1);
    expect(await listInvoices(env.DB, { kinds: ["early_exit"], businessId: s.businessId })).toHaveLength(0);
  });

  it("a subscription with no term (care) owes nothing", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active({ keys: ["care"], termEndsOn: null });
    const r = await cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: false, now: NOW });
    expect(r).toMatchObject({ invoice: null, subscription: { status: "cancelled" } });
  });

  it("cancelling a link_sent subscription closes it with no Stripe call", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await active({ status: "link_sent" });
    const r = await cancelSubscription(E_TEST, s.sub.id, { confirmEarlyExit: false, now: NOW });
    expect(r.invoice).toBeNull();
    expect(r.subscription).toMatchObject({ status: "cancelled", cancelledAt: NOW.toISOString() });
    expect(api.calls).toHaveLength(0);
    const planned = await active({ status: "planned" });
    expect((await cancelSubscription(E_NONE, planned.sub.id, { confirmEarlyExit: false, now: NOW })).subscription.status).toBe("cancelled"); // needs no Stripe at all
  });

  it("refuses an unknown or finished subscription, and a live key on a test row", async () => {
    await expect(cancelSubscription(E_TEST, "nope", { confirmEarlyExit: true, now: NOW })).rejects.toThrow(/no such subscription/i);
    const done = await active();
    await markSubscription(env.DB, done.sub.id, { status: "ended" }, { from: ["active"] });
    await expect(cancelSubscription(E_TEST, done.sub.id, { confirmEarlyExit: true, now: NOW })).rejects.toThrow(/already/);

    const api = stripeApi(); setStripeFetchForTests(api.f);
    const t = await active();
    await env.DB.prepare(`UPDATE subscriptions SET test = 1 WHERE id = ?`).bind(t.sub.id).run();
    await expect(cancelSubscription(E_LIVE, t.sub.id, { confirmEarlyExit: true, now: NOW })).rejects.toThrow(/test/i);
    await expect(cancelSubscription(E_NONE, t.sub.id, { confirmEarlyExit: true, now: NOW })).rejects.toThrow(/Stripe is not set up/);
    expect(api.calls).toHaveLength(0);
    expect((await getSubscription(env.DB, t.sub.id))!.status).toBe("active");
  });
});

describe("setEndAction", () => {
  it("switches a live subscription both ways and refuses a finished one", async () => {
    const s = await active();
    expect(await setEndAction(env.DB, s.sub.id, "none")).toBe(true);
    expect((await getSubscription(env.DB, s.sub.id))!.endAction).toBe("none");
    expect(await setEndAction(env.DB, s.sub.id, "convert_to_care")).toBe(true);
    expect((await getSubscription(env.DB, s.sub.id))!.endAction).toBe("convert_to_care");
    await markSubscription(env.DB, s.sub.id, { status: "cancelled" }, { from: ["active"] });
    expect(await setEndAction(env.DB, s.sub.id, "none")).toBe(false);
    expect(await setEndAction(env.DB, "nope", "none")).toBe(false);
  });
});
