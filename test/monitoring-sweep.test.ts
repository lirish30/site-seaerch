import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertCheck, listIncidents, openIncident, setDomainExpiry, setMonitoring } from "../src/worker/db/monitoring";
import { archiveSite, createSite, getSite, updateSite } from "../src/worker/db/sites";
import { ERROR_TEXT } from "../src/worker/monitoring/probe";
import { CHECK_KEEP_DAYS, CONCURRENCY, DOMAIN_RECHECK_DAYS, MAX_PER_TICK, monitoringDeps, sweepDomains, sweepUptime } from "../src/worker/monitoring/sweep";
import { DAILY_CRON, REMINDER_CRON, runScheduled } from "../src/worker/schedule";
import { seedClient } from "./fixtures/clients";

const NOW = new Date("2027-02-01T10:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();
const realSetTimeout = setTimeout;
const realFetch = monitoringDeps.fetch;

let calls: string[] = [];
let logs: unknown[][] = [];
let errors: unknown[][] = [];

/** A recorder: remembers every URL asked for and answers with `status`. */
const answering = (status: number | ((url: string) => Response | Promise<Response>)): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return typeof status === "number" ? new Response(null, { status }) : status(url);
  }) as typeof fetch;

// Storage is shared by the tests of a file: earlier tests' sites are made test sites (never monitored) and the monitoring tables and activity log start empty.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`UPDATE sites SET test = 1, monitoring = 0`),
    env.DB.prepare(`DELETE FROM site_checks`), env.DB.prepare(`DELETE FROM site_incidents`), env.DB.prepare(`DELETE FROM activity`),
  ]);
  calls = []; logs = []; errors = [];
  monitoringDeps.fetch = answering(200);
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
});
afterEach(() => {
  monitoringDeps.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A client with live Care whose site lives at `url`. */
async function careSite(url: string | null) {
  const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
  await updateSite(env.DB, s.site!.id, { url, domain: url === null ? null : new URL(url.includes("://") ? url : `https://${url}`).hostname }, NOW.toISOString());
  return s;
}
const checkCount = async (siteId: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_checks WHERE site_id = ?`).bind(siteId).first<{ n: number }>())!.n;

describe("constants", () => {
  it("are 40 a tick, 5 at a time, 35 days of checks and a weekly domain look", () => {
    expect([MAX_PER_TICK, CONCURRENCY, CHECK_KEEP_DAYS, DOMAIN_RECHECK_DAYS]).toEqual([40, 5, 35, 7]);
  });
});

describe("sweepUptime", () => {
  it("fetches a Care client's site once and never fetches the sites that are not monitored or not monitorable", async () => {
    const care = await careSite("https://care-site.example.com/");
    const noCare = await seedClient({ subs: [{ monthlyCents: 4970 }] });
    await updateSite(env.DB, noCare.site!.id, { url: "https://no-care.example.com/", domain: "no-care.example.com" }, NOW.toISOString());
    const cancelled = await seedClient({ subs: [{ key: "care", monthlyCents: 12900, status: "cancelled" }] });
    await updateSite(env.DB, cancelled.site!.id, { url: "https://cancelled.example.com/", domain: "cancelled.example.com" }, NOW.toISOString());
    const test = await seedClient({ test: true, subs: [{ key: "care", monthlyCents: 12900 }] });
    await updateSite(env.DB, test.site!.id, { url: "https://test-client.example.com/", domain: "test-client.example.com" }, NOW.toISOString());
    const archived = await careSite("https://archived.example.com/");
    await archiveSite(env.DB, archived.site!.id, NOW.toISOString());
    await careSite(null);
    const internal = await careSite("http://10.0.0.5");

    const r = await sweepUptime(env, NOW);
    expect(calls).toEqual(["https://care-site.example.com/"]);
    expect(r).toEqual({ probed: 1, failed: 0, skipped: 1, opened: 0, closed: 0 });
    expect(await checkCount(care.site!.id)).toBe(1);
    expect(await checkCount(internal.site!.id)).toBe(0);
  });

  it("fetches a non-Care client's site once monitoring is switched on", async () => {
    const s = await seedClient({ subs: [{ monthlyCents: 4970 }] });
    await updateSite(env.DB, s.site!.id, { url: "https://by-hand.example.com/", domain: "by-hand.example.com" }, NOW.toISOString());
    await sweepUptime(env, NOW);
    expect(calls).toEqual([]);
    await setMonitoring(env.DB, s.site!.id, true, NOW.toISOString());
    await sweepUptime(env, NOW);
    expect(calls).toEqual(["https://by-hand.example.com/"]);
  });

  it("probes at most 40 sites a tick and the next tick starts with the ones not yet checked", async () => {
    const s = await seedClient({ site: false, project: false });
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      const { site } = await createSite(env.DB, { businessId: s.businessId, url: `https://bulk${i}.example.com/` });
      await setMonitoring(env.DB, site.id, true, NOW.toISOString());
      ids.push(site.id);
    }
    const first = await sweepUptime(env, NOW);
    expect(first).toMatchObject({ probed: 40, skipped: 0 });
    expect(new Set(calls).size).toBe(40);
    const seen = new Set(calls);
    const notYet = Array.from({ length: 45 }, (_, i) => `https://bulk${i}.example.com/`).filter((u) => !seen.has(u));
    expect(notYet).toHaveLength(5);

    calls = [];
    const second = await sweepUptime(env, new Date(NOW.getTime() + 300_000));
    expect(second.probed).toBe(40);
    expect(new Set(calls.slice(0, 5))).toEqual(new Set(notYet));
    expect(ids).toHaveLength(45);
  });

  it("one site that never answers does not stop the other four, and the call still resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = await seedClient({ site: false, project: false });
    for (let i = 0; i < 5; i++) {
      const { site } = await createSite(env.DB, { businessId: s.businessId, url: `https://hang${i}.example.com/` });
      await setMonitoring(env.DB, site.id, true, NOW.toISOString());
    }
    // This fake ignores the abort signal: it never settles, whatever the probe does.
    monitoringDeps.fetch = answering((url) => (url.includes("hang2") ? new Promise<Response>(() => {}) : new Response(null, { status: 200 })));

    let result: Awaited<ReturnType<typeof sweepUptime>> | undefined;
    const p = sweepUptime(env, NOW).then((r) => { result = r; });
    for (let i = 0; i < 200 && !result; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise<void>((resolve) => realSetTimeout(resolve, 5)); // let the database answer
    }
    await p;
    expect(calls).toHaveLength(5);
    expect(result).toMatchObject({ probed: 5, failed: 1, skipped: 0 });
    const rows = (await env.DB.prepare(`SELECT ok, error FROM site_checks`).all<{ ok: number; error: string | null }>()).results;
    expect(rows.filter((r) => r.ok === 1)).toHaveLength(4);
    expect(rows.filter((r) => r.ok === 0)).toEqual([{ ok: 0, error: ERROR_TEXT.timeout }]);
  });

  it("a fetch that throws is a failed check with a fixed phrase, not a throw", async () => {
    const s = await careSite("https://throws.example.com/");
    monitoringDeps.fetch = (async () => { throw new Error("secret internal detail 10.1.2.3"); }) as typeof fetch;
    const r = await sweepUptime(env, NOW);
    expect(r).toMatchObject({ probed: 1, failed: 1 });
    const row = await env.DB.prepare(`SELECT ok, status, error FROM site_checks WHERE site_id = ?`).bind(s.site!.id).first<{ ok: number; status: number | null; error: string }>();
    expect(row).toEqual({ ok: 0, status: null, error: ERROR_TEXT.connect });
  });

  it("two ticks of 503 open one incident on the second", async () => {
    const s = await careSite("https://flaky.example.com/");
    monitoringDeps.fetch = answering(503);
    expect(await sweepUptime(env, NOW)).toEqual({ probed: 1, failed: 1, skipped: 0, opened: 0, closed: 0 });
    expect(await sweepUptime(env, new Date(NOW.getTime() + 300_000))).toEqual({ probed: 1, failed: 1, skipped: 0, opened: 1, closed: 0 });
    expect(await listIncidents(env.DB, { businessId: s.businessId, open: true })).toHaveLength(1);
    monitoringDeps.fetch = answering(200);
    expect(await sweepUptime(env, new Date(NOW.getTime() + 600_000))).toEqual({ probed: 1, failed: 0, skipped: 0, opened: 0, closed: 1 });
  });

  it("never throws when the database fails", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get: (t, p) => { if (p === "prepare") throw new Error("db down"); const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v; } }) } as typeof env;
    await expect(sweepUptime(broken, NOW)).resolves.toEqual({ probed: 0, failed: 0, skipped: 0, opened: 0, closed: 0 });
  });

  it("the default fetch is the global one, looked up when called", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    monitoringDeps.fetch = realFetch;
    await careSite("https://lazy.example.com/");
    await sweepUptime(env, NOW);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String(globalFetch.mock.calls[0][0])).toBe("https://lazy.example.com/");
  });
});

describe("the crons", () => {
  it("REMINDER_CRON with no monitored sites resolves and logs nothing", async () => {
    await expect(runScheduled(env, REMINDER_CRON, NOW)).resolves.toBeUndefined();
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("REMINDER_CRON stays quiet while sites are up and logs the tick that opens an incident", async () => {
    await careSite("https://cron-site.example.com/");
    await runScheduled(env, REMINDER_CRON, NOW);
    expect(logs).toEqual([]);
    monitoringDeps.fetch = answering(503);
    await runScheduled(env, REMINDER_CRON, new Date(NOW.getTime() + 300_000));
    expect(logs).toEqual([]); // the first failure opens nothing
    await runScheduled(env, REMINDER_CRON, new Date(NOW.getTime() + 600_000));
    expect(logs.map((l) => l[0])).toEqual(["uptime"]);
    expect(String(logs[0][1])).toContain('"opened":1');
  });

  it("the daily cron looks up domains not checked for a week, prunes old checks and leaves the rest", async () => {
    const stale = await careSite("https://stale.example.com/");
    const fresh = await careSite("https://fresh.example.com/");
    const never = await careSite("https://never.example.com/");
    await setDomainExpiry(env.DB, stale.site!.id, "2028-01-01", daysAgo(8));
    await setDomainExpiry(env.DB, fresh.site!.id, "2028-01-01", daysAgo(2));
    await insertCheck(env.DB, { siteId: stale.site!.id, checkedAt: daysAgo(40), ok: true, status: 200, ms: 100, error: null });
    await insertCheck(env.DB, { siteId: stale.site!.id, checkedAt: daysAgo(10), ok: true, status: 200, ms: 100, error: null });
    monitoringDeps.fetch = answering(() => Response.json({ events: [{ eventAction: "expiration", eventDate: "2029-05-06T00:00:00Z" }] }));

    expect(DAILY_CRON).toBe("17 13 * * *");
    await runScheduled(env, DAILY_CRON, NOW);

    const rdap = calls.filter((u) => u.startsWith("https://rdap.org/domain/")).sort();
    expect(rdap).toEqual(["https://rdap.org/domain/never.example.com", "https://rdap.org/domain/stale.example.com"]);
    expect((await getSite(env.DB, stale.site!.id))!.domainExpiresOn).toBe("2029-05-06");
    expect((await getSite(env.DB, never.site!.id))!.domainExpiresOn).toBe("2029-05-06");
    expect((await getSite(env.DB, fresh.site!.id))!.domainExpiresOn).toBe("2028-01-01");
    const left = (await env.DB.prepare(`SELECT checked_at FROM site_checks`).all<{ checked_at: string }>()).results.map((r) => r.checked_at);
    expect(left).toEqual([daysAgo(10)]);
    expect(errors.some((e) => String(e[0]).includes("domain expiry"))).toBe(false);
    expect(logs.some((l) => l[0] === "domain expiry")).toBe(true);
  });
});

describe("sweepDomains", () => {
  it("returns what it did and opens an incident for a domain about to lapse", async () => {
    const s = await careSite("https://lapsing.example.com/");
    monitoringDeps.fetch = answering(() => Response.json({ events: [{ eventAction: "expiration", eventDate: "2027-02-11T00:00:00Z" }] }));
    expect(await sweepDomains(env, NOW)).toEqual({ checked: 1, opened: 1, closed: 0, pruned: 0 });
    expect(await listIncidents(env.DB, { businessId: s.businessId, open: true })).toHaveLength(1);
    expect(await sweepDomains(env, NOW)).toEqual({ checked: 0, opened: 0, closed: 0, pruned: 0 }); // looked up just now
  });

  it("a failed RDAP lookup leaves the expiry date and the incidents as they were", async () => {
    const s = await careSite("https://rdap-down.example.com/");
    await setDomainExpiry(env.DB, s.site!.id, "2027-02-11", daysAgo(8));
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "domain_expiring", detail: "domain expires in 12 days", now: daysAgo(1) });
    monitoringDeps.fetch = answering(500);
    const r = await sweepDomains(env, NOW);
    expect(r).toEqual({ checked: 1, opened: 0, closed: 0, pruned: 0 });
    const site = (await getSite(env.DB, s.site!.id))!;
    expect(site.domainExpiresOn).toBe("2027-02-11");
    // The failed lookup is not stamped, so the site is asked again at the next run (updated: it used to be stamped like "no date known").
    expect(site.domainCheckedAt).toBe(daysAgo(8));
    const open = await listIncidents(env.DB, { businessId: s.businessId, open: true });
    expect(open).toHaveLength(1);
    expect(open[0].detail).toBe("domain expires in 12 days");
  });

  it("a rate limited lookup is not stamped and is asked again the next run; a clean 404 is stamped and waits a week", async () => {
    const limited = await careSite("https://limited.example.com/");
    const missing = await careSite("https://missing.example.com/");
    monitoringDeps.fetch = answering((url) => new Response(null, { status: url.includes("limited") ? 429 : 404 }));
    expect(await sweepDomains(env, NOW)).toEqual({ checked: 2, opened: 0, closed: 0, pruned: 0 });
    expect((await getSite(env.DB, limited.site!.id))!.domainCheckedAt).toBeNull();
    expect((await getSite(env.DB, missing.site!.id))!.domainCheckedAt).toBe(NOW.toISOString());

    calls = [];
    const nextDay = new Date(NOW.getTime() + DAY);
    monitoringDeps.fetch = answering(() => Response.json({ events: [{ eventAction: "expiration", eventDate: "2030-01-01T00:00:00Z" }] }));
    expect(await sweepDomains(env, nextDay)).toEqual({ checked: 1, opened: 0, closed: 0, pruned: 0 });
    expect(calls).toEqual(["https://rdap.org/domain/limited.example.com"]);
    const retried = (await getSite(env.DB, limited.site!.id))!;
    expect(retried.domainExpiresOn).toBe("2030-01-01");
    expect(retried.domainCheckedAt).toBe(nextDay.toISOString());
  });

  it("a found date sets the expiry and the lookup time", async () => {
    const s = await careSite("https://found.example.com/");
    monitoringDeps.fetch = answering(() => Response.json({ events: [{ eventAction: "expiration", eventDate: "2031-05-06T00:00:00Z" }] }));
    await sweepDomains(env, NOW);
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ domainExpiresOn: "2031-05-06", domainCheckedAt: NOW.toISOString() });
  });

  it("one site's failure does not stop the others, and a fetch that throws changes nothing", async () => {
    await careSite("https://boom.example.com/");
    const ok = await careSite("https://fine.example.com/");
    monitoringDeps.fetch = answering((url) => { if (url.includes("boom")) throw new Error("network"); return Response.json({ events: [{ eventAction: "expiration", eventDate: "2030-01-01T00:00:00Z" }] }); });
    const r = await sweepDomains(env, NOW);
    expect(r.checked).toBe(2);
    expect((await getSite(env.DB, ok.site!.id))!.domainExpiresOn).toBe("2030-01-01");
  });

  it("never throws when the database fails", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get: (t, p) => { if (p === "prepare") throw new Error("db down"); const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v; } }) } as typeof env;
    await expect(sweepDomains(broken, NOW)).resolves.toEqual({ checked: 0, opened: 0, closed: 0, pruned: 0 });
  });
});
