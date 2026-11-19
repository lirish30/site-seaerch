import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { getInvoiceByStripeId } from "../src/worker/db/invoices";
import { hmacHex } from "../src/worker/google/crypto";
import { handleStripeEvent, verifyStripeSignature } from "../src/worker/stripe/webhook";
import type { Env } from "../src/worker/env";
import { SECRET, invoiceEvent, seedInvoice, sign } from "./fixtures/stripe";

const NOW = 1_800_000_000;
const BODY = '{"id":"evt_1","type":"invoice.paid"}';
const hdr = async (body: string, t: number, secret = SECRET) => `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;

describe("verifyStripeSignature", () => {
  it("a valid signature passes", async () => {
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW), SECRET, NOW)).toBe(true);
  });
  it("a wrong secret fails", async () => {
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW, "whsec_other"), SECRET, NOW)).toBe(false);
  });
  it("a tampered body fails", async () => {
    expect(await verifyStripeSignature(BODY.replace("evt_1", "evt_2"), await hdr(BODY, NOW), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(`${BODY} `, await hdr(BODY, NOW), SECRET, NOW)).toBe(false);
  });
  it("a timestamp older than 5 minutes fails", async () => {
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW - 301), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW - 300), SECRET, NOW)).toBe(true);
  });
  it("a timestamp from the future beyond the tolerance fails", async () => {
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW + 301), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW + 300), SECRET, NOW)).toBe(true);
  });
  it("the tolerance can be changed", async () => {
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW - 10), SECRET, NOW, 5)).toBe(false);
  });
  it("a header with two v1 values passes when one matches", async () => {
    const good = (await hdr(BODY, NOW)).split("v1=")[1];
    const bad = "0".repeat(64);
    expect(await verifyStripeSignature(BODY, `t=${NOW},v1=${bad},v1=${good}`, SECRET, NOW)).toBe(true);
    expect(await verifyStripeSignature(BODY, `t=${NOW},v1=${good},v1=${bad}`, SECRET, NOW)).toBe(true);
    expect(await verifyStripeSignature(BODY, `t=${NOW},v1=${bad},v1=${bad}`, SECRET, NOW)).toBe(false);
  });
  it("ignores other schemes, so a v0 value alone fails", async () => {
    const good = (await hdr(BODY, NOW)).split("v1=")[1];
    expect(await verifyStripeSignature(BODY, `t=${NOW},v0=${good}`, SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature(BODY, `t=${NOW},v0=${good},v1=${good}`, SECRET, NOW)).toBe(true);
  });
  it("a missing or malformed header fails", async () => {
    const good = (await hdr(BODY, NOW)).split("v1=")[1];
    for (const h of [null, "", "garbage", `v1=${good}`, `t=${NOW}`, `t=abc,v1=${good}`, `t=,v1=${good}`, `t=${NOW},v1=`, `t=${NOW},v1=zz${good.slice(2)}`, `t=${NOW},v1=${good.slice(2)}`, `t=${NOW}v1=${good}`, `t=-${NOW},v1=${good}`, `t=${NOW}.5,v1=${good}`]) {
      expect(await verifyStripeSignature(BODY, h, SECRET, NOW), String(h)).toBe(false);
    }
  });
  it("a header with two timestamps fails, whichever one the signature is for", async () => {
    const good = (await hdr(BODY, NOW)).split("v1=")[1];
    expect(await verifyStripeSignature(BODY, `t=${NOW},t=${NOW},v1=${good}`, SECRET, NOW)).toBe(false);
  });
  it("an empty secret never verifies", async () => {
    expect(await verifyStripeSignature(BODY, await hdr(BODY, NOW), "", NOW)).toBe(false);
    expect(await verifyStripeSignature(BODY, `t=${NOW},v1=${"0".repeat(64)}`, "", NOW)).toBe(false);
  });
  it("a signature made for another timestamp does not verify under this one", async () => {
    const good = (await hdr(BODY, NOW)).split("v1=")[1];
    expect(await verifyStripeSignature(BODY, `t=${NOW + 1},v1=${good}`, SECRET, NOW)).toBe(false);
  });
});

describe("handleStripeEvent", () => {
  it("invoice.paid with the right amount marks the invoice paid and calls onPaid once", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice), { onPaid })).toBe("applied");
    expect(onPaid).toHaveBeenCalledTimes(1);
    const seen = (onPaid.mock.calls[0] as unknown as [Env, { id: string; status: string; paidAt: string }])[1];
    expect(seen).toMatchObject({ id: invoice.id, status: "paid" });
    expect(seen.paidAt).toMatch(/^\d{4}-/);
    expect(await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId)).toMatchObject({ status: "paid", mismatch: null, paidAt: seen.paidAt });
  });

  it("a replayed event id is a duplicate and calls nothing", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    const evt = invoiceEvent("invoice.paid", invoice);
    expect(await handleStripeEvent(env, evt, { onPaid })).toBe("applied");
    expect(await handleStripeEvent(env, evt, { onPaid })).toBe("duplicate");
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("two deliveries of one event at the same time apply it once", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    const evt = invoiceEvent("invoice.paid", invoice);
    const out = await Promise.all([handleStripeEvent(env, evt, { onPaid }), handleStripeEvent(env, evt, { onPaid })]);
    expect(out.sort()).toEqual(["applied", "duplicate"]);
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("a different amount is a mismatch and does not call onPaid", async () => {
    const { invoice } = await seedInvoice({ amountCents: 199850 });
    const onPaid = vi.fn(async () => {});
    for (const amount_paid of [100, 199849, 199851, 0]) {
      expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice, { object: { amount_paid } }), { onPaid })).toBe("mismatch");
    }
    expect(onPaid).not.toHaveBeenCalled();
    const row = (await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!;
    expect(row.status).toBe("open");
    expect(row.paidAt).toBeNull();
    expect(row.mismatch).toMatch(/amount/);
  });

  it("an amount that is not the number we expect is a mismatch", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    for (const amount_paid of ["199850", null, undefined, 199850.0000001, [199850]]) {
      expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice, { object: { amount_paid } }), { onPaid })).toBe("mismatch");
    }
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("a different currency is a mismatch", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    for (const currency of ["eur", "USD", undefined]) {
      expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice, { object: { currency } }), { onPaid })).toBe("mismatch");
    }
    expect(onPaid).not.toHaveBeenCalled();
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.mismatch).toMatch(/currency/);
  });

  it("metadata for another document is a mismatch", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    for (const metadata of [{ document_id: "some-other-doc" }, {}, undefined, null]) {
      expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice, { object: { metadata } }), { onPaid })).toBe("mismatch");
    }
    expect(onPaid).not.toHaveBeenCalled();
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.mismatch).toMatch(/document/);
  });

  it("the mismatch note is capped and a later correct payment clears it", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice, { object: { amount_paid: 1, currency: "x".repeat(500), metadata: { document_id: "y".repeat(500) } } }), { onPaid });
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.mismatch!.length).toBeLessThanOrEqual(200);
    expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice), { onPaid })).toBe("applied");
    expect(await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId)).toMatchObject({ status: "paid", mismatch: null });
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("an unknown invoice id is ignored", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", { ...invoice, stripeInvoiceId: "in_not_ours" }), { onPaid })).toBe("ignored");
    expect(await handleStripeEvent(env, { id: "evt_noid", type: "invoice.paid", data: { object: {} } }, { onPaid })).toBe("ignored");
    expect(await handleStripeEvent(env, { id: "evt_noobj", type: "invoice.paid", data: {} as any }, { onPaid })).toBe("ignored");
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("an event type we do not handle is ignored and changes nothing", async () => {
    const { invoice } = await seedInvoice();
    expect(await handleStripeEvent(env, invoiceEvent("invoice.finalized", invoice))).toBe("ignored");
    expect(await handleStripeEvent(env, invoiceEvent("customer.created", invoice))).toBe("ignored");
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.status).toBe("open");
  });

  it("invoice.voided marks the row void", async () => {
    const { invoice } = await seedInvoice();
    expect(await handleStripeEvent(env, invoiceEvent("invoice.voided", invoice))).toBe("applied");
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.status).toBe("void");
  });

  it("invoice.marked_uncollectible and invoice.payment_failed mark the row", async () => {
    const a = await seedInvoice(), b = await seedInvoice();
    expect(await handleStripeEvent(env, invoiceEvent("invoice.marked_uncollectible", a.invoice))).toBe("applied");
    expect((await getInvoiceByStripeId(env.DB, a.invoice.stripeInvoiceId))!.status).toBe("uncollectible");
    expect(await handleStripeEvent(env, invoiceEvent("invoice.payment_failed", b.invoice))).toBe("applied");
    expect((await getInvoiceByStripeId(env.DB, b.invoice.stripeInvoiceId))!.status).toBe("failed");
  });

  it("a late event never moves a paid invoice back", async () => {
    const { invoice } = await seedInvoice();
    await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice));
    for (const t of ["invoice.payment_failed", "invoice.voided", "invoice.marked_uncollectible"]) {
      expect(await handleStripeEvent(env, invoiceEvent(t, invoice))).toBe("ignored");
    }
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.status).toBe("paid");
  });

  it("a late payment_failed does not undo a void", async () => {
    const { invoice } = await seedInvoice();
    await handleStripeEvent(env, invoiceEvent("invoice.voided", invoice));
    expect(await handleStripeEvent(env, invoiceEvent("invoice.payment_failed", invoice))).toBe("ignored");
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.status).toBe("void");
  });

  it("a failed invoice can still be paid", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    await handleStripeEvent(env, invoiceEvent("invoice.payment_failed", invoice));
    expect(await handleStripeEvent(env, invoiceEvent("invoice.paid", invoice), { onPaid })).toBe("applied");
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.status).toBe("paid");
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  // ---- a failure writing our own state must not leave the event marked as processed ----

  /** An Env whose database refuses writes to invoices. */
  const brokenWrites = (): Env => ({ ...env, DB: new Proxy(env.DB, { get: (t, k) => k === "prepare"
    ? (sql: string) => { if (/^\s*UPDATE invoices/i.test(sql)) throw new Error("D1 is down"); return t.prepare(sql); }
    : (t as any)[k].bind(t) }) } as Env);

  it("a failed write throws and leaves the event unrecorded, so Stripe's retry applies it", async () => {
    const { invoice } = await seedInvoice();
    const onPaid = vi.fn(async () => {});
    const evt = invoiceEvent("invoice.paid", invoice);
    await expect(handleStripeEvent(brokenWrites(), evt, { onPaid })).rejects.toThrow("D1 is down");
    expect(onPaid).not.toHaveBeenCalled();
    expect((await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!.status).toBe("open");
    // The retry is the same event id; it must not be treated as a duplicate.
    expect(await handleStripeEvent(env, evt, { onPaid })).toBe("applied");
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("a failing onPaid throws and leaves the event unrecorded, and the retry calls onPaid again", async () => {
    const { invoice } = await seedInvoice();
    const evt = invoiceEvent("invoice.paid", invoice);
    const failing = vi.fn(async () => { throw new Error("could not start the build"); });
    await expect(handleStripeEvent(env, evt, { onPaid: failing })).rejects.toThrow("could not start the build");
    const ok = vi.fn(async () => {});
    expect(await handleStripeEvent(env, evt, { onPaid: ok })).toBe("applied");
    expect(ok).toHaveBeenCalledTimes(1);
    const row = (await getInvoiceByStripeId(env.DB, invoice.stripeInvoiceId))!;
    expect(row.status).toBe("paid");
    // A retry keeps the first paid time.
    expect(row.paidAt).not.toBeNull();
  });
});

describe("POST /hooks/stripe", () => {
  const post = (body: string, headers: Record<string, string> = {}, over: Partial<Env> = {}) =>
    worker.fetch(new Request("https://x/hooks/stripe", { method: "POST", body, headers }), { ...env, ...over } as Env, createExecutionContext());
  const withSecret = { STRIPE_WEBHOOK_SECRET: SECRET };
  let invoiceId = "", documentId = "";
  beforeAll(async () => { const s = await seedInvoice({ amountCents: 4200 }); invoiceId = s.invoice.stripeInvoiceId; documentId = s.documentId; });
  const paidBody = (id = `evt_route_${crypto.randomUUID()}`) => JSON.stringify({ id, type: "invoice.paid", data: { object: { id: invoiceId, amount_paid: 4200, currency: "usd", metadata: { document_id: documentId } } } });

  it("no secret configured is a 503", async () => {
    const body = paidBody();
    const res = await post(body, { "stripe-signature": await sign(body) });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("");
  });

  it("bad signature is a 400 with an empty body", async () => {
    const body = paidBody();
    for (const sig of [await sign(body, { secret: "whsec_other" }), await sign(body, { t: Math.floor(Date.now() / 1000) - 600 }), "garbage"]) {
      const res = await post(body, { "stripe-signature": sig }, withSecret);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    }
    const none = await post(body, {}, withSecret);
    expect(none.status).toBe(400);
    expect(await none.text()).toBe("");
    expect((await getInvoiceByStripeId(env.DB, invoiceId))!.status).toBe("open");
  });

  it("the route works without a session cookie", async () => {
    // Unsigned and unconfigured it is refused for its own reasons (503), not by the sign-in check (401).
    const res = await worker.fetch(new Request("https://x/hooks/stripe", { method: "POST", body: "{}" }), env, createExecutionContext());
    expect(res.status).toBe(503);
    const body = paidBody();
    const ok = await post(body, { "stripe-signature": await sign(body) }, withSecret);
    expect(ok.status).toBe(200);
  });

  it("a signed paid event applies, and the same event again is still a 200", async () => {
    const s = await seedInvoice({ amountCents: 777 });
    const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: "invoice.paid", data: { object: { id: s.invoice.stripeInvoiceId, amount_paid: 777, currency: "usd", metadata: { document_id: s.documentId } } } });
    const headers = { "stripe-signature": await sign(body) };
    const first = await post(body, headers, withSecret);
    expect(first.status).toBe(200);
    expect((await getInvoiceByStripeId(env.DB, s.invoice.stripeInvoiceId))!.status).toBe("paid");
    expect((await post(body, headers, withSecret)).status).toBe(200);
  });

  it("a mismatch, an unknown invoice and an unhandled type are all 200 so Stripe stops retrying", async () => {
    const s = await seedInvoice({ amountCents: 900 });
    const send = async (type: string, object: object) => {
      const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, data: { object } });
      return post(body, { "stripe-signature": await sign(body) }, withSecret);
    };
    expect((await send("invoice.paid", { id: s.invoice.stripeInvoiceId, amount_paid: 1, currency: "usd", metadata: { document_id: s.documentId } })).status).toBe(200);
    expect((await send("invoice.paid", { id: "in_unknown" })).status).toBe(200);
    expect((await send("charge.refunded", { id: "ch_1" })).status).toBe(200);
    expect((await getInvoiceByStripeId(env.DB, s.invoice.stripeInvoiceId))!.status).toBe("open");
  });

  it("a signed body that is not an event is a 400", async () => {
    for (const body of ["not json", "[]", "null", '{"type":"invoice.paid"}', '{"id":"evt_x"}', '{"id":1,"type":"x"}']) {
      const res = await post(body, { "stripe-signature": await sign(body) }, withSecret);
      expect(res.status, body).toBe(400);
      expect(await res.text()).toBe("");
    }
  });

  it("a failure writing our own state is a 500, and the retry succeeds", async () => {
    const s = await seedInvoice({ amountCents: 321 });
    const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: "invoice.paid", data: { object: { id: s.invoice.stripeInvoiceId, amount_paid: 321, currency: "usd", metadata: { document_id: s.documentId } } } });
    const headers = { "stripe-signature": await sign(body) };
    const broken = new Proxy(env.DB, { get: (t, k) => k === "prepare"
      ? (sql: string) => { if (/^\s*UPDATE invoices/i.test(sql)) throw new Error("D1 is down"); return t.prepare(sql); }
      : (t as any)[k].bind(t) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(body, headers, { ...withSecret, DB: broken });
    expect(res.status).toBe(500);
    // The log line names the event and the error, never the signed body or a secret.
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/whsec_|SECRET|pat@|amount_paid/);
    log.mockRestore();
    expect(await res.text()).toBe("");
    expect((await getInvoiceByStripeId(env.DB, s.invoice.stripeInvoiceId))!.status).toBe("open");
    expect((await post(body, headers, withSecret)).status).toBe(200);
    expect((await getInvoiceByStripeId(env.DB, s.invoice.stripeInvoiceId))!.status).toBe("paid");
  });

  it("a body over 1 MB is refused before it is read in full", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const res = await post(big, { "stripe-signature": await sign(big) }, withSecret);
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("");
    const edge = "x".repeat(1024 * 1024);
    expect((await post(edge, { "stripe-signature": await sign(edge) }, withSecret)).status).toBe(400); // under the cap: reaches the parser, which refuses it
  });

  it("only POST is answered", async () => {
    const res = await worker.fetch(new Request("https://x/hooks/stripe", { method: "GET" }), { ...env, ...withSecret } as Env, createExecutionContext());
    expect([404, 405]).toContain(res.status);
  });
});

describe("GET /api/documents/config", () => {
  const get = async (over: Partial<Env> = {}, auth = true) => {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), env, createExecutionContext());
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    return worker.fetch(new Request("https://x/api/documents/config", { headers: auth ? { cookie } : {} }), { ...env, ...over } as Env, createExecutionContext());
  };

  it("needs a session", async () => {
    expect((await get({}, false)).status).toBe(401);
  });

  it("shows the mode, whether the webhook secret is set and the client base, and never a secret", async () => {
    expect(await (await get()).json()).toEqual({ stripeMode: null, webhookConfigured: false, clientBase: "https://clients.hellositeline.test" });
    const res = await get({ STRIPE_SECRET_KEY: "sk_test_SECRETKEYVALUE123", STRIPE_WEBHOOK_SECRET: "whsec_SECRETVALUE" });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ stripeMode: "test", webhookConfigured: true, clientBase: "https://clients.hellositeline.test" });
    expect(text).not.toMatch(/SECRET/);
    expect((await (await get({ STRIPE_SECRET_KEY: "sk_live_abc" })).json<any>()).stripeMode).toBe("live");
    expect((await (await get({ STRIPE_SECRET_KEY: "pk_live_notasecret" })).json<any>()).stripeMode).toBeNull();
  });
});
