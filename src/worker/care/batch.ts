import { toApproval, UnknownKindError, type Approval } from "../db/approvals";
import type { CareApprovalPayload } from "../approvals/careUpdates";
import { getHandler } from "../approvals/registry";
import {
  availableFor, createSingleBatch, ensureWeeklyBatch, getBatch, getInventory, runsFor, setBatchStatus, setRunStatus, updatableSites,
  type CareBatch, type CareRun, type CareUpdate, type GroupKey,
} from "../db/careUpdates";
import { CARE_KEYS, LIVE } from "../clients/record";
import { getSettings } from "../db/settings";
import type { Site } from "../db/sites";
import { getTemplate } from "../db/sops";
import type { Env } from "../env";
import { InvalidHelperJobError, enqueueHelperJob, getHelperJob } from "../helper/jobs";
import { periodKey, zoneOf } from "../sop/cadence";
import { tickPlanned, tickRuns } from "./tasks";
import { isDue, needsTick, pickCanaries } from "./versions";

// The weekly Care update batch (Plan 12): read every site, send the canaries first, then the rest, each wave as one approval Logan decides.
// Nothing here touches a client site: it queues read-only inventories and drafts approvals; an approved wave is what queues the update jobs (see approvals/careUpdates.ts).

export const CARE_INVENTORY = "care.inventory";
export const CARE_APPROVAL = "care.updates";
/** A weekly batch still reading its sites after this long is given up on. */
const STALE_INVENTORY_DAYS = 6;
/** A queued run with no helper job after this long never got one. */
const ORPHAN_AFTER_MS = 30 * 60_000;
export const ORPHAN_SUMMARY = "the update job was never queued";
const OPEN_RUN = "('queued', 'running')";

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
/** The ISO weekday (1 = Monday ... 7 = Sunday) of an instant in the zone, not in UTC. */
function isoWeekday(now: Date, tz: string): number {
  return WEEKDAYS[new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now)] ?? 0;
}

/** A refusal with a plain sentence the owner may read (a route answers it 409); anything else thrown is a real fault. */
export class CareRunRefused extends Error {
  constructor(message: string) { super(message); this.name = "CareRunRefused"; }
}

const oneLine = (s: string, max = 100): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

// --- starting a batch ------------------------------------------------------------------------------------------------------------------------------------------------

async function queueInventory(db: D1Database, site: Site, batchId: string, dedupeKey: string): Promise<boolean> {
  const job = await enqueueHelperJob(db, CARE_INVENTORY, { siteId: site.id, batchId, alias: site.wpSshAlias ?? "", path: site.wpPath ?? "" }, { dedupeKey });
  return job.created;
}

/**
 * Starts this week's batch, on CARE-1's weekday in the booking zone and only while that template is on: makes the batch of the week once and queues one read-only inventory per updatable
 * (live, real) site. A second call the same day queues nothing, even when the first inventories already finished (the job's dedupe key is looked for in every status).
 */
export async function startWeeklyBatch(env: Env, now: Date): Promise<{ batch: CareBatch | null; queued: number }> {
  const db = env.DB;
  const tpl = await getTemplate(db, "CARE-1");
  if (!tpl || !tpl.active) return { batch: null, queued: 0 };
  const tz = zoneOf(await getSettings(db));
  if (isoWeekday(now, tz) !== (tpl.cadenceDay ?? 3)) return { batch: null, queued: 0 };
  return beginWeekly(env, now, tz);
}

/**
 * Logan starts this week's batch by hand, on any weekday and whether or not CARE-1 is on. `created` is false (and nothing is queued) when this week's weekly batch already exists:
 * the owner asks once, the Wednesday run or an earlier press already did it.
 */
export async function startBatchNow(env: Env, now: Date): Promise<{ batch: CareBatch; queued: number; created: boolean }> {
  const tz = zoneOf(await getSettings(env.DB));
  const { batch, created } = await ensureWeeklyBatch(env.DB, periodKey("weekly", now, tz), now.toISOString());
  if (!created) return { batch, queued: 0, created: false };
  const r = await beginWeekly(env, now, tz);
  return { batch: r.batch ?? batch, queued: r.queued, created: true };
}

async function beginWeekly(env: Env, now: Date, tz: string): Promise<{ batch: CareBatch | null; queued: number }> {
  const db = env.DB;
  const period = periodKey("weekly", now, tz);
  const { batch } = await ensureWeeklyBatch(db, period, now.toISOString());
  if (batch.status !== "inventory") return { batch, queued: 0 };
  let queued = 0;
  for (const site of await updatableSites(db, { includeTest: false })) {
    const key = `care.inventory:${site.id}:${period}`;
    if (await db.prepare(`SELECT 1 AS x FROM helper_jobs WHERE kind = ? AND dedupe_key = ? LIMIT 1`).bind(CARE_INVENTORY, key).first()) continue;
    try {
      if (await queueInventory(db, site, batch.id, key)) queued++;
    } catch (e) {
      // A site whose alias or folder fails the safety check is left out of the week, loudly, and never reaches a shell.
      if (!(e instanceof InvalidHelperJobError)) throw e;
      console.warn(`care batch: site ${site.id} was left out, its access details did not pass the safety check`);
    }
  }
  await onInventoryDone(env, batch.id); // a week with nothing to read moves straight on
  return { batch: (await getBatch(db, batch.id)) ?? batch, queued };
}

/** Logan runs one site by hand, any day, a rehearsal site included. Refuses (throws a plain sentence) a site that does not take updates or already has an update waiting or running. */
export async function startSingleRun(env: Env, siteId: string, now: Date): Promise<CareBatch> {
  const db = env.DB;
  const site = (await updatableSites(db, { includeTest: true })).find((s) => s.id === siteId);
  if (!site) throw new CareRunRefused("This site cannot take updates: it must be live, have a live Care plan and no hold, run WordPress and have its SSH alias and folder filled in.");
  const open = await db.prepare(
    `SELECT 1 AS x FROM care_runs WHERE site_id = ? AND status IN ${OPEN_RUN}
     UNION ALL SELECT 1 FROM helper_jobs WHERE kind = 'care.update' AND dedupe_key = ? AND status IN ('pending', 'claimed') LIMIT 1`,
  ).bind(siteId, `care.update:${siteId}`).first();
  if (open) throw new CareRunRefused("This site already has an update waiting or running. Let it finish first.");
  const reading = await db.prepare(
    `SELECT 1 AS x FROM care_batches WHERE kind = 'single' AND site_id = ? AND status IN ('inventory', 'wave1', 'wave2')
     UNION ALL SELECT 1 FROM helper_jobs WHERE kind = ? AND status IN ('pending', 'claimed') AND json_extract(payload, '$.siteId') = ? LIMIT 1`,
  ).bind(siteId, CARE_INVENTORY, siteId).first();
  if (reading) throw new CareRunRefused("This site's updates are already being read.");
  const tz = zoneOf(await getSettings(db));
  const batch = await createSingleBatch(db, siteId, periodKey("weekly", now, tz), now.toISOString());
  try {
    await queueInventory(db, site, batch.id, `care.inventory:${siteId}:${batch.id}`);
  } catch (e) {
    await setBatchStatus(db, batch.id, ["inventory"], "cancelled", new Date().toISOString());
    if (e instanceof InvalidHelperJobError) throw new CareRunRefused("This site's SSH alias or folder did not pass the safety check, so nothing was queued.");
    throw e;
  }
  return batch;
}

// --- reading what is open --------------------------------------------------------------------------------------------------------------------------------------------

const openInventoryJobs = async (db: D1Database, batchId: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM helper_jobs WHERE kind = ? AND status IN ('pending', 'claimed') AND json_extract(payload, '$.batchId') = ?`).bind(CARE_INVENTORY, batchId).first<{ n: number }>())!.n;

interface WaveApproval { id: string; status: "pending" | "approved" | "rejected"; wave: number }
const approvalsOf = async (db: D1Database, batchId: string, wave?: number): Promise<WaveApproval[]> =>
  (await db.prepare(
    `SELECT id, status, json_extract(payload, '$.wave') AS wave FROM approvals WHERE kind = ? AND json_extract(payload, '$.batchId') = ?${wave === undefined ? "" : " AND json_extract(payload, '$.wave') = ?"} ORDER BY created_at, rowid`,
  ).bind(...[CARE_APPROVAL, batchId, ...(wave === undefined ? [] : [wave])]).all<WaveApproval>()).results;

/** True while work of the batch (or of one wave) is still open: an approval nobody decided, one approved whose runs are not made yet, or a run queued or running. */
async function busy(db: D1Database, batchId: string, wave?: number): Promise<boolean> {
  const w = wave === undefined ? "" : " AND json_extract(a.payload, '$.wave') = ?";
  const rw = wave === undefined ? "" : " AND wave = ?";
  const n = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM care_runs WHERE batch_id = ? AND status IN ${OPEN_RUN}${rw})
          + (SELECT COUNT(*) FROM approvals a WHERE a.kind = ? AND json_extract(a.payload, '$.batchId') = ?${w}
               AND (a.status = 'pending' OR (a.status = 'approved' AND NOT EXISTS (SELECT 1 FROM care_runs r WHERE r.approval_id = a.id)))) AS n`,
  ).bind(...[batchId, ...(wave === undefined ? [] : [wave]), CARE_APPROVAL, batchId, ...(wave === undefined ? [] : [wave])]).first<{ n: number }>();
  return n!.n > 0;
}

// --- the hooks -------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A site's inventory job ended (read, failed or expired). When no inventory job of the batch is open any more, the first wave is drafted: wave 1 for a weekly batch, wave 0 for a one-site run.
 * Safe to call again (a replay, the backstop): the batch moves on once and the approval is made once.
 */
export async function onInventoryDone(env: Env, batchId: string): Promise<void> {
  const batch = await getBatch(env.DB, batchId);
  if (!batch || batch.status !== "inventory") return;
  if ((await openInventoryJobs(env.DB, batchId)) > 0) return;
  await draftWave(env, batch, batch.kind === "weekly" ? 1 : 0);
}

/**
 * A site's update run ended (applied, failed, dropped or expired), or a canary page was reviewed. Moves the batch on: once wave 1 (or the single wave) is decided and none of its runs is open,
 * wave 2 is drafted; once everything is final the batch is done. A rejected first wave stops the batch (the canaries never ran, so the rest must not either). Safe to call any number of times.
 */
export async function onRunDone(env: Env, batchId: string): Promise<void> {
  await advance(env, batchId);
  await tickRuns(env, batchId); // after the batch moved on, so a wave drafted just now already counts as waiting
}

async function advance(env: Env, batchId: string): Promise<void> {
  const db = env.DB;
  const batch = await getBatch(db, batchId);
  if (!batch) return;
  if (batch.status === "wave1") {
    const wave = batch.kind === "single" ? 0 : 1;
    const aps = await approvalsOf(db, batch.id, wave);
    if (aps.length === 0) { await draftWave(env, batch, wave); return; } // the draft was lost between moving the batch and making the approval
    if (aps.some((a) => a.status === "pending")) return;
    if (aps.every((a) => a.status === "rejected")) { await setBatchStatus(db, batch.id, ["wave1"], "cancelled", new Date().toISOString()); return; }
    if (await busy(db, batch.id, wave)) return;
    if (wave === 0) await settle(db, batch);
    else await draftWave(env, batch, 2);
  } else if (batch.status === "wave2") {
    await settle(db, batch);
  }
}

/** Done once nothing of the batch is open; otherwise a weekly batch that is still in wave 1 moves to wave 2. */
async function settle(db: D1Database, batch: CareBatch): Promise<void> {
  const now = new Date().toISOString();
  if (await busy(db, batch.id)) {
    if (batch.kind === "weekly") await setBatchStatus(db, batch.id, ["wave1"], "wave2", now);
    return;
  }
  await setBatchStatus(db, batch.id, ["wave1", "wave2"], "done", now);
}

// --- planning a wave -------------------------------------------------------------------------------------------------------------------------------------------------

interface PlanSite { site: Site; updates: CareUpdate[] }
interface Plan { sites: PlanSite[]; /** Groups held out for the week because every canary run of the group was dropped (no canary ran). */ noCanary?: GroupKey[]; /** Groups held out for the week because a canary page's look ended broken or unsure: the canary did not pass. */ looked?: GroupKey[]; /** A group is held back for a canary page still being reviewed: the wave is drafted again when the review lands. */ waiting: boolean }

/** What the client's live Care plan bills each month (a rehearsal client's own plan when it has no real one); the canary of a group is its cheapest. */
async function careCentsOf(db: D1Database, businessId: string): Promise<number> {
  const r = await db.prepare(
    `SELECT monthly_cents FROM subscriptions WHERE business_id = ? AND status IN (${LIVE.map((x) => `'${x}'`).join(", ")}) AND package_key IN (${CARE_KEYS.map((x) => `'${x}'`).join(", ")})
     ORDER BY test, created_at DESC LIMIT 1`,
  ).bind(businessId).first<{ monthly_cents: number }>();
  return r?.monthly_cents ?? 0;
}

const componentKey = (type: string, slug: string): string => `${type}:${slug}`;

/** The components a wave-1 run broke: what the helper marked rolled back or failed; when it marked none (a page broke and nothing was put back), everything it tried. */
async function brokenComponents(db: D1Database, runs: CareRun[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const run of runs) {
    if ((run.status !== "rolled_back" && run.status !== "failed") || !run.helperJobId) continue;
    const job = await getHelperJob(db, run.helperJobId);
    const ups = ((job?.payload as { updates?: { id: string; type: string; slug: string }[] } | undefined)?.updates ?? []);
    if (!ups.length) continue;
    const bad = (await db.prepare(`SELECT id FROM care_updates WHERE id IN (${ups.map(() => "?").join(",")}) AND status IN ('rolled_back', 'failed')`).bind(...ups.map((u) => u.id)).all<{ id: string }>()).results.map((r) => r.id);
    for (const u of ups) if (!bad.length || bad.includes(u.id)) out.add(componentKey(u.type, u.slug));
  }
  return out;
}

async function planWave(env: Env, batch: CareBatch, wave: 0 | 1 | 2, now: Date): Promise<Plan> {
  const db = env.DB;
  const eligible = (await updatableSites(db, { includeTest: wave === 0 })).filter((s) => wave !== 0 || s.id === batch.siteId);
  const due: PlanSite[] = [];
  for (const site of eligible) {
    const updates = (await availableFor(db, site.id)).filter((u) => isDue(u, now));
    if (updates.length) due.push({ site, updates });
  }
  if (wave === 0) return { sites: due, waiting: false };
  const groupOf = async (siteId: string): Promise<GroupKey> => (await getInventory(db, siteId))?.groupKey ?? "brochure";

  if (wave === 1) {
    const cands = await Promise.all(due.map(async (p) => ({ siteId: p.site.id, group: await groupOf(p.site.id), careCents: await careCentsOf(db, p.site.businessId), domain: p.site.domain ?? p.site.id })));
    const picked = pickCanaries(cands);
    return { sites: due.filter((p) => picked.has(p.site.id)), waiting: false };
  }

  // Wave 2: everything else, minus what broke a canary, minus a group whose canary page is still being reviewed, minus a site another open approval already covers.
  const canaryRuns = (await runsFor(db, batch.id)).filter((r) => r.wave === 1);
  const canaries = new Set(canaryRuns.map((r) => r.siteId));
  const broken = await brokenComponents(db, canaryRuns);
  const pending = (await db.prepare(
    `SELECT DISTINCT r.site_id FROM care_page_checks c JOIN care_runs r ON r.id = c.run_id WHERE r.batch_id = ? AND r.wave = 1 AND c.review = 'pending'`,
  ).bind(batch.id).all<{ site_id: string }>()).results;
  const heldGroups = new Set<GroupKey>();
  for (const p of pending) heldGroups.add(await groupOf(p.site_id));
  // A group whose canary runs all ended dropped never had a canary: it waits until next week.
  const ran = new Map<GroupKey, boolean>();
  for (const r of canaryRuns) { const g = await groupOf(r.siteId); ran.set(g, (ran.get(g) ?? false) || r.status !== "dropped"); }
  const noCanaryGroups = new Set<GroupKey>([...ran].filter(([, ok]) => !ok).map(([g]) => g));
  const failedLook = (await db.prepare(
    `SELECT DISTINCT r.site_id FROM care_page_checks c JOIN care_runs r ON r.id = c.run_id WHERE r.batch_id = ? AND r.wave = 1 AND c.review IN ('broken', 'unsure')`,
  ).bind(batch.id).all<{ site_id: string }>()).results;
  const lookedGroups = new Set<GroupKey>();
  for (const p of failedLook) lookedGroups.add(await groupOf(p.site_id));
  const covered = new Set<string>();
  for (const a of (await db.prepare(`SELECT payload FROM approvals WHERE kind = ? AND status IN ('pending', 'rejected') AND json_extract(payload, '$.batchId') = ?`).bind(CARE_APPROVAL, batch.id).all<{ payload: string }>()).results) {
    for (const s of (JSON.parse(a.payload) as CareApprovalPayload).sites) covered.add(s.siteId);
  }
  const rest: PlanSite[] = [];
  for (const p of due) {
    if (canaries.has(p.site.id) || covered.has(p.site.id)) continue;
    const updates = p.updates.filter((u) => !broken.has(componentKey(u.type, u.slug)));
    if (updates.length) rest.push({ site: p.site, updates });
  }
  const sites: PlanSite[] = [];
  const noCanary = new Set<GroupKey>();
  const looked = new Set<GroupKey>();
  let waiting = false;
  for (const p of rest) {
    const g = await groupOf(p.site.id);
    if (noCanaryGroups.has(g)) noCanary.add(g);
    else if (lookedGroups.has(g)) looked.add(g);
    else if (heldGroups.has(g)) waiting = true;
    else sites.push(p);
  }
  return { sites, waiting, noCanary: [...noCanary].sort(), looked: [...looked].sort() };
}

// --- drafting a wave -------------------------------------------------------------------------------------------------------------------------------------------------

function describe(batch: CareBatch, wave: 0 | 1 | 2, plan: Plan): { title: string; preview: string; payload: CareApprovalPayload } {
  const sites = plan.sites.map((p) => ({
    siteId: p.site.id, domain: oneLine(p.site.domain ?? p.site.url ?? p.site.id, 100),
    updates: p.updates.map((u) => ({
      id: u.id, type: u.type, slug: u.slug, name: oneLine(u.name), from: u.fromVersion, to: u.toVersion, risk: u.security ? ("security" as const) : u.risk, needsTick: needsTick(u),
    })),
  }));
  const count = sites.reduce((n, s) => n + s.updates.length, 0);
  const title = wave === 0 ? `Care updates: ${sites[0].domain}` : `Care updates: wave ${wave} (${plural(sites.length, "site")}, ${plural(count, "update")})`;
  const preview = sites.map((s) => [
    s.domain,
    ...s.updates.map((u) => `  ${u.slug} (${u.type}) ${u.from} to ${u.to}${u.risk === "security" ? " [security]" : ""}${u.risk === "major" || u.needsTick ? " [needs your OK]" : ""}`),
  ].join("\n")).concat((plan.noCanary ?? []).map((g) => `waits until next week: no canary ran for the ${g} sites`), (plan.looked ?? []).map((g) => `waits until next week: a page on the ${g} canary looked different`)).join("\n\n");
  return { title, preview, payload: { batchId: batch.id, wave, sites } };
}

/** The approval of a wave, made once: a second caller (or a crash retry) finds the first one's row and makes nothing. Null then. */
async function makeApproval(db: D1Database, batch: CareBatch, wave: 0 | 1 | 2, plan: Plan): Promise<Approval | null> {
  if (!getHandler(CARE_APPROVAL)) throw new UnknownKindError(CARE_APPROVAL);
  const d = describe(batch, wave, plan);
  const recordId = wave === 2 ? `${batch.id}:2:${plan.sites.map((p) => p.site.id).sort().join(",")}` : `${batch.id}:${wave}`;
  const row = {
    id: crypto.randomUUID(), kind: CARE_APPROVAL, title: d.title, preview: d.preview, payload: JSON.stringify(d.payload), record_type: "care_batch", record_id: recordId,
    drafted_by: "job" as const, status: "pending" as const, error: null, decision_note: null, created_at: new Date().toISOString(), decided_at: null,
  };
  const res = await db.prepare(
    `INSERT INTO approvals (id, kind, title, preview, payload, record_type, record_id, drafted_by, status, created_at)
     SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE record_type = 'care_batch' AND record_id = ?)`,
  ).bind(row.id, row.kind, row.title, row.preview, row.payload, row.record_type, row.record_id, row.drafted_by, row.status, row.created_at, recordId).run();
  return (res.meta.changes ?? 0) > 0 ? toApproval(row) : null;
}

/**
 * Drafts one wave as one approval: wave 1 the canary sites (one per group, two in a big one) that have updates due, wave 2 the rest, wave 0 the one site of a single run. Only due updates go in:
 * not held, a major only after its wait, a security one at once. A wave with nothing due makes no approval and the batch moves on (wave 1 empty goes straight to wave 2; nothing due at all is done).
 * The batch status moves by compare-and-set and the approval row is made once, so two callers draft one approval. Null when nothing was drafted (or it already was).
 */
export async function draftWave(env: Env, batch: CareBatch, wave: 0 | 1 | 2, now: Date = new Date()): Promise<Approval | null> {
  const db = env.DB;
  const cur = await getBatch(db, batch.id);
  if (!cur) return null;
  if (wave !== 2) {
    if (cur.status === "inventory") await setBatchStatus(db, cur.id, ["inventory"], "wave1", now.toISOString());
    const after = await getBatch(db, cur.id);
    if (!after || after.status !== "wave1") return null;
    if (wave === 1) await tickPlanned(env, after, now); // the sites are known: the list is sorted and the test sites picked (idempotent)
    if ((await approvalsOf(db, cur.id, wave)).length > 0) return null;
    const plan = await planWave(env, after, wave, now);
    if (plan.sites.length === 0) {
      if (wave === 1) return draftWave(env, after, 2, now);
      await settle(db, after);
      return null;
    }
    return makeApproval(db, after, wave, plan);
  }
  if (cur.status !== "wave1" && cur.status !== "wave2") return null;
  const plan = await planWave(env, cur, 2, now);
  if (plan.sites.length) {
    const ap = await makeApproval(db, cur, 2, plan);
    if (!plan.waiting) await setBatchStatus(db, cur.id, ["wave1"], "wave2", now.toISOString());
    return ap;
  }
  if (!plan.waiting) await settle(db, cur);
  return null;
}

// --- the backstop ----------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The daily safety net, so a lost hook never strands a batch: drops a queued run that never got a helper job (older than 30 minutes) and frees its updates, calls the hook of every open batch
 * again (drafting the wave a hook missed, once), and cancels a weekly batch that has been reading its sites for more than six days. `drafted` counts the approvals made in this pass.
 */
export async function careBackstop(env: Env, now: Date): Promise<{ drafted: number; cancelled: number }> {
  const db = env.DB;
  const count = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE record_type = 'care_batch'`).first<{ n: number }>())!.n;
  const before = await count();
  const iso = now.toISOString();

  const orphans = (await db.prepare(
    `SELECT id, batch_id, site_id FROM care_runs r WHERE r.status = 'queued' AND r.created_at < ?
       AND (r.helper_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM helper_jobs j WHERE j.id = r.helper_job_id))`,
  ).bind(new Date(now.getTime() - ORPHAN_AFTER_MS).toISOString()).all<{ id: string; batch_id: string; site_id: string }>()).results;
  for (const o of orphans) {
    if (!(await setRunStatus(db, o.id, ["queued"], "dropped", { summary: ORPHAN_SUMMARY }, iso))) continue;
    // Its updates were marked queued before the job should have existed; free them unless the site has other work open.
    const other = await db.prepare(
      `SELECT 1 AS x FROM care_runs WHERE site_id = ? AND status IN ${OPEN_RUN} UNION ALL SELECT 1 FROM helper_jobs WHERE kind = 'care.update' AND dedupe_key = ? AND status IN ('pending', 'claimed') LIMIT 1`,
    ).bind(o.site_id, `care.update:${o.site_id}`).first();
    if (!other) await db.prepare(`UPDATE care_updates SET status = 'available' WHERE site_id = ? AND status = 'queued'`).bind(o.site_id).run();
  }

  let cancelled = 0;
  const open = (await db.prepare(`SELECT id FROM care_batches WHERE status IN ('inventory', 'wave1', 'wave2') ORDER BY created_at, rowid`).all<{ id: string }>()).results;
  for (const { id } of open) {
    const batch = await getBatch(db, id);
    if (!batch) continue;
    if (batch.kind === "weekly" && batch.status === "inventory" && now.getTime() - Date.parse(batch.createdAt) > STALE_INVENTORY_DAYS * 86_400_000) {
      if (await setBatchStatus(db, id, ["inventory"], "cancelled", iso)) {
        cancelled++;
        await db.prepare(`UPDATE helper_jobs SET status = 'expired', error = ?, done_at = ? WHERE kind = ? AND status IN ('pending', 'claimed') AND json_extract(payload, '$.batchId') = ?`)
          .bind("cancelled: its weekly batch ran out of time", iso, CARE_INVENTORY, id).run();
      }
      continue;
    }
    if (batch.status === "inventory") await onInventoryDone(env, id);
    else await onRunDone(env, id);
  }
  for (const o of orphans) await onRunDone(env, o.batch_id);
  return { drafted: (await count()) - before, cancelled };
}
