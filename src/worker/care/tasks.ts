import { getBatch, runsFor, updatableSites, type CareBatch } from "../db/careUpdates";
import { getTask, patchTask } from "../db/tasks";
import { getTemplate } from "../db/sops";
import type { Env } from "../env";
import { completeTask } from "../projects/service";

// Ticking each client's weekly CARE-1 task as the weekly batch moves (Plan 12). Only a weekly batch ticks anything: a single-site run is CARE-0's baseline pass or a rehearsal, not the weekly cycle.
// Every call is idempotent, never un-ticks, and an error is logged and swallowed so it can never break the batch.

export type Care1Step = "1.1" | "1.2" | "1.3" | "1.4" | "1.5" | "1.6";
const CARE_1 = "CARE-1";
/** The monthly report's recurring task. Claude never works it through the step queue: the report builder (`care/reportSweep.ts`) does. */
export const CARE_4 = "CARE-4";
const FINAL_RAN = ["ok", "changed", "rolled_back", "failed"];

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const guarded = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
  try { await fn(); } catch (e) { console.error(`care tasks: could not ${what}`, msg(e)); }
};

/** The client's task ids of a recurring template for the period (one per Care project, normally one). */
async function cadenceIds(env: Env, key: string, businessId: string, period: string): Promise<string[]> {
  return (await env.DB.prepare(`SELECT id FROM tasks WHERE business_id = ? AND cadence_key = ? AND period_key = ? AND is_step = 0`).bind(businessId, key, period).all<{ id: string }>()).results.map((r) => r.id);
}

/**
 * Ticks the checklist items for `steps` on the client's task of the recurring template `key` for `period`, found by their template order in the current template. Does nothing for a task that is done or skipped, and nothing at all when
 * the template no longer has one of the steps (or the task's checklist is shorter than the template). Never un-ticks. Returns whether anything changed.
 */
export async function tickChecklist(env: Env, key: string, businessId: string, period: string, steps: string[], now: Date): Promise<boolean> {
  const tpl = await getTemplate(env.DB, key);
  if (!tpl) return false;
  const idx = steps.map((k) => tpl.steps.findIndex((s) => s.key === k));
  if (idx.some((i) => i < 0)) return false;
  let changed = false;
  for (const id of await cadenceIds(env, key, businessId, period)) {
    const task = await getTask(env.DB, id);
    if (!task || task.status === "done" || task.status === "skipped") continue;
    // The checklist is a snapshot of the template when the task was made: only a task that still lines up with the template (same length, item text starts with the step's title) is ticked.
    if (task.checklist.length !== tpl.steps.length) continue;
    const safe = idx.filter((i) => task.checklist[i].text.startsWith(tpl.steps[i].title));
    if (safe.length === 0) continue;
    const next = task.checklist.map((c, i) => (safe.includes(i) ? { ...c, done: true } : c));
    if (next.every((c, i) => c.done === task.checklist[i].done)) continue;
    await patchTask(env.DB, id, { checklist: next }, now.toISOString());
    changed = true;
  }
  return changed;
}

/** Ticks CARE-1 steps (see `tickChecklist`). */
export const tickCare1 = (env: Env, businessId: string, period: string, steps: Care1Step[], now: Date): Promise<boolean> => tickChecklist(env, CARE_1, businessId, period, steps, now);

export type Care4Step = "1.1" | "1.2" | "1.3" | "1.4";

/** Ticks CARE-4 steps of the client's monthly task of `period` (the month the task is for, not the month reported). Same rules as `tickCare1`; an error is logged and swallowed (false), so it can never break the report. */
export async function tickCare4(env: Env, businessId: string, period: string, steps: Care4Step[], now: Date): Promise<boolean> {
  try {
    return await tickChecklist(env, CARE_4, businessId, period, steps, now);
  } catch (e) {
    console.error("care tasks: could not tick the monthly report task", msg(e));
    return false;
  }
}

/** Marks the task done through `completeTask` when every checklist item is ticked. */
async function finishIfTicked(env: Env, businessId: string, period: string, now: Date): Promise<void> {
  for (const id of await cadenceIds(env, CARE_1, businessId, period)) {
    const task = await getTask(env.DB, id);
    if (!task || task.status === "done" || task.status === "skipped" || task.checklist.length === 0 || !task.checklist.every((c) => c.done)) continue;
    await completeTask(env, id, { by: "system", now });
  }
}

async function businessesOf(env: Env, siteIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (siteIds.length === 0) return out;
  const rows = (await env.DB.prepare(`SELECT id, business_id FROM sites WHERE id IN (${siteIds.map(() => "?").join(",")})`).bind(...siteIds).all<{ id: string; business_id: string }>()).results;
  for (const r of rows) out.set(r.id, r.business_id);
  return out;
}

/** The wave planning step: 1.1 and 1.2 for every client with a site that takes updates this week. */
export async function tickPlanned(env: Env, batch: CareBatch, now: Date = new Date()): Promise<void> {
  if (batch.kind !== "weekly") return;
  await guarded("tick the planning steps", async () => {
    const clients = new Set((await updatableSites(env.DB, { includeTest: false })).map((s) => s.businessId));
    for (const businessId of clients) await guarded("tick one client's planning steps", () => tickCare1(env, businessId, batch.period, ["1.1", "1.2"], now));
  });
}

/** An approval of the batch was executed: 1.4 for every client in it. */
export async function tickApproved(env: Env, batchId: string, siteIds: string[], now: Date = new Date()): Promise<void> {
  await guarded("tick the approval step", async () => {
    const batch = await getBatch(env.DB, batchId);
    if (!batch || batch.kind !== "weekly") return;
    for (const businessId of new Set((await businessesOf(env, siteIds)).values())) await guarded("tick one client's approval step", () => tickCare1(env, businessId, batch.period, ["1.4"], now));
  });
}

/**
 * Brings each client's task in line with the batch's runs: 1.3 once a canary (wave 1) run of the batch has ended (for every client with a run); when every run of the client is final (and no approval of the batch still waits on one of its
 * sites, and the batch is settled) 1.5, and with no failed or rolled-back run 1.6 too and the task is completed once every item is ticked. A failed client keeps 1.6 for Logan, and so does
 * one whose page look ended broken or unsure, or whose `changed` run's site has an open update_failed incident: the site is not known to be fine.
 */
export async function tickRuns(env: Env, batchId: string, now: Date = new Date()): Promise<void> {
  await guarded("tick the run steps", async () => {
    const batch = await getBatch(env.DB, batchId);
    if (!batch || batch.kind !== "weekly") return;
    const runs = await runsFor(env.DB, batchId);
    if (runs.length === 0) return;
    const owner = await businessesOf(env, [...new Set(runs.map((r) => r.siteId))]);
    const waiting = new Set<string>();
    for (const a of (await env.DB.prepare(`SELECT payload FROM approvals WHERE kind = 'care.updates' AND status = 'pending' AND json_extract(payload, '$.batchId') = ?`).bind(batchId).all<{ payload: string }>()).results) {
      for (const s of (JSON.parse(a.payload) as { sites?: { siteId: string }[] }).sites ?? []) { const b = owner.get(s.siteId) ?? (await businessesOf(env, [s.siteId])).get(s.siteId); if (b) waiting.add(b); }
    }
    const lookedBad = new Set((await env.DB.prepare(
      `SELECT DISTINCT r.site_id FROM care_page_checks c JOIN care_runs r ON r.id = c.run_id WHERE r.batch_id = ? AND c.review IN ('broken', 'unsure')`,
    ).bind(batchId).all<{ site_id: string }>()).results.map((r) => r.site_id));
    const failing = new Set((await env.DB.prepare(`SELECT DISTINCT site_id FROM site_incidents WHERE kind = 'update_failed' AND closed_at IS NULL`).all<{ site_id: string }>()).results.map((r) => r.site_id));
    const byClient = new Map<string, typeof runs>();
    for (const r of runs) { const b = owner.get(r.siteId); if (b) byClient.set(b, [...(byClient.get(b) ?? []), r]); }
    // 1.3 is the canary step of the whole batch: once a canary run has ended, it is done for every client that has a run, not only for the canaries (a wave-2 client's checklist would never finish).
    const canaryRan = runs.some((r) => r.wave === 1 && FINAL_RAN.includes(r.status));
    for (const [businessId, mine] of byClient) {
      await guarded("tick one client's run steps", async () => {
        if (canaryRan) await tickCare1(env, businessId, batch.period, ["1.3"], now);
        if (batch.status !== "done" && batch.status !== "cancelled") return; // a client's later wave may not be planned yet: only a settled batch finishes the week
        if (waiting.has(businessId) || mine.some((r) => r.status === "queued" || r.status === "running")) return;
        const bad = mine.some((r) => r.status === "failed" || r.status === "rolled_back" || lookedBad.has(r.siteId) || (r.status === "changed" && failing.has(r.siteId)));
        await tickCare1(env, businessId, batch.period, bad ? ["1.5"] : ["1.5", "1.6"], now);
        if (!bad) await finishIfTicked(env, businessId, batch.period, now);
      });
    }
  });
}
