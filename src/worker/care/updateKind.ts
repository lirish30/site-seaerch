import { z } from "zod";
import type { Env } from "../env";
import { logActivityOnce } from "../db/activity";
import {
  getRun, insertPageChecks, pageChecksFor, setReview, setRunStatus, type CareRun, type CareUpdate, type RunStatus, type UpdateStatus,
} from "../db/careUpdates";
import { getSite, type Site } from "../db/sites";
import { InvalidHelperJobError, enqueueHelperJob } from "../helper/jobs";
import { HelperRefused, registerHelperKind, type HelperKindDef } from "../helper/registry";
import { WP_ARG, SshTarget } from "./args";
import { onRunDone } from "./batch";
import { BACKUP_FAILED_SENTENCE, FAILED_SENTENCE, brokenPageSentence, openUpdateIncident, rollbackFailedSentence, rolledBackSentence, stillBrokenSentence } from "./incidents";
import { queueReview } from "../queue/careReview";
import { MAX_PATHS } from "./versions";

/** The helper updates one client site's plugins, themes and core over SSH: backup, page checks, the updates, a put-back when a page breaks. Only ever queued from an approved run. */
export const CARE_UPDATE_KIND = "care.update";

export const MAX_UPDATES = 40;
const MAX_NOTE = 500;
const MAX_STEPS = MAX_UPDATES;
const SAFE_WORD = /^[A-Za-z0-9._-]{1,100}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A backup file name the helper made: a relative path of plain characters, no `..`. */
const BACKUP_FILE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,300}$/;

const Version = z.string().regex(WP_ARG.version).refine((v) => !v.includes(".."), "That is not a valid version.");

const Update = z.object({
  id: z.string().regex(SAFE_WORD),
  type: z.enum(["core", "plugin", "theme"]),
  /** A core update's slug is "wordpress". Every slug is later put in a remote shell command, so each fits the fixed pattern. */
  slug: z.string().regex(WP_ARG.slug),
  from: Version,
  to: Version,
  rollbackable: z.boolean(),
});

const SiteUrl = z.string().max(300).refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && /^[a-z0-9.-]+$/i.test(u.hostname) && !u.hostname.includes("..") && u.hostname.length <= 100;
  } catch { return false; }
}, "That is not a valid site address.").transform((v) => new URL(v).origin);

export const CareUpdatePayload = SshTarget.extend({
  runId: z.string().regex(RUN_ID),
  siteId: z.string().regex(SAFE_WORD),
  siteUrl: SiteUrl,
  paths: z.array(z.string().regex(WP_ARG.checkPath)).max(MAX_PATHS),
  updates: z.array(Update).min(1).max(MAX_UPDATES),
}).superRefine((p, ctx) => {
  const ids = new Set<string>();
  const components = new Set<string>();
  for (const u of p.updates) {
    const component = u.type === "core" ? "core" : `${u.type}:${u.slug}`;
    if (ids.has(u.id) || components.has(component)) ctx.addIssue({ code: "custom", message: "The same update is listed twice.", path: ["updates"] });
    ids.add(u.id);
    components.add(component);
  }
});
export type CareUpdatePayload = z.infer<typeof CareUpdatePayload>;

/** A note is the helper's own fixed sentence, perhaps with a short reason; it is capped, never shown as a rule and never put in an incident. */
const Note = z.string().transform((s) => s.slice(0, MAX_NOTE));
const Read = z.object({ status: z.number().int().min(0).max(999).nullable(), fatal: z.boolean(), forms: z.number().int().min(0).max(100_000) });
const Step = z.object({ id: z.string().min(1).max(100), outcome: z.enum(["applied", "skipped", "failed", "rolled_back", "rollback_failed"]), note: Note });
const Page = z.object({
  path: z.string().regex(WP_ARG.checkPath),
  before: Read,
  after: Read,
  ssim: z.number().finite().nullable(),
  verdict: z.enum(["ok", "changed", "broken"]),
  uploaded: z.object({ before: z.boolean(), after: z.boolean(), diff: z.boolean() }),
});

/** Exactly what `helper/src/handlers/careUpdate.ts` returns. `pages` is empty on an early exit; on a retry every `before` is `{ status: null, fatal: false, forms: 0 }`. */
export const CareUpdateResult = z.object({
  backupFile: z.string().regex(BACKUP_FILE).nullable(),
  steps: z.array(Step).max(MAX_STEPS),
  pages: z.array(Page).max(MAX_PATHS),
  rolledBack: z.boolean(),
  retry: z.boolean(),
});
export type CareUpdateResult = z.infer<typeof CareUpdateResult>;

/** Where the helper puts a page's three pictures. The run's id and the page's place in the list are in the name, so no other key can pass for one. */
export const carePageKeys = (runId: string, i: number): { before: string; after: string; diff: string } => ({
  before: `care/${runId}/${i}-before.jpg`, after: `care/${runId}/${i}-after.jpg`, diff: `care/${runId}/${i}-diff.jpg`,
});

const EXPIRED_SUMMARY = "your Mac helper didn't pick this up in time";
const BACKUP_NOTE = "the backup failed, nothing was updated";
/** The helper's note on an update it put back only because ANOTHER update failed: nothing is wrong with this one, so it waits again (I3). */
export const COLLATERAL_NOTE = "put back because another update failed";
const FINAL: readonly RunStatus[] = ["ok", "changed", "rolled_back", "failed", "dropped"];
const OPEN: RunStatus[] = ["queued", "running"];

/** The absolute rule (no "before" to compare with): no answer, 404, 410, 5xx or the critical-error text. */
const stillDown = (a: { status: number | null; fatal: boolean }): boolean => a.status === null || a.status === 404 || a.status === 410 || a.status >= 500 || a.fatal;

const STEP_TO_UPDATE: Record<z.infer<typeof Step>["outcome"], UpdateStatus> = {
  applied: "applied", failed: "failed", rollback_failed: "failed", rolled_back: "rolled_back", skipped: "available",
};

/** Sets the updates this run queued (and nobody has moved on) to `to`. One statement per update id, in one batch. A move to failed or rolled back stamps `last_failed_at`. */
async function moveQueued(env: Env, siteId: string, to: (id: string) => UpdateStatus, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const now = new Date().toISOString();
  await env.DB.batch(ids.map((id) => {
    const status = to(id);
    const failed = status === "failed" || status === "rolled_back";
    return env.DB.prepare(`UPDATE care_updates SET status = ?, last_failed_at = CASE WHEN ? = 1 THEN ? ELSE last_failed_at END WHERE id = ? AND site_id = ? AND status IN ('queued', 'available')`)
      .bind(status, failed ? 1 : 0, now, id, siteId);
  }));
}

/**
 * Queues one site's update run: checks the payload FIRST (a slug, version, alias or path with shell syntax throws `InvalidHelperJobError` and nothing is written),
 * then inserts the run `queued`, marks its updates `queued` and queues the helper job. One open update job per site (`care.update:<siteId>`): when one is already open the run is
 * kept as `dropped` and null comes back, and nothing else changes.
 */
export async function queueRun(
  env: Env, o: { batchId: string; site: Site; wave: 0 | 1 | 2; approvalId: string | null; updates: CareUpdate[] },
): Promise<CareRun | null> {
  const db = env.DB;
  const draft = (runId: string) => ({
    runId, siteId: o.site.id, siteUrl: o.site.url ?? "", alias: o.site.wpSshAlias ?? "", path: o.site.wpPath ?? "", paths: o.site.carePaths,
    updates: o.updates.filter((u) => u.siteId === o.site.id).map((u) => ({ id: u.id, type: u.type, slug: u.slug, from: u.fromVersion, to: u.toVersion, rollbackable: u.rollbackable })),
  });
  const check = CareUpdatePayload.safeParse(draft(crypto.randomUUID()));
  if (!check.success) throw new InvalidHelperJobError(`invalid payload for ${CARE_UPDATE_KIND}:\n${check.error.issues.map((i) => `- ${i.path.join(".") || "value"}: ${i.message}`).join("\n")}`);

  // The run and its updates' `queued` mark go in one batch BEFORE the job exists, so a crash can never leave a running job whose updates still look available.
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO care_runs (id, batch_id, site_id, wave, approval_id, helper_job_id, status, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'queued', ?)`)
      .bind(runId, o.batchId, o.site.id, o.wave, o.approvalId, now),
    ...check.data.updates.map((u) => db.prepare(`UPDATE care_updates SET status = 'queued' WHERE id = ? AND site_id = ? AND status = 'available'`).bind(u.id, o.site.id)),
  ]);
  const undo = async (summary: string): Promise<void> => {
    await setRunStatus(db, runId, ["queued"], "dropped", { summary }, now);
    await moveQueued(env, o.site.id, () => "available", check.data.updates.map((u) => u.id));
  };
  let job: { id: string; created: boolean };
  try {
    job = await enqueueHelperJob(db, CARE_UPDATE_KIND, draft(runId), { dedupeKey: `care.update:${o.site.id}` });
  } catch (e) {
    await undo("the update could not be queued for the Mac helper");
    throw e;
  }
  if (!job.created) {
    await undo("another update is already waiting for this site's Mac helper");
    return null;
  }
  await setRunStatus(db, runId, ["queued"], "queued", { helperJobId: job.id }, now);
  return (await getRun(db, runId))!;
}

const careUpdate: HelperKindDef<CareUpdatePayload, CareUpdateResult> = {
  kind: CARE_UPDATE_KIND,
  payload: CareUpdatePayload,
  result: CareUpdateResult,
  inputs: () => [],
  outputs: (p) => p.paths.flatMap((_, i) => Object.values(carePageKeys(p.runId, i))),

  /**
   * Records what the helper did. Refused (the job stays claimed, the helper is told why) when the run is not open, the site is gone, a page is not one of the run's pages, or a picture it
   * says it uploaded is not in R2. Every effect before the final run-status move is safe to repeat, so a crash and retry finishes the job; a run that already has its final status is a replay and changes nothing.
   * The words of an incident come from the stored payload and run, never from a note.
   */
  async apply(env, p, r) {
    const db = env.DB;
    const run = await getRun(db, p.runId);
    if (!run || run.siteId !== p.siteId) throw new HelperRefused("that update run is gone");
    // A run the helper's own result dropped (nothing happened) is a replay; one that expired or was dropped at queue time is refused.
    if (run.status === "dropped" && (run.summary === EXPIRED_SUMMARY || !!run.summary?.startsWith("another update"))) throw new HelperRefused("that update run was dropped, so its result is not taken");
    if (FINAL.includes(run.status)) { await onRunDone(env, run.batchId); return; }
    const site = await getSite(db, p.siteId);
    if (!site) throw new HelperRefused("that site is gone");

    // The pages must be this run's pages, in order, and every picture must really be there.
    if (r.pages.length > p.paths.length) throw new HelperRefused("the result names more pages than this run checks");
    for (const [i, pg] of r.pages.entries()) {
      if (pg.path !== p.paths[i]) throw new HelperRefused(`page ${i + 1} is not one of this run's pages`);
      const keys = carePageKeys(p.runId, i);
      for (const kind of ["before", "after", "diff"] as const) {
        if (pg.uploaded[kind] && !(await env.RAW.head(keys[kind]))) throw new HelperRefused(`the ${kind} picture of page ${i + 1} was never uploaded to ${keys[kind]}`);
      }
    }

    const now = new Date();
    const nowIso = now.toISOString();
    if (r.pages.length && (await pageChecksFor(db, run.id)).length === 0) {
      await insertPageChecks(db, run.id, r.pages.map((pg, i) => {
        const keys = carePageKeys(p.runId, i);
        return {
          path: pg.path, beforeKey: pg.uploaded.before ? keys.before : null, afterKey: pg.uploaded.after ? keys.after : null, diffKey: pg.uploaded.diff ? keys.diff : null,
          statusBefore: pg.before.status, statusAfter: pg.after.status,
          // A retry did not read the page before the update, so its "before" is unknown, not zero forms.
          formsBefore: r.retry ? null : pg.before.forms, formsAfter: pg.after.forms, ssim: pg.ssim, verdict: pg.verdict,
        };
      }));
    }

    // The updates: each one the helper named moves to what happened to it; the rest go back to waiting.
    const outcome = new Map(r.steps.map((s) => [s.id, s.outcome] as const));
    const collateral = new Set(r.steps.filter((s) => s.outcome === "rolled_back" && s.note.startsWith(COLLATERAL_NOTE)).map((s) => s.id));
    const ids = p.updates.map((u) => u.id);
    await moveQueued(env, p.siteId, (id) => (collateral.has(id) ? "available" : STEP_TO_UPDATE[outcome.get(id) ?? "skipped"]), ids);

    const outcomes = p.updates.map((u) => ({ u, o: outcome.get(u.id) ?? "skipped" as const }));
    const slugsOf = (o: string) => outcomes.filter((x) => x.o === o).map((x) => x.u.slug);
    const applied = slugsOf("applied").length;
    const backupFailed = r.steps.length > 0 && r.steps.every((x) => x.outcome === "skipped" && x.note.startsWith(BACKUP_NOTE));
    const broken = r.pages.find((pg) => pg.verdict === "broken");
    const stepBad = outcomes.some((x) => x.o === "failed" || x.o === "rollback_failed");
    const status: RunStatus = r.rolledBack ? "rolled_back"
      : stepBad || broken || backupFailed ? "failed"
      : r.pages.some((pg) => pg.verdict === "changed") ? "changed"
      : applied > 0 ? "ok" : "dropped";
    const counts = { applied, skipped: slugsOf("skipped").length, failed: slugsOf("failed").length + slugsOf("rollback_failed").length, putBack: slugsOf("rolled_back").length };
    const notes = [...new Set(r.steps.filter((x) => x.outcome === "skipped" && x.note.trim()).map((x) => x.note.trim()))].join("; ").slice(0, 300);
    const summary = status === "dropped" ? (notes || "nothing was updated") : `${counts.applied} applied, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.putBack} put back`;
    const tag = run.id.slice(0, 8);
    const domain = site.domain ?? "site";

    if (status === "rolled_back" || status === "failed") {
      const stuck = slugsOf("rollback_failed");
      const putBack = slugsOf("rolled_back").concat(slugsOf("failed"));
      // After a put-back the helper read every page again: one still null/404/410/5xx/fatal means the old code did not fix it, and only the backup can (I7).
      // On a first attempt a page that was already down before the update is not the update's doing (G2); a retry has no "before", so the absolute rule stands.
      const stillBroken = r.rolledBack ? r.pages.find((pg) => stillDown(pg.after) && (r.retry || !stillDown(pg.before))) : undefined;
      const why = stuck.length ? rollbackFailedSentence(stuck, r.backupFile)
        : stillBroken ? stillBrokenSentence(stillBroken.path, r.backupFile)
        : r.rolledBack ? rolledBackSentence(putBack.length ? putBack : p.updates.map((u) => u.slug), broken ? broken.path : null)
        : backupFailed ? BACKUP_FAILED_SENTENCE
        : broken ? brokenPageSentence(broken.path)
        : FAILED_SENTENCE;
      await openUpdateIncident(env, run, site, why, now);
      if (status === "rolled_back") await logActivityOnce(db, site.businessId, "care_rolled_back", `${domain}: updates rolled back (run ${tag})`);
    } else if (status !== "dropped") {
      // An ok run never closes an open update_failed incident (the site may be mid-restore): only Logan does.
      if (applied > 0) await logActivityOnce(db, site.businessId, "care_updated", `${domain}: ${applied} ${applied === 1 ? "update" : "updates"} applied (run ${tag})`);
      // A changed page waits for Claude's look. A retry finds the review already pending and still queues (the task's dedupe key is the check id, so never two).
      if (status === "changed") {
        for (const c of await pageChecksFor(db, run.id)) {
          if (c.verdict !== "changed") continue;
          await setReview(db, c.id, ["none"], "pending");
          await queueReview(env, c.id);
        }
      }
    }

    // The commit point. Whoever lost a race for it (the run was dropped while the effects above ran) says so.
    if (!(await setRunStatus(db, run.id, OPEN, status, { backupFile: r.backupFile, summary }, nowIso))) {
      const now2 = await getRun(db, run.id);
      if (!now2 || now2.status === "dropped") throw new HelperRefused("that update run was dropped, so its result is not taken");
    }
    await onRunDone(env, run.batchId);
  },

  /** The helper gave the job up: the run failed, its updates wait again. */
  async onFail(env, p) {
    const run = await endRun(env, p, "failed", FAILED_SENTENCE);
    // A job that died may have half-updated the site, so it is an incident (and a fix task) like any failed run.
    const site = run && (await getSite(env.DB, p.siteId));
    if (run && site) await openUpdateIncident(env, run, site, FAILED_SENTENCE, new Date());
  },
  /** Nobody picked the job up in time. */
  async onExpire(env, p) { await endRun(env, p, "dropped", EXPIRED_SUMMARY); },
};

async function endRun(env: Env, p: CareUpdatePayload, status: "failed" | "dropped", summary: string): Promise<CareRun | null> {
  const run = await getRun(env.DB, p.runId);
  if (!run) return null;
  if (!(await setRunStatus(env.DB, run.id, OPEN, status, { summary }, new Date().toISOString()))) return null;
  await moveQueued(env, p.siteId, () => "available", p.updates.map((u) => u.id));
  await onRunDone(env, run.batchId);
  return run;
}

registerHelperKind(careUpdate);
