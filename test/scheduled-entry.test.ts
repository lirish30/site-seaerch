import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listIncidents } from "../src/worker/db/monitoring";
import { monitoringDeps } from "../src/worker/monitoring/sweep";
import { REMINDER_CRON } from "../src/worker/schedule";
import worker from "../src/worker/index";
import { seedClient } from "./fixtures/clients";

// The two runs of one duplicated Cloudflare cron carry the SAME `scheduledTime`. The entry point must hand that time (not the wall clock) to runScheduled,
// or the "two failed checks in a row" rule cannot tell a duplicated run from a second real tick.
const T0 = Date.parse("2027-02-01T10:00:00.000Z");
const FIVE_MIN = 300_000;
const realFetch = monitoringDeps.fetch;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`UPDATE sites SET test = 1, monitoring = 0`),
    env.DB.prepare(`DELETE FROM site_checks`), env.DB.prepare(`DELETE FROM site_incidents`), env.DB.prepare(`DELETE FROM activity`),
  ]);
  monitoringDeps.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
});
afterEach(() => { monitoringDeps.fetch = realFetch; });

/** One run of the worker's cron entry, the way Cloudflare calls it. */
async function cronRun(scheduledTime: number): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled!(createScheduledController({ scheduledTime, cron: REMINDER_CRON }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("scheduled entry and the down rule", () => {
  it("a cron run that fires twice (same scheduledTime) counts as ONE failed check, so it opens no incident", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    await cronRun(T0);
    await cronRun(T0); // the duplicate
    const times = (await env.DB.prepare(`SELECT checked_at FROM site_checks WHERE site_id = ?`).bind(s.site!.id).all<{ checked_at: string }>()).results.map((r) => r.checked_at);
    expect(times).toEqual([new Date(T0).toISOString(), new Date(T0).toISOString()]);
    expect(await listIncidents(env.DB, { open: true })).toEqual([]);
  });

  it("the next real tick (5 minutes later) is the second failure and opens the incident", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12900 }] });
    await cronRun(T0);
    await cronRun(T0);
    await cronRun(T0 + FIVE_MIN);
    const open = await listIncidents(env.DB, { open: true });
    expect(open.map((i) => [i.siteId, i.kind, i.detail])).toEqual([[s.site!.id, "down", "HTTP 503"]]);
  });
});
