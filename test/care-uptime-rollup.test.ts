import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uptimeDays, upsertUptimeDay } from "../src/worker/db/careReports";
import { pruneChecks } from "../src/worker/db/monitoring";
import { localDay, MIN_CHECKS_FOR_A_DAY, rollupUptime, uptimeOf } from "../src/worker/monitoring/rollup";
import { sweepDomains } from "../src/worker/monitoring/sweep";
import { seedClient } from "./fixtures/clients";

const LA = "America/Los_Angeles";
const STEP = 5 * 60_000;

let errors: unknown[][] = [];
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM site_checks`), env.DB.prepare(`DELETE FROM site_uptime_days`)]);
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
});
afterEach(() => { vi.restoreAllMocks(); });

const siteOf = async () => (await seedClient()).site!.id;

/** `n` checks five minutes apart from `startIso`; every `failEvery`-th one (1-based) fails, none when 0. */
async function checks(siteId: string, startIso: string, n: number, failEvery = 0): Promise<void> {
  const t0 = Date.parse(startIso);
  const rows = Array.from({ length: n }, (_, i) =>
    env.DB.prepare(`INSERT INTO site_checks (id, site_id, checked_at, ok, status, ms, error) VALUES (?, ?, ?, ?, NULL, NULL, NULL)`)
      .bind(crypto.randomUUID(), siteId, new Date(t0 + i * STEP).toISOString(), failEvery > 0 && (i + 1) % failEvery === 0 ? 0 : 1));
  for (let i = 0; i < rows.length; i += 90) await env.DB.batch(rows.slice(i, i + 90));
}

describe("localDay", () => {
  it("puts 23:30 local on its own date even when UTC has already moved on", () => {
    expect(localDay("2026-12-01T07:30:00.000Z", LA)).toBe("2026-11-30");
    expect(localDay("2026-12-01T08:00:00.000Z", LA)).toBe("2026-12-01");
  });
  it("splits the 23-hour and the 25-hour DST days exactly at local midnight", () => {
    expect(localDay("2026-03-08T07:59:00.000Z", LA)).toBe("2026-03-07");
    expect(localDay("2026-03-08T08:00:00.000Z", LA)).toBe("2026-03-08");
    expect(localDay("2026-03-09T06:55:00.000Z", LA)).toBe("2026-03-08");
    expect(localDay("2026-03-09T07:00:00.000Z", LA)).toBe("2026-03-09");
    expect(localDay("2026-11-01T06:59:00.000Z", LA)).toBe("2026-10-31");
    expect(localDay("2026-11-01T07:00:00.000Z", LA)).toBe("2026-11-01");
    expect(localDay("2026-11-02T07:55:00.000Z", LA)).toBe("2026-11-01");
    expect(localDay("2026-11-02T08:00:00.000Z", LA)).toBe("2026-11-02");
  });
});

describe("uptimeOf", () => {
  it("is null, never 100, when no day is covered", () => {
    expect(uptimeOf([])).toEqual({ percent: null, coveredDays: 0, firstDay: null });
    expect(uptimeOf([{ day: "2026-11-01", checks: 143, okChecks: 143 }])).toEqual({ percent: null, coveredDays: 0, firstDay: null });
  });
  it("counts a day from 144 checks on, and takes the percent over covered days only", () => {
    expect(MIN_CHECKS_FOR_A_DAY).toBe(144);
    const u = uptimeOf([
      { day: "2026-11-03", checks: 144, okChecks: 144 },
      { day: "2026-11-02", checks: 143, okChecks: 0 }, // too few: left out of the percent
      { day: "2026-11-01", checks: 288, okChecks: 276 },
    ]);
    expect(u).toEqual({ percent: 97.2, coveredDays: 2, firstDay: "2026-11-01" }); // 420 / 432
  });
  it("is one decimal: 12 failed of 288 is 95.8", () => {
    expect(uptimeOf([{ day: "2026-11-01", checks: 288, okChecks: 276 }]).percent).toBe(95.8);
  });
});

describe("rollupUptime", () => {
  it("writes the true counts of a day and covers a 288-check day with 12 failures at 95.8%", async () => {
    const id = await siteOf();
    await checks(id, "2026-11-10T08:00:00.000Z", 288, 24); // 12 failures, all on local 11-10
    expect(await rollupUptime(env, new Date("2026-11-11T20:00:00.000Z"))).toBe(1);
    const days = await uptimeDays(env.DB, id, "2026-11-01", "2026-11-30");
    expect(days).toEqual([{ day: "2026-11-10", checks: 288, okChecks: 276 }]);
    expect(uptimeOf(days).percent).toBe(95.8);
  });

  it("assigns a check at 23:30 local to that local day, not the UTC one", async () => {
    const id = await siteOf();
    await checks(id, "2026-12-01T07:30:00.000Z", 1);
    await rollupUptime(env, new Date("2026-12-01T20:00:00.000Z"));
    expect(await uptimeDays(env.DB, id, "2026-11-01", "2026-12-31")).toEqual([{ day: "2026-11-30", checks: 1, okChecks: 1 }]);
  });

  it("writes a day with too few checks with its true counts, and covers it from 144 checks", async () => {
    const id = await siteOf();
    await checks(id, "2026-11-10T08:00:00.000Z", 143);
    await checks(id, "2026-11-11T08:00:00.000Z", 144);
    await rollupUptime(env, new Date("2026-11-12T20:00:00.000Z"));
    const days = await uptimeDays(env.DB, id, "2026-11-01", "2026-11-30");
    expect(days).toEqual([{ day: "2026-11-10", checks: 143, okChecks: 143 }, { day: "2026-11-11", checks: 144, okChecks: 144 }]);
    expect(uptimeOf(days).coveredDays).toBe(1);
  });

  it("puts every check of the 23-hour day (2026-03-08) on that date once, and 276 checks cover it", async () => {
    const id = await siteOf();
    await checks(id, "2026-03-08T08:00:00.000Z", 276 + 2); // the last two are 03-09 (07:00Z and 07:05Z)
    await rollupUptime(env, new Date("2026-03-09T20:00:00.000Z"));
    const days = await uptimeDays(env.DB, id, "2026-03-01", "2026-03-31");
    expect(days).toEqual([{ day: "2026-03-08", checks: 276, okChecks: 276 }, { day: "2026-03-09", checks: 2, okChecks: 2 }]);
    expect(uptimeOf(days.slice(0, 1))).toEqual({ percent: 100, coveredDays: 1, firstDay: "2026-03-08" });
  });

  it("puts every check of the 25-hour day (2026-11-01) on that date once", async () => {
    const id = await siteOf();
    await checks(id, "2026-11-01T07:00:00.000Z", 300 + 1); // the last one is 08:00Z next day: 11-02
    await rollupUptime(env, new Date("2026-11-02T20:00:00.000Z"));
    expect(await uptimeDays(env.DB, id, "2026-11-01", "2026-11-30")).toEqual([
      { day: "2026-11-01", checks: 300, okChecks: 300 }, { day: "2026-11-02", checks: 1, okChecks: 1 },
    ]);
  });

  it("counts checks written with the same time once (a cron that fired twice), a moment is ok when any of its checks was", async () => {
    const id = await siteOf();
    const at = "2026-11-10T20:00:00.000Z";
    await checks(id, at, 1, 1); // failed
    await checks(id, at, 1); // ok, same time
    await checks(id, "2026-11-10T20:05:00.000Z", 1, 1);
    await checks(id, "2026-11-10T20:05:00.000Z", 1, 1);
    await rollupUptime(env, new Date("2026-11-10T21:00:00.000Z"));
    expect(await uptimeDays(env.DB, id, "2026-11-10", "2026-11-10")).toEqual([{ day: "2026-11-10", checks: 2, okChecks: 1 }]);
  });

  it("is idempotent and keeps each site's days apart", async () => {
    const a = await siteOf(), b = await siteOf();
    await checks(a, "2026-11-10T08:00:00.000Z", 200, 10);
    await checks(b, "2026-11-10T08:00:00.000Z", 150);
    const now = new Date("2026-11-11T20:00:00.000Z");
    expect(await rollupUptime(env, now)).toBe(2);
    const first = [await uptimeDays(env.DB, a, "2026-11-01", "2026-11-30"), await uptimeDays(env.DB, b, "2026-11-01", "2026-11-30")];
    expect(await rollupUptime(env, now)).toBe(2);
    expect([await uptimeDays(env.DB, a, "2026-11-01", "2026-11-30"), await uptimeDays(env.DB, b, "2026-11-01", "2026-11-30")]).toEqual(first);
    expect(first).toEqual([[{ day: "2026-11-10", checks: 200, okChecks: 180 }], [{ day: "2026-11-10", checks: 150, okChecks: 150 }]]);
  });

  it("recomputes only from 3 local days back: older rows are left alone", async () => {
    const id = await siteOf();
    await upsertUptimeDay(env.DB, id, "2026-11-01", 288, 288);
    await checks(id, "2026-11-01T08:00:00.000Z", 10);
    await checks(id, "2026-11-08T08:00:00.000Z", 10); // 3 days before 11-11: in
    await checks(id, "2026-11-07T08:00:00.000Z", 10); // 4 days before: out
    await rollupUptime(env, new Date("2026-11-11T20:00:00.000Z"));
    expect(await uptimeDays(env.DB, id, "2026-11-01", "2026-11-30")).toEqual([
      { day: "2026-11-01", checks: 288, okChecks: 288 }, { day: "2026-11-08", checks: 10, okChecks: 10 },
    ]);
  });

  it("keeps the rollup rows after the checks they came from are pruned", async () => {
    const id = await siteOf();
    await checks(id, "2026-10-10T07:00:00.000Z", 288);
    await rollupUptime(env, new Date("2026-10-11T20:00:00.000Z"));
    expect(await pruneChecks(env.DB, "2026-12-01T00:00:00.000Z")).toBe(288);
    expect(await rollupUptime(env, new Date("2026-12-05T20:00:00.000Z"))).toBe(0);
    expect(await uptimeDays(env.DB, id, "2026-10-01", "2026-10-31")).toEqual([{ day: "2026-10-10", checks: 288, okChecks: 288 }]);
  });
});

describe("the daily sweep", () => {
  it("rolls the days up before it prunes, so a day about to lose its checks is kept", async () => {
    const id = await siteOf();
    const now = new Date("2026-12-20T10:00:00.000Z");
    await checks(id, "2026-12-18T08:00:00.000Z", 288, 48); // within the 3 days
    await checks(id, "2026-10-01T08:00:00.000Z", 3); // older than 35 days: pruned, never rolled up now
    expect((await sweepDomains(env, now)).pruned).toBe(3);
    expect(await uptimeDays(env.DB, id, "2026-10-01", "2026-12-31")).toEqual([{ day: "2026-12-18", checks: 288, okChecks: 282 }]);
  });

  it("logs a rollup that fails and still prunes", async () => {
    const id = await siteOf();
    await checks(id, "2026-10-01T08:00:00.000Z", 3);
    await checks(id, "2026-12-19T08:00:00.000Z", 5); // a day to write, so the rollup has something to fail on
    await env.DB.prepare(`ALTER TABLE site_uptime_days RENAME TO site_uptime_days_away`).run();
    try {
      const r = await sweepDomains(env, new Date("2026-12-20T10:00:00.000Z"));
      expect(r.pruned).toBe(3);
    } finally {
      await env.DB.prepare(`ALTER TABLE site_uptime_days_away RENAME TO site_uptime_days`).run();
    }
    expect(errors.some((e) => String(e[0]).includes("uptime rollup"))).toBe(true);
  });
});
