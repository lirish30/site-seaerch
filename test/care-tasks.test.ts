import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSite } from "../src/worker/db/sites";
import { approve } from "../src/worker/approvals/decide";
import "../src/worker/approvals/careUpdates";
import { onInventoryDone, startSingleRun, startWeeklyBatch } from "../src/worker/care/batch";
import { tickCare1 } from "../src/worker/care/tasks";
import { getBatch, getRun, insertPageChecks, runsFor, saveInventory, setRunStatus, upsertSeen, type CareBatch } from "../src/worker/db/careUpdates";
import { openIncident } from "../src/worker/db/monitoring";
import { addCadence } from "../src/worker/db/projects";
import { ensureSeedSops } from "../src/worker/db/sops";
import { listTasks, patchTask } from "../src/worker/db/tasks";
import "../src/worker/helper/kinds";
import { generateRecurring } from "../src/worker/projects/sweep";
import { onRunDone } from "../src/worker/care/batch";
import { seedClient } from "./fixtures/clients";
import { tickingClock } from "./fixtures/clock";

const WED = new Date("2026-12-02T17:00:00.000Z"); // a Wednesday in Los Angeles, week 2026-W49
const LAST_WEEK = new Date("2026-11-25T17:00:00.000Z"); // 2026-W48
const iso = (ms: number) => new Date(ms).toISOString();

// An approval of a weekly batch only executes in the batch's own week (I2): the clock is that week's Wednesday, and it keeps running.
let realClock: (() => void) | null = null;
afterEach(() => { realClock?.(); realClock = null; });
beforeEach(async () => {
  realClock = tickingClock(WED);
  await env.DB.batch([
    "care_page_checks", "care_runs", "care_batches", "care_updates", "site_inventories", "helper_jobs", "approvals", "tasks", "project_cadences", "site_incidents",
  ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`UPDATE sites SET archived_at = '2020-01-01T00:00:00.000Z' WHERE archived_at IS NULL`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});

/** A real client with live Care, a WordPress site with one waiting update and a CARE-1 task for this week (and the week before when asked). */
async function mk(domain: string, o: { lastWeek?: boolean; cents?: number; group?: "brochure" | "woocommerce" } = {}) {
  const s = await seedClient({ subs: [{ key: "care", monthlyCents: o.cents ?? 5000 }] });
  await env.DB.prepare(`UPDATE sites SET domain = ?, cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = ?, wp_path = ?, care_paths = '["/"]' WHERE id = ?`)
    .bind(domain, `${domain.split(".")[0]}-host`, `/var/www/${domain.split(".")[0]}`, s.site!.id).run();
  await saveInventory(env.DB, { siteId: s.site!.id, wpVersion: "6.4", phpVersion: "8.2", groupKey: o.group ?? "brochure", plugins: [], readAt: iso(Date.now()) });
  await upsertSeen(env.DB, s.site!.id, [{ type: "plugin", slug: "akismet", name: "akismet", fromVersion: "1.0", toVersion: "1.1", risk: "minor", rollbackable: true }], iso(Date.now() - 86_400_000));
  await addCadence(env.DB, s.project!.id, "CARE-1");
  if (o.lastWeek) await generateRecurring(env, LAST_WEEK);
  await generateRecurring(env, WED);
  return { ...s, siteId: s.site!.id, businessId: s.businessId };
}
/** A second WordPress site for a client that already has one, with a waiting update. */
async function addSite(businessId: string, domain: string) {
  const site = (await createSite(env.DB, { businessId, url: `https://${domain}` })).site!;
  await env.DB.prepare(`UPDATE sites SET domain = ?, cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = ?, wp_path = ?, care_paths = '["/"]' WHERE id = ?`)
    .bind(domain, `${domain.split(".")[0]}-host`, `/var/www/${domain.split(".")[0]}`, site.id).run();
  await saveInventory(env.DB, { siteId: site.id, wpVersion: "6.4", phpVersion: "8.2", groupKey: "brochure", plugins: [], readAt: iso(Date.now()) });
  await upsertSeen(env.DB, site.id, [{ type: "plugin", slug: "akismet", name: "akismet", fromVersion: "1.0", toVersion: "1.1", risk: "minor", rollbackable: true }], iso(Date.now() - 86_400_000));
  return site.id;
}
const care1 = async (projectId: string, period = "2026-W49") => (await listTasks(env.DB, projectId)).find((t) => t.cadenceKey === "CARE-1" && t.periodKey === period)!;
const ticks = async (projectId: string, period?: string) => (await care1(projectId, period)).checklist.map((c) => c.done);

async function inventoried(): Promise<CareBatch> {
  const { batch } = await startWeeklyBatch(env, WED);
  await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE kind = 'care.inventory'`).run();
  await onInventoryDone(env, batch!.id);
  return (await getBatch(env.DB, batch!.id))!;
}
const approveAll = async () => {
  for (const a of (await env.DB.prepare(`SELECT id FROM approvals WHERE kind = 'care.updates' AND status = 'pending' ORDER BY created_at, rowid`).all<{ id: string }>()).results) await approve(env, a.id);
};
const finishRun = async (runId: string, status: "ok" | "changed" | "rolled_back" | "failed") => {
  const run = (await getRun(env.DB, runId))!;
  await setRunStatus(env.DB, run.id, ["queued", "running"], status, { summary: "x" }, iso(Date.now()));
  await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(run.helperJobId).run();
  await onRunDone(env, run.batchId);
};

describe("the batch ticks the CARE-1 task", () => {
  const changedPage = (review: "fine" | "unsure" | "broken") => ({ path: "/", beforeKey: null, afterKey: null, diffKey: null, statusBefore: 200, statusAfter: 200, formsBefore: 1, formsAfter: 1, ssim: 0.9, verdict: "changed" as const, review });
  it.each(["unsure", "broken"] as const)("a client whose page look ended %s keeps 1.6 open and the task not done (M2)", async (review) => {
    const a = await mk("a.com");
    const batch = await inventoried();
    await approveAll();
    const run = (await runsFor(env.DB, batch.id))[0];
    await insertPageChecks(env.DB, run.id, [changedPage(review)]);
    await finishRun(run.id, "changed");
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
    expect(await ticks(a.project!.id)).toEqual([true, true, true, true, true, false]);
    expect((await care1(a.project!.id)).status).not.toBe("done");
  });
  it("a changed run whose site has an open update_failed keeps 1.6 open (M2)", async () => {
    const a = await mk("a.com");
    const batch = await inventoried();
    await approveAll();
    const run = (await runsFor(env.DB, batch.id))[0];
    await insertPageChecks(env.DB, run.id, [changedPage("fine")]);
    await openIncident(env.DB, { siteId: a.siteId, businessId: a.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now: iso(Date.now()) });
    await finishRun(run.id, "changed");
    expect(await ticks(a.project!.id)).toEqual([true, true, true, true, true, false]);
    expect((await care1(a.project!.id)).status).not.toBe("done");
  });
  it("a changed run Claude found fine, with no incident, finishes the task (M2 control)", async () => {
    const a = await mk("a.com");
    const batch = await inventoried();
    await approveAll();
    const run = (await runsFor(env.DB, batch.id))[0];
    await insertPageChecks(env.DB, run.id, [changedPage("fine")]);
    await finishRun(run.id, "changed");
    expect(await ticks(a.project!.id)).toEqual([true, true, true, true, true, true]);
    expect((await care1(a.project!.id)).status).toBe("done");
  });

  it("a clean week ticks every item and finishes the task, step by step", async () => {
    const a = await mk("a.com");
    const batch = await inventoried();
    expect(await ticks(a.project!.id)).toEqual([true, true, false, false, false, false]); // list sorted, canary picked
    await approveAll();
    expect(await ticks(a.project!.id)).toEqual([true, true, false, true, false, false]);
    const [run] = await runsFor(env.DB, batch.id);
    await finishRun(run.id, "ok");
    expect(await ticks(a.project!.id)).toEqual([true, true, true, true, true, true]);
    expect((await care1(a.project!.id)).status).toBe("done");
    await onRunDone(env, batch.id); // a repeat changes nothing and throws nothing
    expect((await care1(a.project!.id)).status).toBe("done");
  });

  it("a wave 2 client's checklist is ticked and finished too, not only the canary's", async () => {
    const a = await mk("a.com", { cents: 5000 });
    const b = await mk("b.com", { cents: 7000 });
    const batch = await inventoried();
    await approveAll(); // wave 1: a.com, the cheapest, is the canary
    expect(await ticks(b.project!.id)).toEqual([true, true, false, false, false, false]);
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    await approveAll(); // wave 2: b.com
    expect(await ticks(b.project!.id)).toEqual([true, true, true, true, false, false]);
    const second = (await runsFor(env.DB, batch.id)).find((r) => r.siteId === b.siteId)!;
    await finishRun(second.id, "ok");
    expect(await ticks(b.project!.id)).toEqual([true, true, true, true, true, true]);
    expect((await care1(b.project!.id)).status).toBe("done");
    expect((await care1(a.project!.id)).status).toBe("done");
  });

  it("a site that rolled back leaves 1.6 open and the task not done", async () => {
    const a = await mk("a.com");
    const batch = await inventoried();
    await approveAll();
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "rolled_back");
    expect(await ticks(a.project!.id)).toEqual([true, true, true, true, true, false]);
    expect((await care1(a.project!.id)).status).not.toBe("done");
  });

  it("a CARE-1 task for another week is untouched", async () => {
    const a = await mk("a.com", { lastWeek: true });
    const batch = await inventoried();
    await approveAll();
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    expect(await ticks(a.project!.id, "2026-W48")).toEqual([false, false, false, false, false, false]);
    expect((await care1(a.project!.id, "2026-W48")).status).toBe("todo");
  });

  it("a task Logan already marked done is untouched", async () => {
    const a = await mk("a.com");
    const t = await care1(a.project!.id);
    await env.DB.prepare(`UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?`).bind(iso(Date.now()), t.id).run();
    expect(await tickCare1(env, a.businessId, "2026-W49", ["1.1", "1.2"], WED)).toBe(false);
    expect(await ticks(a.project!.id)).toEqual([false, false, false, false, false, false]);
  });

  it("a template edited to drop step 1.2 makes tickCare1 change nothing and not throw", async () => {
    const a = await mk("a.com");
    await env.DB.prepare(`DELETE FROM sop_template_steps WHERE key = '1.2' AND template_id = (SELECT id FROM sop_templates WHERE key = 'CARE-1')`).run();
    expect(await tickCare1(env, a.businessId, "2026-W49", ["1.2"], WED)).toBe(false);
    expect(await ticks(a.project!.id)).toEqual([false, false, false, false, false, false]);
  });

  it("never un-ticks, and reports whether anything changed", async () => {
    const a = await mk("a.com");
    expect(await tickCare1(env, a.businessId, "2026-W49", ["1.1"], WED)).toBe(true);
    expect(await tickCare1(env, a.businessId, "2026-W49", ["1.1"], WED)).toBe(false);
    const t = await care1(a.project!.id);
    await patchTask(env.DB, t.id, { checklist: t.checklist.map((c, i) => ({ ...c, done: i === 2 })) }, iso(Date.now()));
    await tickCare1(env, a.businessId, "2026-W49", ["1.1"], WED);
    expect(await ticks(a.project!.id)).toEqual([true, false, true, false, false, false]);
  });

  it("a client with no Care project and no CARE-1 task is fine", async () => {
    const s = await seedClient({ project: false, subs: [{ key: "care", monthlyCents: 5000 }] });
    expect(await tickCare1(env, s.businessId, "2026-W49", ["1.1"], WED)).toBe(false);
  });

  it("a single-site run ticks nothing", async () => {
    const a = await mk("a.com");
    const batch = await startSingleRun(env, a.siteId, WED);
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE kind = 'care.inventory'`).run();
    await onInventoryDone(env, batch.id);
    await approveAll();
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    expect(await ticks(a.project!.id)).toEqual([false, false, false, false, false, false]);
  });

  it("a two-site client finishes only when the batch settles, not when its canary ends first", async () => {
    const x = await mk("a.com", { cents: 4000, group: "brochure" });
    const y = await mk("c.com", { cents: 5000, group: "woocommerce" });
    const bSite = await addSite(x.businessId, "b.com");
    await env.DB.prepare(`UPDATE sites SET archived_at = NULL WHERE id = ?`).bind(bSite).run();
    const batch = await inventoried();
    await approveAll(); // wave 1: a.com and c.com
    const runs = await runsFor(env.DB, batch.id);
    expect(runs).toHaveLength(2);
    const runOf = (siteId: string) => runs.find((r) => r.siteId === siteId)!;
    await finishRun(runOf(x.siteId).id, "ok"); // c.com's canary is still running
    expect(await ticks(x.project!.id)).toEqual([true, true, true, true, false, false]);
    expect((await care1(x.project!.id)).status).not.toBe("done");
    await finishRun(runOf(y.siteId).id, "ok"); // wave 2 is drafted for b.com
    expect((await care1(x.project!.id)).status).not.toBe("done");
    await approveAll();
    const b = (await runsFor(env.DB, batch.id)).find((r) => r.siteId === bSite)!;
    expect((await care1(x.project!.id)).status).not.toBe("done");
    await finishRun(b.id, "ok");
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
    expect(await ticks(x.project!.id)).toEqual([true, true, true, true, true, true]);
    expect((await care1(x.project!.id)).status).toBe("done");
  });

  it("a step inserted into the template after the task was made ticks nothing wrong", async () => {
    const a = await mk("a.com");
    const tid = (await env.DB.prepare(`SELECT id FROM sop_templates WHERE key = 'CARE-1'`).first<{ id: string }>())!.id;
    await env.DB.prepare(`UPDATE sop_template_steps SET position = position + 1 WHERE template_id = ? AND key IN ('1.2','1.3','1.4','1.5','1.6')`).bind(tid).run();
    await env.DB.prepare(`INSERT INTO sop_template_steps (template_id, key, phase_key, phase_title, position, title, owner, est_minutes, done_when, requires, skippable)
      SELECT template_id, '1.1b', phase_key, phase_title, position - 1, 'A new step', owner, 0, 'x', '[]', 0 FROM sop_template_steps WHERE template_id = ? AND key = '1.2'`).bind(tid).run();
    expect(await tickCare1(env, a.businessId, "2026-W49", ["1.2", "1.3"], WED)).toBe(false);
    expect(await ticks(a.project!.id)).toEqual([false, false, false, false, false, false]);
  });

  it("an error in the run ticks is logged and swallowed, and the batch still advances", async () => {
    const a = await mk("a.com");
    const batch = await inventoried();
    await approveAll();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = await import("../src/worker/projects/service");
    const spy = vi.spyOn(svc, "completeTask").mockRejectedValue(new Error("boom"));
    await finishRun((await runsFor(env.DB, batch.id))[0].id, "ok");
    expect((await getBatch(env.DB, batch.id))!.status).toBe("done");
    expect(err).toHaveBeenCalled();
    expect((await care1(a.project!.id)).status).not.toBe("done");
    spy.mockRestore(); err.mockRestore();
  });
});
