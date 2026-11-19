import { describe, expect, it } from "vitest";
import { StripeError, createCustomer, createDepositInvoice, encodeForm, retrieveInvoice, stripeMode } from "../src/worker/stripe/client";
import { KEY, fakeStripe } from "./fixtures/stripe";

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
