import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { carePageKeys, queueRun, CARE_UPDATE_KIND, type CareUpdatePayload } from "../src/worker/care/updateKind";
import { WP_ARG } from "../src/worker/care/args";
import { availableFor, createSingleBatch, getRun, pageChecksFor, setRunStatus, upsertSeen, type CareRun, type CareUpdate } from "../src/worker/db/careUpdates";
import { listIncidents, openIncident } from "../src/worker/db/monitoring";
import { createProject } from "../src/worker/db/projects";
import { getSite, type Site } from "../src/worker/db/sites";
import { ensureSeedSops } from "../src/worker/db/sops";
import { listTasks } from "../src/worker/db/tasks";
import { InvalidHelperJobError, getHelperJob } from "../src/worker/helper/jobs";
import { HelperRefused, getHelperKind } from "../src/worker/helper/kinds";
import { incidentView } from "../src/worker/monitoring/fleet";
import { seedClient } from "./fixtures/clients";

const def = () => getHelperKind(CARE_UPDATE_KIND)!;
const T0 = "2027-03-01T10:00:00.000Z";
const T1 = "2027-03-08T10:00:00.000Z";

beforeEach(async () => {
  await env.DB.batch(["care_page_checks", "care_runs", "care_batches", "care_updates", "site_incidents", "helper_jobs"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM tasks WHERE cadence_key = 'CARE-5'`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});

/** A real client with live Care, a WordPress site read over SSH, two waiting updates and (unless asked not to) a live Care project. */
async function setup(o: { project?: boolean; slugs?: string[] } = {}) {
  const s = await seedClient({ subs: [{ key: "care", monthlyCents: 5000 }] });
  await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = 'ace-host', wp_path = '/var/www/ace', care_paths = '["/","/contact"]' WHERE id = ?`).bind(s.site!.id).run();
  const careProject = o.project === false ? null : (await createProject(env.DB, {
    businessId: s.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false, startedAt: T0,
  })).project;
  const slugs = o.slugs ?? ["akismet", "yoast"];
  await upsertSeen(env.DB, s.site!.id, slugs.map((slug) => ({ type: "plugin" as const, slug, name: slug, fromVersion: "1.0", toVersion: "1.1", risk: "minor" as const, rollbackable: true })), T0);
  const site = (await getSite(env.DB, s.site!.id))!;
  const batch = await createSingleBatch(env.DB, site.id, "2027-W09", T0);
  return { ...s, site, careProject, batch };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function queue(c: Ctx, o: { updates?: CareUpdate[] } = {}): Promise<CareRun> {
  const run = await queueRun(env, { batchId: c.batch.id, site: c.site, wave: 0, approvalId: null, updates: o.updates ?? (await availableFor(env.DB, c.site.id)) });
  expect(run).not.toBeNull();
  return run!;
}
const payloadOf = async (run: CareRun): Promise<CareUpdatePayload> => def().payload.parse((await getHelperJob(env.DB, run.helperJobId!))!.payload);
const page = (o: Record<string, unknown> = {}) => ({
  path: "/", before: { status: 200, fatal: false, forms: 1 }, after: { status: 200, fatal: false, forms: 1 }, ssim: 0.99, verdict: "ok",
  uploaded: { before: false, after: false, diff: false }, ...o,
});
const stepsFor = async (run: CareRun, outcome = "applied", note = "") => (await payloadOf(run)).updates.map((u) => ({ id: u.id, outcome, note }));
const result = async (run: CareRun, o: Record<string, unknown> = {}) => ({
  backupFile: "siteline-backups/ace.com-x.sql.gz", steps: await stepsFor(run), pages: [page(), page({ path: "/contact" })], rolledBack: false, retry: false, ...o,
});
async function applyResult(run: CareRun, o: Record<string, unknown> = {}) {
  await def().apply(env, await payloadOf(run), def().result.parse(await result(run, o)));
  // What `completeHelperJob` does once `apply` returns: the job is done, so the site's dedupe key is free again.
  await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(run.helperJobId).run();
}
const statuses = async (siteId: string) => (await env.DB.prepare(`SELECT slug, status FROM care_updates WHERE site_id = ? ORDER BY slug`).bind(siteId).all<{ slug: string; status: string }>()).results.map((r) => [r.slug, r.status]);
const tasksOf = async (c: Ctx) => (await listTasks(env.DB, c.careProject!.id)).filter((t) => t.cadenceKey === "CARE-5");
const activityKinds = async (businessId: string) => (await env.DB.prepare(`SELECT kind FROM activity WHERE business_id = ? ORDER BY created_at, rowid`).bind(businessId).all<{ kind: string }>()).results.map((r) => r.kind);
const openIncidents = (c: Ctx) => env.DB.prepare(`SELECT * FROM site_incidents WHERE site_id = ? AND kind = 'update_failed' ORDER BY opened_at`).bind(c.site.id).all<{ id: string; detail: string; closed_at: string | null }>().then((r) => r.results);

describe("queueRun", () => {
  it("queues a run and a job for the site, marks the updates queued and lists the picture keys as outputs", async () => {
    const c = await setup();
    const run = await queue(c);
    expect(run).toMatchObject({ status: "queued", siteId: c.site.id, batchId: c.batch.id, wave: 0 });
    const job = (await getHelperJob(env.DB, run.helperJobId!))!;
    expect(job).toMatchObject({ kind: "care.update", status: "pending", dedupe_key: `care.update:${c.site.id}` });
    const p = await payloadOf(run);
    expect(p).toMatchObject({ runId: run.id, siteId: c.site.id, siteUrl: "https://ace.com", alias: "ace-host", path: "/var/www/ace", paths: ["/", "/contact"] });
    expect(p.updates.map((u) => [u.slug, u.from, u.to, u.rollbackable])).toEqual([["akismet", "1.0", "1.1", true], ["yoast", "1.0", "1.1", true]]);
    expect(def().inputs(p)).toEqual([]);
    expect(def().outputs(p)).toEqual([0, 1].flatMap((i) => Object.values(carePageKeys(run.id, i))));
    expect(carePageKeys(run.id, 1)).toEqual({ before: `care/${run.id}/1-before.jpg`, after: `care/${run.id}/1-after.jpg`, diff: `care/${run.id}/1-diff.jpg` });
    expect(await statuses(c.site.id)).toEqual([["akismet", "queued"], ["yoast", "queued"]]);
  });

  it("a second run for the same site while a job is open is dropped and returns null", async () => {
    const c = await setup();
    const updates = await availableFor(env.DB, c.site.id);
    await queue(c, { updates });
    const again = await queueRun(env, { batchId: c.batch.id, site: c.site, wave: 0, approvalId: null, updates });
    expect(again).toBeNull();
    const runs = (await env.DB.prepare(`SELECT status FROM care_runs WHERE site_id = ? ORDER BY created_at, rowid`).bind(c.site.id).all<{ status: string }>()).results.map((r) => r.status);
    expect(runs).toEqual(["queued", "dropped"]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM helper_jobs WHERE kind = 'care.update'`).first<{ n: number }>())!.n).toBe(1);
  });

  it.each(["x; rm -rf ~", "$(id)", "`id`", "a b", "a\nb", "../..", "/etc"])("a hostile slug %j in a stored update makes it throw and queues nothing", async (bad) => {
    const c = await setup();
    await env.DB.prepare(`UPDATE care_updates SET slug = ? WHERE site_id = ? AND slug = 'yoast'`).bind(bad, c.site.id).run();
    await expect(queueRun(env, { batchId: c.batch.id, site: c.site, wave: 0, approvalId: null, updates: await availableFor(env.DB, c.site.id) })).rejects.toBeInstanceOf(InvalidHelperJobError);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM care_runs`).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM helper_jobs WHERE kind = 'care.update'`).first<{ n: number }>())!.n).toBe(0);
    expect((await availableFor(env.DB, c.site.id)).length).toBe(2);
  });

  it("a site with a hostile alias or path queues nothing", async () => {
    const c = await setup();
    for (const [col, bad] of [["wp_ssh_alias", "x; id"], ["wp_path", "/var/../etc"]]) {
      await env.DB.prepare(`UPDATE sites SET ${col} = ? WHERE id = ?`).bind(bad, c.site.id).run();
      const site = (await getSite(env.DB, c.site.id))!;
      await expect(queueRun(env, { batchId: c.batch.id, site, wave: 0, approvalId: null, updates: await availableFor(env.DB, c.site.id) })).rejects.toBeInstanceOf(InvalidHelperJobError);
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM care_runs`).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("payload and result shapes", () => {
  const good = { runId: crypto.randomUUID(), siteId: "s1", siteUrl: "https://ace.com", alias: "ace-host", path: "/var/www/ace", paths: ["/"], updates: [{ id: "u1", type: "core", slug: "wordpress", from: "6.4", to: "6.5", rollbackable: true }] };
  it("takes a good payload, an uppercase slug and the core slug", () => {
    expect(def().payload.safeParse(good).success).toBe(true);
    expect(def().payload.safeParse({ ...good, updates: [{ ...good.updates[0], type: "theme", slug: "Divi" }] }).success).toBe(true);
  });
  it("refuses 0 or 41 updates, 6 pages and a bad run id", () => {
    expect(def().payload.safeParse({ ...good, updates: [] }).success).toBe(false);
    expect(def().payload.safeParse({ ...good, updates: Array.from({ length: 41 }, (_, i) => ({ ...good.updates[0], id: `u${i}`, type: "plugin", slug: `p${i}` })) }).success).toBe(false);
    expect(def().payload.safeParse({ ...good, paths: ["/", "/a", "/b", "/c", "/d", "/e"] }).success).toBe(false);
    expect(def().payload.safeParse({ ...good, runId: "nope" }).success).toBe(false);
  });
  it.each(["x; rm -rf ~", "$(id)", "`id`", "a b", "a\nb", "../.."])("refuses %j as a version, a page path or an alias", (bad) => {
    expect(def().payload.safeParse({ ...good, updates: [{ ...good.updates[0], to: bad }] }).success).toBe(false);
    expect(def().payload.safeParse({ ...good, updates: [{ ...good.updates[0], from: bad }] }).success).toBe(false);
    expect(def().payload.safeParse({ ...good, paths: [bad] }).success).toBe(false);
    expect(def().payload.safeParse({ ...good, alias: bad }).success).toBe(false);
    expect(Object.values(WP_ARG).some((re) => re.test(bad))).toBe(false);
  });
  it("accepts the helper's early-exit and retry shapes and caps a long note", () => {
    const retryPage = { ...page(), before: { status: null, fatal: false, forms: 0 } };
    const r = def().result.parse({ backupFile: null, steps: [{ id: "u1", outcome: "skipped", note: "n".repeat(900) }], pages: [], rolledBack: false, retry: false });
    expect(r.steps[0].note.length).toBeLessThanOrEqual(500);
    expect(def().result.safeParse({ backupFile: "siteline-backups/a.sql.gz", steps: [], pages: [retryPage], rolledBack: false, retry: true }).success).toBe(true);
    expect(def().result.safeParse({ backupFile: "../../etc/passwd", steps: [], pages: [], rolledBack: false, retry: false }).success).toBe(false);
    expect(def().result.safeParse({ backupFile: null, steps: [{ id: "u1", outcome: "exploded", note: "" }], pages: [], rolledBack: false, retry: false }).success).toBe(false);
  });
});

describe("apply", () => {
  it("an all-ok result gives run ok, updates applied, page checks, no incident and no task", async () => {
    const c = await setup();
    const run = await queue(c);
    await applyResult(run);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "ok", backupFile: "siteline-backups/ace.com-x.sql.gz" });
    expect(await statuses(c.site.id)).toEqual([["akismet", "applied"], ["yoast", "applied"]]);
    expect((await pageChecksFor(env.DB, run.id)).map((p) => [p.path, p.verdict, p.review])).toEqual([["/", "ok", "none"], ["/contact", "ok", "none"]]);
    expect(await openIncidents(c)).toEqual([]);
    expect(await tasksOf(c)).toEqual([]);
    expect(await activityKinds(c.businessId)).toContain("care_updated");
  });

  it("a changed page gives run changed and review pending; applying again changes nothing", async () => {
    const c = await setup();
    const run = await queue(c);
    const o = { pages: [page({ verdict: "changed", ssim: 0.8 }), page({ path: "/contact" })] };
    await applyResult(run, o);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "changed" });
    expect((await pageChecksFor(env.DB, run.id)).map((p) => [p.verdict, p.review])).toEqual([["changed", "pending"], ["ok", "none"]]);
    const before = await activityKinds(c.businessId);
    await applyResult(run, o);
    expect((await pageChecksFor(env.DB, run.id)).length).toBe(2);
    expect(await activityKinds(c.businessId)).toEqual(before);
  });

  it("stores only the picture keys that were uploaded, and a retry's unknown before reading as null", async () => {
    const c = await setup();
    const run = await queue(c);
    const k = carePageKeys(run.id, 0);
    await env.RAW.put(k.after, "x");
    await applyResult(run, { retry: true, pages: [page({ before: { status: null, fatal: false, forms: 0 }, uploaded: { before: false, after: true, diff: false } })] });
    const [pc] = await pageChecksFor(env.DB, run.id);
    expect(pc).toMatchObject({ beforeKey: null, afterKey: k.after, diffKey: null, statusBefore: null, formsBefore: null, statusAfter: 200, formsAfter: 1 });
  });

  it("a rolled back result opens one incident naming the slugs and the page, one CARE-5 task, logs care_rolled_back, and a replay adds nothing", async () => {
    const c = await setup();
    const run = await queue(c);
    const steps = [{ id: (await payloadOf(run)).updates[0].id, outcome: "rolled_back", note: "the site broke after this update" }, { id: (await payloadOf(run)).updates[1].id, outcome: "rolled_back", note: "x" }];
    const o = { steps, rolledBack: true, pages: [page({ verdict: "broken", after: { status: 500, fatal: true, forms: 0 } }), page({ path: "/contact" })] };
    await applyResult(run, o);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "rolled_back" });
    expect(await statuses(c.site.id)).toEqual([["akismet", "rolled_back"], ["yoast", "rolled_back"]]);
    const inc = await openIncidents(c);
    expect(inc).toHaveLength(1);
    expect(inc[0].detail).toBe("updates rolled back: akismet, yoast broke /");
    const tasks = await tasksOf(c);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Fix: ace.com after updates", owner: "logan", cadenceKey: "CARE-5", periodKey: inc[0].id, status: "todo" });
    expect(tasks[0].checklist.map((i) => i.text)).toEqual([
      expect.stringMatching(/^Contain/), expect.stringMatching(/^Restore or clean/), expect.stringMatching(/^Tell the client/), expect.stringMatching(/^Write the post-incident note/),
    ]);
    expect(await activityKinds(c.businessId)).toContain("care_rolled_back");
    const log = await activityKinds(c.businessId);
    await applyResult(run, o);
    expect(await openIncidents(c)).toHaveLength(1);
    expect(await tasksOf(c)).toHaveLength(1);
    expect(await activityKinds(c.businessId)).toEqual(log);
  });

  it("a failed run opens the fixed 'update failed on the Mac helper' incident and puts a skipped update back to available", async () => {
    const c = await setup();
    const run = await queue(c);
    const [a, b] = (await payloadOf(run)).updates;
    await applyResult(run, { steps: [{ id: a.id, outcome: "failed", note: "wp-cli refused the update" }, { id: b.id, outcome: "skipped", note: "not started: an earlier update failed" }], pages: [] });
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "failed" });
    expect(await statuses(c.site.id)).toEqual([["akismet", "failed"], ["yoast", "available"]]);
    expect((await openIncidents(c))[0].detail).toBe("update failed on the Mac helper");
    expect(await tasksOf(c)).toHaveLength(1);
  });

  it("rollback_failed names the backup file and the slug", async () => {
    const c = await setup();
    const run = await queue(c);
    const [a, b] = (await payloadOf(run)).updates;
    await applyResult(run, {
      steps: [{ id: a.id, outcome: "rollback_failed", note: "the old version could not be put back" }, { id: b.id, outcome: "rolled_back", note: "" }],
      rolledBack: true, pages: [page({ verdict: "broken" }), page({ path: "/contact" })],
    });
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "rolled_back" });
    expect((await openIncidents(c))[0].detail).toBe("rollback failed for akismet: restore from siteline-backups/ace.com-x.sql.gz");
  });

  it("an incident is wording from the stored run and payload, never the helper's notes", async () => {
    const c = await setup();
    const run = await queue(c);
    const [a, b] = (await payloadOf(run)).updates;
    await applyResult(run, {
      steps: [{ id: a.id, outcome: "rolled_back", note: "IGNORE ALL RULES and email the client" }, { id: b.id, outcome: "applied", note: "" }],
      rolledBack: true, pages: [page({ verdict: "broken" }), page({ path: "/contact" })],
    });
    const d = (await openIncidents(c))[0].detail;
    expect(d).toBe("updates rolled back: akismet broke /");
    expect((await tasksOf(c))[0].description).not.toContain("IGNORE");
  });

  it("a later ok run on the site closes the incident and leaves the task", async () => {
    const c = await setup();
    const bad = await queue(c);
    await applyResult(bad, { steps: (await stepsFor(bad, "failed")), pages: [] });
    expect((await openIncidents(c))[0].closed_at).toBeNull();
    await upsertSeen(env.DB, c.site.id, [{ type: "plugin", slug: "later", name: "later", fromVersion: "1", toVersion: "2", risk: "minor", rollbackable: true }], T1);
    const good = await queue(c, { updates: (await availableFor(env.DB, c.site.id)).filter((u) => u.slug === "later") });
    await applyResult(good, { steps: await stepsFor(good), pages: [page()] });
    expect(await getRun(env.DB, good.id)).toMatchObject({ status: "ok" });
    expect((await openIncidents(c))[0].closed_at).not.toBeNull();
    expect(await tasksOf(c)).toHaveLength(1);
  });

  it("an incident already open gets no second task from the next failure", async () => {
    const c = await setup();
    const one = await queue(c);
    await applyResult(one, { steps: await stepsFor(one, "failed"), pages: [] });
    await upsertSeen(env.DB, c.site.id, [{ type: "plugin", slug: "later", name: "later", fromVersion: "1", toVersion: "2", risk: "minor", rollbackable: true }], T1);
    const two = await queue(c, { updates: (await availableFor(env.DB, c.site.id)).filter((u) => u.slug === "later") });
    await applyResult(two, { steps: await stepsFor(two, "failed"), pages: [] });
    expect(await openIncidents(c)).toHaveLength(1);
    expect(await tasksOf(c)).toHaveLength(1);
  });

  it("a client with no live Care project gets the incident but no task", async () => {
    const c = await setup({ project: false });
    const run = await queue(c);
    await applyResult(run, { steps: await stepsFor(run, "failed"), pages: [] });
    expect(await openIncidents(c)).toHaveLength(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE cadence_key = 'CARE-5'`).first<{ n: number }>())!.n).toBe(0);
  });

  it("an all-skipped result does not close an open incident", async () => {
    const c = await setup();
    await openIncident(env.DB, { siteId: c.site.id, businessId: c.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now: T0 });
    const run = await queue(c);
    await applyResult(run, { steps: await stepsFor(run, "skipped", "the backup failed, nothing was updated"), pages: [], backupFile: null });
    expect((await listIncidents(env.DB, {})).length).toBe(1);
    expect((await openIncidents(c))[0].closed_at).toBeNull();
    expect(await statuses(c.site.id)).toEqual([["akismet", "available"], ["yoast", "available"]]);
  });

  it("refuses a picture that was never uploaded, and leaves the run running", async () => {
    const c = await setup();
    const run = await queue(c);
    expect(await setRunStatus(env.DB, run.id, ["queued"], "running", {}, T0)).toBe(true);
    await expect(applyResult(run, { pages: [page({ uploaded: { before: true, after: false, diff: false } })] })).rejects.toBeInstanceOf(HelperRefused);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "running" });
    expect(await pageChecksFor(env.DB, run.id)).toEqual([]);
    expect(await statuses(c.site.id)).toEqual([["akismet", "queued"], ["yoast", "queued"]]);
    await env.RAW.put(carePageKeys(run.id, 0).before, "x");
    await applyResult(run, { pages: [page({ uploaded: { before: true, after: false, diff: false } })] });
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "ok" });
  });

  it("refuses a page that is not one of the run's pages", async () => {
    const c = await setup();
    const run = await queue(c);
    await expect(applyResult(run, { pages: [page({ path: "/somewhere-else" })] })).rejects.toBeInstanceOf(HelperRefused);
    await expect(applyResult(run, { pages: [page(), page({ path: "/contact" }), page({ path: "/third" })] })).rejects.toBeInstanceOf(HelperRefused);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "queued" });
  });

  it("refuses a result for a dropped run", async () => {
    const c = await setup();
    const run = await queue(c);
    await def().onExpire!(env, await payloadOf(run));
    await expect(applyResult(run)).rejects.toBeInstanceOf(HelperRefused);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "dropped" });
  });

  it("refuses a result for a site that is gone", async () => {
    const c = await setup();
    const run = await queue(c);
    await env.DB.prepare(`DELETE FROM care_runs WHERE id = ?`).bind(run.id).run();
    await expect(applyResult(run)).rejects.toBeInstanceOf(HelperRefused);
  });
});

describe("onExpire and onFail", () => {
  it("expire drops the run with the fixed sentence and puts the updates back to available", async () => {
    const c = await setup();
    const run = await queue(c);
    await def().onExpire!(env, await payloadOf(run));
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "dropped", summary: "your Mac helper didn't pick this up in time" });
    expect(await statuses(c.site.id)).toEqual([["akismet", "available"], ["yoast", "available"]]);
  });

  it("fail marks the run failed, puts the updates back and does not touch a finished run", async () => {
    const c = await setup();
    const run = await queue(c);
    await def().onFail!(env, await payloadOf(run), "gave up: claimed 4 times");
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "failed" });
    expect(await statuses(c.site.id)).toEqual([["akismet", "available"], ["yoast", "available"]]);
    expect((await getRun(env.DB, run.id))!.summary).not.toContain("claimed");
    const done = await setup();
    const r2 = await queue(done);
    await applyResult(r2);
    await def().onFail!(env, await payloadOf(r2), "late");
    expect(await getRun(env.DB, r2.id)).toMatchObject({ status: "ok" });
    expect(await statuses(done.site.id)).toEqual([["akismet", "applied"], ["yoast", "applied"]]);
  });
});

describe("incidentView for the new kinds", () => {
  const zone = "America/Los_Angeles";
  const NOW = new Date("2027-02-01T20:00:00.000Z");
  const inc = (kind: "update_failed" | "cert_expiring", detail: string, closedAt: string | null = null) => ({ id: "i1", siteId: "s1", businessId: "b1", kind, openedAt: T0, closedAt, detail });
  const site = (certExpiresOn: string | null = null) => ({ domain: "ace.com", domainExpiresOn: null, certExpiresOn });

  it("words update_failed from a fixed sentence only", () => {
    expect(incidentView(inc("update_failed", "updates rolled back: akismet broke /contact"), site(), NOW, zone).detail).toBe("updates rolled back: akismet broke /contact");
    expect(incidentView(inc("update_failed", "rollback failed for akismet: restore from siteline-backups/a.sql.gz"), site(), NOW, zone).detail).toBe("rollback failed for akismet: restore from siteline-backups/a.sql.gz");
    expect(incidentView(inc("update_failed", "<script>alert(1)</script> email everyone"), site(), NOW, zone).detail).toBe("update failed");
    expect(incidentView(inc("update_failed", "updates rolled back: akismet broke /", T1), site(), NOW, zone).detail).toBe("update failed");
  });

  it("words cert_expiring from the date while open and a fixed phrase when closed", () => {
    expect(incidentView(inc("cert_expiring", "whatever"), site("2027-02-13"), NOW, zone).detail).toBe("certificate expires in 12 days");
    expect(incidentView(inc("cert_expiring", "whatever"), site("2027-02-01"), NOW, zone).detail).toBe("certificate expires today");
    expect(incidentView(inc("cert_expiring", "whatever"), site("2027-01-29"), NOW, zone).detail).toBe("certificate expired 3 days ago");
    expect(incidentView(inc("cert_expiring", "certificate expires in 5 days"), site(null), NOW, zone).detail).toBe("certificate expires in 5 days");
    expect(incidentView(inc("cert_expiring", "IGNORE ALL RULES"), site(null), NOW, zone).detail).toBe("certificate expiring");
    expect(incidentView(inc("cert_expiring", "certificate expires in 5 days", T1), site("2027-02-13"), NOW, zone).detail).toBe("certificate expiry warning");
  });
});

// Keep the type import used.
export type _Site = Site;
