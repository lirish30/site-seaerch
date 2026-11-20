import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { careLabel, clientMrrCents, getClientRecord, isClient, listClients } from "../src/worker/clients/record";
import { archiveSite, createSite, setAccess } from "../src/worker/db/sites";
import { listSubscriptions } from "../src/worker/db/subscriptions";
import { setProjectStatus } from "../src/worker/db/projects";
import { seedDeal } from "./fixtures/documents";
import { addChangeOrder, addSub, seedClient } from "./fixtures/clients";

const NOW = new Date("2027-02-01T18:00:00.000Z");
const row = async (id: string, includeTest = false) => (await listClients(env.DB, { includeTest })).find((c) => c.id === id);

describe("MRR", () => {
  it("counts active and past_due and not cancelled, ended, planned or test", async () => {
    const s = await seedClient({
      subs: [
        { key: "website_subscription", monthlyCents: 49700, status: "active" },
        { key: "care", monthlyCents: 12900, status: "past_due" },
        { key: "care_plus", monthlyCents: 30000, status: "cancelled" },
        { key: "local_seo", monthlyCents: 75000, status: "ended" },
        { key: "local_seo_growth", monthlyCents: 90000, status: "planned" },
        { key: "reviews_addon", monthlyCents: 11100, status: "active", test: true },
      ],
    });
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.mrrCents).toBe(49700 + 12900);
    expect(clientMrrCents(await listSubscriptions(env.DB, { businessId: s.businessId }))).toBe(62600);
    expect(rec.subscriptions).toHaveLength(6);
    expect((await row(s.businessId))!.mrrCents).toBe(62600);
  });

  it("two sites do not double the client's MRR", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 49700 }] });
    await createSite(env.DB, { businessId: s.businessId, url: "https://second-ace.com" });
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.sites).toHaveLength(2);
    expect(rec.mrrCents).toBe(49700);
    expect((await row(s.businessId))!).toMatchObject({ mrrCents: 49700, siteCount: 2 });
  });

  it("is an integer in cents with no rounding, and 0 for a client with no subscription", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 12950 }, { key: "care", monthlyCents: 1 }] });
    expect((await getClientRecord(env.DB, s.businessId, NOW))!.mrrCents).toBe(12951);
    expect((await getClientRecord(env.DB, (await seedClient()).businessId, NOW))!.mrrCents).toBe(0);
  });
});

describe("Care", () => {
  it("a client with Care and a Website Subscription shows Care $129/mo and both rows", async () => {
    const s = await seedClient({ subs: [{ key: "website_subscription", monthlyCents: 49700 }, { key: "care", monthlyCents: 12900 }] });
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.careLabel).toBe("Care $129/mo");
    expect(rec.subscriptions.map((x) => x.packageKey).sort()).toEqual(["care", "website_subscription"]);
    expect((await row(s.businessId))!.careLabel).toBe("Care $129/mo");
  });

  it("is null without an active Care row, names Care Plus, and shows cents only when there are some", async () => {
    const none = await seedClient({ subs: [{ key: "website_subscription", monthlyCents: 49700 }, { key: "care", monthlyCents: 12900, status: "cancelled" }] });
    expect((await getClientRecord(env.DB, none.businessId, NOW))!.careLabel).toBeNull();
    expect((await row(none.businessId))!.careLabel).toBeNull();
    const plus = await seedClient({ subs: [{ key: "care_plus", monthlyCents: 22950 }] });
    expect((await getClientRecord(env.DB, plus.businessId, NOW))!.careLabel).toBe("Care Plus $229.50/mo");
    expect(careLabel([])).toBeNull();
  });

  it("a client whose only Care row is past_due still shows the Care label and the client-hosted flag", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12900, status: "past_due" }], site: false });
    await createSite(env.DB, { businessId: s.businessId, url: "https://own-host.com", hostingTier: "client_hosted", accessMethod: "unknown" });
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.careLabel).toBe("Care $129/mo");
    expect(rec.sites[0].flags.map((f) => f.code)).toContain("client_hosted_no_access");
    expect((await row(s.businessId))!.careLabel).toBe("Care $129/mo");
  });

  it("two active Care-family rows: the label shows the newest and MRR sums both", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    await addSub(s, { key: "care_plus", monthlyCents: 22900 });
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.careLabel).toBe("Care Plus $229/mo");
    expect(rec.mrrCents).toBe(12900 + 22900);
    expect((await row(s.businessId))!).toMatchObject({ careLabel: "Care Plus $229/mo", mrrCents: 35800 });
  });

  it("a client-hosted site on Care with no access method is flagged; a Logan-hosted one is not", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }], site: false });
    await createSite(env.DB, { businessId: s.businessId, url: "https://own-host.com", hostingTier: "client_hosted", accessMethod: "none" });
    await createSite(env.DB, { businessId: s.businessId, url: "https://my-host.com", hostingTier: "logan_hosted", accessMethod: "none" });
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    const flagged = Object.fromEntries(rec.sites.map((x) => [x.site.domain, x.flags.map((f) => f.code)]));
    expect(flagged["own-host.com"]).toContain("client_hosted_no_access");
    expect(flagged["my-host.com"]).not.toContain("client_hosted_no_access");
  });
});

describe("who is a client", () => {
  it("a won lead with no project is a client; a lead with a project but not won is a client; a plain lead is not", async () => {
    const won = await seedClient({ project: false });
    const proj = await seedClient({ won: false });
    const plain = await seedClient({ won: false, project: false });
    const unknown = "00000000-0000-0000-0000-000000000000";
    expect(await isClient(env.DB, won.businessId)).toBe(true);
    expect(await isClient(env.DB, proj.businessId)).toBe(true);
    expect(await isClient(env.DB, plain.businessId)).toBe(false);
    expect(await getClientRecord(env.DB, won.businessId, NOW)).not.toBeNull();
    expect(await getClientRecord(env.DB, proj.businessId, NOW)).not.toBeNull();
    expect(await getClientRecord(env.DB, plain.businessId, NOW)).toBeNull();
    expect(await getClientRecord(env.DB, unknown, NOW)).toBeNull();
    const ids = (await listClients(env.DB)).map((c) => c.id);
    expect(ids).toContain(won.businessId);
    expect(ids).toContain(proj.businessId);
    expect(ids).not.toContain(plain.businessId);
  });
});

describe("renewal", () => {
  it("nextRenewalOn is the earliest term_ends_on among live subscriptions", async () => {
    const s = await seedClient({
      subs: [
        { key: "website_subscription", monthlyCents: 49700, termEndsOn: "2028-12-20" },
        { key: "care", monthlyCents: 12900, termEndsOn: "2028-03-05" },
        { key: "local_seo", monthlyCents: 75000, termEndsOn: "2027-01-01", status: "cancelled" },
        { key: "reviews_addon", monthlyCents: 5000, termEndsOn: "2027-01-02", test: true },
        { key: "local_seo_growth", monthlyCents: 5000, termEndsOn: null },
      ],
    });
    expect((await getClientRecord(env.DB, s.businessId, NOW))!.nextRenewalOn).toBe("2028-03-05");
    expect((await row(s.businessId))!.nextRenewalOn).toBe("2028-03-05");
    expect((await getClientRecord(env.DB, (await seedClient({ subs: [{ monthlyCents: 100 }] })).businessId, NOW))!.nextRenewalOn).toBeNull();
  });
});

describe("linked records", () => {
  it("a change order on a done project is listed, with no signing token or content body", async () => {
    const s = await seedClient();
    const co = await addChangeOrder(s, s.project!.id);
    await setProjectStatus(env.DB, s.project!.id, "done");
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.changeOrders.map((c) => c.id)).toEqual([co.id]);
    expect(rec.changeOrders[0]).toMatchObject({ reference: "SL-ACE-CO1", title: "Add a gallery", priceCents: 30000, status: "draft" });
    expect(JSON.stringify(rec.changeOrders)).not.toContain("deliverables");
    expect(rec.projects.map((p) => p.id)).toEqual([s.project!.id]);
    expect(rec.documents).toHaveLength(1);
    expect(rec.people.map((p) => p.name)).toEqual(["Pat Jones"]);
  });

  it("sums open, overdue and paid invoices in cents, by date in the booking time zone, and leaves test invoices out", async () => {
    const s = await seedClient({ invoice: { cents: 199850, dueOn: "2027-01-31" } });
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.invoices).toEqual({ openCents: 199850, overdueCount: 1, paidCents: 0 });
    // 2027-02-01T05:00Z is still 31 January in Los Angeles: due on the 31st is not yet overdue there.
    expect((await getClientRecord(env.DB, s.businessId, new Date("2027-02-01T05:00:00.000Z")))!.invoices.overdueCount).toBe(0);
    await env.DB.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind("2027-02-01T10:00:00.000Z", s.invoice!.id).run();
    expect((await getClientRecord(env.DB, s.businessId, NOW))!.invoices).toEqual({ openCents: 0, overdueCount: 0, paidCents: 199850 });
    expect((await row(s.businessId))!.openInvoiceCents).toBe(0);
    const t = await seedClient({ invoice: { cents: 5000 }, test: true });
    expect((await getClientRecord(env.DB, t.businessId, NOW))!.invoices).toEqual({ openCents: 0, overdueCount: 0, paidCents: 0 });
  });

  it("the list carries the open invoice total, the hold and the missing access count", async () => {
    const s = await seedClient({ invoice: { cents: 199850 } });
    expect(await row(s.businessId)).toMatchObject({ openInvoiceCents: 199850, held: false, accessMissing: 6, siteCount: 1, name: "Ace Plumbing" });
    await env.DB.prepare(`INSERT INTO billing_holds (id, business_id, invoice_id, placed_at) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), s.businessId, s.invoice!.id, "2027-02-01T10:00:00.000Z").run();
    expect((await row(s.businessId))!.held).toBe(true);
    expect((await getClientRecord(env.DB, s.businessId, NOW))!.held).toBe(true);
  });
});

describe("test records", () => {
  it("listClients excludes test records unless includeTest", async () => {
    const real = await seedClient({ subs: [{ monthlyCents: 49700 }] });
    const test = await seedClient({ test: true, subs: [{ monthlyCents: 49700 }] });
    const mixed = await seedDeal();
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(mixed.businessId).run();
    await createSite(env.DB, { businessId: mixed.businessId, url: "https://rehearsal.com", test: true });
    await createSite(env.DB, { businessId: mixed.businessId, url: "https://real-mixed.com" });
    const bare = await seedDeal();
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(bare.businessId).run();
    const without = (await listClients(env.DB)).map((c) => c.id);
    expect(without).toContain(real.businessId);
    expect(without).toContain(mixed.businessId);
    expect(without).toContain(bare.businessId);
    expect(without).not.toContain(test.businessId);
    const withTest = await listClients(env.DB, { includeTest: true });
    expect(withTest.map((c) => c.id)).toContain(test.businessId);
    expect(withTest.find((c) => c.id === test.businessId)!.mrrCents).toBe(0);
  });
});

describe("archived sites", () => {
  it("an archived site is not listed in the record or counted in accessMissing", async () => {
    const s = await seedClient();
    const second = (await createSite(env.DB, { businessId: s.businessId, url: "https://old-ace.com" })).site;
    expect((await row(s.businessId))!).toMatchObject({ siteCount: 2, accessMissing: 12 });
    expect(await archiveSite(env.DB, second.id, "2027-02-01T10:00:00.000Z")).toBe(true);
    const rec = (await getClientRecord(env.DB, s.businessId, NOW))!;
    expect(rec.sites.map((x) => x.site.id)).toEqual([s.site!.id]);
    expect(await row(s.businessId)).toMatchObject({ siteCount: 1, accessMissing: 6 });
    for (const key of ["hosting", "dns", "registrar", "admin", "gbp", "analytics"] as const) await setAccess(env.DB, s.site!.id, key, { status: key === "gbp" ? "not_applicable" : "verified" }, "2027-02-01T11:00:00.000Z");
    expect((await row(s.businessId))!.accessMissing).toBe(0);
    expect((await getClientRecord(env.DB, s.businessId, NOW))!.sites[0].flags).toEqual([]);
  });
});

describe("the record never carries a client token", () => {
  it("subscriptions, documents and change orders have no token", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 100 }] });
    await env.DB.prepare(`UPDATE subscriptions SET token = 'tok-secret-123' WHERE business_id = ?`).bind(s.businessId).run();
    await addChangeOrder(s, s.project!.id);
    await addSub(s, { monthlyCents: 5, status: "planned" });
    expect(JSON.stringify(await getClientRecord(env.DB, s.businessId, NOW))).not.toContain("tok-secret-123");
  });
});
