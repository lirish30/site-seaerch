import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { createCampaign } from "../src/worker/db/campaigns";
import { getRadar } from "../src/worker/db/radar";
import { runScheduled } from "../src/worker/schedule";
import { syncAllMailboxes } from "../src/worker/mail/sync";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAILY = "17 13 * * *";
const EVERY_15 = "*/15 * * * *";

let created: any[] = [];
let origCreate: any;
let errors: unknown[][] = [];

async function seedRadar() {
  await env.DB.prepare(`INSERT INTO radars (id, location, business_type, radius_km, max_results, interval_days, enabled, next_run_at, created_at) VALUES ('r','Boise, ID','plumber',15,50,30,1,?,?)`)
    .bind(iso(NOW.getTime() - 86_400_000), iso(NOW.getTime() - 100 * 86_400_000)).run();
}
/** A due call step: the scan advances it without needing any mail setup, so a changed row proves the scan ran. */
async function seedDueCall() {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Acme Plumbing", category: null, address: null, phone: null, websiteUrl: "https://acme.test", mapsUrl: null, rating: null, reviewCount: null }, s.id);
  const c = await createCampaign(env.DB, { name: "c", niche: "plumber", region: "r", towns: ["Boise, ID"] });
  await env.DB.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, next_due_at, started_at, last_sent_at, last_sent_step)
    VALUES ('e1', ?, ?, 'outreach', 'dana@acme.test', 'active', 2, ?, ?, ?, 1)`).bind(b.id, c.id, iso(NOW.getTime() - 3_600_000), iso(NOW.getTime() - 9 * 86_400_000), iso(NOW.getTime() - 86_400_000)).run();
}
const enrollmentStep = async () => (await env.DB.prepare(`SELECT next_step_index AS n FROM enrollments WHERE id = 'e1'`).first<{ n: number }>())!.n;
/** An env whose database throws for any statement matching `re`: stands in for one part of the cron failing. */
const failing = (re: RegExp) => ({
  ...env,
  DB: new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare") return (sql: string) => { if (re.test(sql)) throw new Error("db down"); return t.prepare(sql); };
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  }),
}) as typeof env;

beforeEach(async () => {
  await env.DB.prepare(`UPDATE fixed_costs SET active = 0`).run();
  await env.DB.batch([...["radars", "searches", "usage", "enrollments", "campaigns"].map((t) => env.DB.prepare(`DELETE FROM ${t}`))]);
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks'.", monthly_spend_limit_usd: 25 });
  created = []; errors = [];
  origCreate = env.SEARCH_WORKFLOW.create;
  (env.SEARCH_WORKFLOW as any).create = async (o: any) => { created.push(o); return {} as any; };
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { (env.SEARCH_WORKFLOW as any).create = origCreate; vi.restoreAllMocks(); });
afterAll(() => saveSettings(env.DB, { monthly_spend_limit_usd: 25 }));

describe("runScheduled", () => {
  it("the daily cron runs the radars and then the sequence scan", async () => {
    await seedRadar(); await seedDueCall();
    await runScheduled(env, DAILY, NOW);
    expect(created).toHaveLength(1);
    expect((await getRadar(env.DB, "r"))!.last_search_id).toBeTruthy();
    expect(await enrollmentStep()).toBe(3);
  });

  it("runScheduled with the 15-minute cron does not run radars", async () => {
    await seedRadar(); await seedDueCall();
    await runScheduled(env, EVERY_15, NOW);
    expect(created).toHaveLength(0);
    expect((await getRadar(env.DB, "r"))!.last_search_id).toBeNull();
    expect(await enrollmentStep()).toBe(2); // the sequence scan is daily too
  });

  it("an unknown cron string is treated as the daily one", async () => {
    await seedRadar();
    await runScheduled(env, "", NOW);
    expect(created).toHaveLength(1);
  });

  it("a failing scan does not stop the radar run", async () => {
    await seedRadar();
    await expect(runScheduled(failing(/enrollments/), DAILY, NOW)).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
    expect((await getRadar(env.DB, "r"))!.last_search_id).toBeTruthy();
    expect(errors.some((e) => String(e[0]).includes("sequence scan"))).toBe(true);
  });

  it("a failing radar run does not stop the scan", async () => {
    await seedDueCall();
    await expect(runScheduled(failing(/radars/), DAILY, NOW)).resolves.toBeUndefined();
    expect(await enrollmentStep()).toBe(3);
    expect(errors.some((e) => String(e[0]).includes("radar run"))).toBe(true);
  });

  it("the mail sync stub resolves", async () => {
    await expect(syncAllMailboxes(env)).resolves.toBeUndefined();
  });
});
