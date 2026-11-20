import { logActivityOnce } from "../db/activity";
import { getDocument, listForDeal, type Document } from "../db/documents";
import { getOnboardingForDeal } from "../db/onboardings";
import type { PackageKey } from "../db/packages";
import { createProject, getProject, type Project, type ProjectKind } from "../db/projects";
import { ensureSeedSops, templatesForPackages } from "../db/sops";
import { SEED_SOPS } from "../sop/seeds";
import { listTasks } from "../db/tasks";
import { BUILD_KEYS } from "../documents/schedule";
import type { Env } from "../env";
import { cleanText } from "../onboarding/templates";
import { instantiateSop } from "../sop/instantiate";
import type { SopTemplate } from "../sop/model";
import { onProjectDone, runTasksChanged } from "./hooks";
import "./dispatch"; // registers the hook that sends the next ready Claude step when a task changes

/** A test project cannot be started (a 409): the message is a plain sentence for Logan. */
export class ProjectStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStartError";
  }
}

const CARE_KEYS: PackageKey[] = ["care", "care_plus", "care_fallback"];
/** Sold alongside a job, never a job of their own: a missing template for these is not worth a note. */
const NO_PROJECT_KEYS: PackageKey[] = ["client_hosted_surcharge", "hourly"];
/** The client's name comes from scraped lead data, so it is cleaned and clipped before it becomes part of a name. */
const CLIENT_NAME_MAX = 80;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const covers = (t: SopTemplate, keys: PackageKey[]) => t.appliesTo.some((k) => keys.includes(k));
const projectName = (doc: Document, t: SopTemplate) => `${cleanText(doc.content.header.clientName, CLIENT_NAME_MAX) || "Client"}: ${t.name}`;

/**
 * Makes the project for one template (or finds the one already made for this document) and makes sure it has its steps. The steps are copied whenever the project has
 * none, not only when the project is new, so a start that died between the two heals when it is run again.
 */
async function begin(env: Env, doc: Document, template: SopTemplate, o: { kind: ProjectKind; careDeferred: boolean; now: Date }): Promise<Project> {
  const db = env.DB;
  const onboarding = await getOnboardingForDeal(db, doc.dealId);
  const { project } = await createProject(db, {
    businessId: doc.businessId, dealId: doc.dealId, documentId: doc.id, onboardingId: onboarding?.id ?? null, kind: o.kind, name: projectName(doc, template), test: doc.test,
    templateKey: template.key, templateVersion: template.version, careDeferred: o.careDeferred, startedAt: o.now.toISOString(),
  });
  if (!(await listTasks(db, project.id)).length) {
    try { await instantiateSop(db, { project, template }); }
    catch (e) {
      // A start at the same moment copied the steps first (the batch refuses a step key the project already has): its steps are the project's.
      if (!(await listTasks(db, project.id)).length) throw e;
    }
  }
  await logActivityOnce(db, doc.businessId, "project_started", `${project.name} started (${doc.content.header.reference} v${doc.version})${project.test ? ", test" : ""}`);
  return project;
}

/** One note on the lead's timeline (once per document and package set) for packages that have no SOP, so a sale is never silently without a project. */
async function noteMissing(env: Env, doc: Document, names: string[]): Promise<void> {
  if (!names.length) return;
  const detail = oneLine(`${doc.content.header.reference} v${doc.version}: no SOP for ${names.join(", ")} yet, so no project was started for it`);
  await logActivityOnce(env.DB, doc.businessId, "note", detail)
    .catch((e) => console.error("projects: could not note the missing SOP", e instanceof Error ? e.message : "unknown error"));
}

/** One cheap read: whether every built-in template is already in the database, so the 5 insert batches of `ensureSeedSops` are skipped on every later start. */
async function seedsPresent(db: D1Database): Promise<boolean> {
  const keys = SEED_SOPS.map((t) => t.key);
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM sop_templates WHERE key IN (${keys.map(() => "?").join(", ")})`).bind(...keys).first<{ n: number }>();
  return (row?.n ?? 0) >= keys.length;
}

/**
 * Starts the projects for a signed proposal, from the packages the document froze: one primary project (BUILD for a site, else QUICKFIX) and a Care project (CARE-0) unless Care was
 * declined or is not sold. When there is a primary, Care waits (`careDeferred` on the primary) and starts when the primary is done; otherwise Care starts now. A package with no
 * template leaves one note on the lead's timeline and nothing else. Idempotent per (document, template): a replay finds the same projects, and one that has no steps gets them.
 * A real project then runs the tasks-changed hooks so its Claude steps begin; a test one (copied from the document) queues nothing. Returns the projects, primary first.
 * It does not catch database errors: the payment path wraps it so a failure here can never stop a payment from being recorded.
 */
export async function startProjects(env: Env, doc: Document, o: { now?: Date } = {}): Promise<Project[]> {
  if (doc.status !== "signed") return [];
  const now = o.now ?? new Date();
  if (!(await seedsPresent(env.DB))) await ensureSeedSops(env.DB);
  const keys = doc.content.packages.map((p) => p.key);
  const templates = await templatesForPackages(env.DB, keys);

  const buildTemplate = templates.find((t) => covers(t, keys.filter((k) => BUILD_KEYS.includes(k))));
  const quickTemplate = buildTemplate ? undefined : templates.find((t) => covers(t, keys.filter((k) => k === "quick_fix")));
  const careWanted = !doc.content.careDeclined;
  const careTemplate = careWanted ? templates.find((t) => covers(t, keys.filter((k) => CARE_KEYS.includes(k)))) : undefined;
  const primaryTemplate = buildTemplate ?? quickTemplate;

  // Every package that nothing above will start is named once. A declined Care is not a gap; a hosting surcharge or hourly time is not a job.
  const started = [primaryTemplate, careTemplate].filter((t): t is SopTemplate => !!t);
  const missing = doc.content.packages.filter((p) => !NO_PROJECT_KEYS.includes(p.key) && !(CARE_KEYS.includes(p.key) && !careWanted) && !started.some((t) => t.appliesTo.includes(p.key)));
  await noteMissing(env, doc, missing.map((p) => p.name));

  const out: Project[] = [];
  if (primaryTemplate) {
    const primary = await begin(env, doc, primaryTemplate, { kind: primaryTemplate === buildTemplate ? "build" : "quick_fix", careDeferred: !!careTemplate, now });
    out.push(primary);
    // The primary may have finished before this replay (a payment found again later): hand over the Care project a done hook may have missed.
    if (primary.careDeferred && primary.status === "done") {
      const care = await startDeferredCare(env, primary);
      if (care) out.push(care);
    }
  } else if (careTemplate) {
    out.push(await begin(env, doc, careTemplate, { kind: "care_onboarding", careDeferred: false, now }));
  }
  if (!doc.test) for (const p of out) if (p.status === "active") await runTasksChanged(env, p.id);
  return out;
}

/** A one-time line on the lead's timeline (the same words once, so a daily retry does not pile them up) saying Care did not start when the build finished. Best effort. */
async function noteCareNotStarted(env: Env, doc: Document, why: string): Promise<void> {
  const detail = oneLine(`${doc.content.header.reference} v${doc.version}: Care was not started when the build finished ${why}`);
  await logActivityOnce(env.DB, doc.businessId, "note", detail)
    .catch((e) => console.error("projects: could not note that Care was not started", e instanceof Error ? e.message : "unknown error"));
}

/**
 * Starts the Care project (CARE-0) for the document the primary project was sold on, when the primary was set to wait for it. Registered with `onProjectDone`, so it runs
 * when the primary finishes, and the daily sweep runs it again for a finished build that has no Care project (a lost or failed hook); only a project that is `done` counts (a cancelled
 * build starts no Care). Once: the same call again returns the project already made. A failure to start it, or no active Care template, leaves one note on the lead's timeline (the same
 * line once) so it is never silent; a failure is still thrown to the caller (the hook runner logs it, the sweep notes it and tries again).
 * Null when there is nothing to start (no wait set, no document, Care declined or not sold, no active Care template, or the primary is not done).
 */
export async function startDeferredCare(env: Env, primary: Project): Promise<Project | null> {
  const current = (await getProject(env.DB, primary.id)) ?? primary;
  if (!current.careDeferred || current.status !== "done" || !current.documentId) return null;
  const doc = await getDocument(env.DB, current.documentId);
  if (!doc || doc.content.careDeclined) return null;
  const keys = doc.content.packages.map((p) => p.key).filter((k) => CARE_KEYS.includes(k));
  if (!keys.length) return null;
  const template = (await templatesForPackages(env.DB, keys)).find((t) => covers(t, keys));
  if (!template) {
    await noteCareNotStarted(env, doc, "because its Care template (CARE-0) is switched off or missing. Switch it on in Settings > SOPs and the daily sweep will start Care.");
    return null;
  }
  let care: Project;
  try { care = await begin(env, doc, template, { kind: "care_onboarding", careDeferred: false, now: new Date() }); }
  catch (e) {
    await noteCareNotStarted(env, doc, "(it will be tried again by the daily sweep, or press Start projects on the deal).");
    throw e;
  }
  if (!care.test && care.status === "active") await runTasksChanged(env, care.id);
  return care;
}
/** The done hook: starts the Care project that was waiting for the primary. */
export const startCareWhenDone = async (env: Env, primary: Project): Promise<void> => { await startDeferredCare(env, primary); };
onProjectDone(startCareWhenDone);

/**
 * The document the owner's "Start projects" button works from: the deal's latest signed, real (not a test copy) proposal whose deposit is paid, or the plain sentence that says why there
 * is none. The payment normally starts the projects by itself; this is the retry for when it could not.
 */
export async function paidSignedDocument(db: D1Database, dealId: string): Promise<{ doc: Document } | { problem: string }> {
  const signed = (await listForDeal(db, dealId)).filter((d) => d.status === "signed" && !d.test);
  if (!signed.length) return { problem: "There is no signed proposal for this deal yet (a test copy does not count)." };
  const paid = signed.find((d) => d.paidAt);
  return paid ? { doc: paid } : { problem: "The deposit has not been paid yet. Projects start when it is." };
}

/**
 * Rehearses the start for a deal whose latest signed proposal is a test copy: the same projects, marked test, that queue nothing for Claude (dispatch skips them).
 * Refuses, with a plain sentence, a deal with no signed proposal or whose latest signed one is real.
 */
export async function startTestProject(env: Env, dealId: string, o: { now?: Date } = {}): Promise<Project[]> {
  const latest = (await listForDeal(env.DB, dealId)).find((d) => d.status === "signed");
  if (!latest) throw new ProjectStartError("There is no signed proposal for this deal yet, so there is nothing to start a project from.");
  if (!latest.test) throw new ProjectStartError("This deal's signed proposal is a real one, so a test project cannot be started from it. Rehearse on a test lead instead.");
  return startProjects(env, latest, o);
}

/** The most documents one call takes, so a long backlog cannot run a request or a sweep out of time; the rest wait for the next call. */
const SWEEP_LIMIT = 25;

/**
 * Starts projects for real, signed documents whose deposit is paid and that have no project at all (the retry for a payment whose start failed: it is never replayed, because the
 * document is marked paid), whose project was made but never got its steps (a start that died between the two), or whose finished build was waiting to hand over Care and never did (a lost
 * or failed done hook). A finished or cancelled project with no tasks is left as it is.
 * Each document is tried on its own, so one failure leaves the rest to go on (it is noted on the lead's timeline and tried again next time). Returns how many documents got a project
 * or their steps. A document that has none to start (a Local SEO sale, whose note is written once) is not counted. Safe to repeat: it finds nothing new the second time.
 *
 * The documents least recently tried come first (never-tried ones before all, then by payment date), and each one is marked as tried whatever came of it. So a document that can never
 * get a project, or keeps failing, takes its turn and then waits behind the others instead of filling the `limit` for good and starving the ones behind it.
 */
export async function startProjectsForPaidDocuments(env: Env, now: Date = new Date(), o: { limit?: number } = {}): Promise<number> {
  const ids = (await env.DB.prepare(
    `SELECT d.id FROM documents d WHERE d.status = 'signed' AND d.test = 0 AND d.paid_at IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM projects p WHERE p.document_id = d.id)
       OR EXISTS (SELECT 1 FROM projects p WHERE p.document_id = d.id AND p.status = 'active' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id))
       OR EXISTS (SELECT 1 FROM projects p WHERE p.document_id = d.id AND p.care_deferred = 1 AND p.status = 'done'
                    AND NOT EXISTS (SELECT 1 FROM projects c WHERE c.document_id = d.id AND c.kind = 'care_onboarding')))
     ORDER BY COALESCE(d.projects_checked_at, ''), d.paid_at, d.id LIMIT ?`,
  ).bind(o.limit ?? SWEEP_LIMIT).all<{ id: string }>()).results;
  let started = 0;
  for (const { id } of ids) {
    try {
      const doc = await getDocument(env.DB, id);
      if (doc && (await startProjects(env, doc, { now })).length) started++;
    } catch (e) {
      const raw = e instanceof Error ? e.message : "unknown error";
      const key = env.STRIPE_SECRET_KEY;
      const reason = (key ? raw.split(key).join("[key]") : raw).replace(/\s+/g, " ").trim().slice(0, 200);
      console.error("projects: could not start the projects for a paid document", reason);
      try {
        const doc = await getDocument(env.DB, id);
        if (doc) await logActivityOnce(env.DB, doc.businessId, "note", `${doc.content.header.reference} v${doc.version}: projects were not started: ${reason}. Use Start projects on the deal, or wait for the daily sweep.`);
      } catch { /* the note is best effort */ }
    }
    await env.DB.prepare(`UPDATE documents SET projects_checked_at = ? WHERE id = ?`).bind(now.toISOString(), id)
      .run().catch((e) => console.error("projects: could not mark a document as tried", e instanceof Error ? e.message : "unknown error"));
  }
  return started;
}
