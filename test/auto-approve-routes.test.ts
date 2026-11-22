import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeAutoApprove } from "../src/worker/approvals/auto";
import { createApproval } from "../src/worker/db/approvals";
import { listRules, recordAutoApproval } from "../src/worker/db/autoApprove";
import { attachStripeInvoice, getInvoice } from "../src/worker/db/invoices";
import { saveSettings } from "../src/worker/db/settings";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { seedDraft } from "./fixtures/billing";
import { readyToSend } from "./fixtures/documents";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await readyToSend();
  await saveSettings(env.DB, { billing_config: "{}" });
  await env.DB.batch(["auto_approvals", "auto_approve_rules"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

const call = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x${path}`, { method, headers: { ...(auth ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = async () => (await (await call("GET", "/api/auto-approve")).json()) as any;

/** A pending reminder approval (step 1) for a real open invoice, made now. */
async function reminder() {
  const s = await seedDraft();
  await attachStripeInvoice(env.DB, s.invoice.id, { stripeCustomerId: "cus_1", stripeInvoiceId: `in_${crypto.randomUUID().slice(0, 8)}`, hostedUrl: "https://invoice.stripe.com/i/x", dueOn: "2027-01-20", now: "2027-01-13T10:00:00.000Z" });
  const inv = (await getInvoice(env.DB, s.invoice.id))!;
  const approval = await createApproval(env.DB, { kind: "invoice.reminder", title: "Send reminder 1 for Milestone to Ace Plumbing", preview: "x", payload: { invoiceId: inv.id, step: 1 }, record_type: "business", record_id: inv.businessId, drafted_by: "logan" });
  return { ...s, approval };
}

describe("auto-approve routes", () => {
  it("PUT needs a session", async () => {
    expect((await call("GET", "/api/auto-approve", undefined, false)).status).toBe(401);
    expect((await call("PUT", "/api/auto-approve/invoice.reminder", { enabled: true }, false)).status).toBe(401);
    expect(await listRules(env.DB)).toEqual([]);
  });

  it("GET shows both rules off, with plain-sentence Covers and Never covers, today's count and the cap", async () => {
    const s = await get();
    expect(s.rules.map((r: any) => [r.kind, r.enabled, r.enabledAt])).toEqual([["invoice.reminder", false, null], ["onboarding.nudge", false, null]]);
    for (const r of s.rules) {
      expect(r.label).toEqual(expect.any(String));
      expect(r.covers.length).toBeGreaterThan(20);
      expect(r.never).toContain("test");
    }
    expect(s.rules[0].never).toContain("last reminder");
    expect(s.rules[1].never).toContain("Friday");
    expect(s).toMatchObject({ today: 0, cap: 20, recent: [] });
  });

  it("PUT with an unlisted kind is 404 and makes no rule row; a body that is not a boolean is 400", async () => {
    for (const kind of ["invoice.send", "ladder.mail", "nope"]) {
      expect((await call("PUT", `/api/auto-approve/${kind}`, { enabled: true })).status).toBe(404);
    }
    expect(await listRules(env.DB)).toEqual([]);
    expect((await call("PUT", "/api/auto-approve/invoice.reminder", { enabled: "yes" })).status).toBe(400);
    expect((await call("PUT", "/api/auto-approve/invoice.reminder", {})).status).toBe(400);
    expect(await listRules(env.DB)).toEqual([]);
  });

  it("switching on stamps the time, saving it on again keeps the first stamp, and off clears it", async () => {
    const on = await call("PUT", "/api/auto-approve/invoice.reminder", { enabled: true });
    expect(on.status).toBe(200);
    const first = (await on.json() as any).rules[0];
    expect(first.enabled).toBe(true);
    expect(Date.parse(first.enabledAt)).toBeGreaterThan(Date.now() - 60_000);
    await new Promise((r) => setTimeout(r, 5));
    const again = ((await (await call("PUT", "/api/auto-approve/invoice.reminder", { enabled: true })).json()) as any).rules[0];
    expect(again.enabledAt).toBe(first.enabledAt);
    const off = ((await (await call("PUT", "/api/auto-approve/invoice.reminder", { enabled: false })).json()) as any).rules[0];
    expect(off).toMatchObject({ enabled: false, enabledAt: null });
    expect((await get()).rules[1].enabled).toBe(false); // the other rule is untouched
  });

  it("switching off stops the next one at once", async () => {
    await call("PUT", "/api/auto-approve/invoice.reminder", { enabled: true });
    await new Promise((r) => setTimeout(r, 5));
    const one = await reminder();
    expect(await maybeAutoApprove(env as Env, one.approval, new Date("2027-01-17T18:00:00.000Z"))).toBe("approved");
    await call("PUT", "/api/auto-approve/invoice.reminder", { enabled: false });
    const two = await reminder();
    expect(await maybeAutoApprove(env as Env, two.approval, new Date("2027-01-17T18:00:00.000Z"))).toBe("left");
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(two.approval.id).first<{ status: string }>())!.status).toBe("pending");
  });

  it("GET lists the last auto-approvals with client names, newest first, at most 50", async () => {
    const one = await reminder();
    const base = { kind: "invoice.reminder", decidedOn: "2027-01-17", outcome: "sent" as const };
    await recordAutoApproval(env.DB, { ...base, approvalId: one.approval.id, businessId: one.businessId, decidedAt: "2027-01-17T18:00:00.000Z" });
    await recordAutoApproval(env.DB, { ...base, approvalId: "second", businessId: one.businessId, decidedAt: "2027-01-17T19:00:00.000Z", outcome: "failed", error: "smtp is down" });
    for (let i = 0; i < 60; i++) await recordAutoApproval(env.DB, { ...base, approvalId: `old-${i}`, businessId: null, decidedAt: `2027-01-1${i % 2}T0${i % 9}:00:00.000Z` });
    const s = await get();
    expect(s.recent).toHaveLength(50);
    expect(s.recent[0]).toMatchObject({ approvalId: "second", kind: "invoice.reminder", label: "Invoice reminders", businessName: "Ace Plumbing", outcome: "failed", error: "smtp is down" });
    expect(s.recent[1].approvalId).toBe(one.approval.id); // the 62 rows are cut to the newest 50
    const small = await (async () => { await env.DB.prepare(`DELETE FROM auto_approvals WHERE approval_id LIKE 'old-%'`).run(); return get(); })();
    expect(small.recent.map((r: any) => [r.approvalId, r.businessName, r.outcome])).toEqual([["second", "Ace Plumbing", "failed"], [one.approval.id, "Ace Plumbing", "sent"]]);
  });
});
