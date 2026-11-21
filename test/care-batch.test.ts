import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { approve, reject } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import "../src/worker/approvals/careUpdates";
import { careBackstop, draftWave, onInventoryDone, onRunDone, startSingleRun, startWeeklyBatch } from "../src/worker/care/batch";
import {
  availableFor, getBatch, getRun, insertPageChecks, insertRun, runsFor, saveInventory, setRunStatus, setReview, setUpdateFlag, upsertSeen, type CareBatch, type GroupKey,
} from "../src/worker/db/careUpdates";
import { archiveSite } from "../src/worker/db/sites";
import { createApproval } from "../src/worker/db/approvals";
import { openIncident } from "../src/worker/db/monitoring";
import { BATCH_OVER, OLD_WEEK, WRONG_SHAPE } from "../src/worker/approvals/careUpdates";
import { createSingleBatch, ensureWeeklyBatch, setBatchStatus } from "../src/worker/db/careUpdates";
import { ensureSeedSops } from "../src/worker/db/sops";
import { markSubscription } from "../src/worker/db/subscriptions";
import "../src/worker/helper/kinds";
import { claimHelperJob, completeHelperJob, getHelperJob } from "../src/worker/helper/jobs";
import { createDevice } from "../src/worker/helper/auth";
import { seedClient } from "./fixtures/clients";
import { tickingClock } from "./fixtures/clock";

const WED = new Date("2026-12-02T17:00:00.000Z"); // a Wednesday in Los Angeles
const TUE = new Date("2026-12-01T17:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const daysAgo = (n: number) => iso(Date.now() - n * DAY);

// An approval of a weekly batch only executes within six days of the batch being made (I2, G5): the clock is that week's Wednesday, and it keeps running.
let realClock: (() => void) | null = null;
afterEach(() => { realClock?.(); realClock = null; });
beforeEach(async () => {
  realClock = tickingClock(WED);
  await env.DB.batch([
    "care_page_checks", "care_runs", "care_batches", "care_updates", "site_inventories", "helper_jobs", "approvals", "site_incidents",
  ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`UPDATE sites SET archived_at = '2020-01-01T00:00:00.000Z' WHERE archived_at IS NULL`).run(); // sites of earlier tests stay out of the week
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});

type Seen = { slug: string; risk?: "security" | "major" | "mild" | "minor"; rollbackable?: boolean; type?: "plugin" | "theme" | "core"; to?: string };
/** A real client with live Care at `cents`, a WordPress site read over SSH, an inventory and the given waiting updates. */
async function mk(domain: string, cents: number, o: { slugs?: (string | Seen)[]; group?: GroupKey; test?: boolean; firstSeen?: string } = {}) {
  const s = await seedClient({ test: o.test, subs: [{ key: "care", monthlyCents: cents, test: o.test }] });
  await env.DB.prepare(`UPDATE sites SET domain = ?, cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = ?, wp_path = ?, care_paths = '["/"]' WHERE id = ?`)
    .bind(domain, `${domain.split(".")[0]}-host`, `/var/www/${domain.split(".")[0]}`, s.site!.id).run();
  const seen = (o.slugs ?? ["akismet"]).map((x) => (typeof x === "string" ? { slug: x } : x) as Seen);
  await saveInventory(env.DB, { siteId: s.site!.id, wpVersion: "6.4", phpVersion: "8.2", groupKey: o.group ?? "brochure", plugins: [], readAt: daysAgo(0) });
  await upsertSeen(env.DB, s.site!.id, seen.map((x) => ({
    type: x.type ?? "plugin", slug: x.slug, name: x.slug, fromVersion: "1.0", toVersion: x.to ?? "1.1", risk: x.risk ?? "minor", rollbackable: x.rollbackable ?? true,
  })), o.firstSeen ?? daysAgo(1));
  return { ...s, siteId: s.site!.id, domain };
}
type Site = Awaited<ReturnType<typeof mk>>;

const jobsOf = async (kind: string) => (await env.DB.prepare(`SELECT * FROM helper_jobs WHERE kind = ? ORDER BY created_at, rowid`).bind(kind).all<{ id: string; status: string; payload: string }>()).results;
const approvalsOf = async (kind = "care.updates") => (await env.DB.prepare(`SELECT * FROM approvals WHERE kind = ? ORDER BY created_at, rowid`).bind(kind).all<{ id: string; title: string; preview: string; status: string; payload: string }>()).results
  .map((a) => ({ ...a, payload: JSON.parse(a.payload) as { batchId: string; wave: number; sites: { siteId: string; domain: string; updates: { id: string; slug: string; to: string; needsTick: boolean }[] }[] } }));
const slugsIn = (a: Awaited<ReturnType<typeof approvalsOf>>[number]) => a.payload.sites.map((s) => [s.domain, s.updates.map((u) => u.slug).sort()]);
const doneJobs = (kind: string) => env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE kind = ?`).bind(kind).run();

/** Starts this week's batch and finishes every inventory, the way the helper would: the last one drafts wave 1. */
async function inventoried(): Promise<CareBatch> {
  const { batch } = await startWeeklyBatch(env, WED);
  expect(batch).not.toBeNull();
  await doneJobs("care.inventory");
  await onInventoryDone(env, batch!.id);
  return (await getBatch(env.DB, batch!.id))!;
}
const finishRun = async (runId: string, status: "ok" | "changed" | "rolled_back" | "failed", slugsRolledBack: string[] = []) => {
  const run = (await getRun(env.DB, runId))!;
  await setRunStatus(env.DB, run.id, ["queued", "running"], status, { summary: "x" }, daysAgo(0));
  await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(run.helperJobId).run();
  const job = (await getHelperJob(env.DB, run.helperJobId!))!;
  const ups = (job.payload as { updates: { id: string; slug: string }[] }).updates;
  for (const u of ups) await env.DB.prepare(`UPDATE care_updates SET status = ? WHERE id = ?`).bind(slugsRolledBack.includes(u.slug) ? "rolled_back" : "applied", u.id).run();
  await onRunDone(env, run.batchId);
};
const statusOf = async (siteId: string) => (await env.DB.prepare(`SELECT slug, status FROM care_updates WHERE site_id = ? ORDER BY slug, status`).bind(siteId).all<{ slug: string; status: string }>()).results.map((r) => [r.slug, r.status]);

describe("startWeeklyBatch", () => {
  it("on a Wednesday in Los Angeles queues one inventory per updatable site, none for a test client or one without Care", async () => {
    await mk("a.com", 5000); await mk("b.com", 6000);
    await mk("t.com", 5000, { test: true });
    const nocare = await seedClient({}); await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = 'n-host', wp_path = '/var/www/n' WHERE id = ?`).bind(nocare.site!.id).run();
    const r = await startWeeklyBatch(env, WED);
    expect(r.queued).toBe(2);
    expect(r.batch).toMatchObject({ kind: "weekly", status: "inventory", period: "2026-W49" });
    const jobs = await jobsOf("care.inventory");
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => JSON.parse(j.payload).batchId)).toEqual([r.batch!.id, r.batch!.id]);
    expect((await env.DB.prepare(`SELECT dedupe_key FROM helper_jobs WHERE kind = 'care.inventory' ORDER BY dedupe_key`).all<{ dedupe_key: string }>()).results.every((x) => /^care\.inventory:.+:2026-W49$/.test(x.dedupe_key))).toBe(true);
  });

  it("queues nothing on a Tuesday", async () => {
    await mk("a.com", 5000);
    expect(await startWeeklyBatch(env, TUE)).toEqual({ batch: null, queued: 0 });
    expect(await jobsOf("care.inventory")).toHaveLength(0);
  });

  it("queues nothing when CARE-1 is off", async () => {
    await mk("a.com", 5000);
    await env.DB.prepare(`UPDATE sop_templates SET active = 0 WHERE key = 'CARE-1'`).run();
    expect(await startWeeklyBatch(env, WED)).toEqual({ batch: null, queued: 0 });
  });

  it("twice on the same Wednesday queues once, even after the inventories finished", async () => {
    await mk("a.com", 5000);
    expect((await startWeeklyBatch(env, WED)).queued).toBe(1);
    await doneJobs("care.inventory");
    expect((await startWeeklyBatch(env, WED)).queued).toBe(0);
    expect(await jobsOf("care.inventory")).toHaveLength(1);
  });

  it("a week with no site to read goes straight to done", async () => {
    const r = await startWeeklyBatch(env, WED);
    expect(r.queued).toBe(0);
    expect((await getBatch(env.DB, r.batch!.id))!.status).toBe("done");
  });
});

describe("waves", () => {
  it("wave 1 is one approval naming only the cheapest brochure site; approving it queues one care.update job", async () => {
    const a = await mk("a.com", 7000, { slugs: ["akismet", "yoast"] }), b = await mk("b.com", 5000, { slugs: ["akismet", "yoast"] }), c = await mk("c.com", 6000, { slugs: ["akismet"] });
    const batch = await inventoried();
    expect(batch.status).toBe("wave1");
    const ap = await approvalsOf();
    expect(ap).toHaveLength(1);
    expect(ap[0].title).toBe("Care updates: wave 1 (1 site, 2 updates)");
    expect(slugsIn(ap[0])).toEqual([["b.com", ["akismet", "yoast"]]]);
    expect(ap[0].preview).toContain("b.com");
    expect(ap[0].preview).not.toContain("a.com");
    expect(await jobsOf("care.update")).toHaveLength(0);
    expect(await approve(env, ap[0].id)).toEqual({ ok: true });
    const jobs = await jobsOf("care.update");
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload).siteId).toBe(b.siteId);
    const runs = await runsFor(env.DB, batch.id);
    expect(runs.map((r) => [r.siteId, r.wave, r.status, r.approvalId])).toEqual([[b.siteId, 1, "queued", ap[0].id]]);
    expect(await statusOf(a.siteId)).toEqual([["akismet", "available"], ["yoast", "available"]]);
    void c;
  });

  it("when the canary's run is ok, wave 2 is drafted for the other sites; when that is done the batch is done", async () => {
    await mk("a.com", 7000); const b = await mk("b.com", 5000); await mk("c.com", 6000);
    const batch = await inventoried();
    const w1 = (await approvalsOf())[0];
    await approve(env, w1.id);
    const run = (await runsFor(env.DB, batch.id))[0];
    await onRunDone(env, batch.id); // still running: nothing yet
    expect(await approvalsOf()).toHaveLength(1);
    await finishRun(run.id, "ok");
    const all = await approvalsOf();
    expect(all).toHaveLength(2);
    expect(all[1].title).toBe("Care updates: wave 2 (2 sites, 2 updates)");
    expect(slugsIn(all[1])).toEqual([["a.com", ["akismet"]], ["c.com", ["akismet"]]]);
    expect(all[1].payload.sites.some((s) => s.siteId === b.siteId)).toBe(false);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("wave2");
    await approve(env, all[1].id);
    const runs = (await runsFor(env.DB, batch.id)).filter((r) => r.wave === 2);
    expect(runs).toHaveLength(2);
    await finishRun(runs[0].id, "ok");
    expect((await getBatch(env.DB, batch.id))!.status).toBe("wave2");
    await finishRun(runs[1].id, "ok");
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
    await onRunDone(env, batch.id); // a replay changes nothing
    expect(await approvalsOf()).toHaveLength(2);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
  });

  it("when the canary rolled back plugin x, wave 2 leaves x out for every site", async () => {
    await mk("a.com", 7000, { slugs: ["akismet", "x"] }); await mk("b.com", 5000, { slugs: ["akismet", "x"] }); await mk("c.com", 6000, { slugs: ["x", "yoast"] });
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "rolled_back", ["x"]);
    const w2 = (await approvalsOf())[1];
    expect(slugsIn(w2)).toEqual([["a.com", ["akismet"]], ["c.com", ["yoast"]]]);
  });

  it("a canary page still pending review keeps its group out of wave 2 until the review lands", async () => {
    await mk("a.com", 7000); await mk("b.com", 5000);
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    const run = (await runsFor(env.DB, batch.id))[0];
    await insertPageChecks(env.DB, run.id, [{ path: "/", beforeKey: null, afterKey: null, diffKey: null, statusBefore: 200, statusAfter: 200, formsBefore: 1, formsAfter: 1, ssim: 0.9, verdict: "changed", review: "pending" }]);
    await finishRun(run.id, "changed");
    expect(await approvalsOf()).toHaveLength(1);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("wave1");
    await onRunDone(env, batch.id);
    await careBackstop(env, new Date());
    expect(await approvalsOf()).toHaveLength(1);
    const check = (await env.DB.prepare(`SELECT id FROM care_page_checks WHERE run_id = ?`).bind(run.id).first<{ id: string }>())!;
    await setReview(env.DB, check.id, ["pending"], "fine");
    await onRunDone(env, batch.id);
    const all = await approvalsOf();
    expect(all).toHaveLength(2);
    expect(slugsIn(all[1])).toEqual([["a.com", ["akismet"]]]);
  });

  it("a pending review in one group does not hold another group's wave 2", async () => {
    await mk("a.com", 7000, { group: "brochure" }); await mk("b.com", 5000, { group: "brochure" });
    await mk("c.com", 9000, { group: "booking" }); await mk("d.com", 5000, { group: "booking" });
    await mk("e.com", 9500, { group: "booking" });
    const batch = await inventoried();
    const w1 = (await approvalsOf())[0];
    expect(w1.payload.sites.map((s) => s.domain).sort()).toEqual(["b.com", "d.com"]);
    await approve(env, w1.id);
    const runs = await runsFor(env.DB, batch.id);
    const brochure = runs.find((r) => r.siteId === w1.payload.sites.find((s) => s.domain === "b.com")!.siteId)!;
    await insertPageChecks(env.DB, brochure.id, [{ path: "/", beforeKey: null, afterKey: null, diffKey: null, statusBefore: 200, statusAfter: 200, formsBefore: 1, formsAfter: 1, ssim: 0.9, verdict: "changed", review: "pending" }]);
    await finishRun(brochure.id, "changed");
    await finishRun(runs.find((r) => r.id !== brochure.id)!.id, "ok");
    const all = await approvalsOf();
    expect(all).toHaveLength(2);
    expect(slugsIn(all[1])).toEqual([["c.com", ["akismet"]], ["e.com", ["akismet"]]]);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("wave1"); // the brochure group is still waiting
    await onRunDone(env, batch.id);
    expect(await approvalsOf()).toHaveLength(2);
  });

  it("with no canary due, wave 2 is drafted at once for every site with updates; nothing due anywhere is done", async () => {
    // Every update is a major seen yesterday: not due, so nothing is drafted and the batch is done.
    await mk("a.com", 5000, { slugs: [{ slug: "big", risk: "major" }] });
    const batch = await inventoried();
    expect(await approvalsOf()).toHaveLength(0);
    expect(batch.status).toBe("done");
  });

  it("a major first seen 3 days ago is in no wave; a major marked security is", async () => {
    const a = await mk("a.com", 5000, { slugs: [{ slug: "old", risk: "major" }, { slug: "sec", risk: "major" }, "akismet"], firstSeen: daysAgo(3) });
    const sec = (await availableFor(env.DB, a.siteId)).find((u) => u.slug === "sec")!;
    await setUpdateFlag(env.DB, sec.id, "security", true);
    await inventoried();
    expect(slugsIn((await approvalsOf())[0])).toEqual([["a.com", ["akismet", "sec"]]]);
  });

  it("a major seen 8 days ago is in the wave and marked [needs your OK]", async () => {
    await mk("a.com", 5000, { slugs: [{ slug: "old", risk: "major" }, "akismet"], firstSeen: daysAgo(8) });
    await inventoried();
    const ap = (await approvalsOf())[0];
    expect(ap.payload.sites[0].updates.find((u) => u.slug === "old")!.needsTick).toBe(true);
    const lines = ap.preview.split("\n");
    expect(lines.find((l) => l.includes("old"))).toContain("[needs your OK]");
    expect(lines.find((l) => l.includes("akismet"))).not.toContain("[needs your OK]");
  });

  it("a held update is in no wave, and one held after the draft but before approval is not queued", async () => {
    const a = await mk("a.com", 5000, { slugs: ["akismet", "yoast", "hello"] });
    const ups = await availableFor(env.DB, a.siteId);
    await setUpdateFlag(env.DB, ups.find((u) => u.slug === "hello")!.id, "held", true);
    const batch = await inventoried();
    const ap = (await approvalsOf())[0];
    expect(slugsIn(ap)).toEqual([["a.com", ["akismet", "yoast"]]]);
    await setUpdateFlag(env.DB, ups.find((u) => u.slug === "yoast")!.id, "held", true);
    await approve(env, ap.id);
    const job = JSON.parse((await jobsOf("care.update"))[0].payload) as { updates: { slug: string }[] };
    expect(job.updates.map((u) => u.slug)).toEqual(["akismet"]);
    expect(await statusOf(a.siteId)).toEqual([["akismet", "queued"], ["hello", "available"], ["yoast", "available"]]);
    expect((await runsFor(env.DB, batch.id))).toHaveLength(1);
  });

  it("a rejected wave 1 cancels the batch and never drafts wave 2", async () => {
    await mk("a.com", 5000); await mk("b.com", 6000);
    const batch = await inventoried();
    expect(await reject(env.DB, (await approvalsOf())[0].id)).toBe(true);
    await onRunDone(env, batch.id);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("cancelled");
    expect(await approvalsOf()).toHaveLength(1);
  });

  it("onInventoryDone waits while an inventory job of the batch is still open, and is safe to repeat", async () => {
    await mk("a.com", 5000); await mk("b.com", 6000);
    const { batch } = await startWeeklyBatch(env, WED);
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = (SELECT id FROM helper_jobs WHERE kind = 'care.inventory' LIMIT 1)`).run();
    await onInventoryDone(env, batch!.id);
    expect(await approvalsOf()).toHaveLength(0);
    await doneJobs("care.inventory");
    await onInventoryDone(env, batch!.id);
    await onInventoryDone(env, batch!.id);
    expect(await approvalsOf()).toHaveLength(1);
  });

  it("two draftWave calls for one wave make one approval", async () => {
    await mk("a.com", 5000);
    const { batch } = await startWeeklyBatch(env, WED);
    await doneJobs("care.inventory");
    const [x, y] = await Promise.all([draftWave(env, batch!, 1), draftWave(env, batch!, 1)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(await approvalsOf()).toHaveLength(1);
  });
});

describe("fix round 1", () => {
  const dropCanary = async (batchId: string, siteId: string) => {
    const run = (await runsFor(env.DB, batchId)).find((r) => r.siteId === siteId)!;
    await setRunStatus(env.DB, run.id, ["queued", "running"], "dropped", { summary: "x" }, daysAgo(0));
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(run.helperJobId).run();
    return run;
  };

  it("a group whose only canary was dropped is absent from wave 2 and named in the preview; another group goes ahead", async () => {
    await mk("a.com", 7000, { group: "brochure" }); const b = await mk("b.com", 5000, { group: "brochure" });
    await mk("c.com", 9000, { group: "booking" }); await mk("d.com", 5000, { group: "booking" });
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    const runs = await runsFor(env.DB, batch.id);
    await dropCanary(batch.id, b.siteId);
    await finishRun(runs.find((r) => r.siteId !== b.siteId)!.id, "ok");
    const all = await approvalsOf();
    expect(all).toHaveLength(2);
    expect(slugsIn(all[1])).toEqual([["c.com", ["akismet"]]]);
    expect(all[1].preview).toContain("waits until next week: no canary ran for the brochure sites");
  });

  it("when every group's canary was dropped there is no wave 2 and the batch is done", async () => {
    await mk("a.com", 7000); const b = await mk("b.com", 5000);
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    await dropCanary(batch.id, b.siteId);
    await onRunDone(env, batch.id);
    expect(await approvalsOf()).toHaveLength(1);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
  });

  it("a group with one dropped and one ok canary goes ahead", async () => {
    const sites: Site[] = [];
    for (const [d, c] of [["a.com", 5000], ["b.com", 5100], ["c.com", 5200], ["d.com", 5300], ["e.com", 5400], ["f.com", 5500], ["g.com", 9000]] as const) sites.push(await mk(d, c));
    const batch = await inventoried(); // six or more in a group: two canaries (a, b)
    await approve(env, (await approvalsOf())[0].id);
    await dropCanary(batch.id, sites[0].siteId);
    await finishRun((await runsFor(env.DB, batch.id)).find((r) => r.siteId === sites[1].siteId)!.id, "ok");
    const w2 = (await approvalsOf())[1];
    expect(w2.payload.sites.map((s) => s.domain).sort()).toEqual(["c.com", "d.com", "e.com", "f.com", "g.com"]);
  });

  it("a site in a rejected wave-2 approval is not offered again", async () => {
    await mk("a.com", 7000, { group: "brochure" }); const b = await mk("b.com", 5000, { group: "brochure" });
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    const w2 = (await approvalsOf())[1];
    expect(await reject(env.DB, w2.id)).toBe(true);
    await onRunDone(env, batch.id);
    await careBackstop(env, new Date());
    expect(await approvalsOf()).toHaveLength(2);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
    void b;
  });

  it("Tuesday evening in Los Angeles is not Wednesday", async () => {
    await mk("a.com", 5000);
    expect(await startWeeklyBatch(env, new Date("2026-12-02T03:00:00Z"))).toEqual({ batch: null, queued: 0 });
  });
});

describe("executing an approval later", () => {
  /** Four sites: a canary that passes, then a wave 2 for the other three. */
  async function wave2() {
    const b = await mk("b.com", 5000); const a = await mk("a.com", 7000); const c = await mk("c.com", 8000); const d = await mk("d.com", 9000);
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    const ap = (await approvalsOf())[1];
    expect(ap.payload.sites).toHaveLength(3);
    return { batch, ap, a, b, c, d };
  }

  it("queues nothing for an archived site, a cancelled Care plan or an update applied by hand, and leaves a dropped run with a reason", async () => {
    const { batch, ap, a, c, d } = await wave2();
    await archiveSite(env.DB, a.siteId, daysAgo(0));
    await markSubscription(env.DB, (await env.DB.prepare(`SELECT id FROM subscriptions WHERE business_id = ?`).bind(c.businessId).first<{ id: string }>())!.id, { status: "cancelled" });
    await upsertSeen(env.DB, d.siteId, [], daysAgo(0)); // applied by hand: no longer waiting, so `gone`
    expect(await statusOf(d.siteId)).toEqual([["akismet", "gone"]]);
    expect(await approve(env, ap.id)).toEqual({ ok: true });
    expect(await jobsOf("care.update")).toHaveLength(1); // only the canary's
    const runs = (await runsFor(env.DB, batch.id)).filter((r) => r.wave === 2);
    expect(runs.map((r) => r.status)).toEqual(["dropped", "dropped", "dropped"]);
    for (const r of runs) { expect(r.summary).toBeTruthy(); expect(r.approvalId).toBe(ap.id); }
    expect(runs.find((r) => r.siteId === a.siteId)!.summary).toMatch(/no longer/i);
    expect(runs.find((r) => r.siteId === d.siteId)!.summary).toMatch(/already|nothing/i);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
  });

  it("does not queue an old version after a newer one was seen", async () => {
    const { ap, a, batch } = await wave2();
    await upsertSeen(env.DB, a.siteId, [{ type: "plugin", slug: "akismet", name: "akismet", fromVersion: "1.0", toVersion: "1.2", risk: "minor", rollbackable: true }], daysAgo(0));
    await approve(env, ap.id);
    const jobs = (await jobsOf("care.update")).map((j) => JSON.parse(j.payload) as { siteId: string; updates: { to: string }[] });
    expect(jobs.find((j) => j.siteId === a.siteId)).toBeUndefined();
    expect((await runsFor(env.DB, batch.id)).find((r) => r.siteId === a.siteId && r.wave === 2)!.status).toBe("dropped");
    expect(await statusOf(a.siteId)).toEqual([["akismet", "available"], ["akismet", "gone"]]);
  });

  it("running execute a second time queues nothing new", async () => {
    const { ap, batch } = await wave2();
    const handler = getHandler("care.updates")!;
    const full = (await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(ap.id).first<Record<string, unknown>>())!;
    const a = { ...full, payload: ap.payload } as never;
    await handler.execute(env, handler.parse(ap.payload), a);
    const afterOne = [(await jobsOf("care.update")).length, (await runsFor(env.DB, batch.id)).length];
    await handler.execute(env, handler.parse(ap.payload), a);
    expect([(await jobsOf("care.update")).length, (await runsFor(env.DB, batch.id)).length]).toEqual(afterOne);
  });
});

describe("startSingleRun", () => {
  it("works for a test site, queues one inventory and then drafts one approval named for the domain", async () => {
    const t = await mk("t.com", 5000, { test: true });
    const batch = await startSingleRun(env, t.siteId, WED);
    expect(batch).toMatchObject({ kind: "single", siteId: t.siteId, status: "inventory" });
    const jobs = await jobsOf("care.inventory");
    expect(jobs).toHaveLength(1);
    await doneJobs("care.inventory");
    await onInventoryDone(env, batch.id);
    const ap = await approvalsOf();
    expect(ap).toHaveLength(1);
    expect(ap[0]).toMatchObject({ title: "Care updates: t.com" });
    expect(ap[0].payload.wave).toBe(0);
    await approve(env, ap[0].id);
    const runs = await runsFor(env.DB, batch.id);
    expect(runs.map((r) => [r.wave, r.status])).toEqual([[0, "queued"]]);
    await finishRun(runs[0].id, "ok");
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
  });

  it("refuses a site that is not updatable, with a plain sentence", async () => {
    const m = await mk("m.com", 5000);
    await env.DB.prepare(`UPDATE sites SET access_method = 'mainwp' WHERE id = ?`).bind(m.siteId).run();
    await expect(startSingleRun(env, m.siteId, WED)).rejects.toThrow(/not|cannot|can't/i);
    await expect(startSingleRun(env, "nope", WED)).rejects.toThrow();
    expect(await jobsOf("care.inventory")).toHaveLength(0);
  });

  it("refuses a site that already has an open run", async () => {
    const t = await mk("t.com", 5000, { test: true });
    const b = await startSingleRun(env, t.siteId, WED);
    await doneJobs("care.inventory");
    await onInventoryDone(env, b.id);
    await approve(env, (await approvalsOf())[0].id);
    await expect(startSingleRun(env, t.siteId, WED)).rejects.toThrow(/already/i);
  });
});

describe("careBackstop", () => {
  it("drafts the wave an onRunDone missed, and does not draft it twice", async () => {
    await mk("a.com", 7000); await mk("b.com", 5000);
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    const run = (await runsFor(env.DB, batch.id))[0];
    // The run ended but its hook never ran.
    await setRunStatus(env.DB, run.id, ["queued"], "ok", { summary: "x" }, daysAgo(0));
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done'`).run();
    const first = await careBackstop(env, new Date());
    expect(first.drafted).toBe(1);
    expect(await approvalsOf()).toHaveLength(2);
    const again = await careBackstop(env, new Date());
    expect(again.drafted).toBe(0);
    expect(await approvalsOf()).toHaveLength(2);
  });

  it("drafts wave 1 for a batch whose last inventory hook was lost", async () => {
    await mk("a.com", 5000);
    await startWeeklyBatch(env, WED);
    await doneJobs("care.inventory");
    expect((await careBackstop(env, new Date())).drafted).toBe(1);
    expect(await approvalsOf()).toHaveLength(1);
  });

  it("cancels a weekly batch older than 6 days still in inventory and expires its open inventory jobs", async () => {
    await mk("a.com", 5000);
    const { batch } = await startWeeklyBatch(env, WED);
    const r = await careBackstop(env, new Date(WED.getTime() + 7 * DAY));
    expect(r.cancelled).toBe(1);
    expect((await getBatch(env.DB, batch!.id))!.status).toBe("cancelled");
    expect((await jobsOf("care.inventory")).map((j) => j.status)).toEqual(["expired"]);
    expect((await careBackstop(env, new Date(WED.getTime() + 7 * DAY))).cancelled).toBe(0);
  });

  it("leaves a young batch in inventory alone", async () => {
    await mk("a.com", 5000);
    const { batch } = await startWeeklyBatch(env, WED);
    expect((await careBackstop(env, new Date(WED.getTime() + 2 * DAY))).cancelled).toBe(0);
    expect((await getBatch(env.DB, batch!.id))!.status).toBe("inventory");
  });

  it("drops a queued run that never got a job after 30 minutes and frees its updates; a fresh one is left", async () => {
    const a = await mk("a.com", 5000, { slugs: ["akismet", "yoast"] });
    const b = await mk("b.com", 5000);
    const { batch } = await startWeeklyBatch(env, WED);
    await env.DB.prepare(`UPDATE care_updates SET status = 'queued'`).run();
    const old = await insertRun(env.DB, { batchId: batch!.id, siteId: a.siteId, wave: 1, now: iso(Date.now() - 45 * 60_000) });
    const fresh = await insertRun(env.DB, { batchId: batch!.id, siteId: b.siteId, wave: 1, now: iso(Date.now() - 5 * 60_000) });
    await careBackstop(env, new Date());
    expect((await getRun(env.DB, old.id))!).toMatchObject({ status: "dropped", summary: "the update job was never queued" });
    expect((await getRun(env.DB, fresh.id))!.status).toBe("queued");
    expect(await statusOf(a.siteId)).toEqual([["akismet", "available"], ["yoast", "available"]]);
    expect(await statusOf(b.siteId)).toEqual([["akismet", "queued"]]);
  });

  it("drops a run whose helper job row does not exist", async () => {
    const a = await mk("a.com", 5000);
    const { batch } = await startWeeklyBatch(env, WED);
    const run = await insertRun(env.DB, { batchId: batch!.id, siteId: a.siteId, wave: 1, helperJobId: "gone", now: iso(Date.now() - 45 * 60_000) });
    await careBackstop(env, new Date());
    expect((await getRun(env.DB, run.id))!.status).toBe("dropped");
  });
});

describe("the daily cron", () => {
  it("starts the weekly batch on Wednesday and not on Tuesday", async () => {
    await mk("a.com", 5000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 404 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runScheduled(env, DAILY_CRON, TUE);
      expect(await jobsOf("care.inventory")).toHaveLength(0);
      await runScheduled(env, DAILY_CRON, WED);
      expect(await jobsOf("care.inventory")).toHaveLength(1);
    } finally { vi.restoreAllMocks(); }
  });
});

describe("the last inventory, completed the way the helper route does it", () => {
  it("drafts wave 1 when the last inventory job is completed, though that job is still claimed while its result is applied", async () => {
    const a = await mk("a.com", 5000), b = await mk("b.com", 6000);
    const { batch } = await startWeeklyBatch(env, WED);
    const device = (await createDevice(env.DB, "Test Mac")).device.id;
    const result = { wpVersion: "6.4", phpVersion: "8.2", core: null, plugins: [{ slug: "akismet", name: "Akismet", status: "active", version: "1.0", updateVersion: "1.1", fromWporg: true }], themes: [], activeTheme: null, dropped: 0 };
    const first = (await claimHelperJob(env, device, new Date(), ["care.inventory"]))!;
    const second = (await claimHelperJob(env, device, new Date(), ["care.inventory"]))!;
    expect(await completeHelperJob(env, first.id, device, result)).toEqual({ ok: true });
    expect(await approvalsOf()).toHaveLength(0); // the other site is still being read
    expect((await getBatch(env.DB, batch!.id))!.status).toBe("inventory");
    expect(await completeHelperJob(env, second.id, device, result)).toEqual({ ok: true });
    expect((await getBatch(env.DB, batch!.id))!.status).toBe("wave1");
    expect((await approvalsOf()).map((x) => x.title)).toEqual(["Care updates: wave 1 (1 site, 1 update)"]);
    void a; void b;
  });
});

describe("execute refuses an approval that does not fit its batch (I1, I2)", () => {
  const entry = async (siteId: string) => ({ siteId, domain: "x", updates: (await availableFor(env.DB, siteId)).map((u) => ({ id: u.id, type: u.type, slug: u.slug, name: u.name, from: u.fromVersion, to: u.toVersion, risk: u.risk, needsTick: false })) });
  const handMade = async (payload: unknown) => createApproval(env.DB, { kind: "care.updates", title: "x", preview: "x", payload, drafted_by: "mcp" });
  const nothingQueued = async () => expect([(await jobsOf("care.update")).length, (await env.DB.prepare(`SELECT COUNT(*) AS n FROM care_runs`).first<{ n: number }>())!.n]).toEqual([0, 0]);

  it("a wave 0 for a weekly batch, a weekly wave for a single batch, and a wave 0 naming another site are refused", async () => {
    const a = await mk("a.com", 5000); const b = await mk("b.com", 6000);
    const { batch: weekly } = await ensureWeeklyBatch(env.DB, "2026-W49", WED.toISOString());
    const single = await createSingleBatch(env.DB, a.siteId, "2026-W49", WED.toISOString());
    for (const payload of [
      { batchId: weekly.id, wave: 0, sites: [await entry(a.siteId)] },
      { batchId: single.id, wave: 1, sites: [await entry(a.siteId)] },
      { batchId: single.id, wave: 0, sites: [await entry(b.siteId)] },
      { batchId: single.id, wave: 0, sites: [await entry(a.siteId), await entry(b.siteId)] },
    ]) {
      const ap = await handMade(payload);
      expect(await approve(env, ap.id)).toEqual({ ok: false, error: WRONG_SHAPE, status: 502 });
      expect((await env.DB.prepare(`SELECT status, error FROM approvals WHERE id = ?`).bind(ap.id).first())).toEqual({ status: "pending", error: WRONG_SHAPE });
    }
    await nothingQueued();
    const ok = await handMade({ batchId: single.id, wave: 0, sites: [await entry(a.siteId)] });
    expect(await approve(env, ok.id)).toEqual({ ok: true });
  });

  it("a done or cancelled batch is refused with a plain sentence and nothing queued", async () => {
    const a = await mk("a.com", 5000);
    for (const to of ["done", "cancelled"] as const) {
      const single = await createSingleBatch(env.DB, a.siteId, "2026-W49", WED.toISOString());
      await setBatchStatus(env.DB, single.id, ["inventory"], to, WED.toISOString());
      const ap = await handMade({ batchId: single.id, wave: 0, sites: [await entry(a.siteId)] });
      expect(await approve(env, ap.id)).toMatchObject({ ok: false, error: BATCH_OVER });
    }
    await nothingQueued();
  });

  it("a wave of last week's weekly batch is refused (the clock is this week)", async () => {
    const a = await mk("a.com", 5000);
    const { batch } = await ensureWeeklyBatch(env.DB, "2026-W48", "2026-11-25T17:00:00.000Z");
    await setBatchStatus(env.DB, batch.id, ["inventory"], "wave1", WED.toISOString());
    const ap = await handMade({ batchId: batch.id, wave: 1, sites: [await entry(a.siteId)] });
    expect(await approve(env, ap.id)).toMatchObject({ ok: false, error: OLD_WEEK });
    await nothingQueued();
  });

  it("a new week's batch rejects last week's pending waves with a note and cancels that batch; a settled one is left alone", async () => {
    const a = await mk("a.com", 5000);
    const { batch: old } = await ensureWeeklyBatch(env.DB, "2026-W48", "2026-11-25T17:00:00.000Z");
    await setBatchStatus(env.DB, old.id, ["inventory"], "wave2", WED.toISOString());
    const { batch: older } = await ensureWeeklyBatch(env.DB, "2026-W47", "2026-11-18T17:00:00.000Z");
    await setBatchStatus(env.DB, older.id, ["inventory"], "done", WED.toISOString());
    const single = await createSingleBatch(env.DB, a.siteId, "2026-W48", "2026-11-25T17:00:00.000Z");
    const stale = await handMade({ batchId: old.id, wave: 2, sites: [await entry(a.siteId)] });
    const rehearsal = await handMade({ batchId: single.id, wave: 0, sites: [await entry(a.siteId)] });
    const { batch } = await startWeeklyBatch(env, WED);
    expect(batch!.period).toBe("2026-W49");
    expect(await env.DB.prepare(`SELECT status, decision_note FROM approvals WHERE id = ?`).bind(stale.id).first()).toEqual({ status: "rejected", decision_note: "replaced by this week's batch" });
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(rehearsal.id).first<{ status: string }>())!.status).toBe("pending"); // a single run is not a week's batch
    expect((await getBatch(env.DB, old.id))!.status).toBe("cancelled");
    expect((await getBatch(env.DB, older.id))!.status).toBe("done");
    expect((await getBatch(env.DB, single.id))!.status).toBe("inventory");
  });
});

describe("a site with an open update_failed sits out the weekly batch (I6)", () => {
  it("gets no inventory and is in no wave; a single-site run may still take it", async () => {
    const a = await mk("a.com", 5000); const b = await mk("b.com", 6000);
    await openIncident(env.DB, { siteId: a.siteId, businessId: a.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now: WED.toISOString() });
    const batch = await inventoried();
    const inv = (await jobsOf("care.inventory")).map((j) => (JSON.parse(j.payload) as { siteId: string }).siteId);
    expect(inv).toEqual([b.siteId]);
    const w1 = (await approvalsOf())[0];
    expect(w1.payload.sites.map((x) => x.siteId)).toEqual([b.siteId]);
    await approve(env, w1.id);
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    expect((await approvalsOf()).flatMap((x) => x.payload.sites.map((y) => y.siteId))).not.toContain(a.siteId);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
    const single = await startSingleRun(env, a.siteId, WED);
    await doneJobs("care.inventory");
    await onInventoryDone(env, single.id);
    const ap = (await approvalsOf()).find((x) => x.payload.batchId === single.id)!;
    expect(ap.payload.sites.map((x) => x.siteId)).toEqual([a.siteId]);
  });

  it("a site whose incident opens after wave 1 is left out of wave 2", async () => {
    const a = await mk("a.com", 7000); const b = await mk("b.com", 5000); const c = await mk("c.com", 6000);
    const batch = await inventoried();
    await approve(env, (await approvalsOf())[0].id);
    await openIncident(env.DB, { siteId: c.siteId, businessId: c.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now: WED.toISOString() });
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    expect((await approvalsOf())[1].payload.sites.map((x) => x.siteId)).toEqual([a.siteId]);
    void b;
  });
});

describe("a weekly batch's approvals keep for six days, not one ISO week (G5)", () => {
  const entry = async (siteId: string) => ({ siteId, domain: "x", updates: (await availableFor(env.DB, siteId)).map((u) => ({ id: u.id, type: u.type, slug: u.slug, name: u.name, from: u.fromVersion, to: u.toVersion, risk: u.risk, needsTick: false })) });
  const handMade = async (payload: unknown) => createApproval(env.DB, { kind: "care.updates", title: "x", preview: "x", payload, drafted_by: "mcp" });
  const useClock = (at: Date) => { realClock?.(); realClock = tickingClock(at); };

  it("a Saturday batch's wave 2 approved on Monday (the next ISO week) is queued", async () => {
    const a = await mk("a.com", 5000);
    const SAT = new Date("2026-11-28T18:00:00.000Z"); // Saturday 10:00 in Los Angeles, ISO week 2026-W48
    const { batch } = await ensureWeeklyBatch(env.DB, "2026-W48", SAT.toISOString());
    await setBatchStatus(env.DB, batch.id, ["inventory"], "wave2", SAT.toISOString());
    const ap = await handMade({ batchId: batch.id, wave: 2, sites: [await entry(a.siteId)] });
    useClock(new Date("2026-11-30T17:00:00.000Z")); // Monday 09:00, ISO week 2026-W49
    expect(await approve(env, ap.id)).toEqual({ ok: true });
    expect(await jobsOf("care.update")).toHaveLength(1);
  });

  it("an approval of a batch made more than six days ago is refused, even inside the same ISO week", async () => {
    const a = await mk("a.com", 5000);
    const MON = new Date("2026-11-30T08:30:00.000Z"); // Monday 00:30 in Los Angeles, 2026-W49
    const { batch } = await ensureWeeklyBatch(env.DB, "2026-W49", MON.toISOString());
    await setBatchStatus(env.DB, batch.id, ["inventory"], "wave2", MON.toISOString());
    const ap = await handMade({ batchId: batch.id, wave: 2, sites: [await entry(a.siteId)] });
    useClock(new Date("2026-12-07T06:00:00.000Z")); // Sunday 22:00 the same ISO week, 6 days 21.5 hours later
    expect(await approve(env, ap.id)).toMatchObject({ ok: false, error: OLD_WEEK });
    expect(await jobsOf("care.update")).toHaveLength(0);
  });

  it("the backstop cancels a weekly batch older than six days in any wave, with CARE-1 off, rejects its pending waves and leaves queued runs to finish", async () => {
    await mk("a.com", 7000); await mk("b.com", 5000);
    const batch = await inventoried();
    const [wave1] = await approvalsOf();
    expect(await approve(env, wave1.id)).toEqual({ ok: true });
    const [run] = await runsFor(env.DB, batch.id);
    const pending = await handMade({ batchId: batch.id, wave: 2, sites: [wave1.payload.sites[0]] });
    await env.DB.prepare(`UPDATE sop_templates SET active = 0 WHERE key = 'CARE-1'`).run();
    const later = new Date(WED.getTime() + 7 * DAY);
    const r = await careBackstop(env, later);
    expect(r.cancelled).toBe(1);
    expect((await getBatch(env.DB, batch.id))!.status).toBe("cancelled");
    const row = await env.DB.prepare(`SELECT status, decision_note, decided_at, error FROM approvals WHERE id = ?`).bind(pending.id).first<{ status: string; decision_note: string; decided_at: string | null; error: string | null }>();
    expect(row).toMatchObject({ status: "rejected", decision_note: "this week's batch ran out of time", error: null });
    expect(row!.decided_at).toEqual(expect.any(String));
    expect((await getRun(env.DB, run.id))!.status).toBe("queued");
    expect((await getHelperJob(env.DB, run.helperJobId!))!.status).toBe("pending");
    expect((await careBackstop(env, later)).cancelled).toBe(0);
  });

  it("a new week's batch rejects earlier waves the way Logan's reject does (decided_at set)", async () => {
    const a = await mk("a.com", 5000);
    const { batch: old } = await ensureWeeklyBatch(env.DB, "2026-W48", "2026-11-25T17:00:00.000Z");
    await setBatchStatus(env.DB, old.id, ["inventory"], "wave2", WED.toISOString());
    const stale = await handMade({ batchId: old.id, wave: 2, sites: [await entry(a.siteId)] });
    await startWeeklyBatch(env, WED);
    const row = await env.DB.prepare(`SELECT status, decision_note, decided_at, error FROM approvals WHERE id = ?`).bind(stale.id).first<{ decided_at: string | null }>();
    expect(row).toMatchObject({ status: "rejected", decision_note: "replaced by this week's batch", error: null });
    expect(row!.decided_at).toEqual(expect.any(String));
  });
});
