import { CARE_KEYS, LIVE, testClientSql } from "../clients/record";
import { holdFreeSql } from "./holds";
import { CARE_SUBSCRIPTION_SQL } from "./monitoring";
import { toSite, type Site, type SiteRow } from "./sites";

// Care updates data (Plan 12): the updates a site could take, the batches and runs that apply them, the page checks around each run and what the helper last read from a site.
// Times are UTC ISO strings with milliseconds. No secret is stored. Everything a client site returns (names, versions) is untrusted text, kept as given and shown only as data.

export type UpdateType = "core" | "plugin" | "theme";
export type Risk = "security" | "major" | "mild" | "minor";
export type UpdateStatus = "available" | "queued" | "applied" | "failed" | "rolled_back" | "gone";
export type BatchStatus = "inventory" | "wave1" | "wave2" | "done" | "cancelled";
export type BatchKind = "weekly" | "single";
export type RunStatus = "queued" | "running" | "ok" | "changed" | "rolled_back" | "failed" | "dropped";
export type Verdict = "ok" | "changed" | "broken";
export type Review = "none" | "pending" | "fine" | "broken" | "unsure" | "logan_ok";
export type GroupKey = "woocommerce" | "booking" | "builder" | "brochure";

export interface CareUpdate {
  id: string; siteId: string; type: UpdateType; slug: string; name: string; fromVersion: string; toVersion: string; risk: Risk;
  rollbackable: boolean; security: boolean; held: boolean; firstSeenAt: string; lastSeenAt: string; status: UpdateStatus;
  /** When a run last marked it failed or rolled back (null when never). */
  lastFailedAt: string | null;
}
/** What the helper reports for one update; the rest of a CareUpdate is ours to keep. */
export interface SeenUpdate { type: UpdateType; slug: string; name: string; fromVersion: string; toVersion: string; risk: Risk; rollbackable: boolean }
export interface CareBatch { id: string; period: string; kind: BatchKind; siteId: string | null; status: BatchStatus; createdAt: string; updatedAt: string }
export interface CareRun {
  id: string; batchId: string; siteId: string; wave: 0 | 1 | 2; approvalId: string | null; helperJobId: string | null; status: RunStatus;
  backupFile: string | null; summary: string | null; createdAt: string; finishedAt: string | null;
}
export interface PageCheck {
  id: string; runId: string; path: string; beforeKey: string | null; afterKey: string | null; diffKey: string | null; statusBefore: number | null; statusAfter: number | null;
  formsBefore: number | null; formsAfter: number | null; ssim: number | null; verdict: Verdict; review: Review;
}
/** A page check as the helper reports it; `review` starts at `none` unless given. */
export type PageCheckInput = Omit<PageCheck, "id" | "runId" | "review"> & { review?: Review };
export interface Inventory { siteId: string; wpVersion: string | null; phpVersion: string | null; groupKey: GroupKey; plugins: string[]; readAt: string }

interface UpdateRow {
  id: string; site_id: string; type: UpdateType; slug: string; name: string; from_version: string; to_version: string; risk: Risk;
  rollbackable: number; security: number; held: number; first_seen_at: string; last_seen_at: string; status: UpdateStatus; last_failed_at: string | null;
}
interface BatchRow { id: string; period: string; kind: BatchKind; site_id: string | null; status: BatchStatus; created_at: string; updated_at: string }
interface RunRow {
  id: string; batch_id: string; site_id: string; wave: 0 | 1 | 2; approval_id: string | null; helper_job_id: string | null; status: RunStatus;
  backup_file: string | null; summary: string | null; created_at: string; finished_at: string | null;
}
interface CheckRow {
  id: string; run_id: string; path: string; before_key: string | null; after_key: string | null; diff_key: string | null; status_before: number | null; status_after: number | null;
  forms_before: number | null; forms_after: number | null; ssim: number | null; verdict: Verdict; review: Review;
}
interface InventoryRow { site_id: string; wp_version: string | null; php_version: string | null; group_key: GroupKey; plugins: string; read_at: string }

const toUpdate = (r: UpdateRow): CareUpdate => ({
  id: r.id, siteId: r.site_id, type: r.type, slug: r.slug, name: r.name, fromVersion: r.from_version, toVersion: r.to_version, risk: r.risk,
  rollbackable: !!r.rollbackable, security: !!r.security, held: !!r.held, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, status: r.status,
  lastFailedAt: r.last_failed_at ?? null,
});
const toBatch = (r: BatchRow): CareBatch => ({ id: r.id, period: r.period, kind: r.kind, siteId: r.site_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });
const toRun = (r: RunRow): CareRun => ({
  id: r.id, batchId: r.batch_id, siteId: r.site_id, wave: r.wave, approvalId: r.approval_id, helperJobId: r.helper_job_id, status: r.status,
  backupFile: r.backup_file, summary: r.summary, createdAt: r.created_at, finishedAt: r.finished_at,
});
const toCheck = (r: CheckRow): PageCheck => ({
  id: r.id, runId: r.run_id, path: r.path, beforeKey: r.before_key, afterKey: r.after_key, diffKey: r.diff_key, statusBefore: r.status_before, statusAfter: r.status_after,
  formsBefore: r.forms_before, formsAfter: r.forms_after, ssim: r.ssim, verdict: r.verdict, review: r.review,
});
const toInventory = (r: InventoryRow): Inventory => {
  let plugins: string[] = [];
  try { const v: unknown = JSON.parse(r.plugins); if (Array.isArray(v)) plugins = v.filter((x): x is string => typeof x === "string"); } catch { /* an unreadable list is an empty one */ }
  return { siteId: r.site_id, wpVersion: r.wp_version, phpVersion: r.php_version, groupKey: r.group_key, plugins, readAt: r.read_at };
};

const MAX_PLUGINS = 200;
const TERMINAL_RUN: readonly RunStatus[] = ["ok", "changed", "rolled_back", "failed", "dropped"];
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

// --- updates -------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Records what the helper just read for a site. A new update goes in `available` with `first_seen_at = now`; one seen before only has `last_seen_at` (and its looks) refreshed.
 * An `available` update that is not in `seen` any more (applied by hand, or a newer version replaced it) becomes `gone`. `security` and `held` are Logan's marks and are never reset.
 * A `failed` or `rolled_back` update still seen at the same version is `available` again (it would otherwise be stuck for good), keeping `last_failed_at` so it needs Logan's tick.
 */
export async function upsertSeen(db: D1Database, siteId: string, seen: SeenUpdate[], now: string): Promise<void> {
  const key = (type: string, slug: string, to: string) => JSON.stringify([type, slug, to]);
  const keep = new Set(seen.map((u) => key(u.type, u.slug, u.toVersion)));
  const open = (await db.prepare(`SELECT id, type, slug, to_version FROM care_updates WHERE site_id = ? AND status = 'available'`).bind(siteId).all<{ id: string; type: string; slug: string; to_version: string }>()).results;
  const stmts = seen.map((u) => db.prepare(
    `INSERT INTO care_updates (id, site_id, type, slug, name, from_version, to_version, risk, rollbackable, security, held, first_seen_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'available')
     ON CONFLICT (site_id, type, slug, to_version) DO UPDATE SET
       last_seen_at = excluded.last_seen_at, name = excluded.name, from_version = excluded.from_version, risk = excluded.risk, rollbackable = excluded.rollbackable,
       status = CASE WHEN care_updates.status IN ('gone', 'failed', 'rolled_back') THEN 'available' ELSE care_updates.status END`,
  ).bind(crypto.randomUUID(), siteId, u.type, u.slug, u.name, u.fromVersion, u.toVersion, u.risk, u.rollbackable ? 1 : 0, now, now));
  for (const o of open) if (!keep.has(key(o.type, o.slug, o.to_version))) stmts.push(db.prepare(`UPDATE care_updates SET status = 'gone' WHERE id = ? AND status = 'available'`).bind(o.id));
  if (stmts.length) await db.batch(stmts);
}

/** Sets or clears one of Logan's two marks on an update. Returns the update, or null when it is unknown. */
export async function setUpdateFlag(db: D1Database, id: string, flag: "security" | "held", on: boolean): Promise<CareUpdate | null> {
  const col = flag === "security" ? "security" : "held";
  const r = await db.prepare(`UPDATE care_updates SET ${col} = ? WHERE id = ? RETURNING *`).bind(on ? 1 : 0, id).first<UpdateRow>();
  return r ? toUpdate(r) : null;
}

/** The site's updates that can still be taken, in a steady order (core first, then plugins, then themes). */
export async function availableFor(db: D1Database, siteId: string): Promise<CareUpdate[]> {
  const rows = (await db.prepare(
    `SELECT * FROM care_updates WHERE site_id = ? AND status = 'available' ORDER BY CASE type WHEN 'core' THEN 0 WHEN 'plugin' THEN 1 ELSE 2 END, slug, to_version`,
  ).bind(siteId).all<UpdateRow>()).results;
  return rows.map(toUpdate);
}

/** The updates that can still be taken for many sites at once (50 per read), grouped by site, in `availableFor`'s order. */
export async function availableForSites(db: D1Database, siteIds: string[]): Promise<Map<string, CareUpdate[]>> {
  const out = new Map<string, CareUpdate[]>();
  for (let i = 0; i < siteIds.length; i += 50) {
    const part = siteIds.slice(i, i + 50);
    const rows = (await db.prepare(
      `SELECT * FROM care_updates WHERE site_id IN (${marks(part.length)}) AND status = 'available' ORDER BY site_id, CASE type WHEN 'core' THEN 0 WHEN 'plugin' THEN 1 ELSE 2 END, slug, to_version`,
    ).bind(...part).all<UpdateRow>()).results;
    for (const r of rows) (out.get(r.site_id) ?? out.set(r.site_id, []).get(r.site_id)!).push(toUpdate(r));
  }
  return out;
}

/** The newest run of each site (50 sites per read); a site that never ran is not in the map. */
export async function lastRunsFor(db: D1Database, siteIds: string[]): Promise<Map<string, CareRun>> {
  const out = new Map<string, CareRun>();
  for (let i = 0; i < siteIds.length; i += 50) {
    const part = siteIds.slice(i, i + 50);
    const rows = (await db.prepare(
      `SELECT r.* FROM care_runs r WHERE r.site_id IN (${marks(part.length)})
         AND r.rowid = (SELECT r2.rowid FROM care_runs r2 WHERE r2.site_id = r.site_id ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1)`,
    ).bind(...part).all<RunRow>()).results;
    for (const r of rows) out.set(r.site_id, toRun(r));
  }
  return out;
}

/** The sites a Care board lists: live, real sites of real clients with a live Care plan, oldest first. */
export async function careBoardSites(db: D1Database): Promise<Site[]> {
  const rows = (await db.prepare(
    `SELECT s.* FROM sites s JOIN businesses b ON b.id = s.business_id
     WHERE s.archived_at IS NULL AND s.test = 0 AND NOT ${testClientSql("b")} AND ${CARE_SUBSCRIPTION_SQL("b")} ORDER BY s.created_at, s.id`,
  ).all<SiteRow>()).results;
  return rows.map(toSite);
}

// --- inventory -----------------------------------------------------------------------------------------------------------------------------------------------------

/** Saves what the helper read from a site (one row per site). Only the first 200 plugin slugs are kept. */
export async function saveInventory(db: D1Database, i: Inventory): Promise<void> {
  await db.prepare(
    `INSERT INTO site_inventories (site_id, wp_version, php_version, group_key, plugins, read_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id) DO UPDATE SET wp_version = excluded.wp_version, php_version = excluded.php_version, group_key = excluded.group_key, plugins = excluded.plugins, read_at = excluded.read_at`,
  ).bind(i.siteId, i.wpVersion, i.phpVersion, i.groupKey, JSON.stringify(i.plugins.slice(0, MAX_PLUGINS)), i.readAt).run();
}

export async function getInventory(db: D1Database, siteId: string): Promise<Inventory | null> {
  const r = await db.prepare(`SELECT * FROM site_inventories WHERE site_id = ?`).bind(siteId).first<InventoryRow>();
  return r ? toInventory(r) : null;
}

// --- batches -------------------------------------------------------------------------------------------------------------------------------------------------------

/** The weekly batch of a period, made once: `created` is true only for the call that made it. */
export async function ensureWeeklyBatch(db: D1Database, period: string, now: string): Promise<{ batch: CareBatch; created: boolean }> {
  const made = await db.prepare(
    `INSERT INTO care_batches (id, period, kind, site_id, status, created_at, updated_at) VALUES (?, ?, 'weekly', NULL, 'inventory', ?, ?) ON CONFLICT DO NOTHING RETURNING *`,
  ).bind(crypto.randomUUID(), period, now, now).first<BatchRow>();
  if (made) return { batch: toBatch(made), created: true };
  const existing = await db.prepare(`SELECT * FROM care_batches WHERE kind = 'weekly' AND period = ?`).bind(period).first<BatchRow>();
  if (!existing) throw new Error("could not make the weekly batch");
  return { batch: toBatch(existing), created: false };
}

/** A one-site batch (Logan runs a single site by hand). Several may share a period. */
export async function createSingleBatch(db: D1Database, siteId: string, period: string, now: string): Promise<CareBatch> {
  const r = await db.prepare(
    `INSERT INTO care_batches (id, period, kind, site_id, status, created_at, updated_at) VALUES (?, ?, 'single', ?, 'inventory', ?, ?) RETURNING *`,
  ).bind(crypto.randomUUID(), period, siteId, now, now).first<BatchRow>();
  return toBatch(r!);
}

/** The weekly batch of a period, or null when none was made. */
export async function getWeeklyBatch(db: D1Database, period: string): Promise<CareBatch | null> {
  const r = await db.prepare(`SELECT * FROM care_batches WHERE kind = 'weekly' AND period = ?`).bind(period).first<BatchRow>();
  return r ? toBatch(r) : null;
}

export async function getBatch(db: D1Database, id: string): Promise<CareBatch | null> {
  const r = await db.prepare(`SELECT * FROM care_batches WHERE id = ?`).bind(id).first<BatchRow>();
  return r ? toBatch(r) : null;
}

/** Moves a batch from one of the `from` statuses to `to`. One statement, so two callers cannot both win; false when the batch was not in any of them. */
export async function setBatchStatus(db: D1Database, id: string, from: BatchStatus[], to: BatchStatus, now: string): Promise<boolean> {
  if (from.length === 0) return false;
  const res = await db.prepare(`UPDATE care_batches SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks(from.length)})`).bind(to, now, id, ...from).run();
  return (res.meta.changes ?? 0) === 1;
}

// --- runs ----------------------------------------------------------------------------------------------------------------------------------------------------------

export async function insertRun(
  db: D1Database, r: { batchId: string; siteId: string; wave: 0 | 1 | 2; approvalId?: string | null; helperJobId?: string | null; status?: RunStatus; now: string },
): Promise<CareRun> {
  const row = await db.prepare(
    `INSERT INTO care_runs (id, batch_id, site_id, wave, approval_id, helper_job_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(crypto.randomUUID(), r.batchId, r.siteId, r.wave, r.approvalId ?? null, r.helperJobId ?? null, r.status ?? "queued", r.now).first<RunRow>();
  return toRun(row!);
}

export async function getRun(db: D1Database, id: string): Promise<CareRun | null> {
  const r = await db.prepare(`SELECT * FROM care_runs WHERE id = ?`).bind(id).first<RunRow>();
  return r ? toRun(r) : null;
}

export async function runsFor(db: D1Database, batchId: string): Promise<CareRun[]> {
  const rows = (await db.prepare(`SELECT * FROM care_runs WHERE batch_id = ? ORDER BY created_at, rowid`).bind(batchId).all<RunRow>()).results;
  return rows.map(toRun);
}

/**
 * Moves a run from one of the `from` statuses to `to`, in one statement (false when it was not in any of them). A finishing status stamps `finished_at`.
 * `patch` fills the backup file, the summary, the helper job and the approval only when given; a value already stored is kept otherwise.
 */
export async function setRunStatus(
  db: D1Database, id: string, from: RunStatus[], to: RunStatus,
  patch: { backupFile?: string | null; summary?: string | null; helperJobId?: string | null; approvalId?: string | null }, now: string,
): Promise<boolean> {
  if (from.length === 0) return false;
  const res = await db.prepare(
    `UPDATE care_runs SET status = ?,
       backup_file = CASE WHEN ? = 1 THEN ? ELSE backup_file END, summary = CASE WHEN ? = 1 THEN ? ELSE summary END,
       helper_job_id = CASE WHEN ? = 1 THEN ? ELSE helper_job_id END, approval_id = CASE WHEN ? = 1 THEN ? ELSE approval_id END,
       finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
     WHERE id = ? AND status IN (${marks(from.length)})`,
  ).bind(
    to,
    patch.backupFile !== undefined ? 1 : 0, patch.backupFile ?? null, patch.summary !== undefined ? 1 : 0, patch.summary ?? null,
    patch.helperJobId !== undefined ? 1 : 0, patch.helperJobId ?? null, patch.approvalId !== undefined ? 1 : 0, patch.approvalId ?? null,
    TERMINAL_RUN.includes(to) ? 1 : 0, now, id, ...from,
  ).run();
  return (res.meta.changes ?? 0) === 1;
}

// --- page checks ---------------------------------------------------------------------------------------------------------------------------------------------------

export async function insertPageChecks(db: D1Database, runId: string, rows: PageCheckInput[]): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(rows.map((c) => db.prepare(
    `INSERT INTO care_page_checks (id, run_id, path, before_key, after_key, diff_key, status_before, status_after, forms_before, forms_after, ssim, verdict, review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), runId, c.path, c.beforeKey ?? null, c.afterKey ?? null, c.diffKey ?? null, c.statusBefore ?? null, c.statusAfter ?? null,
    c.formsBefore ?? null, c.formsAfter ?? null, c.ssim ?? null, c.verdict, c.review ?? "none",
  )));
}

export async function pageChecksFor(db: D1Database, runId: string): Promise<PageCheck[]> {
  const rows = (await db.prepare(`SELECT * FROM care_page_checks WHERE run_id = ? ORDER BY rowid`).bind(runId).all<CheckRow>()).results;
  return rows.map(toCheck);
}

export async function getPageCheck(db: D1Database, id: string): Promise<PageCheck | null> {
  const r = await db.prepare(`SELECT * FROM care_page_checks WHERE id = ?`).bind(id).first<CheckRow>();
  return r ? toCheck(r) : null;
}

/** Records the review of one page check, only while it is in one of the `from` states; false otherwise. */
export async function setReview(db: D1Database, checkId: string, from: Review[], to: Review): Promise<boolean> {
  if (from.length === 0) return false;
  const res = await db.prepare(`UPDATE care_page_checks SET review = ? WHERE id = ? AND review IN (${marks(from.length)})`).bind(to, checkId, ...from).run();
  return (res.meta.changes ?? 0) === 1;
}

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
/** A rehearsal client's Care subscription: the same rule as `CARE_SUBSCRIPTION_SQL`, for the test rows it leaves out. Used only when a rehearsal is asked for. */
const TEST_CARE_SQL = (a: string): string =>
  `EXISTS (SELECT 1 FROM subscriptions ts WHERE ts.business_id = ${a}.id AND ts.test = 1 AND ts.status IN (${list(LIVE)}) AND ts.package_key IN (${list(CARE_KEYS)}))`;

// --- which sites -----------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The sites a weekly batch may touch: live, real (test ones only with `includeTest`), WordPress read over SSH with an alias and a folder set, and a client with live Care and no open hold.
 * Oldest first, so the order is steady.
 */
export async function updatableSites(db: D1Database, o: { includeTest: boolean }): Promise<Site[]> {
  const rows = (await db.prepare(
    `SELECT s.* FROM sites s JOIN businesses b ON b.id = s.business_id
     WHERE s.archived_at IS NULL AND s.cms = 'wordpress' AND s.access_method = 'ssh_wpcli'
       AND s.wp_ssh_alias IS NOT NULL AND s.wp_ssh_alias <> '' AND s.wp_path IS NOT NULL AND s.wp_path <> ''
       ${o.includeTest ? "" : `AND s.test = 0 AND NOT ${testClientSql("b")}`}
       AND (${CARE_SUBSCRIPTION_SQL("b")}${o.includeTest ? ` OR ${TEST_CARE_SQL("b")}` : ""}) AND ${holdFreeSql("s")}
     ORDER BY s.created_at, s.id`,
  ).all<SiteRow>()).results;
  return rows.map(toSite);
}
