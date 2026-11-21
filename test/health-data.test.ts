import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getClientRecord } from "../src/worker/clients/record";
import { computeHealth } from "../src/worker/clients/health";
import { healthFor, healthInputs } from "../src/worker/clients/healthData";
import { createOnboarding, markWelcomeSent } from "../src/worker/db/onboardings";
import { insertCheck, openIncident, setDomainExpiry } from "../src/worker/db/monitoring";
import { ACCESS_KEYS, archiveSite, createSite, setAccess } from "../src/worker/db/sites";
import { dueDatesFor } from "../src/worker/onboarding/schedule";
import { itemsFor } from "../src/worker/onboarding/templates";
import { seedClient } from "./fixtures/clients";

const NOW = new Date("2027-02-01T18:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

// Storage is shared by the tests of a file: the monitoring tables start empty each time.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM site_checks`), env.DB.prepare(`DELETE FROM site_incidents`)]);
});

const check = (siteId: string, ago: number, ok: boolean) => insertCheck(env.DB, { siteId, checkedAt: daysAgo(ago), ok, status: ok ? 200 : 503, ms: 100, error: ok ? null : "HTTP 503" });
const inputsOf = async (id: string) => (await healthInputs(env.DB, [id], NOW)).get(id)!;
const resolveAccess = async (siteId: string) => { for (const k of ACCESS_KEYS) await setAccess(env.DB, siteId, k, { status: "received" }, NOW.toISOString()); };

describe("healthInputs", () => {
  it("a client with nothing gives no checks, no uptime and a score of 100", async () => {
    const s = await seedClient({ site: false });
    const i = await inputsOf(s.businessId);
    expect(i).toEqual({ openDown: false, updateFailed: false, certExpiring: false, domainDaysLeft: null, uptime30: null, checks30: 0, overdueInvoices: 0, held: false, pastDueSubscription: false, accessUnresolved: 0, waitingOnClient: false });
    expect(computeHealth(i)).toEqual({ score: 100, band: "good", reasons: [], hasData: false });
  });

  it("returns one entry for every id asked for, including an unknown one and more than one chunk", async () => {
    const s = await seedClient();
    const ids = [s.businessId, "no-such-business", ...Array.from({ length: 120 }, (_, n) => `ghost-${n}`)];
    const m = await healthInputs(env.DB, ids, NOW);
    expect([...m.keys()].sort()).toEqual([...ids].sort());
    expect(m.get("ghost-7")).toMatchObject({ checks30: 0, uptime30: null, accessUnresolved: 0 });
    expect(m.get(s.businessId)!.accessUnresolved).toBe(6);
    expect((await healthInputs(env.DB, [], NOW)).size).toBe(0);
  });

  it("3 ok and 1 failed check in the window is 75% over 4 checks", async () => {
    const s = await seedClient();
    await check(s.site!.id, 1, true); await check(s.site!.id, 2, true); await check(s.site!.id, 3, true); await check(s.site!.id, 4, false);
    expect(await inputsOf(s.businessId)).toMatchObject({ uptime30: 75, checks30: 4 });
  });

  it("a check older than 30 days is ignored, and one exactly 30 days old counts", async () => {
    const s = await seedClient();
    await check(s.site!.id, 31, false); await check(s.site!.id, 60, false); await check(s.site!.id, 5, true);
    expect(await inputsOf(s.businessId)).toMatchObject({ uptime30: 100, checks30: 1 });
    await check(s.site!.id, 30, false);
    expect(await inputsOf(s.businessId)).toMatchObject({ uptime30: 50, checks30: 2 });
  });

  it("two sites of one client pool their checks", async () => {
    const s = await seedClient();
    const { site: second } = await createSite(env.DB, { businessId: s.businessId, url: "https://ace-two.com" });
    await check(s.site!.id, 1, true); await check(s.site!.id, 2, true); await check(second.id, 1, true); await check(second.id, 2, false);
    expect(await inputsOf(s.businessId)).toMatchObject({ uptime30: 75, checks30: 4 });
  });

  it("test sites, archived sites and test clients never count", async () => {
    const s = await seedClient();
    const { site: archived } = await createSite(env.DB, { businessId: s.businessId, url: "https://old-ace.com" });
    await check(archived.id, 1, false);
    await archiveSite(env.DB, archived.id, NOW.toISOString());
    const { site: testSite } = await createSite(env.DB, { businessId: s.businessId, url: "https://ace-test.com", test: true });
    await check(testSite.id, 1, false);
    await check(s.site!.id, 1, true);
    expect(await inputsOf(s.businessId)).toMatchObject({ uptime30: 100, checks30: 1 });

    const t = await seedClient({ test: true });
    await check(t.site!.id, 1, false);
    expect(await inputsOf(t.businessId)).toMatchObject({ uptime30: null, checks30: 0, accessUnresolved: 0, domainDaysLeft: null, openDown: false });
  });

  it("an open down incident sets openDown and a closed one does not", async () => {
    const s = await seedClient();
    expect((await inputsOf(s.businessId)).openDown).toBe(false);
    const { incident } = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "HTTP 503", now: daysAgo(0) });
    expect((await inputsOf(s.businessId)).openDown).toBe(true);
    await env.DB.prepare(`UPDATE site_incidents SET closed_at = ? WHERE id = ?`).bind(daysAgo(0), incident.id).run();
    expect((await inputsOf(s.businessId)).openDown).toBe(false);
    // a domain incident is not a down incident
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "domain_expiring", detail: "domain expires in 5 days", now: daysAgo(0) });
    expect((await inputsOf(s.businessId)).openDown).toBe(false);
  });

  it("an open update_failed sets updateFailed and an open cert_expiring sets certExpiring, each costing 15; closed ones do not", async () => {
    const s = await seedClient();
    await resolveAccess(s.site!.id);
    expect(await inputsOf(s.businessId)).toMatchObject({ updateFailed: false, certExpiring: false });
    const u = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now: daysAgo(0) });
    expect(await inputsOf(s.businessId)).toMatchObject({ updateFailed: true, certExpiring: false, openDown: false });
    expect(computeHealth(await inputsOf(s.businessId)).score).toBe(85);
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "cert_expiring", detail: "certificate expires in 5 days", now: daysAgo(0) });
    expect(computeHealth(await inputsOf(s.businessId)).score).toBe(70);
    await env.DB.prepare(`UPDATE site_incidents SET closed_at = ?`).bind(daysAgo(0)).run();
    expect(await inputsOf(s.businessId)).toMatchObject({ updateFailed: false, certExpiring: false });
    expect(u.created).toBe(true);
  });

  it("a site whose address was cleared counts for nothing monitoring-related: no open down, no checks, no domain date; its access items still count", async () => {
    const s = await seedClient();
    await check(s.site!.id, 1, false);
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "HTTP 503", now: daysAgo(0) });
    await env.DB.prepare(`UPDATE sites SET domain_expires_on = '2027-02-05' WHERE id = ?`).bind(s.site!.id).run();
    expect(await inputsOf(s.businessId)).toMatchObject({ openDown: true, checks30: 1, domainDaysLeft: 4 });
    for (const cleared of [null, ""]) {
      await env.DB.prepare(`UPDATE sites SET url = ? WHERE id = ?`).bind(cleared, s.site!.id).run();
      expect(await inputsOf(s.businessId)).toMatchObject({ openDown: false, uptime30: null, checks30: 0, domainDaysLeft: null, accessUnresolved: 6 });
    }
  });

  it("domainDaysLeft is the soonest among live real sites, counted in the booking time zone; past is negative", async () => {
    const s = await seedClient();
    const { site: second } = await createSite(env.DB, { businessId: s.businessId, url: "https://ace-two.com" });
    const { site: archived } = await createSite(env.DB, { businessId: s.businessId, url: "https://old-ace.com" });
    await setDomainExpiry(env.DB, s.site!.id, "2027-03-15", NOW.toISOString());
    await setDomainExpiry(env.DB, second.id, "2027-02-12", NOW.toISOString());
    await setDomainExpiry(env.DB, archived.id, "2027-02-02", NOW.toISOString());
    await archiveSite(env.DB, archived.id, NOW.toISOString());
    expect((await inputsOf(s.businessId)).domainDaysLeft).toBe(11);
    await setDomainExpiry(env.DB, second.id, "2027-01-29", NOW.toISOString());
    expect((await inputsOf(s.businessId)).domainDaysLeft).toBe(-3);
    // 2027-02-01T18:00Z is still 1 Feb in Los Angeles, so a domain expiring on the 1st has 0 days left
    await setDomainExpiry(env.DB, second.id, "2027-02-01", NOW.toISOString());
    expect((await inputsOf(s.businessId)).domainDaysLeft).toBe(0);
  });

  it("a client with an overdue invoice has overdueInvoices equal to the record's overdueCount, for the same now", async () => {
    const s = await seedClient({ invoice: { cents: 199850, dueOn: "2027-01-31" } });
    expect((await inputsOf(s.businessId)).overdueInvoices).toBe(1);
    expect((await inputsOf(s.businessId)).overdueInvoices).toBe((await getClientRecord(env.DB, s.businessId, NOW))!.invoices.overdueCount);
    // 2027-02-01T05:00Z is still 31 January in Los Angeles: due on the 31st is not yet overdue there
    const early = new Date("2027-02-01T05:00:00.000Z");
    expect((await healthInputs(env.DB, [s.businessId], early)).get(s.businessId)!.overdueInvoices).toBe(0);
    expect((await getClientRecord(env.DB, s.businessId, early))!.invoices.overdueCount).toBe(0);
    // a paid invoice is not overdue
    await env.DB.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind(NOW.toISOString(), s.invoice!.id).run();
    expect((await inputsOf(s.businessId)).overdueInvoices).toBe(0);
  });

  it("a failed invoice past due counts, a test invoice and an invoice with no due date do not", async () => {
    const a = await seedClient({ invoice: { cents: 5000, dueOn: "2027-01-10" } });
    await env.DB.prepare(`UPDATE invoices SET status = 'failed' WHERE id = ?`).bind(a.invoice!.id).run();
    expect((await inputsOf(a.businessId)).overdueInvoices).toBe(1);
    const b = await seedClient({ invoice: { cents: 5000 } });
    await env.DB.prepare(`UPDATE invoices SET due_on = NULL WHERE id = ?`).bind(b.invoice!.id).run();
    expect((await inputsOf(b.businessId)).overdueInvoices).toBe(0);
    expect((await getClientRecord(env.DB, b.businessId, NOW))!.invoices.overdueCount).toBe(0);
    const c = await seedClient({ invoice: { cents: 5000, dueOn: "2027-01-10" }, test: true });
    expect((await inputsOf(c.businessId)).overdueInvoices).toBe(0);
    expect((await inputsOf(c.businessId)).overdueInvoices).toBe((await getClientRecord(env.DB, c.businessId, NOW))!.invoices.overdueCount);
  });

  it("a held client has held: true, as the record says; a lifted hold does not", async () => {
    const s = await seedClient({ invoice: { cents: 199850 } });
    expect((await inputsOf(s.businessId)).held).toBe(false);
    const holdId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO billing_holds (id, business_id, invoice_id, placed_at) VALUES (?, ?, ?, ?)`).bind(holdId, s.businessId, s.invoice!.id, daysAgo(2)).run();
    expect((await inputsOf(s.businessId)).held).toBe(true);
    expect((await getClientRecord(env.DB, s.businessId, NOW))!.held).toBe(true);
    await env.DB.prepare(`UPDATE billing_holds SET lifted_at = ?, lifted_by = 'manual' WHERE id = ?`).bind(NOW.toISOString(), holdId).run();
    expect((await inputsOf(s.businessId)).held).toBe(false);
    expect((await getClientRecord(env.DB, s.businessId, NOW))!.held).toBe(false);
  });

  it("a past-due live subscription sets pastDueSubscription; an active, cancelled or test one does not", async () => {
    const care = await seedClient({ subs: [{ key: "care", monthlyCents: 12900, status: "past_due" }] });
    expect((await inputsOf(care.businessId)).pastDueSubscription).toBe(true);
    const site = await seedClient({ subs: [{ key: "website_subscription", monthlyCents: 49700, status: "past_due" }] });
    expect((await inputsOf(site.businessId)).pastDueSubscription).toBe(true);
    const fine = await seedClient({ subs: [{ key: "care", monthlyCents: 12900, status: "active" }, { key: "care_plus", monthlyCents: 30000, status: "cancelled" }] });
    expect((await inputsOf(fine.businessId)).pastDueSubscription).toBe(false);
    const test = await seedClient({ subs: [{ key: "care", monthlyCents: 12900, status: "past_due", test: true }] });
    expect((await inputsOf(test.businessId)).pastDueSubscription).toBe(false);
  });

  it("accessUnresolved counts the unresolved items over live real sites", async () => {
    const s = await seedClient();
    expect((await inputsOf(s.businessId)).accessUnresolved).toBe(6);
    await setAccess(env.DB, s.site!.id, "hosting", { status: "received" }, NOW.toISOString());
    await setAccess(env.DB, s.site!.id, "dns", { status: "not_applicable" }, NOW.toISOString());
    await setAccess(env.DB, s.site!.id, "admin", { status: "requested" }, NOW.toISOString());
    expect((await inputsOf(s.businessId)).accessUnresolved).toBe(4);
    const { site: second } = await createSite(env.DB, { businessId: s.businessId, url: "https://ace-two.com" });
    expect((await inputsOf(s.businessId)).accessUnresolved).toBe(10);
    await archiveSite(env.DB, second.id, NOW.toISOString());
    expect((await inputsOf(s.businessId)).accessUnresolved).toBe(4);
    await resolveAccess(s.site!.id);
    expect((await inputsOf(s.businessId)).accessUnresolved).toBe(0);
  });

  it("waitingOnClient is the Today test: an open real onboarding whose welcome went out and the client has been silent 14 days", async () => {
    const s = await seedClient();
    const { onboarding } = await createOnboarding(env.DB, {
      businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "build", test: false, items: itemsFor(["starter_site", "care"]),
    });
    expect((await inputsOf(s.businessId)).waitingOnClient).toBe(false); // welcome not sent yet
    const sentAt = new Date(NOW.getTime() - 10 * DAY);
    await markWelcomeSent(env.DB, onboarding.id, { sentAt: sentAt.toISOString(), ...dueDatesFor(sentAt) });
    expect((await inputsOf(s.businessId)).waitingOnClient).toBe(false); // 10 days of silence
    const long = new Date(NOW.getTime() - 15 * DAY);
    await env.DB.prepare(`UPDATE onboardings SET last_client_activity_at = ?, welcome_sent_at = ? WHERE id = ?`).bind(long.toISOString(), long.toISOString(), onboarding.id).run();
    expect((await inputsOf(s.businessId)).waitingOnClient).toBe(true);
    await env.DB.prepare(`UPDATE onboardings SET closed_at = ? WHERE id = ?`).bind(NOW.toISOString(), onboarding.id).run();
    expect((await inputsOf(s.businessId)).waitingOnClient).toBe(false); // closed
    await env.DB.prepare(`UPDATE onboardings SET closed_at = NULL, test = 1 WHERE id = ?`).bind(onboarding.id).run();
    expect((await inputsOf(s.businessId)).waitingOnClient).toBe(false); // a rehearsal never counts
  });
});

describe("healthFor", () => {
  it("scores one client from its inputs", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12900, status: "past_due" }] });
    await resolveAccess(s.site!.id);
    expect(await healthFor(env.DB, s.businessId, NOW)).toEqual({ score: 85, band: "good", reasons: ["A subscription payment failed"], hasData: false });
  });

  it("an unknown business is a clean 100 with no data, never NaN", async () => {
    const h = await healthFor(env.DB, "nobody", NOW);
    expect(h).toEqual({ score: 100, band: "good", reasons: [], hasData: false });
  });
});
