import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import "../src/worker/approvals/careUpdates";
import { onInventoryDone, startSingleRun, startWeeklyBatch } from "../src/worker/care/batch";
import { tickCare1 } from "../src/worker/care/tasks";
import { getBatch, getRun, runsFor, saveInventory, setRunStatus, upsertSeen, type CareBatch } from "../src/worker/db/careUpdates";
import { addCadence } from "../src/worker/db/projects";
import { ensureSeedSops } from "../src/worker/db/sops";
import { getTask, listTasks, patchTask } from "../src/worker/db/tasks";
import "../src/worker/helper/kinds";
import { generateRecurring } from "../src/worker/projects/sweep";
import { onRunDone } from "../src/worker/care/batch";
import { seedClient } from "./fixtures/clients";

const WED = new Date("2026-12-02T17:00:00.000Z"); // a Wednesday in Los Angeles, week 2026-W49
const LAST_WEEK = new Date("2026-11-25T17:00:00.000Z"); // 2026-W48
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
  await env.DB.batch([
    "care_page_checks", "care_runs", "care_batches", "care_updates", "site_inventories", "helper_jobs", "approvals", "tasks", "project_cadences",
  ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`UPDATE sites SET archived_at = '2020-01-01T00:00:00.000Z' WHERE archived_at IS NULL`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});

/** A real client with live Care, a WordPress site with one waiting update and a CARE-1 task for this week (and the week before when asked). */
async function mk(domain: string, o: { lastWeek?: boolean } = {}) {
  const s = await seedClient({ subs: [{ key: "care", monthlyCents: 5000 }] });
  await env.DB.prepare(`UPDATE sites SET domain = ?, cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = ?, wp_path = ?, care_paths = '["/"]' WHERE id = ?`)
    .bind(domain, `${domain.split(".")[0]}-host`, `/var/www/${domain.split(".")[0]}`, s.site!.id).run();
  await saveInventory(env.DB, { siteId: s.site!.id, wpVersion: "6.4", phpVersion: "8.2", groupKey: "brochure", plugins: [], readAt: iso(Date.now()) });
  await upsertSeen(env.DB, s.site!.id, [{ type: "plugin", slug: "akismet", name: "akismet", fromVersion: "1.0", toVersion: "1.1", risk: "minor", rollbackable: true }], iso(Date.now() - 86_400_000));
  await addCadence(env.DB, s.project!.id, "CARE-1");
  if (o.lastWeek) await generateRecurring(env, LAST_WEEK);
  await generateRecurring(env, WED);
  return { ...s, siteId: s.site!.id, businessId: s.businessId };
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
const finishRun = async (runId: string, status: "ok" | "rolled_back" | "failed") => {
  const run = (await getRun(env.DB, runId))!;
  await setRunStatus(env.DB, run.id, ["queued", "running"], status, { summary: "x" }, iso(Date.now()));
  await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(run.helperJobId).run();
  await onRunDone(env, run.batchId);
};

describe("the batch ticks the CARE-1 task", () => {
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

  it("an error while ticking is logged and swallowed, the batch still moves on", async () => {
    const a = await mk("a.com");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation(((sql: string) => {
      if (/FROM tasks/.test(sql)) throw new Error("boom");
      return orig(sql);
    }) as typeof env.DB.prepare);
    const batch = await inventoried();
    spy.mockRestore();
    expect(batch.status).toBe("wave1");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    void a; void getTask;
  });
});
