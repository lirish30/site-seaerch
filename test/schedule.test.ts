import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { createCampaign } from "../src/worker/db/campaigns";
import { getRadar } from "../src/worker/db/radar";
import { runScheduled } from "../src/worker/schedule";
import { setMailDeps } from "../src/worker/mail/deps";
import { saveMailbox } from "../src/worker/db/mailboxes";
import type { ImapFetch } from "../src/worker/mail/types";
import { getTask } from "../src/worker/queue/db";
import { createCroAudit, getCroAudit, updateCroAudit } from "../src/worker/db/cro";
import { CRO_SYNTH_KIND, CRO_TARGET } from "../src/worker/queue/croKinds";
import { seedBusiness } from "./fixtures/cro";
import "../src/worker/queue/replyClassify"; // registers reply.classify

const NOW = new Date("2026-10-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAILY = "17 13 * * *";
const EVERY_15 = "*/15 * * * *";

let created: any[] = [];
let origCreate: any;
let errors: unknown[][] = [];
let logs: unknown[][] = [];

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
  created = []; errors = []; logs = [];
  origCreate = env.SEARCH_WORKFLOW.create;
  (env.SEARCH_WORKFLOW as any).create = async (o: any) => { created.push(o); return {} as any; };
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a); });
});
afterEach(() => { (env.SEARCH_WORKFLOW as any).create = origCreate; vi.restoreAllMocks(); setMailDeps(null); });
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

  describe("the queue upkeep", () => {
    const old = (n: number) => iso(NOW.getTime() - n * 86_400_000);
    const seedTask = async (id: string, createdAt: string, status = "pending") =>
      env.DB.prepare(`INSERT INTO claude_tasks (id, kind, payload, status, attempts, created_at) VALUES (?, 'reply.classify', '{}', ?, 0, ?)`).bind(id, status, createdAt).run();
    beforeEach(() => env.DB.batch(["claude_tasks", "cro_audits"].map((t) => env.DB.prepare(`DELETE FROM ${t}`))));

    it("the daily cron expires tasks nobody picked up in 14 days, and leaves newer ones", async () => {
      await seedTask("t-old", old(15)); await seedTask("t-new", old(13)); await seedTask("t-done", old(30), "done");
      await runScheduled(env, DAILY, NOW);
      expect((await getTask(env.DB, "t-old"))!.status).toBe("expired");
      expect((await getTask(env.DB, "t-new"))!.status).toBe("pending");
      expect((await getTask(env.DB, "t-done"))!.status).toBe("done");
      expect(logs.some((l) => l[0] === "expire tasks" && String(l[1]) === "1")).toBe(true);
    });

    it("the daily cron expires Mac helper jobs nobody picked up in 14 days, and leaves newer ones", async () => {
      const seed = (id: string, createdAt: string, status = "pending") =>
        env.DB.prepare(`INSERT INTO helper_jobs (id, kind, payload, status, attempts, created_at) VALUES (?, 'voice.segment', '{"videoId":"v","segmentId":"s","engine":"qwen3-tts","text":"hi"}', ?, 0, ?)`).bind(id, status, createdAt).run();
      await env.DB.prepare(`DELETE FROM helper_jobs`).run();
      await seed("h-old", old(15)); await seed("h-new", old(13)); await seed("h-done", old(30), "done");
      await runScheduled(env, DAILY, NOW);
      const status = async (id: string) => (await env.DB.prepare(`SELECT status FROM helper_jobs WHERE id = ?`).bind(id).first<{ status: string }>())!.status;
      expect(await status("h-old")).toBe("expired");
      expect(await status("h-new")).toBe("pending");
      expect(await status("h-done")).toBe("done");
      expect(logs.some((l) => l[0] === "expire helper jobs" && String(l[1]) === "1")).toBe(true);
    });

    it("the 15-minute cron leaves the queue alone", async () => {
      await seedTask("t-old", old(15));
      await runScheduled(env, EVERY_15, NOW);
      expect((await getTask(env.DB, "t-old"))!.status).toBe("pending");
    });

    it("a failing expiry does not stop the radar run or the scan, and is logged", async () => {
      await seedRadar(); await seedDueCall();
      await expect(runScheduled(failing(/claude_tasks/), DAILY, NOW)).resolves.toBeUndefined();
      expect(created).toHaveLength(1);
      expect(await enrollmentStep()).toBe(3);
      expect(errors.some((e) => String(e[0]).includes("expire tasks"))).toBe(true);
    });

    it("the daily cron sweeps for a CRO audit stuck waiting for its roadmap task", async () => {
      const b = await seedBusiness();
      const a = await createCroAudit(env.DB, b.id);
      // Stuck: every page review is in and the audit moved on to the roadmap, but the roadmap task was never queued.
      await updateCroAudit(env.DB, a.id, {
        status: "waiting", step: "synthesize", pending_pages: [], pages: [{ index: 0, url: "https://ace.com/", kind: "home", ok: true, key: null }],
        page_reviews: [{ page: "https://ace.com/", five_second_read: { thinks_business_does: "plumbing", would_do_next: "call" }, strengths: [], issues: [] }],
      });
      const synth = async () => (await env.DB.prepare(`SELECT status FROM claude_tasks WHERE kind = ? AND target_type = ? AND target_id = ?`).bind(CRO_SYNTH_KIND, CRO_TARGET, a.id).all<{ status: string }>()).results;
      expect(await synth()).toEqual([]); // nothing is queued for it: this is the stuck state
      await runScheduled(env, DAILY, NOW);
      expect(logs.some((l) => l[0] === "cro heal" && String(l[1]) === "1")).toBe(true);
      expect((await synth()).map((t) => t.status)).toEqual(["pending"]); // the sweep put the roadmap task back in the queue
      expect(await getCroAudit(env.DB, a.id)).toMatchObject({ status: "waiting", step: "synthesize" });
      // and a second sweep finds nothing left to heal
      logs.length = 0;
      await runScheduled(env, DAILY, NOW);
      expect(logs.some((l) => l[0] === "cro heal" && String(l[1]) === "0")).toBe(true);
      expect(await synth()).toHaveLength(1);
    });

    it("a failing CRO heal does not stop the scan, and is logged", async () => {
      await seedDueCall();
      await expect(runScheduled(failing(/cro_audits/), DAILY, NOW)).resolves.toBeUndefined();
      expect(await enrollmentStep()).toBe(3);
      expect(errors.some((e) => String(e[0]).includes("cro heal"))).toBe(true);
    });
  });

  describe("the 15-minute mail sync", () => {
    const logged = () => logs.map((c) => String(c[0]));
    const enableOutreach = () => saveMailbox(env.DB, "outreach", {
      enabled: 1, smtp_host: "smtp.mail.test", imap_host: "imap.mail.test", username: "hello@outreach.test", from_email: "hello@outreach.test",
      imap_uid_validity: 1, imap_last_uid: 5, last_sync_error: null,
    });
    const serving = (n: number): ImapFetch => async () => ({
      uidValidity: 1, uidNext: 6 + n, highestUid: 5 + n, skipped: [],
      messages: Array.from({ length: n }, (_, i) => ({ uid: 6 + i, raw: new TextEncoder().encode("From: x@nowhere.test\r\nSubject: hi\r\n\r\nhello") })),
    });
    afterAll(() => saveMailbox(env.DB, "outreach", { enabled: 0, imap_uid_validity: null, imap_last_uid: null, last_sync_error: null }));

    it("logs nothing when no mailbox is enabled or nothing new arrived", async () => {
      await runScheduled(env, EVERY_15, NOW);
      await enableOutreach();
      setMailDeps({ imap: serving(0) });
      await runScheduled(env, EVERY_15, NOW);
      expect(logged().filter((l) => l.startsWith("mail sync"))).toEqual([]);
      expect(errors).toEqual([]);
    });

    it("logs one line when mail was fetched", async () => {
      await enableOutreach();
      setMailDeps({ imap: serving(2) });
      await runScheduled(env, EVERY_15, NOW);
      expect(logged().filter((l) => l.startsWith("mail sync"))).toEqual(["mail sync outreach"]);
      expect(logs.find((c) => c[0] === "mail sync outreach")![1]).toContain('"fetched":2');
    });

    it("an IMAP failure is logged as an error, recorded on the mailbox, and does not fail the cron", async () => {
      await enableOutreach();
      setMailDeps({ imap: async () => { throw new Error("connection refused"); } });
      await expect(runScheduled(env, EVERY_15, NOW)).resolves.toBeUndefined();
      expect(errors.some((e) => String(e[0]).includes("connection refused"))).toBe(true);
      expect(logged().filter((l) => l.startsWith("mail sync"))).toEqual([]);
      expect((await env.DB.prepare(`SELECT last_sync_error FROM mailboxes WHERE key = 'outreach'`).first<{ last_sync_error: string }>())!.last_sync_error).toBe("connection refused");
    });
  });
});
