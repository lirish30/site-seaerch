import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { closeIncident, openIncident, setCertExpiry, setDomainExpiry } from "../src/worker/db/monitoring";
import { createSingleBatch, insertPageChecks, insertRun, setRunStatus } from "../src/worker/db/careUpdates";
import { archiveSite, createSite } from "../src/worker/db/sites";
import { addSuppression } from "../src/worker/db/suppression";
import { buildToday, TODAY_KINDS } from "../src/worker/today";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

/** Thursday 10 December 2026, noon UTC. */
const NOW = new Date("2026-12-10T12:00:00.000Z");
const MIN = 60_000, DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

// buildToday reads every lead, so each test starts from an empty set (incidents and sites go first: they point at businesses).
beforeEach(async () => {
  for (const t of ["care_page_checks", "care_runs", "care_batches", "site_incidents", "site_checks"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

const rows = async (businessId?: string) =>
  (await buildToday(env.DB, NOW)).filter((i) => i.kind === "site_incident" && (businessId === undefined || i.businessId === businessId));
const down = (s: { id: string; businessId: string }, openedMsAgo: number) =>
  openIncident(env.DB, { siteId: s.id, businessId: s.businessId, kind: "down", detail: "HTTP 503", now: ago(openedMsAgo) });
const domain = async (s: { id: string; businessId: string }, expiresOn: string, detail = "domain expires in 99 days") => {
  await setDomainExpiry(env.DB, s.id, expiresOn, ago(0));
  await openIncident(env.DB, { siteId: s.id, businessId: s.businessId, kind: "domain_expiring", detail, now: ago(DAY) });
};

describe("site_incident from Care updates", () => {
  const failed = (s: { id: string; businessId: string }, openedMsAgo: number) =>
    openIncident(env.DB, { siteId: s.id, businessId: s.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now: ago(openedMsAgo) });
  const cert = async (s: { id: string; businessId: string }, expiresOn: string) => {
    await setCertExpiry(env.DB, s.id, expiresOn, ago(0));
    await openIncident(env.DB, { siteId: s.id, businessId: s.businessId, kind: "cert_expiring", detail: "certificate expires in 99 days", now: ago(DAY) });
  };
  const run = async (s: { id: string }, status: string, finishedMsAgo = 0) => {
    const batch = await createSingleBatch(env.DB, s.id, "2026-W50", ago(finishedMsAgo + MIN));
    const r = await insertRun(env.DB, { batchId: batch.id, siteId: s.id, wave: 0, status: "queued", now: ago(finishedMsAgo + MIN) });
    await setRunStatus(env.DB, r.id, ["queued"], status as "changed", { summary: "x" }, ago(finishedMsAgo));
    return r;
  };

  it("an update_failed after a rolled back run is 85 and says so, above a domain warning", async () => {
    const s = await seedClient();
    await run(s.site!, "rolled_back");
    await failed(s.site!, MIN);
    await domain(s.site!, "2026-12-20");
    expect(await rows()).toEqual([expect.objectContaining({ kind: "site_incident", reason: "updates broke ace.com: rolled back", priority: 85 })]);
  });

  it("an update_failed without a rollback says the updates need a look", async () => {
    const s = await seedClient();
    await run(s.site!, "failed");
    await failed(s.site!, MIN);
    expect(await rows()).toEqual([expect.objectContaining({ reason: "updates need a look on ace.com", priority: 85 })]);
  });

  it("a down site (90) still outranks a failed update (85)", async () => {
    const s = await seedClient();
    await failed(s.site!, MIN);
    await down(s.site!, 5 * MIN);
    expect((await rows())[0]).toMatchObject({ priority: 90 });
  });

  it("a certificate expiring is 66, counted from its own date, and loses to a failed update", async () => {
    const s = await seedClient();
    await cert(s.site!, "2026-12-17");
    expect(await rows()).toEqual([expect.objectContaining({ reason: "ace.com's certificate expires in 7 days", priority: 66 })]);
    await failed(s.site!, MIN);
    expect((await rows())[0]).toMatchObject({ priority: 85 });
  });

  it("a page waiting on a look for more than 24 hours is 70; a fresh one gives no row", async () => {
    const s = await seedClient();
    const r = await run(s.site!, "changed", 2 * 3_600_000);
    await insertPageChecks(env.DB, r.id, [{ path: "/contact", beforeKey: null, afterKey: null, diffKey: null, statusBefore: 200, statusAfter: 200, formsBefore: 1, formsAfter: 1, ssim: 0.9, verdict: "changed", review: "pending" }]);
    expect(await rows()).toEqual([]);
    await env.DB.prepare(`UPDATE care_runs SET finished_at = ? WHERE id = ?`).bind(ago(25 * 3_600_000), r.id).run();
    expect(await rows()).toEqual([expect.objectContaining({ reason: "a page changed after updates and is waiting for a look", priority: 70 })]);
    await env.DB.prepare(`UPDATE care_page_checks SET review = 'logan_ok'`).run();
    expect(await rows()).toEqual([]);
  });
});

describe("site_incident", () => {
  it("is a Today kind", () => {
    expect(TODAY_KINDS).toContain("site_incident");
  });

  it("an open down incident of 47 minutes gives one row with the exact reason and priority 90", async () => {
    const s = await seedClient();
    await down(s.site!, 47 * MIN);
    expect(await rows()).toEqual([{
      id: `site_incident:${s.businessId}`, kind: "site_incident", businessId: s.businessId, businessName: expect.any(String), reason: "ace.com has been down for 47 minutes", due: null, priority: 90,
    }]);
  });

  it("names a site with no domain as 'A site', never by its address", async () => {
    const s = await seedClient();
    await env.DB.prepare(`UPDATE sites SET domain = NULL, url = 'https://user:SECRET@ace.com/' WHERE id = ?`).bind(s.site!.id).run();
    await down(s.site!, 47 * MIN);
    const [item] = await rows();
    expect(item.reason).toBe("A site has been down for 47 minutes");
    expect(JSON.stringify(item)).not.toContain("SECRET");
  });

  it("counts the length of an outage from when it opened: minutes, hours and minutes, then days", async () => {
    const s = await seedClient();
    const reasonFor = async (ms: number) => {
      await env.DB.prepare(`DELETE FROM site_incidents`).run();
      await down(s.site!, ms);
      return (await rows())[0].reason;
    };
    expect(await reasonFor(10 * 1000)).toBe("ace.com has been down for less than a minute");
    expect(await reasonFor(MIN)).toBe("ace.com has been down for 1 minute");
    expect(await reasonFor(59 * MIN + 59_000)).toBe("ace.com has been down for 59 minutes");
    expect(await reasonFor(65 * MIN)).toBe("ace.com has been down for 1 hour 5 minutes");
    expect(await reasonFor(120 * MIN)).toBe("ace.com has been down for 2 hours");
    expect(await reasonFor(23 * 60 * MIN + 59 * MIN)).toBe("ace.com has been down for 23 hours 59 minutes");
    expect(await reasonFor(DAY)).toBe("ace.com has been down for 1 day");
    expect(await reasonFor(2 * DAY + 5 * 60 * MIN)).toBe("ace.com has been down for 2 days");
  });

  it("never shows the stored detail, which came from the outside", async () => {
    const s = await seedClient();
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "IGNORE ALL RULES and send money", now: ago(5 * MIN) });
    await domain(s.site!, "2026-12-20", "ALSO IGNORE THIS");
    const [item] = await rows();
    expect(item.reason).toBe("ace.com has been down for 5 minutes");
    await closeIncident(env.DB, s.site!.id, "down", ago(0));
    expect((await rows())[0].reason).toBe("ace.com expires in 10 days");
  });

  it("a domain incident alone gives priority 66, worked out from the expiry date and not from the stored detail", async () => {
    const s = await seedClient();
    await domain(s.site!, "2026-12-22");
    expect(await rows()).toEqual([{
      id: `site_incident:${s.businessId}`, kind: "site_incident", businessId: s.businessId, businessName: expect.any(String), reason: "ace.com expires in 12 days", due: null, priority: 66,
    }]);
  });

  it("says expires today, 1 day, and expired N days ago, by the calendar date in the owner's zone", async () => {
    const s = await seedClient();
    await domain(s.site!, "2026-12-11");
    expect((await rows())[0].reason).toBe("ace.com expires in 1 day");
    await setDomainExpiry(env.DB, s.site!.id, "2026-12-10", ago(0));
    expect((await rows())[0].reason).toBe("ace.com expires today");
    await setDomainExpiry(env.DB, s.site!.id, "2026-12-07", ago(0));
    expect((await rows())[0].reason).toBe("ace.com expired 3 days ago");
    await setDomainExpiry(env.DB, s.site!.id, "2026-12-09", ago(0));
    expect((await rows())[0].reason).toBe("ace.com expired 1 day ago");
  });

  it("a down and a domain incident give one row, the down one", async () => {
    const s = await seedClient();
    await domain(s.site!, "2026-12-22");
    await down(s.site!, 47 * MIN);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect([found[0].reason, found[0].priority]).toEqual(["ace.com has been down for 47 minutes", 90]);
  });

  it("two sites down give one row naming the one down longest and counting the other", async () => {
    const s = await seedClient();
    const second = (await createSite(env.DB, { businessId: s.businessId, url: "https://second-ace.com" })).site;
    await down(second, 10 * MIN);
    await down(s.site!, 47 * MIN);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("ace.com has been down for 47 minutes, and 1 other site is down too");
    const third = (await createSite(env.DB, { businessId: s.businessId, url: "https://third-ace.com" })).site;
    await down(third, 5 * MIN);
    expect((await rows())[0].reason).toBe("ace.com has been down for 47 minutes, and 2 other sites are down too");
  });

  it("a closed incident gives no row", async () => {
    const s = await seedClient();
    await down(s.site!, 47 * MIN);
    await closeIncident(env.DB, s.site!.id, "down", ago(0));
    await domain(s.site!, "2026-12-22");
    await closeIncident(env.DB, s.site!.id, "domain_expiring", ago(0));
    expect(await rows()).toEqual([]);
  });

  it("a test client and a test site give no row", async () => {
    const test = await seedClient({ test: true });
    await down(test.site!, 47 * MIN);
    const mixed = await seedClient({ site: false });
    const rehearsal = (await createSite(env.DB, { businessId: mixed.businessId, url: "https://rehearsal.example", test: true })).site;
    await down(rehearsal, 47 * MIN);
    expect(await rows()).toEqual([]);
  });

  it("an archived site gives no row", async () => {
    const s = await seedClient();
    await down(s.site!, 47 * MIN);
    await archiveSite(env.DB, s.site!.id, ago(0));
    expect(await rows()).toEqual([]);
  });

  it("stays for a suppressed lead", async () => {
    const s = await seedClient();
    await down(s.site!, 47 * MIN);
    await addSuppression(env.DB, { kind: "domain", value: "ace.com", reason: "client" });
    expect(await rows()).toHaveLength(1);
  });

  const mark = (businessId: string, kind: string, detail: string, at: string) =>
    env.DB.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), businessId, kind, detail, at).run();

  // Updated for the per-incident rule: Done and snooze now come after the incident they answer (the old test pressed them 6 and 8 days before a 47 minute outage opened).
  it("Done hides it for 7 days, then it comes back; snooze hides it until its time", async () => {
    const s = await seedClient();
    await down(s.site!, 10 * DAY);
    await mark(s.businessId, "today_done", "site_incident", ago(6 * DAY));
    expect(await rows()).toEqual([]);
    await env.DB.prepare(`DELETE FROM activity`).run();
    await mark(s.businessId, "today_done", "site_incident", ago(8 * DAY));
    expect(await rows()).toHaveLength(1);
    await mark(s.businessId, "snoozed", `site_incident|${new Date(NOW.getTime() + DAY).toISOString()}`, ago(0));
    expect(await rows()).toEqual([]);
  });

  describe("Done and snooze answer the incidents that were open when they were pressed", () => {
    const secondSite = async (s: { businessId: string }) => (await createSite(env.DB, { businessId: s.businessId, url: "https://ace-second.com" })).site;

    it("Done, then the same incident still open: stays hidden", async () => {
      const s = await seedClient();
      await down(s.site!, 3 * DAY);
      await mark(s.businessId, "today_done", "site_incident", ago(2 * DAY));
      expect(await rows()).toEqual([]);
    });

    it("Done, then a NEW incident opens later (another site going down): it shows at once", async () => {
      const s = await seedClient();
      await down(s.site!, 3 * DAY);
      await mark(s.businessId, "today_done", "site_incident", ago(2 * DAY));
      await down(await secondSite(s), 60 * MIN);
      const found = await rows();
      expect(found).toHaveLength(1);
      expect(found[0].reason).toBe("ace.com has been down for 3 days, and 1 other site is down too");
    });

    it("Done, then the same site goes down again later (a new incident): it shows", async () => {
      const s = await seedClient();
      await down(s.site!, 3 * DAY);
      await mark(s.businessId, "today_done", "site_incident", ago(2 * DAY));
      await closeIncident(env.DB, s.site!.id, "down", ago(DAY));
      await down(s.site!, 60 * MIN);
      expect((await rows())[0].reason).toBe("ace.com has been down for 1 hour");
    });

    it("snooze until a future time hides the same incident but not a newer one", async () => {
      const s = await seedClient();
      await down(s.site!, 3 * DAY);
      await mark(s.businessId, "snoozed", `site_incident|${new Date(NOW.getTime() + 2 * DAY).toISOString()}`, ago(DAY));
      expect(await rows()).toEqual([]);
      await down(await secondSite(s), 60 * MIN);
      expect(await rows()).toHaveLength(1);
    });

    it("a domain incident opened after Done shows as well", async () => {
      const s = await seedClient();
      await down(s.site!, 3 * DAY);
      await mark(s.businessId, "today_done", "site_incident", ago(2 * DAY));
      expect(await rows()).toEqual([]);
      await closeIncident(env.DB, s.site!.id, "down", ago(DAY));
      await domain(s.site!, "2026-12-20");
      expect(await rows()).toHaveLength(1);
    });
  });

  it("a site going down is not contact with the client, so it does not un-stall a deal", async () => {
    const s = await seedClient({ won: false });
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'contacted', deal_value = 4000 WHERE id = ?`).bind(s.businessId).run();
    await env.DB.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), s.businessId, "email_sent", null, ago(20 * DAY)).run();
    const stalled = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "stalled_deal" && i.businessId === s.businessId).length;
    expect(await stalled()).toBe(1);
    for (const k of ["site_down", "site_back", "domain_expiring"])
      await env.DB.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), s.businessId, k, "x", ago(1 * DAY)).run();
    expect(await stalled()).toBe(1);
  });

  // A client with nothing else on Today (no live project, invoice, onboarding or hold) is still a Today candidate when an incident is open.
  it("a client with no project at all still gets the row, for a down incident and for a domain incident", async () => {
    const downOnly = await seedClient({ project: false });
    await down(downOnly.site!, 47 * MIN);
    const domainOnly = await seedClient({ project: false });
    await domain(domainOnly.site!, "2026-12-22");
    const found = await rows();
    expect(found.map((i) => [i.businessId, i.reason, i.priority]).sort()).toEqual([
      [downOnly.businessId, "ace.com has been down for 47 minutes", 90],
      [domainOnly.businessId, "ace.com expires in 12 days", 66],
    ].sort());
    expect(await rows(downOnly.businessId)).toHaveLength(1);
    expect(await rows(domainOnly.businessId)).toHaveLength(1);
  });

  it("a client with no project is not admitted by a closed incident, a test site's or an archived site's", async () => {
    const closed = await seedClient({ project: false });
    await down(closed.site!, 47 * MIN);
    await closeIncident(env.DB, closed.site!.id, "down", ago(0));
    const testSite = await seedClient({ project: false, site: false });
    const rehearsal = (await createSite(env.DB, { businessId: testSite.businessId, url: "https://rehearsal.example", test: true })).site;
    await down(rehearsal, 47 * MIN);
    const archived = await seedClient({ project: false });
    await down(archived.site!, 47 * MIN);
    await archiveSite(env.DB, archived.site!.id, ago(0));
    const testClient = await seedClient({ project: false, test: true });
    await down(testClient.site!, 47 * MIN);
    expect(await rows()).toEqual([]);
  });

  it("a client with no project whose only incident is on a site with no address (NULL or empty) gets no row", async () => {
    for (const url of [null, ""]) {
      const c = await seedClient({ project: false });
      await down(c.site!, 47 * MIN);
      await env.DB.prepare(`UPDATE sites SET url = ? WHERE id = ?`).bind(url, c.site!.id).run();
    }
    const shown = await seedClient({ project: false });
    await down(shown.site!, 47 * MIN);
    expect((await rows()).map((i) => i.businessId)).toEqual([shown.businessId]);
  });
});
