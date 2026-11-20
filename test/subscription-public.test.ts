import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planSubscriptions } from "../src/worker/billing/subscriptions";
import { startCheckout, subscriptionPage, type PublicSubscription } from "../src/worker/billing/checkout";
import { getDocument } from "../src/worker/db/documents";
import { getSubscription, insertPlanned, listSubscriptions, markSubscription } from "../src/worker/db/subscriptions";
import { setStripeFetchForTests } from "../src/worker/documents/deposit";
import { newClientToken } from "../src/worker/documents/token";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { seedSubscriptionDoc } from "./fixtures/billing";
import { KEY, stripeApi, stripeError, stripeJson } from "./fixtures/stripe";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const withEnv = (over: Partial<Env>) => ({ ...env, ...over }) as Env;
const E_TEST = withEnv({ STRIPE_SECRET_KEY: KEY });
const LIVE = "sk_live_LIVEKEYVALUE456";
const NOW = new Date("2026-12-20T18:00:00.000Z");
const BASE = "https://clients.hellositeline.test";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); setStripeFetchForTests(null); });

/** The Worker as a client's browser reaches it: no cookie. */
const call = (path: string, init: RequestInit = {}, e: Env = E_TEST) => worker.fetch(new Request(`https://x/api${path}`, init), e as never, ctx);
const NOT_FOUND = { error: "not found" };

interface Opts { keys?: Parameters<typeof seedSubscriptionDoc>[0]["keys"]; status?: "planned" | "proposed" | "link_sent" | "active"; test?: boolean; firstChargeOn?: string | null }
/** A subscription in the given state. A link_sent one has a token. */
async function seed(o: Opts = {}) {
  const s = await seedSubscriptionDoc({ keys: o.keys ?? ["care"], test: o.test });
  const doc = (await getDocument(env.DB, s.documentId))!;
  let sub;
  if (o.test) {
    sub = (await insertPlanned(env.DB, {
      businessId: s.businessId, documentId: s.documentId, projectId: null, packageKey: "care", packageVersion: 1, monthlyCents: 12900, startsWhen: "signing", firstChargeOn: null,
      termMonths: null, termEndsOn: null, endAction: "none", test: true,
    })).subscription;
  } else {
    await planSubscriptions(E_TEST, doc);
    sub = (await listSubscriptions(env.DB, { businessId: s.businessId }))[0];
  }
  const status = o.status ?? "link_sent";
  const token = newClientToken();
  const firstChargeOn = o.firstChargeOn === undefined ? "2027-01-02" : o.firstChargeOn;
  if (status !== "planned") await markSubscription(env.DB, sub.id, { status, firstChargeOn, ...(status === "link_sent" || status === "active" ? { token } : {}) });
  return { ...s, id: sub.id, token, sub: (await getSubscription(env.DB, sub.id))! };
}
const page = (token: string, e: Env = E_TEST, f?: ReturnType<typeof stripeApi>["f"], now?: Date) => subscriptionPage(e, token, { ...(f ? { fetch: f } : {}), ...(now ? { now } : {}) });
const ready = (p: PublicSubscription | null) => { if (!p || p.state !== "ready") throw new Error(`expected a ready page, got ${p?.state ?? "null"}`); return p; };

describe("the page", () => {
  it("an unknown, malformed or planned token is 404, on the page and on the checkout", async () => {
    const planned = await seed({ status: "planned" });
    await env.DB.prepare(`UPDATE subscriptions SET token = ? WHERE id = ?`).bind("P".repeat(43), planned.id).run(); // even a token forced onto a planned row is not served
    const proposed = await seed({ status: "proposed" });
    await env.DB.prepare(`UPDATE subscriptions SET token = ? WHERE id = ?`).bind("Q".repeat(43), proposed.id).run();
    const live = await seed();
    const dead = ["A".repeat(43), "short", `${live.token}x`, live.token.slice(1), `${live.token.slice(0, 42)}+`, "P".repeat(43), "Q".repeat(43)];
    for (const t of dead) {
      const get = await call(`/public/s/${t}`);
      const post = await call(`/public/s/${t}/checkout`, { method: "POST" });
      expect([get.status, post.status], t).toEqual([404, 404]);
      expect(await get.json(), t).toEqual(NOT_FOUND);
      expect(await post.json(), t).toEqual(NOT_FOUND);
      expect(await page(t), t).toBeNull();
    }
    expect((await getSubscription(env.DB, live.id))!.status).toBe("link_sent");
  });

  it("shows what the client needs and nothing else", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await seed({ keys: ["website_subscription"] });
    const p = await page(s.token, E_TEST, undefined, NOW);
    expect(p).toEqual({ clientName: "Ace Plumbing", planName: "Website Subscription", monthlyCents: 29700, firstChargeOn: "2027-01-02", chargedNow: false, termMonths: 24, state: "ready" });
    expect(api.calls).toHaveLength(0); // no Checkout yet: nothing to ask Stripe
    expect(JSON.stringify(p)).not.toContain(s.token);
  });

  it("answers over HTTP with the same hardening headers as the other client pages", async () => {
    const s = await seed();
    const r = await call(`/public/s/${s.token}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await r.json()).toMatchObject({ planName: "Care", state: "ready" });
  });

  it("states: an active or past-due subscription is active, a cancelled or ended one is closed", async () => {
    const active = await seed({ status: "active" });
    expect((await page(active.token))!.state).toBe("active");
    await markSubscription(env.DB, active.id, { status: "past_due" });
    expect((await page(active.token))!.state).toBe("active");
    await markSubscription(env.DB, active.id, { status: "cancelled" });
    expect((await page(active.token))!.state).toBe("closed");
    await markSubscription(env.DB, active.id, { status: "ended" });
    expect((await page(active.token))!.state).toBe("closed");
  });
});

describe("chargedNow", () => {
  // Noon UTC of the first-charge date against the clock the Checkout call uses: 3 or more days away is a trial, anything sooner (or no date) is charged at Checkout.
  const cases: [string, string | null, Date, boolean][] = [
    ["5 days away", "2026-12-25", new Date("2026-12-20T12:00:00.000Z"), false],
    ["exactly 3 days", "2026-12-23", new Date("2026-12-20T12:00:00.000Z"), false],
    ["2 days", "2026-12-22", new Date("2026-12-20T12:00:00.000Z"), true],
    ["1 day", "2026-12-21", new Date("2026-12-20T12:00:00.000Z"), true],
    ["today", "2026-12-20", new Date("2026-12-20T12:00:00.000Z"), true],
    ["already past", "2026-12-01", new Date("2026-12-20T12:00:00.000Z"), true],
    ["no date", null, new Date("2026-12-20T12:00:00.000Z"), true],
  ];
  for (const [name, firstChargeOn, now, expected] of cases) {
    it(`${name}: the page says chargedNow ${expected}, and the Checkout request agrees about trial_end`, async () => {
      const api = stripeApi(); setStripeFetchForTests(api.f);
      const s = await seed({ keys: ["website_subscription"], firstChargeOn });
      const p = await page(s.token, E_TEST, undefined, now);
      expect(p!.chargedNow).toBe(expected);
      expect(p!.firstChargeOn).toBe(firstChargeOn);
      const r = await startCheckout(E_TEST, s.token, { now });
      expect("url" in r).toBe(true);
      const session = api.calls.find((c) => c.method === "POST" && c.url.includes("/v1/checkout/sessions"))!;
      expect(session.form.has("subscription_data[trial_end]"), name).toBe(!expected);
    });
  }
});

describe("startCheckout", () => {
  it("returns a Stripe https url and stores the session", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await seed();
    const r = await startCheckout(E_TEST, s.token, { now: NOW });
    expect(r).toEqual({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_/) });
    const after = (await getSubscription(env.DB, s.id))!;
    expect(after.stripeCheckoutSessionId).toMatch(/^cs_/);
    expect(after.stripeCustomerId).toMatch(/^cus_/);
    expect(after.status).toBe("link_sent"); // only a completed Checkout activates it
    expect(api.made.customers).toBe(1);
    expect(api.more).toEqual({ products: 1, sessions: 1 });

    const session = api.creates().find((c) => new URL(c.url).pathname === "/v1/checkout/sessions")!;
    expect(session.headers["idempotency-key"]).toBe(`checkout:${s.id}:2026-12-20:2`);
    expect(session.form.get("client_reference_id")).toBe(s.id);
    expect(session.form.get("success_url")).toBe(`${BASE}/s/${s.token}?done=1`);
    expect(session.form.get("cancel_url")).toBe(`${BASE}/s/${s.token}`);
    expect(session.form.get("line_items[0][price_data][unit_amount]")).toBe("12900");
    expect(session.form.get("subscription_data[metadata][subscription_id]")).toBe(s.id);
    const product = api.creates().find((c) => new URL(c.url).pathname === "/v1/products")!;
    expect(product.headers["idempotency-key"]).toBe("product:care");
    expect(product.form.get("name")).toBe("Care");
  });

  it("over HTTP: 200 with the url, 409 for a closed subscription", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await seed();
    const ok = await call(`/public/s/${s.token}/checkout`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) });
    await markSubscription(env.DB, s.id, { status: "cancelled" });
    const closed = await call(`/public/s/${s.token}/checkout`, { method: "POST" });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({ error: "closed" });
  });

  const OPEN = (id: string) => ({ id, status: "open", payment_status: "unpaid", subscription: null, customer: null });
  const DAY = 86_400_000;

  it("a second click, the same day or a later one, returns the same open Checkout and makes no second session", async () => {
    const api = stripeApi({ session: OPEN }); setStripeFetchForTests(api.f);
    const s = await seed();
    const first = await startCheckout(E_TEST, s.token, { now: NOW });
    const firstId = (await getSubscription(env.DB, s.id))!.stripeCheckoutSessionId;
    expect(first).toEqual({ url: `https://checkout.stripe.com/c/pay/${firstId}` });
    expect(await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + 3_600_000) })).toEqual(first);
    // A later UTC day, the first still open: the same url, not a second session that could be paid beside it.
    expect(await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + DAY) })).toEqual(first);
    expect(await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + 3 * DAY) })).toEqual(first);
    expect(api.more.sessions).toBe(1);
    expect((await getSubscription(env.DB, s.id))!.stripeCheckoutSessionId).toBe(firstId);
    expect(api.made.customers).toBe(1);
    expect(api.more.products).toBe(1);
  });

  it("a stored session that Stripe says is complete but unpaid (a bank debit clearing) is closed, never a new Checkout", async () => {
    const api = stripeApi({ session: (id) => ({ id, status: "complete", payment_status: "unpaid", subscription: `sub_${id}`, customer: "cus_1" }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    expect(await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + DAY) })).toEqual({ error: "closed" });
    expect(await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + 5 * DAY) })).toEqual({ error: "closed" });
    expect(api.more.sessions).toBe(1);
    expect((await getSubscription(env.DB, s.id))!.status).toBe("link_sent"); // not active until the money is
  });

  it("an expired stored session is replaced by a new one, whose id is stored", async () => {
    let expired = false;
    const api = stripeApi({ session: (id) => (expired ? { id, status: "expired", payment_status: "unpaid", subscription: null, customer: null, url: null } : OPEN(id)) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    const firstId = (await getSubscription(env.DB, s.id))!.stripeCheckoutSessionId;
    expired = true;
    const next = await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + DAY) });
    const secondId = (await getSubscription(env.DB, s.id))!.stripeCheckoutSessionId;
    expect(secondId).not.toBe(firstId);
    expect(next).toEqual({ url: `https://checkout.stripe.com/c/pay/${secondId}` });
    expect(api.more.sessions).toBe(2);
  });

  it("a stored session Stripe no longer knows (404) is replaced too", async () => {
    let gone = false;
    const api = stripeApi({ session: OPEN, fail: (c) => (gone && c.method === "GET" && c.url.includes("/v1/checkout/sessions/") ? stripeError("No such checkout.session", 404) : null) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    gone = true;
    expect(await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + DAY) })).toEqual({ url: expect.stringContaining("https://checkout.stripe.com/") });
    expect(api.more.sessions).toBe(2);
  });

  it("Stripe unreachable when the stored session is read is unavailable, and no session is made", async () => {
    let down = false;
    const api = stripeApi({ session: OPEN, fail: (c) => (down && c.method === "GET" ? stripeError("down", 500) : null) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    const firstId = (await getSubscription(env.DB, s.id))!.stripeCheckoutSessionId;
    down = true;
    expect(await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + DAY) })).toEqual({ error: "unavailable" });
    expect(api.more.sessions).toBe(1);
    expect((await getSubscription(env.DB, s.id))!.stripeCheckoutSessionId).toBe(firstId);
  });

  it("an active, past-due, cancelled or ended subscription is refused, and Stripe is not asked", async () => {
    const api = stripeApi({ session: OPEN }); setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    const before = api.calls.length;
    for (const status of ["active", "past_due", "cancelled", "ended"] as const) {
      await markSubscription(env.DB, s.id, { status });
      expect(await startCheckout(E_TEST, s.token, { now: NOW }), status).toEqual({ error: "closed" });
    }
    expect(api.calls).toHaveLength(before);
  });

  it("a client who already finished Checkout is not sent to a second one", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f); // its sessions read back complete and paid
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    const again = await startCheckout(E_TEST, s.token, { now: new Date(NOW.getTime() + 86_400_000) });
    expect(again).toEqual({ error: "closed" });
    expect(api.more.sessions).toBe(1);
    expect((await getSubscription(env.DB, s.id))!.status).toBe("active");
  });

  it("is unavailable without a key, for a test row on a live key, off an https base, and when Stripe fails; nothing is stored", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await seed();
    expect(await startCheckout(withEnv({ STRIPE_SECRET_KEY: undefined }), s.token, { now: NOW })).toEqual({ error: "unavailable" });
    expect(await startCheckout(withEnv({ STRIPE_SECRET_KEY: KEY, CLIENT_LINK_BASE: "http://clients.hellositeline.test" }), s.token, { now: NOW })).toEqual({ error: "unavailable" });
    expect(await startCheckout(withEnv({ STRIPE_SECRET_KEY: KEY, CLIENT_LINK_BASE: undefined }), s.token, { now: NOW })).toEqual({ error: "unavailable" });
    expect(api.calls).toHaveLength(0);

    const t = await seed({ test: true });
    expect(await startCheckout(withEnv({ STRIPE_SECRET_KEY: LIVE }), t.token, { now: NOW })).toEqual({ error: "unavailable" });
    expect(api.calls).toHaveLength(0); // a live key never touches a test row
    expect(await startCheckout(E_TEST, t.token, { now: NOW })).toEqual({ url: expect.stringContaining("https://checkout.stripe.com/") });

    const broken = stripeApi({ fail: (c) => (new URL(c.url).pathname === "/v1/checkout/sessions" ? stripeError("Boom sk_test_SECRETKEYVALUE123", 500) : null) });
    setStripeFetchForTests(broken.f);
    const u = await seed();
    expect(await startCheckout(E_TEST, u.token, { now: NOW })).toEqual({ error: "unavailable" });
    expect((await getSubscription(env.DB, u.id))!.stripeCheckoutSessionId).toBeNull();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("SECRETKEYVALUE123");
  });

  it("is unavailable when Stripe's session has no https url", async () => {
    const api = stripeApi({ fail: (c) => (new URL(c.url).pathname === "/v1/checkout/sessions" ? stripeJson({ id: "cs_x", url: "http://evil.test/pay" }) : null) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    expect(await startCheckout(E_TEST, s.token, { now: NOW })).toEqual({ error: "unavailable" });
    expect((await getSubscription(env.DB, s.id))!.stripeCheckoutSessionId).toBeNull();
  });
});

describe("what the page believes", () => {
  it("?done=1 on a subscription that Stripe says is not paid still shows ready", async () => {
    const api = stripeApi({ session: (id) => ({ id, status: "open", payment_status: "unpaid", subscription: null, customer: "cus_1" }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    const r = await call(`/public/s/${s.token}?done=1`);
    expect(r.status).toBe(200);
    expect(ready(await r.json())).toMatchObject({ state: "ready" });
    expect((await getSubscription(env.DB, s.id))!.status).toBe("link_sent");
    // Nor does ?done=1 on a subscription with no Checkout at all.
    const bare = await seed();
    expect(ready(await (await call(`/public/s/${bare.token}?done=1`)).json())).toMatchObject({ state: "ready" });
  });

  it("a session that is complete but not paid does not activate", async () => {
    const api = stripeApi({ session: (id) => ({ id, status: "complete", payment_status: "unpaid", subscription: `sub_${id}`, customer: "cus_1" }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    ready(await page(s.token));
    expect((await getSubscription(env.DB, s.id))!.status).toBe("link_sent");
  });

  it("a complete session found by the page activates the subscription once", async () => {
    const api = stripeApi({ session: (id) => ({ id, status: "complete", payment_status: "no_payment_required", subscription: "sub_PAGE1", customer: "cus_PAGE" }) });
    setStripeFetchForTests(api.f);
    const s = await seed({ keys: ["website_subscription"], firstChargeOn: "2027-02-10" });
    await startCheckout(E_TEST, s.token, { now: NOW });
    const p = await page(s.token);
    expect(p!.state).toBe("active");
    const after = (await getSubscription(env.DB, s.id))!;
    expect(after).toMatchObject({ status: "active", stripeSubscriptionId: "sub_PAGE1", stripeCustomerId: "cus_PAGE", termEndsOn: "2029-02-10" });
    expect(after.activatedAt).not.toBeNull();
    // Looked at again (and by a late webhook): the same, once.
    expect((await page(s.token))!.state).toBe("active");
    expect((await getSubscription(env.DB, s.id))!.activatedAt).toBe(after.activatedAt);
  });

  it("a session that is not the one stored never activates it", async () => {
    const api = stripeApi({ session: () => ({ id: "cs_someone_elses", status: "complete", payment_status: "paid", subscription: "sub_X", customer: "cus_1" }) });
    setStripeFetchForTests(api.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    ready(await page(s.token));
    expect((await getSubscription(env.DB, s.id))!).toMatchObject({ status: "link_sent", stripeSubscriptionId: null });
  });

  it("Stripe being unreachable leaves the page ready, and a live key never reads a test row's session", async () => {
    const down = stripeApi({ fail: (c) => (c.method === "GET" ? stripeError("down", 500) : null) });
    setStripeFetchForTests(down.f);
    const s = await seed();
    await startCheckout(E_TEST, s.token, { now: NOW });
    ready(await page(s.token));

    const api = stripeApi(); setStripeFetchForTests(api.f);
    const t = await seed({ test: true });
    await markSubscription(env.DB, t.id, { stripeCheckoutSessionId: "cs_test_row" });
    ready(await page(t.token, withEnv({ STRIPE_SECRET_KEY: LIVE })));
    expect(api.calls).toHaveLength(0);
    expect((await getSubscription(env.DB, t.id))!.status).toBe("link_sent");
  });

  it("a link_sent subscription with no stored session is not checked with Stripe", async () => {
    const api = stripeApi(); setStripeFetchForTests(api.f);
    const s = await seed();
    ready(await page(s.token));
    expect(api.calls).toHaveLength(0);
  });
});
