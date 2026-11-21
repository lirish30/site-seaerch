import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  closeIncident, insertCheck, listIncidents, monitoredSites, openIncident, pruneChecks, recentChecks, setDomainExpiry, setMonitoring, uptimePercent,
} from "../src/worker/db/monitoring";
import { archiveSite, createSite, getSite, updateSite } from "../src/worker/db/sites";
import { addSub, seedClient } from "./fixtures/clients";

const T0 = "2027-02-01T10:00:00.000Z";
const T1 = "2027-02-01T10:01:00.000Z";
const T2 = "2027-02-01T10:02:00.000Z";
const T3 = "2027-02-01T10:03:00.000Z";
const T4 = "2027-02-01T10:04:00.000Z";

const check = (siteId: string, checkedAt: string, ok = true) => ({ siteId, checkedAt, ok, status: ok ? 200 : 500, ms: 120, error: ok ? null : "HTTP 500" });
// Storage is shared by the tests of a file, so the two monitoring tables (leaves: nothing refers to them) start empty each time.
beforeEach(async () => { await env.DB.batch([env.DB.prepare(`DELETE FROM site_checks`), env.DB.prepare(`DELETE FROM site_incidents`)]); });

const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe("site checks", () => {
  it("insertCheck and recentChecks return the newest first, limited", async () => {
    const s = await seedClient();
    await insertCheck(env.DB, check(s.site!.id, T0));
    await insertCheck(env.DB, check(s.site!.id, T2, false));
    await insertCheck(env.DB, check(s.site!.id, T1));
    const rows = await recentChecks(env.DB, s.site!.id, 2);
    expect(rows.map((r) => r.checkedAt)).toEqual([T2, T1]);
    expect(rows[0]).toMatchObject({ siteId: s.site!.id, ok: false, status: 500, ms: 120, error: "HTTP 500" });
    expect(rows[1]).toMatchObject({ ok: true, error: null });
    expect(typeof rows[0].id).toBe("string");
  });

  it("uptimePercent is null with no checks and a one-decimal percent of the ok ones since the time given", async () => {
    const s = await seedClient();
    expect(await uptimePercent(env.DB, s.site!.id, T0)).toEqual({ percent: null, checks: 0 });
    await insertCheck(env.DB, check(s.site!.id, T0));
    await insertCheck(env.DB, check(s.site!.id, T1));
    await insertCheck(env.DB, check(s.site!.id, T2, false));
    await insertCheck(env.DB, check(s.site!.id, T3));
    expect(await uptimePercent(env.DB, s.site!.id, T0)).toEqual({ percent: 75, checks: 4 });
    expect(await uptimePercent(env.DB, s.site!.id, T2)).toEqual({ percent: 50, checks: 2 });
    expect(await uptimePercent(env.DB, s.site!.id, T4)).toEqual({ percent: null, checks: 0 });
    const t = await seedClient();
    for (const [i, ok] of [true, true, false].entries()) await insertCheck(env.DB, check(t.site!.id, `2027-02-01T11:0${i}:00.000Z`, ok));
    expect((await uptimePercent(env.DB, t.site!.id, T0)).percent).toBe(66.7);
  });

  it("pruneChecks removes only rows older than the time and returns how many", async () => {
    const s = await seedClient();
    for (const t of [T0, T1, T2, T3]) await insertCheck(env.DB, check(s.site!.id, t));
    expect(await pruneChecks(env.DB, T2)).toBe(2);
    expect((await recentChecks(env.DB, s.site!.id, 10)).map((r) => r.checkedAt)).toEqual([T3, T2]);
    expect(await pruneChecks(env.DB, T2)).toBe(0);
  });
});

describe("incidents", () => {
  it("openIncident is created once per site and kind; a second call changes nothing", async () => {
    const s = await seedClient();
    const a = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "HTTP 500", now: T0 });
    expect(a.created).toBe(true);
    expect(a.incident).toMatchObject({ siteId: s.site!.id, businessId: s.businessId, kind: "down", openedAt: T0, closedAt: null, detail: "HTTP 500" });
    const b = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "timeout", now: T1 });
    expect(b.created).toBe(false);
    expect(b.incident).toEqual(a.incident);
    expect(await count(`SELECT COUNT(*) AS n FROM site_incidents WHERE site_id = ? AND kind = 'down'`, s.site!.id)).toBe(1);
    // another kind on the same site is its own incident
    expect((await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "domain_expiring", detail: "12 days", now: T1 })).created).toBe(true);
  });

  it("two concurrent openIncident calls make exactly one incident and exactly one says created", async () => {
    const s = await seedClient();
    const open = (detail: string) => openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail, now: T0 });
    const [a, b] = await Promise.all([open("a"), open("b")]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.incident.id).toBe(b.incident.id);
    expect(await count(`SELECT COUNT(*) AS n FROM site_incidents WHERE site_id = ? AND kind = 'down'`, s.site!.id)).toBe(1);
  });

  it("an incident that is closed between the conflict and the read is opened again, never a crash", async () => {
    const s = await seedClient();
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "first", now: T0 });
    let closedOnce = false;
    const racing = { prepare: (sql: string) => {
      if (!closedOnce && sql.startsWith("SELECT * FROM site_incidents")) { closedOnce = true; return { bind: () => ({ first: async () => { await closeIncident(env.DB, s.site!.id, "down", T1); return null; } }) }; }
      return env.DB.prepare(sql);
    } } as unknown as D1Database;
    const again = await openIncident(racing, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "second", now: T2 });
    expect(again.created).toBe(true);
    expect(again.incident).toMatchObject({ detail: "second", closedAt: null });
  });

  it("closeIncident returns the closed one, null when none is open, and a later open is new", async () => {
    const s = await seedClient();
    expect(await closeIncident(env.DB, s.site!.id, "down", T1)).toBeNull();
    const a = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "x", now: T0 });
    const closed = await closeIncident(env.DB, s.site!.id, "down", T1);
    expect(closed).toMatchObject({ id: a.incident.id, openedAt: T0, closedAt: T1 });
    expect(await closeIncident(env.DB, s.site!.id, "down", T2)).toBeNull();
    const again = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "y", now: T2 });
    expect(again.created).toBe(true);
    expect(again.incident.id).not.toBe(a.incident.id);
    expect(await count(`SELECT COUNT(*) AS n FROM site_incidents WHERE site_id = ?`, s.site!.id)).toBe(2);
  });

  it("listIncidents is newest first, filters by business and open, and leaves out test clients and test sites", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const t = await seedClient({ test: true });
    const i1 = await openIncident(env.DB, { siteId: a.site!.id, businessId: a.businessId, kind: "down", detail: "one", now: T0 });
    const i2 = await openIncident(env.DB, { siteId: a.site!.id, businessId: a.businessId, kind: "domain_expiring", detail: "two", now: T1 });
    const i3 = await openIncident(env.DB, { siteId: b.site!.id, businessId: b.businessId, kind: "down", detail: "three", now: T2 });
    await openIncident(env.DB, { siteId: t.site!.id, businessId: t.businessId, kind: "down", detail: "test", now: T3 });
    await closeIncident(env.DB, a.site!.id, "down", T3);
    const all = await listIncidents(env.DB, {});
    expect(all.map((i) => i.id)).toEqual([i3.incident.id, i2.incident.id, i1.incident.id]);
    expect(all.some((i) => i.businessId === t.businessId)).toBe(false);
    expect((await listIncidents(env.DB, { businessId: a.businessId })).map((i) => i.id)).toEqual([i2.incident.id, i1.incident.id]);
    expect((await listIncidents(env.DB, { open: true })).map((i) => i.id)).toEqual([i3.incident.id, i2.incident.id]);
    expect((await listIncidents(env.DB, { open: false })).map((i) => i.id)).toEqual([i1.incident.id]);
    expect(await listIncidents(env.DB, { limit: 1 })).toHaveLength(1);
    expect(await listIncidents(env.DB, { businessId: t.businessId })).toEqual([]);
  });
});

describe("listIncidents and sites the owner never sees", () => {
  it("leaves out an incident on an archived site and on a site whose address is NULL or empty, open or closed", async () => {
    const live = await seedClient();
    const archived = await seedClient();
    const nulled = await seedClient();
    const emptied = await seedClient();
    const kept = await openIncident(env.DB, { siteId: live.site!.id, businessId: live.businessId, kind: "down", detail: "HTTP 503", now: T0 });
    for (const [c, now] of [[archived, T1], [nulled, T2], [emptied, T3]] as const) await openIncident(env.DB, { siteId: c.site!.id, businessId: c.businessId, kind: "down", detail: "HTTP 503", now });
    await closeIncident(env.DB, emptied.site!.id, "down", T4);
    await archiveSite(env.DB, archived.site!.id, T4);
    await env.DB.prepare(`UPDATE sites SET url = NULL WHERE id = ?`).bind(nulled.site!.id).run();
    await env.DB.prepare(`UPDATE sites SET url = '' WHERE id = ?`).bind(emptied.site!.id).run();
    expect((await listIncidents(env.DB, {})).map((i) => i.id)).toEqual([kept.incident.id]);
    expect((await listIncidents(env.DB, { open: true })).map((i) => i.id)).toEqual([kept.incident.id]);
    expect((await listIncidents(env.DB, { open: false }))).toEqual([]);
    for (const c of [archived, nulled, emptied]) expect(await listIncidents(env.DB, { businessId: c.businessId })).toEqual([]);
    // They are still in the table: only the owner's views leave them out.
    expect(await count(`SELECT COUNT(*) AS n FROM site_incidents`)).toBe(4);
  });

  it("a limit counts only the incidents that are shown", async () => {
    const live = await seedClient();
    const gone = await seedClient();
    const kept = await openIncident(env.DB, { siteId: live.site!.id, businessId: live.businessId, kind: "down", detail: "HTTP 503", now: T0 });
    await openIncident(env.DB, { siteId: gone.site!.id, businessId: gone.businessId, kind: "down", detail: "HTTP 503", now: T2 }); // newer, so it would take the one place
    await archiveSite(env.DB, gone.site!.id, T3);
    expect((await listIncidents(env.DB, { limit: 1 })).map((i) => i.id)).toEqual([kept.incident.id]);
  });
});

describe("site fields", () => {
  it("monitoring defaults off and setMonitoring flips it; setDomainExpiry stores the date and when it was checked", async () => {
    const s = await seedClient();
    expect(s.site).toMatchObject({ monitoring: false, domainExpiresOn: null, domainCheckedAt: null });
    expect(await setMonitoring(env.DB, s.site!.id, true, T0)).toMatchObject({ id: s.site!.id, monitoring: true, updatedAt: T0 });
    expect((await getSite(env.DB, s.site!.id))!.monitoring).toBe(true);
    expect((await setMonitoring(env.DB, s.site!.id, false, T1))!.monitoring).toBe(false);
    expect(await setMonitoring(env.DB, "nope", true, T1)).toBeNull();
    await setDomainExpiry(env.DB, s.site!.id, "2027-06-01", T2);
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ domainExpiresOn: "2027-06-01", domainCheckedAt: T2 });
    await setDomainExpiry(env.DB, s.site!.id, null, T3);
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ domainExpiresOn: null, domainCheckedAt: T3 });
  });
});

describe("monitoredSites", () => {
  it("returns a live Care client's site and not a client without Care, with a cancelled Care row, a test client, an archived site or a site with no URL", async () => {
    const care = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    const plus = await seedClient({ subs: [{ key: "care_plus", monthlyCents: 24900, status: "past_due" }] });
    const none = await seedClient({ subs: [{ monthlyCents: 4970 }] });
    const cancelled = await seedClient({ subs: [{ key: "care", monthlyCents: 12900, status: "cancelled" }] });
    const test = await seedClient({ test: true, subs: [{ key: "care", monthlyCents: 12900 }] });
    const archived = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    await archiveSite(env.DB, archived.site!.id, T0);
    const noUrl = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    await updateSite(env.DB, noUrl.site!.id, { url: null, domain: null }, T0);
    const ids = (await monitoredSites(env.DB, 100)).map((s) => s.id);
    expect(ids).toContain(care.site!.id);
    expect(ids).toContain(plus.site!.id);
    for (const x of [none, cancelled, test, archived, noUrl]) expect(ids).not.toContain(x.site!.id);
  });

  it("a Care row that is test, or a lead that is not a client's real record, does not make a site monitored", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 4970 }] });
    await addSub(s, { key: "care", monthlyCents: 12900, test: true });
    expect((await monitoredSites(env.DB, 100)).map((x) => x.id)).not.toContain(s.site!.id);
  });

  it("returns a non-Care site once monitoring is on, but never for a test client", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 4970 }] });
    const t = await seedClient({ test: true });
    expect((await monitoredSites(env.DB, 100)).map((x) => x.id)).not.toContain(s.site!.id);
    await setMonitoring(env.DB, s.site!.id, true, T0);
    await setMonitoring(env.DB, t.site!.id, true, T0);
    const ids = (await monitoredSites(env.DB, 100)).map((x) => x.id);
    expect(ids).toContain(s.site!.id);
    expect(ids).not.toContain(t.site!.id);
  });

  it("puts a never-checked site before one checked a minute ago, the longest-ago check first, and honours the limit", async () => {
    const fresh = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    const older = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    const never = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    await insertCheck(env.DB, check(fresh.site!.id, T3));
    await insertCheck(env.DB, check(older.site!.id, T0));
    await insertCheck(env.DB, check(older.site!.id, T1));
    const mine = new Set([fresh.site!.id, older.site!.id, never.site!.id]);
    const order = (await monitoredSites(env.DB, 100)).map((s) => s.id).filter((id) => mine.has(id));
    expect(order.indexOf(never.site!.id)).toBeLessThan(order.indexOf(older.site!.id));
    expect(order.indexOf(older.site!.id)).toBeLessThan(order.indexOf(fresh.site!.id));
    expect(await monitoredSites(env.DB, 2)).toHaveLength(2);
    expect(await monitoredSites(env.DB, 1)).toHaveLength(1);
  });
});
