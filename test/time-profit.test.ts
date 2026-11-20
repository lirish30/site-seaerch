import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { estimateVsActual, projectProfit } from "../src/worker/time/profit";
import { DEFAULT_WORK_CONFIG, parseWorkConfig, WorkConfigSchema } from "../src/worker/time/config";
import { getSettings } from "../src/worker/db/settings";
import { insertDraftInvoice, insertInvoice, markInvoice, paidTotalForDeal } from "../src/worker/db/invoices";
import { createDraft } from "../src/worker/db/documents";
import { proposal, seedDeal, sendDraft } from "./fixtures/documents";
import { openInvoice, seedSignedProject } from "./fixtures/billing";

describe("projectProfit", () => {
  it("projectProfit with a zero cost rate has zero cost", () => {
    expect(projectProfit({ soldCents: 200000, paidCents: 100000, minutes: 600, costRateCentsPerHour: 0 })).toEqual({
      costCents: 0, marginSoldCents: 200000, marginPaidCents: 100000, effectiveHourlyCents: 10000,
    });
  });

  it("projectProfit with zero minutes has no effective rate", () => {
    expect(projectProfit({ soldCents: 200000, paidCents: 100000, minutes: 0, costRateCentsPerHour: 5000 })).toMatchObject({ costCents: 0, effectiveHourlyCents: null });
  });

  it("cost is minutes times the rate per hour, rounded to a cent, and margins subtract it", () => {
    // 100 minutes at $45.55 an hour: 100 * 4555 / 60 = 7591.67 cents
    const p = projectProfit({ soldCents: 50000, paidCents: 20000, minutes: 100, costRateCentsPerHour: 4555 });
    expect(p.costCents).toBe(7592);
    expect(p.marginSoldCents).toBe(50000 - 7592);
    expect(p.marginPaidCents).toBe(20000 - 7592);
    expect(projectProfit({ soldCents: 0, paidCents: 0, minutes: 90, costRateCentsPerHour: 10000 }).marginSoldCents).toBe(-15000);
  });

  it("effective hourly is paid cents per hour rounded to a cent", () => {
    // 100000 cents over 7 hours = 14285.71 cents an hour
    expect(projectProfit({ soldCents: 0, paidCents: 100000, minutes: 420, costRateCentsPerHour: 0 }).effectiveHourlyCents).toBe(14286);
    expect(projectProfit({ soldCents: 0, paidCents: 100000, minutes: 90, costRateCentsPerHour: 0 }).effectiveHourlyCents).toBe(66667);
  });
});

describe("estimateVsActual", () => {
  it("estimateVsActual states", () => {
    expect(estimateVsActual(0, 40)).toEqual({ deltaMinutes: 40, state: "none" });
    expect(estimateVsActual(60, 45)).toEqual({ deltaMinutes: -15, state: "under" });
    expect(estimateVsActual(60, 60)).toEqual({ deltaMinutes: 0, state: "under" });
    expect(estimateVsActual(100, 110)).toEqual({ deltaMinutes: 10, state: "near" });
    expect(estimateVsActual(100, 101)).toMatchObject({ state: "near" });
    expect(estimateVsActual(100, 111)).toEqual({ deltaMinutes: 11, state: "over" });
    expect(estimateVsActual(30, 120)).toMatchObject({ state: "over" });
  });
});

describe("work config", () => {
  it("defaults are a zero cost rate, Monday and a 12-hour cap", () => {
    expect(DEFAULT_WORK_CONFIG).toEqual({ costRateCentsPerHour: 0, weekStartsOn: 1, timerCapMinutes: 720 });
    expect(parseWorkConfig("")).toEqual(DEFAULT_WORK_CONFIG);
    expect(parseWorkConfig("{}")).toEqual(DEFAULT_WORK_CONFIG);
    expect(parseWorkConfig(JSON.stringify({ costRateCentsPerHour: 3500 }))).toEqual({ ...DEFAULT_WORK_CONFIG, costRateCentsPerHour: 3500 });
  });

  it("parseWorkConfig hands back its own copy, so changing the result never changes the defaults", () => {
    for (const raw of ["", "{}", "not json", JSON.stringify({ timerCapMinutes: 59 })]) {
      const c = parseWorkConfig(raw);
      expect(c).not.toBe(DEFAULT_WORK_CONFIG);
      c.timerCapMinutes = 1;
      c.costRateCentsPerHour = 999;
      expect(DEFAULT_WORK_CONFIG).toEqual({ costRateCentsPerHour: 0, weekStartsOn: 1, timerCapMinutes: 720 });
      expect(parseWorkConfig(raw)).toEqual(DEFAULT_WORK_CONFIG);
    }
  });

  it("parseWorkConfig falls back on invalid JSON and out-of-range values", () => {
    expect(parseWorkConfig("not json")).toEqual(DEFAULT_WORK_CONFIG);
    expect(parseWorkConfig("[1]")).toEqual(DEFAULT_WORK_CONFIG);
    expect(parseWorkConfig(JSON.stringify({ costRateCentsPerHour: 50001 }))).toEqual(DEFAULT_WORK_CONFIG);
    expect(parseWorkConfig(JSON.stringify({ timerCapMinutes: 59 }))).toEqual(DEFAULT_WORK_CONFIG);
    expect(parseWorkConfig(JSON.stringify({ timerCapMinutes: 1441 }))).toEqual(DEFAULT_WORK_CONFIG);
    expect(parseWorkConfig(JSON.stringify({ weekStartsOn: 2 }))).toEqual(DEFAULT_WORK_CONFIG);
    expect(WorkConfigSchema.safeParse({ ...DEFAULT_WORK_CONFIG, costRateCentsPerHour: 1.5 }).success).toBe(false);
    expect(WorkConfigSchema.safeParse({ ...DEFAULT_WORK_CONFIG, costRateCentsPerHour: 50000, timerCapMinutes: 1440, weekStartsOn: 0 }).success).toBe(true);
  });
});

describe("PUT /api/settings work_config", () => {
  let cookie = "";
  const put = (body: unknown) => SELF.fetch("https://x/api/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });

  it("stores a valid document, filling the defaults, and an empty one resets", async () => {
    expect((await getSettings(env.DB)).work_config).toBe("{}");
    expect((await put({ work_config: JSON.stringify({ costRateCentsPerHour: 4000, weekStartsOn: 0 }) })).status).toBe(200);
    expect(parseWorkConfig((await getSettings(env.DB)).work_config)).toEqual({ costRateCentsPerHour: 4000, weekStartsOn: 0, timerCapMinutes: 720 });
    expect((await put({ work_config: "" })).status).toBe(200);
    expect((await getSettings(env.DB)).work_config).toBe("{}");
  });

  it("refuses a bad value with a 400 and keeps what was saved", async () => {
    await put({ work_config: JSON.stringify({ costRateCentsPerHour: 2500 }) });
    const before = (await getSettings(env.DB)).work_config;
    for (const bad of ["not json", "[]", JSON.stringify({ timerCapMinutes: 30 }), JSON.stringify({ costRateCentsPerHour: 60000 }), JSON.stringify({ weekStartsOn: 3 })]) {
      const r = await put({ work_config: bad });
      expect(r.status).toBe(400);
      expect(await r.json<any>()).toMatchObject({ fields: ["work_config"] });
    }
    expect((await getSettings(env.DB)).work_config).toBe(before);
    await put({ work_config: "{}" });
  });
});

describe("paidTotalForDeal", () => {
  it("paidTotalForDeal sums paid invoices only", async () => {
    const s = await seedDeal();
    expect(await paidTotalForDeal(env.DB, s.dealId)).toBe(0);
    const invoice = async (amountCents: number, status: "paid" | "open" | "void") => {
      // A deal holds one live proposal; voiding the earlier one lets this test give the deal several invoices.
      const draft = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
      const { doc } = await sendDraft(draft.id, proposal());
      await env.DB.prepare(`UPDATE documents SET status = 'void' WHERE id = ?`).bind(doc.id).run();
      const inv = await insertInvoice(env.DB, {
        businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "deposit", stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID()}`, amountCents, hostedUrl: "https://pay.test/x",
      });
      if (status !== "open") await markInvoice(env.DB, inv.id, { status, paidAt: status === "paid" ? "2026-12-04T10:00:00.000Z" : null });
    };
    await invoice(199850, "paid");
    await invoice(100001, "paid");
    await invoice(50000, "open");
    await invoice(70000, "void");
    expect(await paidTotalForDeal(env.DB, s.dealId)).toBe(299851);
    const other = await seedDeal();
    expect(await paidTotalForDeal(env.DB, other.dealId)).toBe(0);
  });
});

describe("project profit: what was paid", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });

  it("profit paid counts the document's deposit and milestone invoices and not a change-order invoice", async () => {
    const s = await seedSignedProject({ option: "c" });
    const make = async (kind: "milestone" | "change_order" | "hourly" | "subscription", cents: number, paid: boolean) => {
      const { invoice } = await insertDraftInvoice(env.DB, {
        businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, projectId: s.project.id, changeOrderId: null, subscriptionId: null,
        kind, ref: `${kind}:${crypto.randomUUID()}`, test: false, description: kind, lines: [{ description: kind, amountCents: cents }],
      });
      const open = await openInvoice(invoice);
      if (paid) await markInvoice(env.DB, open.id, { status: "paid", paidAt: "2027-01-10T10:00:00.000Z" });
    };
    const deposit = await insertInvoice(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "deposit", stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID()}`, amountCents: 199850, hostedUrl: "https://pay.test/x",
    });
    await markInvoice(env.DB, deposit.id, { status: "paid", paidAt: "2026-12-04T10:00:00.000Z" });
    await make("milestone", 100001, true);
    await make("milestone", 77700, false); // sent but unpaid
    await make("change_order", 25000, true); // the change order's own price is counted through the order, never here
    await make("hourly", 31300, true);
    await make("subscription", 29900, true);
    const r = await SELF.fetch(`https://x/api/projects/${s.project.id}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect((await r.json<any>()).profit.paidCents).toBe(199850 + 100001);
  });
});
