import { availableForSites, careBoardSites, getInventory, getWeeklyBatch, lastRunsFor, pageChecksFor, type CareBatch, type CareRun, type CareUpdate, type PageCheck, type Review, type Risk, type RunStatus, type UpdateType, type Verdict } from "../db/careUpdates";
import { openIncidentsFor } from "../db/monitoring";
import { getSettings } from "../db/settings";
import type { Site } from "../db/sites";
import { chunks } from "../db/chunks";
import { incidentViews, type IncidentView } from "../monitoring/fleet";
import { periodKey, zoneOf } from "../sop/cadence";
import { heldBusinessIds } from "../db/holds";
import { isDue, needsTick } from "./versions";

// What the owner's Care updates board and the MCP tool show (Plan 12). Built field by field: a site's SSH alias and folder, a picture's storage key and the backup directory never leave here.
// The backup file's name is on the run view and the incident only.

export interface CareUpdateView {
  id: string; type: UpdateType; slug: string; name: string; fromVersion: string; toVersion: string; risk: Risk;
  rollbackable: boolean; security: boolean; held: boolean; needsTick: boolean; due: boolean; firstSeenAt: string;
}
export interface CareRunView { id: string; batchId: string; wave: 0 | 1 | 2; status: RunStatus; summary: string | null; createdAt: string; finishedAt: string | null }
export interface CareSiteView {
  siteId: string; domain: string | null; group: string | null; canUpdate: boolean; why: string | null;
  updates: CareUpdateView[]; lastRun: CareRunView | null; openIncident: IncidentView | null;
}
export interface CareUpdatesBoard { batch: CareBatch | null; sites: CareSiteView[] }
export interface PageCheckView {
  id: string; path: string; statusBefore: number | null; statusAfter: number | null; formsBefore: number | null; formsAfter: number | null; ssim: number | null;
  verdict: Verdict; review: Review; pictures: { before: string | null; after: string | null; diff: string | null };
}
export interface CareRunDetail extends CareRunView { backupFile: string | null; pages: PageCheckView[] }

const MAX_SUMMARY = 300;
const clip = (s: string | null): string | null => (s === null ? null : s.slice(0, MAX_SUMMARY));

export function updateView(u: CareUpdate, now: Date): CareUpdateView {
  return {
    id: u.id, type: u.type, slug: u.slug, name: u.name, fromVersion: u.fromVersion, toVersion: u.toVersion, risk: u.security ? "security" : u.risk,
    rollbackable: u.rollbackable, security: u.security, held: u.held, needsTick: needsTick(u), due: isDue(u, now), firstSeenAt: u.firstSeenAt,
  };
}

export const runView = (r: CareRun): CareRunView => ({ id: r.id, batchId: r.batchId, wave: r.wave, status: r.status, summary: clip(r.summary), createdAt: r.createdAt, finishedAt: r.finishedAt });

/** Why a site cannot take updates (a plain phrase), or null when it can. The access method comes first: a MainWP site is "no SSH access" whatever platform it is marked. */
export function whyNotUpdatable(site: Pick<Site, "cms" | "accessMethod" | "wpSshAlias" | "wpPath">): string | null {
  if (site.accessMethod !== "ssh_wpcli") return "no SSH access";
  if (site.cms !== "wordpress") return "not WordPress";
  if (!site.wpSshAlias || !site.wpPath) return "SSH alias or path missing";
  return null;
}

/** The picture links are our own route (behind the owner's session): the storage key is never shown. */
const pictureLink = (checkId: string, kind: "before" | "after" | "diff", key: string | null): string | null => (key ? `/api/care/pictures/${checkId}/${kind}` : null);

export async function runDetail(db: D1Database, run: CareRun): Promise<CareRunDetail> {
  const checks = await pageChecksFor(db, run.id);
  return { ...runView(run), backupFile: run.backupFile, pages: checks.map(pageView) };
}

export const pageView = (c: PageCheck): PageCheckView => ({
  id: c.id, path: c.path, statusBefore: c.statusBefore, statusAfter: c.statusAfter, formsBefore: c.formsBefore, formsAfter: c.formsAfter, ssim: c.ssim, verdict: c.verdict, review: c.review,
  pictures: { before: pictureLink(c.id, "before", c.beforeKey), after: pictureLink(c.id, "after", c.afterKey), diff: pictureLink(c.id, "diff", c.diffKey) },
});

/** This week's batch (or null) and every Care site with its updates, last run and open `update_failed` incident. A bounded number of reads however many sites there are. */
export async function careUpdatesBoard(db: D1Database, now: Date): Promise<CareUpdatesBoard> {
  const period = periodKey("weekly", now, zoneOf(await getSettings(db)));
  const [batch, sites] = await Promise.all([getWeeklyBatch(db, period), careBoardSites(db)]);
  const ids = sites.map((s) => s.id);
  const [updates, runs] = await Promise.all([availableForSites(db, ids), lastRunsFor(db, ids)]);
  const failed = new Map<string, IncidentView>();
  for (const part of chunks([...new Set(sites.map((s) => s.businessId))], 50)) {
    const open = (await openIncidentsFor(db, part)).filter((i) => i.kind === "update_failed");
    for (const v of await incidentViews(db, open, now)) if (!failed.has(v.siteId)) failed.set(v.siteId, v);
  }
  const held = new Set<string>();
  for (const part of chunks([...new Set(sites.map((s) => s.businessId))], 50)) for (const id of await heldBusinessIds(db, part)) held.add(id);
  const out: CareSiteView[] = [];
  for (const s of sites) {
    const why = whyNotUpdatable(s) ?? (held.has(s.businessId) ? "on billing hold" : null);
    const run = runs.get(s.id);
    out.push({
      siteId: s.id, domain: s.domain, group: (await getInventory(db, s.id))?.groupKey ?? null, canUpdate: why === null, why,
      updates: (updates.get(s.id) ?? []).map((u) => updateView(u, now)), lastRun: run ? runView(run) : null, openIncident: failed.get(s.id) ?? null,
    });
  }
  return { batch, sites: out };
}
