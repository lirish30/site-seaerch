import { describe, expect, it } from "vitest";
import {
  StripeError, cancelSubscriptionAtPeriodEnd, changeSubscriptionPrice, createCustomer, createDepositInvoice, createInvoice, createSubscriptionCheckout, encodeForm,
  ensureProduct, retrieveCheckoutSession, retrieveInvoice, retrieveSubscription, stripeMode, voidInvoice,
} from "../src/worker/stripe/client";
import { KEY, fakeStripe, stripeApi } from "./fixtures/stripe";

const INVOICE_OPTS = { customerId: "cus_9", amountCents: 199850, description: "Deposit for Acme", documentId: "doc_1", dealId: "deal_1", businessId: "biz_1" };

/** Answers the three calls of the deposit flow. */
const happy = (c: { url: string }) =>
  c.url.endsWith("/v1/invoices") ? Response.json({ id: "in_1", status: "draft" })
  : c.url.endsWith("/v1/invoiceitems") ? Response.json({ id: "ii_1" })
  : Response.json({ id: "in_1", status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/acct/in_1" });

describe("stripeMode", () => {
  it("reads the key prefix", () => {
    expect(stripeMode("sk_test_abc")).toBe("test");
    expect(stripeMode("rk_test_abc")).toBe("test");
    expect(stripeMode("sk_live_abc")).toBe("live");
    expect(stripeMode("rk_live_abc")).toBe("live");
    expect(stripeMode("pk_live_abc")).toBeNull();
    expect(stripeMode("whsec_abc")).toBeNull();
    expect(stripeMode("")).toBeNull();
    expect(stripeMode(undefined)).toBeNull();
  });
});

describe("encodeForm", () => {
  it("nests metadata and arrays", () => {
    const out = encodeForm({ customer: "cus_1", metadata: { document_id: "d1", kind: "deposit" }, payment_settings: { payment_method_types: ["card", "us_bank_account"] }, days_until_due: 7, auto_advance: false });
    expect(out.split("&")).toEqual([
      "customer=cus_1", "metadata[document_id]=d1", "metadata[kind]=deposit",
      "payment_settings[payment_method_types][0]=card", "payment_settings[payment_method_types][1]=us_bank_account",
      "days_until_due=7", "auto_advance=false",
    ]);
  });

  it("skips undefined and escapes values and keys", () => {
    expect(encodeForm({ a: undefined, b: "x y&z=1", metadata: { "k&": "v" } })).toBe("b=x%20y%26z%3D1&metadata[k%26]=v");
    expect(encodeForm({})).toBe("");
    expect(encodeForm({ metadata: {} })).toBe("");
  });
});

describe("createDepositInvoice", () => {
  it("calls invoices, then invoiceitems with the invoice id, then finalize", async () => {
    const { f, calls } = fakeStripe(happy);
    await createDepositInvoice(f, KEY, INVOICE_OPTS, "base");
    expect(calls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/invoices", "https://api.stripe.com/v1/invoiceitems", "https://api.stripe.com/v1/invoices/in_1/finalize"]);
    expect(calls.every((c) => c.method === "POST")).toBe(true);
    expect(calls.every((c) => c.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(calls.every((c) => c.headers["content-type"] === "application/x-www-form-urlencoded")).toBe(true);
    const [inv, item] = calls;
    expect(inv.form.get("customer")).toBe("cus_9");
    expect(inv.form.get("collection_method")).toBe("send_invoice");
    expect(inv.form.get("days_until_due")).toBe("7");
    expect(inv.form.get("auto_advance")).toBe("false");
    expect(inv.form.get("pending_invoice_items_behavior")).toBe("exclude");
    expect(inv.form.get("metadata[document_id]")).toBe("doc_1");
    expect(inv.form.get("metadata[deal_id]")).toBe("deal_1");
    expect(inv.form.get("metadata[business_id]")).toBe("biz_1");
    expect(inv.form.get("metadata[kind]")).toBe("deposit");
    expect(item.form.get("invoice")).toBe("in_1");
    expect(item.form.get("customer")).toBe("cus_9");
    expect(item.form.get("amount")).toBe("199850");
    expect(item.form.get("currency")).toBe("usd");
    expect(item.form.get("description")).toBe("Deposit for Acme");
  });

  it("each call carries a distinct idempotency key derived from the base key", async () => {
    const { f, calls } = fakeStripe(happy);
    await createDepositInvoice(f, KEY, INVOICE_OPTS, "dep-doc_1");
    const keys = calls.map((c) => c.headers["idempotency-key"]);
    expect(keys.every((k) => k.startsWith("dep-doc_1:"))).toBe(true);
    expect(new Set(keys).size).toBe(3);
    // The same base key gives the same three keys again, so a retry replays rather than duplicates.
    const again = fakeStripe(happy);
    await createDepositInvoice(again.f, KEY, INVOICE_OPTS, "dep-doc_1");
    expect(again.calls.map((c) => c.headers["idempotency-key"])).toEqual(keys);
  });

  it("the invoice asks for card and us_bank_account", async () => {
    const { f, calls } = fakeStripe(happy);
    await createDepositInvoice(f, KEY, INVOICE_OPTS, "k");
    expect(calls[0].form.get("payment_settings[payment_method_types][0]")).toBe("card");
    expect(calls[0].form.get("payment_settings[payment_method_types][1]")).toBe("us_bank_account");
  });

  it("returns the hosted url", async () => {
    const { f } = fakeStripe(happy);
    expect(await createDepositInvoice(f, KEY, INVOICE_OPTS, "k")).toEqual({ invoiceId: "in_1", hostedUrl: "https://invoice.stripe.com/i/acct/in_1", status: "open" });
  });

  it("refuses a finalize response with no https hosted url", async () => {
    for (const hosted of [undefined, null, "http://invoice.stripe.com/x", "javascript:alert(1)"]) {
      const { f } = fakeStripe((c) => c.url.endsWith("/finalize") ? Response.json({ id: "in_1", status: "open", hosted_invoice_url: hosted }) : happy(c));
      await expect(createDepositInvoice(f, KEY, INVOICE_OPTS, "k")).rejects.toBeInstanceOf(StripeError);
    }
  });

  it("stops at the first failing call and never sends the later ones", async () => {
    const { f, calls } = fakeStripe((c) => c.url.endsWith("/v1/invoiceitems") ? Response.json({ error: { message: "no" } }, { status: 400 }) : happy(c));
    await expect(createDepositInvoice(f, KEY, INVOICE_OPTS, "k")).rejects.toBeInstanceOf(StripeError);
    expect(calls).toHaveLength(2);
  });

  it("refuses an amount that is not whole positive cents before calling Stripe", async () => {
    for (const amountCents of [0, -5, 10.5, NaN, Infinity]) {
      const { f, calls } = fakeStripe(happy);
      await expect(createDepositInvoice(f, KEY, { ...INVOICE_OPTS, amountCents }, "k")).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  it("a Stripe error message is capped and never contains the key", async () => {
    const long = `${"x".repeat(400)}`;
    const { f } = fakeStripe(() => Response.json({ error: { message: long, type: "invalid_request_error" } }, { status: 400 }));
    const e = await createCustomer(f, KEY, { name: "A", email: "a@b.test", businessId: "b" }, "k").catch((x) => x);
    expect(e).toBeInstanceOf(StripeError);
    expect(e.message.length).toBeLessThanOrEqual(200);

    const leaky = fakeStripe(() => Response.json({ error: { message: `Invalid API Key provided: ${KEY}` } }, { status: 401 }));
    const e2 = await createCustomer(leaky.f, KEY, { name: "A", email: "a@b.test", businessId: "b" }, "k").catch((x) => x);
    expect(e2.message).not.toContain(KEY);
    expect(e2.message).not.toContain("SECRETKEYVALUE");
    expect(JSON.stringify(e2)).not.toContain("SECRETKEYVALUE");
  });

  it("an error with no readable body, or a network failure, is still a StripeError without the key", async () => {
    const html = fakeStripe(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const a = await retrieveInvoice(html.f, KEY, "in_1").catch((x) => x);
    expect(a).toBeInstanceOf(StripeError);
    expect(a.message).toMatch(/502/);
    const down = async () => { throw new TypeError(`fetch failed for Bearer ${KEY}`); };
    const b = await retrieveInvoice(down, KEY, "in_1").catch((x) => x);
    expect(b).toBeInstanceOf(StripeError);
    expect(b.message).not.toContain("SECRETKEYVALUE");
  });

  it("refuses a value that is not a Stripe secret key", async () => {
    const { f, calls } = fakeStripe(happy);
    await expect(createCustomer(f, "whsec_nope", { name: "A", email: "a@b.test", businessId: "b" }, "k")).rejects.toBeInstanceOf(StripeError);
    await expect(createCustomer(f, "", { name: "A", email: "a@b.test", businessId: "b" }, "k")).rejects.toBeInstanceOf(StripeError);
    expect(calls).toHaveLength(0);
  });
});

describe("createCustomer and retrieveInvoice", () => {
  it("creates a customer with the business id in metadata", async () => {
    const { f, calls } = fakeStripe(() => Response.json({ id: "cus_new" }));
    expect(await createCustomer(f, KEY, { name: "Acme Co", email: "pat@acme.test", businessId: "biz_1" }, "cust-biz_1")).toEqual({ id: "cus_new" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/customers");
    expect(calls[0].headers["idempotency-key"]).toBe("cust-biz_1");
    expect(Object.fromEntries(calls[0].form)).toEqual({ name: "Acme Co", email: "pat@acme.test", "metadata[business_id]": "biz_1" });
  });

  it("retrieves an invoice with a GET and no body", async () => {
    const { f, calls } = fakeStripe(() => Response.json({ id: "in_1", status: "paid", amount_due: 100, amount_paid: 100, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/x" }));
    expect(await retrieveInvoice(f, KEY, "in_1")).toEqual({ id: "in_1", status: "paid", amountDue: 100, amountPaid: 100, currency: "usd", hostedUrl: "https://invoice.stripe.com/i/x" });
    expect(calls[0]).toMatchObject({ url: "https://api.stripe.com/v1/invoices/in_1", method: "GET", body: "" });
    expect(calls[0].headers["idempotency-key"]).toBeUndefined();
  });

  it("an invoice id cannot add path segments or a query", async () => {
    const { f, calls } = fakeStripe(() => Response.json({ id: "x", status: "open", amount_due: 1, amount_paid: 0, currency: "usd", hosted_invoice_url: null }));
    await retrieveInvoice(f, KEY, "in_1/../customers?x=1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/invoices/in_1%2F..%2Fcustomers%3Fx%3D1");
  });
});

const LINES = [{ description: "Milestone 1", amountCents: 120000 }, { description: "Hosting setup", amountCents: 4500 }];
const INV = { customerId: "cus_9", lines: LINES, daysUntilDue: 14, ref: "milestone:m1", kind: "milestone" as const, businessId: "biz_1", documentId: "doc_1" };

describe("createInvoice", () => {
  it("sends one invoice item per line and finalizes, with ref and kind in metadata", async () => {
    const api = stripeApi();
    const r = await createInvoice(api.f, KEY, { ...INV, footer: "Thank you" }, "inv-1");
    const [inv, item0, item1, fin] = api.calls;
    expect(api.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/invoices", "/v1/invoiceitems", "/v1/invoiceitems", `/v1/invoices/${r.invoiceId}/finalize`]);
    expect(inv.form.get("collection_method")).toBe("send_invoice");
    expect(inv.form.get("auto_advance")).toBe("false");
    expect(inv.form.get("pending_invoice_items_behavior")).toBe("exclude");
    expect(inv.form.get("days_until_due")).toBe("14");
    expect(inv.form.get("footer")).toBe("Thank you");
    expect(inv.form.get("payment_settings[payment_method_types][0]")).toBe("card");
    expect(inv.form.get("payment_settings[payment_method_types][1]")).toBe("us_bank_account");
    expect(inv.form.get("metadata[ref]")).toBe("milestone:m1");
    expect(inv.form.get("metadata[kind]")).toBe("milestone");
    expect(inv.form.get("metadata[business_id]")).toBe("biz_1");
    expect(inv.form.get("metadata[document_id]")).toBe("doc_1");
    expect([item0, item1].map((c) => [c.form.get("invoice"), c.form.get("amount"), c.form.get("description")])).toEqual([[r.invoiceId, "120000", "Milestone 1"], [r.invoiceId, "4500", "Hosting setup"]]);
    expect(fin.form.get("auto_advance")).toBe("false");
    expect(r.hostedUrl).toBe(`https://invoice.stripe.com/i/${r.invoiceId}`);
    expect(r.status).toBe("open");
  });

  it("leaves out the footer and document_id when there are none", async () => {
    const api = stripeApi();
    await createInvoice(api.f, KEY, { ...INV, documentId: undefined }, "inv-2");
    expect(api.calls[0].form.has("footer")).toBe(false);
    expect(api.calls[0].form.has("metadata[document_id]")).toBe(false);
  });

  it("returns dueOn from Stripe's due_date as a calendar date", async () => {
    // 2026-03-05T23:30:00Z is still the 5th in UTC (and the 5th in Los Angeles, where it is 15:30); 2026-03-06T00:30:00Z is the 6th in UTC.
    for (const [due, dueOn] of [[Date.UTC(2026, 2, 5, 23, 30) / 1000, "2026-03-05"], [Date.UTC(2026, 2, 6, 0, 30) / 1000, "2026-03-06"]] as const) {
      const { f } = fakeStripe((c) => c.url.endsWith("/finalize") ? Response.json({ id: "in_1", status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/x", due_date: due }) : happy(c));
      expect((await createInvoice(f, KEY, INV, "k")).dueOn).toBe(dueOn);
    }
    const none = fakeStripe((c) => c.url.endsWith("/finalize") ? Response.json({ id: "in_1", status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/x", due_date: null }) : happy(c));
    expect((await createInvoice(none.f, KEY, INV, "k")).dueOn).toBeNull();
  });

  it("refuses a zero or fractional amount before calling Stripe", async () => {
    for (const amountCents of [0, -1, 10.5, NaN, Infinity]) {
      const { f, calls } = fakeStripe(happy);
      await expect(createInvoice(f, KEY, { ...INV, lines: [LINES[0], { description: "bad", amountCents }] }, "k")).rejects.toBeInstanceOf(RangeError);
      expect(calls).toHaveLength(0);
    }
    const { f, calls } = fakeStripe(happy);
    await expect(createInvoice(f, KEY, { ...INV, lines: [] }, "k")).rejects.toBeInstanceOf(RangeError);
    await expect(createInvoice(f, KEY, { ...INV, daysUntilDue: 0 }, "k")).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("a repeat with the same base key makes nothing new", async () => {
    const api = stripeApi();
    const a = await createInvoice(api.f, KEY, INV, "inv-3");
    const b = await createInvoice(api.f, KEY, INV, "inv-3");
    expect(b).toEqual(a);
    expect(api.made).toMatchObject({ invoices: 1, items: 2 });
  });
});

describe("createDepositInvoice", () => {
  it("still sends the same calls as before", async () => {
    const api = stripeApi();
    const r = await createDepositInvoice(api.f, KEY, INVOICE_OPTS, "dep-doc_1");
    expect(Object.keys(r).sort()).toEqual(["hostedUrl", "invoiceId", "status"]);
    expect(api.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/invoices", "/v1/invoiceitems", `/v1/invoices/${r.invoiceId}/finalize`]);
    expect(api.calls[0].form.get("days_until_due")).toBe("7");
    expect(api.calls[0].form.get("metadata[document_id]")).toBe("doc_1");
    expect(api.calls[0].form.get("metadata[kind]")).toBe("deposit");
    expect(api.calls[0].form.get("metadata[deal_id]")).toBe("deal_1");
    expect(api.calls[0].form.get("metadata[ref]")).toBe("deposit:doc_1");
    expect(api.calls[1].form.get("amount")).toBe("199850");
  });
});

describe("subscriptions", () => {
  const NOW = Date.UTC(2026, 2, 1, 18, 0);
  const CO = { customerId: "cus_9", productId: "prod_1", name: "Care Plus", monthlyCents: 29900, firstChargeOn: null, subscriptionId: "sub_row_1", businessId: "biz_1", successUrl: "https://c.test/ok", cancelUrl: "https://c.test/no", nowMs: NOW };

  it("ensureProduct names the product and keeps the package key in metadata", async () => {
    const api = stripeApi();
    const p = await ensureProduct(api.f, KEY, { packageKey: "care_plus", name: "Care Plus" }, "prod-care_plus");
    expect(p.id).toMatch(/^prod_/);
    expect(Object.fromEntries(api.calls[0].form)).toEqual({ name: "Care Plus", "metadata[package_key]": "care_plus" });
    expect(api.calls[0].headers["idempotency-key"]).toBe("prod-care_plus");
    expect(await ensureProduct(api.f, KEY, { packageKey: "care_plus", name: "Care Plus" }, "prod-care_plus")).toEqual(p);
    expect(api.more.products).toBe(1);
  });

  it("createSubscriptionCheckout sends a monthly price on the product, in subscription mode", async () => {
    const api = stripeApi();
    const r = await createSubscriptionCheckout(api.f, KEY, CO, "sub-1");
    const form = api.calls[0].form;
    expect(r.url).toBe(`https://checkout.stripe.com/c/pay/${r.sessionId}`);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("customer")).toBe("cus_9");
    expect(form.get("client_reference_id")).toBe("sub_row_1");
    expect(form.get("subscription_data[metadata][subscription_id]")).toBe("sub_row_1");
    expect(form.get("subscription_data[metadata][business_id]")).toBe("biz_1");
    expect(form.get("payment_method_types[0]")).toBe("card");
    expect(form.get("payment_method_types[1]")).toBe("us_bank_account");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("line_items[0][price_data][product]")).toBe("prod_1");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("29900");
    expect(form.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(form.get("success_url")).toBe("https://c.test/ok");
    expect(form.get("cancel_url")).toBe("https://c.test/no");
    expect(form.has("subscription_data[trial_end]")).toBe(false);
  });

  it("createSubscriptionCheckout sets a trial_end at noon UTC only when the first charge is 3 or more days away", async () => {
    const trial = async (firstChargeOn: string | null, nowMs = NOW) => {
      const api = stripeApi();
      await createSubscriptionCheckout(api.f, KEY, { ...CO, firstChargeOn, nowMs }, "k");
      return api.calls[0].form.get("subscription_data[trial_end]");
    };
    expect(await trial("2026-03-10")).toBe(String(Date.UTC(2026, 2, 10, 12) / 1000));
    expect(await trial("2026-03-05")).toBe(String(Date.UTC(2026, 2, 5, 12) / 1000)); // noon on the 5th is 3.75 days after 18:00 on the 1st
    expect(await trial("2026-03-04")).toBeNull(); // 2.75 days
    expect(await trial("2026-03-04", Date.UTC(2026, 2, 1, 12))).toBe(String(Date.UTC(2026, 2, 4, 12) / 1000)); // exactly 3 days
    expect(await trial("2026-03-01")).toBeNull();
    expect(await trial("2026-02-20")).toBeNull(); // already past
    expect(await trial(null)).toBeNull();
  });

  it("createSubscriptionCheckout refuses a non-https url", async () => {
    for (const url of [undefined, null, "http://checkout.stripe.com/x", "javascript:alert(1)"]) {
      const { f } = fakeStripe(() => Response.json({ id: "cs_1", url }));
      await expect(createSubscriptionCheckout(f, KEY, CO, "k")).rejects.toBeInstanceOf(StripeError);
    }
  });

  it("createSubscriptionCheckout refuses a bad amount or date before calling Stripe", async () => {
    const { f, calls } = fakeStripe(() => Response.json({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
    for (const bad of [{ monthlyCents: 0 }, { monthlyCents: 99.5 }, { firstChargeOn: "next week" }, { firstChargeOn: "2026-02-31" }]) {
      await expect(createSubscriptionCheckout(f, KEY, { ...CO, ...bad }, "k")).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toHaveLength(0);
  });

  it("retrieveCheckoutSession reads status and the ids, whether Stripe sends them bare or expanded", async () => {
    const api = stripeApi({ session: (id) => ({ id, status: "complete", payment_status: "paid", subscription: { id: "sub_9", object: "subscription" }, customer: "cus_9" }) });
    expect(await retrieveCheckoutSession(api.f, KEY, "cs_1")).toEqual({ id: "cs_1", status: "complete", paymentStatus: "paid", subscriptionId: "sub_9", customerId: "cus_9" });
    expect(api.calls[0]).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/checkout/sessions/cs_1" });
    const open = stripeApi({ session: (id) => ({ id, status: "open", payment_status: "unpaid", subscription: null, customer: null }) });
    expect(await retrieveCheckoutSession(open.f, KEY, "cs_2")).toEqual({ id: "cs_2", status: "open", paymentStatus: "unpaid", subscriptionId: null, customerId: null });
  });

  it("retrieveSubscription reads the period end from the subscription or from its item", async () => {
    const a = stripeApi({ subscription: (id) => ({ id, status: "active", cancel_at_period_end: true, current_period_end: 1800000000 }) });
    expect(await retrieveSubscription(a.f, KEY, "sub_1")).toEqual({ id: "sub_1", status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: 1800000000 });
    const b = stripeApi({ subscription: (id) => ({ id, status: "trialing", current_period_end: undefined, items: { data: [{ id: "si_1", current_period_end: 1810000000 }] } }) });
    expect(await retrieveSubscription(b.f, KEY, "sub_2")).toEqual({ id: "sub_2", status: "trialing", cancelAtPeriodEnd: false, currentPeriodEnd: 1810000000 });
    const c = stripeApi({ subscription: (id) => ({ id, status: "incomplete", current_period_end: undefined, items: { data: [] } }) });
    expect((await retrieveSubscription(c.f, KEY, "sub_3")).currentPeriodEnd).toBeNull();
  });

  it("changeSubscriptionPrice sends proration_behavior none and the product id", async () => {
    const api = stripeApi();
    await changeSubscriptionPrice(api.f, KEY, { subscriptionId: "sub_1", productId: "prod_1", name: "Care Plus", monthlyCents: 34900 }, "chg-1");
    expect(api.calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([["GET", "/v1/subscriptions/sub_1"], ["POST", "/v1/subscriptions/sub_1"]]);
    const form = api.calls[1].form;
    expect(form.get("proration_behavior")).toBe("none");
    expect(form.get("items[0][id]")).toBe("si_sub_1");
    expect(form.get("items[0][price_data][product]")).toBe("prod_1");
    expect(form.get("items[0][price_data][unit_amount]")).toBe("34900");
    expect(form.get("items[0][price_data][currency]")).toBe("usd");
    expect(form.get("items[0][price_data][recurring][interval]")).toBe("month");
    expect(api.calls[1].headers["idempotency-key"]).toBe("chg-1");
  });

  it("changeSubscriptionPrice stops, with nothing posted, when the subscription has no item", async () => {
    const api = stripeApi({ subscription: (id) => ({ id, items: { data: [] } }) });
    await expect(changeSubscriptionPrice(api.f, KEY, { subscriptionId: "sub_1", productId: "p", name: "n", monthlyCents: 100 }, "k")).rejects.toBeInstanceOf(StripeError);
    expect(api.creates()).toHaveLength(0);
  });

  it("voidInvoice and cancelSubscriptionAtPeriodEnd send the right form", async () => {
    const api = stripeApi();
    await voidInvoice(api.f, KEY, "in_1");
    await cancelSubscriptionAtPeriodEnd(api.f, KEY, "sub_1", "cancel-sub_1");
    expect(api.calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([["POST", "/v1/invoices/in_1/void", ""], ["POST", "/v1/subscriptions/sub_1", "cancel_at_period_end=true"]]);
    const after = await retrieveSubscription(api.f, KEY, "sub_1");
    expect(after.cancelAtPeriodEnd).toBe(true);
  });

  it("every POST carries an Idempotency-Key and no error message contains the key", async () => {
    const api = stripeApi();
    await createCustomer(api.f, KEY, { name: "A", email: "a@b.test", businessId: "b" }, "c");
    await createInvoice(api.f, KEY, INV, "i");
    await voidInvoice(api.f, KEY, "in_1");
    await ensureProduct(api.f, KEY, { packageKey: "p", name: "P" }, "p");
    await createSubscriptionCheckout(api.f, KEY, CO, "s");
    await changeSubscriptionPrice(api.f, KEY, { subscriptionId: "sub_1", productId: "prod_1", name: "n", monthlyCents: 100 }, "chg");
    await cancelSubscriptionAtPeriodEnd(api.f, KEY, "sub_1", "can");
    const posts = api.creates();
    expect(posts.length).toBeGreaterThan(8);
    for (const c of posts) expect(c.headers["idempotency-key"], c.url).toBeTruthy();
    expect(api.calls.filter((c) => c.method === "GET").every((c) => c.headers["idempotency-key"] === undefined)).toBe(true);

    const leaky = fakeStripe(() => Response.json({ error: { message: `Invalid API Key provided: ${KEY}` } }, { status: 401 }));
    const calls: Promise<unknown>[] = [
      createInvoice(leaky.f, KEY, INV, "k"), voidInvoice(leaky.f, KEY, "in_1"), ensureProduct(leaky.f, KEY, { packageKey: "p", name: "P" }, "k"),
      createSubscriptionCheckout(leaky.f, KEY, CO, "k"), retrieveCheckoutSession(leaky.f, KEY, "cs_1"), retrieveSubscription(leaky.f, KEY, "sub_1"),
      changeSubscriptionPrice(leaky.f, KEY, { subscriptionId: "sub_1", productId: "p", name: "n", monthlyCents: 100 }, "k"), cancelSubscriptionAtPeriodEnd(leaky.f, KEY, "sub_1", "k"),
    ];
    for (const e of (await Promise.all(calls.map((p) => p.catch((x) => x)))) as Error[]) {
      expect(e).toBeInstanceOf(StripeError);
      expect(e.message).not.toContain("SECRETKEYVALUE");
    }
  });
});
