import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listActivity } from "../src/worker/db/activity";
import { listIncidents } from "../src/worker/db/monitoring";
import { getSite } from "../src/worker/db/sites";
import { DOMAIN_WARN_DAYS, DOWN_AFTER, domainDaysLeft, recordDomainExpiry, recordProbe } from "../src/worker/monitoring/incidents";
import { ERROR_TEXT, type ProbeResult } from "../src/worker/monitoring/probe";
import { seedClient } from "./fixtures/clients";

const at = (min: number) => new Date(Date.UTC(2027, 1, 1, 10, 0, 0) + min * 60_000);
const up: ProbeResult = { ok: true, status: 200, ms: 120, error: null, slow: false };
const down503: ProbeResult = { ok: false, status: 503, ms: 90, error: "HTTP 503", slow: false };

// Storage is shared by the tests of a file, so the monitoring tables and the activity log start empty each time.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM site_checks`), env.DB.prepare(`DELETE FROM site_incidents`), env.DB.prepare(`DELETE FROM activity`)]);
});

const kinds = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 100)).filter((a) => a.kind === kind);
const checks = async (siteId: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_checks WHERE site_id = ?`).bind(siteId).first<{ n: number }>())!.n;

describe("constants", () => {
  it("are 2 checks and 30 days", () => { expect(DOWN_AFTER).toBe(2); expect(DOMAIN_WARN_DAYS).toBe(30); });
});

describe("recordProbe", () => {
  it("one failure opens nothing; the second opens one down incident and one site_down; more change nothing", async () => {
    const s = await seedClient();
    const site = s.site!;
    expect(await recordProbe(env, site, down503, at(0))).toEqual({ opened: false, closed: false });
    expect(await checks(site.id)).toBe(1);
    expect(await listIncidents(env.DB, {})).toHaveLength(0);
    expect(await kinds(s.businessId, "site_down")).toHaveLength(0);

    expect(await recordProbe(env, site, down503, at(5))).toEqual({ opened: true, closed: false });
    const open = await listIncidents(env.DB, { businessId: s.businessId });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ siteId: site.id, kind: "down", detail: "HTTP 503", closedAt: null, openedAt: at(5).toISOString() });
    expect(await kinds(s.businessId, "site_down")).toHaveLength(1);

    expect(await recordProbe(env, site, down503, at(10))).toEqual({ opened: false, closed: false });
    expect(await recordProbe(env, site, down503, at(15))).toEqual({ opened: false, closed: false });
    expect(await listIncidents(env.DB, {})).toHaveLength(1);
    expect(await kinds(s.businessId, "site_down")).toHaveLength(1);
    expect(await checks(site.id)).toBe(4);
  });

  it("two failed checks written with the identical time (a duplicated cron run) are one failure: no incident until a later check also fails", async () => {
    const s = await seedClient();
    const site = s.site!;
    expect(await recordProbe(env, site, down503, at(0))).toEqual({ opened: false, closed: false });
    expect(await recordProbe(env, site, down503, at(0))).toEqual({ opened: false, closed: false });
    expect(await checks(site.id)).toBe(2);
    expect(await listIncidents(env.DB, {})).toHaveLength(0);
    expect(await kinds(s.businessId, "site_down")).toHaveLength(0);
    expect(await recordProbe(env, site, down503, at(5))).toEqual({ opened: true, closed: false });
    expect(await listIncidents(env.DB, {})).toHaveLength(1);
  });

  it("a failed check at the same time as an ok one does not count as a failure", async () => {
    const s = await seedClient();
    await recordProbe(env, s.site!, up, at(0));
    await recordProbe(env, s.site!, down503, at(5));
    await recordProbe(env, s.site!, up, at(5));
    expect(await recordProbe(env, s.site!, down503, at(10))).toEqual({ opened: false, closed: false });
  });

  it("an ok check closes it and logs one site_back with the minutes down; a second ok changes nothing", async () => {
    const s = await seedClient();
    const site = s.site!;
    await recordProbe(env, site, down503, at(0));
    await recordProbe(env, site, down503, at(5)); // opened at +5
    expect(await recordProbe(env, site, up, at(52))).toEqual({ opened: false, closed: true }); // 47 min later
    const [inc] = await listIncidents(env.DB, {});
    expect(inc.closedAt).toBe(at(52).toISOString());
    const back = await kinds(s.businessId, "site_back");
    expect(back).toHaveLength(1);
    expect(back[0].detail).toBe("back after 47 min");

    expect(await recordProbe(env, site, up, at(57))).toEqual({ opened: false, closed: false });
    expect(await kinds(s.businessId, "site_back")).toHaveLength(1);
    expect(await listIncidents(env.DB, {})).toHaveLength(1);
  });

  it("fail, fail, ok, fail, fail gives two incidents, the first closed and the second open", async () => {
    const s = await seedClient();
    const site = s.site!;
    for (const [i, r] of [down503, down503, up, down503, down503].entries()) await recordProbe(env, site, r, at(i * 5));
    const all = await listIncidents(env.DB, {});
    expect(all).toHaveLength(2);
    expect(all.filter((i) => i.closedAt === null)).toHaveLength(1);
    expect(all.filter((i) => i.closedAt !== null)).toHaveLength(1);
    expect(await kinds(s.businessId, "site_down")).toHaveLength(2);
    expect(await kinds(s.businessId, "site_back")).toHaveLength(1);
  });

  it("fail, ok, fail never two in a row opens none", async () => {
    const s = await seedClient();
    const site = s.site!;
    for (const [i, r] of [down503, up, down503].entries()) await recordProbe(env, site, r, at(i * 5));
    expect(await listIncidents(env.DB, {})).toHaveLength(0);
    expect(await kinds(s.businessId, "site_down")).toHaveLength(0);
  });

  it("a slow ok result opens nothing and does not count as down", async () => {
    const s = await seedClient();
    const site = s.site!;
    const slow: ProbeResult = { ok: true, status: 200, ms: 6000, error: null, slow: true };
    for (let i = 0; i < 3; i++) expect(await recordProbe(env, site, slow, at(i * 5))).toEqual({ opened: false, closed: false });
    expect(await listIncidents(env.DB, {})).toHaveLength(0);
    expect(await checks(site.id)).toBe(3);
  });

  it("keeps the probe's own error word as the detail and nothing else", async () => {
    const s = await seedClient();
    const site = s.site!;
    const t: ProbeResult = { ok: false, status: null, ms: 10_000, error: ERROR_TEXT.timeout, slow: false };
    await recordProbe(env, site, t, at(0));
    await recordProbe(env, site, t, at(5));
    expect((await listIncidents(env.DB, {}))[0].detail).toBe(ERROR_TEXT.timeout);
    expect((await kinds(s.businessId, "site_down"))[0].detail).toBe(ERROR_TEXT.timeout);
  });

  it("sends nothing and creates no task or approval", async () => {
    const s = await seedClient();
    const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
    const [tasks, approvals] = [await count("tasks"), await count("approvals")];
    await recordProbe(env, s.site!, down503, at(0));
    await recordProbe(env, s.site!, down503, at(5));
    await recordProbe(env, s.site!, up, at(10));
    expect(await count("tasks")).toBe(tasks);
    expect(await count("approvals")).toBe(approvals);
  });
});

describe("domainDaysLeft", () => {
  it("counts calendar days in the zone, not UTC", () => {
    // 07:30Z on 21 Nov is 23:30 on 20 Nov in Los Angeles, so 3 December is 13 days away.
    expect(domainDaysLeft("2026-12-03", new Date("2026-11-21T07:30:00Z"), "America/Los_Angeles")).toBe(13);
    // 08:30Z is 00:30 on 21 Nov there: the same date is 0 days away.
    expect(domainDaysLeft("2026-11-21", new Date("2026-11-21T08:30:00Z"), "America/Los_Angeles")).toBe(0);
    expect(domainDaysLeft("2026-11-21", new Date("2026-11-21T07:30:00Z"), "America/Los_Angeles")).toBe(1);
  });
  it("is negative once past, and works across month and year ends", () => {
    expect(domainDaysLeft("2026-11-18", new Date("2026-11-21T20:00:00Z"), "America/Los_Angeles")).toBe(-3);
    expect(domainDaysLeft("2027-01-02", new Date("2026-12-30T20:00:00Z"), "America/Los_Angeles")).toBe(3);
  });
});

describe("recordDomainExpiry", () => {
  const now = new Date("2026-11-21T20:00:00Z"); // 12:00 on 21 Nov in Los Angeles

  it("12 days left opens domain_expiring once; a second call opens no second", async () => {
    const s = await seedClient();
    expect(await recordDomainExpiry(env, s.site!, "2026-12-03", now)).toEqual({ opened: true, closed: false });
    const [inc] = await listIncidents(env.DB, { businessId: s.businessId });
    expect(inc).toMatchObject({ kind: "domain_expiring", detail: "domain expires in 12 days", closedAt: null });
    const site = (await getSite(env.DB, s.site!.id))!;
    expect(site).toMatchObject({ domainExpiresOn: "2026-12-03", domainCheckedAt: now.toISOString() });
    const log = await kinds(s.businessId, "domain_expiring");
    expect(log).toHaveLength(1);
    expect(log[0].detail).toBe("domain expires in 12 days");

    expect(await recordDomainExpiry(env, site, "2026-12-03", new Date(now.getTime() + 86_400_000))).toEqual({ opened: false, closed: false });
    expect(await listIncidents(env.DB, {})).toHaveLength(1);
    expect(await kinds(s.businessId, "domain_expiring")).toHaveLength(1);
  });

  it("90 days left closes an open one (the domain was renewed)", async () => {
    const s = await seedClient();
    await recordDomainExpiry(env, s.site!, "2026-12-03", now);
    expect(await recordDomainExpiry(env, s.site!, "2027-02-19", now)).toEqual({ opened: false, closed: true });
    const [inc] = await listIncidents(env.DB, {});
    expect(inc.closedAt).toBe(now.toISOString());
    expect((await getSite(env.DB, s.site!.id))!.domainExpiresOn).toBe("2027-02-19");
  });

  it("90 days left with nothing open changes nothing", async () => {
    const s = await seedClient();
    expect(await recordDomainExpiry(env, s.site!, "2027-02-19", now)).toEqual({ opened: false, closed: false });
    expect(await listIncidents(env.DB, {})).toHaveLength(0);
  });

  it("30 days is inside the window and 31 is not", async () => {
    const a = await seedClient();
    expect((await recordDomainExpiry(env, a.site!, "2026-12-21", now)).opened).toBe(true);
    const b = await seedClient();
    expect((await recordDomainExpiry(env, b.site!, "2026-12-22", now)).opened).toBe(false);
  });

  it("an already-past date says expired", async () => {
    const s = await seedClient();
    expect(await recordDomainExpiry(env, s.site!, "2026-11-18", now)).toEqual({ opened: true, closed: false });
    expect((await listIncidents(env.DB, {}))[0].detail).toBe("domain expired 3 days ago");
    expect((await kinds(s.businessId, "domain_expiring"))[0].detail).toBe("domain expired 3 days ago");
  });

  it("expiring today reads as 0 days, singular reads as 1 day", async () => {
    const a = await seedClient();
    await recordDomainExpiry(env, a.site!, "2026-11-21", now);
    expect((await listIncidents(env.DB, { businessId: a.businessId }))[0].detail).toBe("domain expires today");
    const b = await seedClient();
    await recordDomainExpiry(env, b.site!, "2026-11-22", now);
    expect((await listIncidents(env.DB, { businessId: b.businessId }))[0].detail).toBe("domain expires in 1 day");
  });

  it("null stores only the check time and leaves an open incident open", async () => {
    const s = await seedClient();
    await recordDomainExpiry(env, s.site!, "2026-12-03", now);
    const later = new Date(now.getTime() + 3_600_000);
    expect(await recordDomainExpiry(env, (await getSite(env.DB, s.site!.id))!, null, later)).toEqual({ opened: false, closed: false });
    const site = (await getSite(env.DB, s.site!.id))!;
    expect(site.domainCheckedAt).toBe(later.toISOString());
    expect(site.domainExpiresOn).toBe("2026-12-03"); // the last known date is kept
    expect((await listIncidents(env.DB, { open: true }))).toHaveLength(1);
  });
});
