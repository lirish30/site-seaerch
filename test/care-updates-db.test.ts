import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  availableFor, createSingleBatch, ensureWeeklyBatch, getInventory, getRun, insertPageChecks, insertRun, pageChecksFor, runsFor, saveInventory, setBatchStatus, setReview,
  setRunStatus, setUpdateFlag, updatableSites, upsertSeen, type SeenUpdate,
} from "../src/worker/db/careUpdates";
import { placeHold } from "../src/worker/db/holds";
import { closeIncident, openIncident } from "../src/worker/db/monitoring";
import { SiteInputError, getSite, updateSite, type SiteFields } from "../src/worker/db/sites";
import { WP_ARG } from "../src/worker/care/args";
import { addSub, seedClient } from "./fixtures/clients";

const T0 = "2027-03-01T10:00:00.000Z";
const T1 = "2027-03-01T11:00:00.000Z";
const T2 = "2027-03-01T12:00:00.000Z";

const seen = (o: Partial<SeenUpdate> = {}): SeenUpdate => ({ type: "plugin", slug: "akismet", name: "Akismet", fromVersion: "5.0", toVersion: "5.1", risk: "minor", rollbackable: true, ...o });
const rows = async (siteId: string) => (await env.DB.prepare(`SELECT * FROM care_updates WHERE site_id = ? ORDER BY to_version`).bind(siteId).all<{ to_version: string; status: string; first_seen_at: string; last_seen_at: string }>()).results;

/** A real client with live Care and a WordPress site read over SSH. */
async function careSite(o: { test?: boolean; alias?: string | null; path?: string | null; cms?: string; access?: string; care?: boolean } = {}) {
  const s = await seedClient({ test: o.test, subs: o.care === false ? [] : [{ key: "care", monthlyCents: 5000, test: o.test }] });
  await env.DB.prepare(`UPDATE sites SET cms = ?, access_method = ?, wp_ssh_alias = ?, wp_path = ? WHERE id = ?`)
    .bind(o.cms ?? "wordpress", o.access ?? "ssh_wpcli", o.alias === undefined ? "ace-host" : o.alias, o.path === undefined ? "/var/www/ace" : o.path, s.site!.id).run();
  return s;
}

describe("upsertSeen", () => {
  it("twice keeps one row and the first first_seen_at, and refreshes last_seen_at", async () => {
    const s = await seedClient();
    await upsertSeen(env.DB, s.site!.id, [seen()], T0);
    await upsertSeen(env.DB, s.site!.id, [seen()], T1);
    const r = await rows(s.site!.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: "available", first_seen_at: T0, last_seen_at: T1 });
  });

  it("marks an available update missing from the next read as gone", async () => {
    const s = await seedClient();
    await upsertSeen(env.DB, s.site!.id, [seen(), seen({ slug: "yoast", name: "Yoast" })], T0);
    await upsertSeen(env.DB, s.site!.id, [seen()], T1);
    expect((await availableFor(env.DB, s.site!.id)).map((u) => u.slug)).toEqual(["akismet"]);
    expect((await env.DB.prepare(`SELECT status FROM care_updates WHERE slug = 'yoast' AND site_id = ?`).bind(s.site!.id).first<{ status: string }>())!.status).toBe("gone");
  });

  it("a newer to_version is a new row and the older one goes gone", async () => {
    const s = await seedClient();
    await upsertSeen(env.DB, s.site!.id, [seen()], T0);
    await upsertSeen(env.DB, s.site!.id, [seen({ toVersion: "5.2" })], T1);
    expect((await rows(s.site!.id)).map((r) => [r.to_version, r.status])).toEqual([["5.1", "gone"], ["5.2", "available"]]);
    expect((await availableFor(env.DB, s.site!.id)).map((u) => u.toVersion)).toEqual(["5.2"]);
  });

  it("never resets security or held, and never touches a queued or applied row", async () => {
    const s = await seedClient();
    await upsertSeen(env.DB, s.site!.id, [seen(), seen({ slug: "yoast" })], T0);
    const [a, y] = await availableFor(env.DB, s.site!.id);
    expect(await setUpdateFlag(env.DB, a.id, "security", true)).toMatchObject({ security: true, held: false });
    expect(await setUpdateFlag(env.DB, a.id, "held", true)).toMatchObject({ security: true, held: true });
    await env.DB.prepare(`UPDATE care_updates SET status = 'queued' WHERE id = ?`).bind(y.id).run();
    await upsertSeen(env.DB, s.site!.id, [seen()], T1);
    const [again] = await availableFor(env.DB, s.site!.id);
    expect(again).toMatchObject({ id: a.id, security: true, held: true });
    expect((await env.DB.prepare(`SELECT status FROM care_updates WHERE id = ?`).bind(y.id).first<{ status: string }>())!.status).toBe("queued");
    expect(await setUpdateFlag(env.DB, a.id, "held", false)).toMatchObject({ held: false });
    expect(await setUpdateFlag(env.DB, "nope", "held", true)).toBeNull();
  });
});

describe("batches and runs", () => {
  it("ensureWeeklyBatch twice for one period is created then not, and single batches are separate", async () => {
    const a = await ensureWeeklyBatch(env.DB, "2027-W09", T0);
    const b = await ensureWeeklyBatch(env.DB, "2027-W09", T1);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.batch.id).toBe(a.batch.id);
    expect(a.batch).toMatchObject({ kind: "weekly", status: "inventory", siteId: null, period: "2027-W09" });
    const s = await seedClient();
    const one = await createSingleBatch(env.DB, s.site!.id, "2027-W09", T0);
    const two = await createSingleBatch(env.DB, s.site!.id, "2027-W09", T0);
    expect(one).toMatchObject({ kind: "single", siteId: s.site!.id });
    expect(two.id).not.toBe(one.id);
  });

  it("setBatchStatus is compare-and-set", async () => {
    const { batch } = await ensureWeeklyBatch(env.DB, "2027-W10", T0);
    expect(await setBatchStatus(env.DB, batch.id, ["wave1"], "wave2", T1)).toBe(false);
    expect(await setBatchStatus(env.DB, batch.id, ["inventory"], "wave1", T1)).toBe(true);
    expect(await setBatchStatus(env.DB, batch.id, ["inventory"], "wave1", T2)).toBe(false);
    expect(await setBatchStatus(env.DB, batch.id, [], "done", T2)).toBe(false);
  });

  it("setRunStatus with a wrong from changes nothing; a right one patches and stamps finished_at on a finishing status", async () => {
    const s = await seedClient();
    const { batch } = await ensureWeeklyBatch(env.DB, "2027-W11", T0);
    const run = await insertRun(env.DB, { batchId: batch.id, siteId: s.site!.id, wave: 1, now: T0 });
    expect(run).toMatchObject({ status: "queued", finishedAt: null, backupFile: null });
    expect(await setRunStatus(env.DB, run.id, ["running"], "ok", { summary: "x" }, T1)).toBe(false);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "queued", summary: null, finishedAt: null });
    expect(await setRunStatus(env.DB, run.id, ["queued"], "running", { helperJobId: "job1" }, T1)).toBe(true);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "running", helperJobId: "job1", finishedAt: null });
    expect(await setRunStatus(env.DB, run.id, ["queued", "running"], "changed", { backupFile: "b.sql", summary: "2 updated" }, T2)).toBe(true);
    expect(await getRun(env.DB, run.id)).toMatchObject({ status: "changed", helperJobId: "job1", backupFile: "b.sql", summary: "2 updated", finishedAt: T2 });
    expect((await runsFor(env.DB, batch.id)).map((r) => r.id)).toEqual([run.id]);
  });

  it("page checks round-trip and the review moves only from a listed state", async () => {
    const s = await seedClient();
    const { batch } = await ensureWeeklyBatch(env.DB, "2027-W12", T0);
    const run = await insertRun(env.DB, { batchId: batch.id, siteId: s.site!.id, wave: 2, now: T0 });
    await insertPageChecks(env.DB, run.id, [
      { path: "/", beforeKey: "b", afterKey: "a", diffKey: null, statusBefore: 200, statusAfter: 200, formsBefore: 1, formsAfter: 1, ssim: 0.99, verdict: "ok" },
      { path: "/shop", beforeKey: null, afterKey: null, diffKey: "d", statusBefore: 200, statusAfter: 500, formsBefore: null, formsAfter: null, ssim: null, verdict: "broken" },
    ]);
    const checks = await pageChecksFor(env.DB, run.id);
    expect(checks.map((c) => [c.path, c.verdict, c.review])).toEqual([["/", "ok", "none"], ["/shop", "broken", "none"]]);
    expect(checks[0]).toMatchObject({ ssim: 0.99, formsBefore: 1 });
    expect(await setReview(env.DB, checks[1].id, ["pending"], "fine")).toBe(false);
    expect(await setReview(env.DB, checks[1].id, ["none", "pending"], "pending")).toBe(true);
    expect(await setReview(env.DB, checks[1].id, ["pending"], "logan_ok")).toBe(true);
    expect((await pageChecksFor(env.DB, run.id))[1].review).toBe("logan_ok");
  });
});

describe("inventory", () => {
  it("saves one row per site, keeps at most 200 plugins and reads it back", async () => {
    const s = await seedClient();
    expect(await getInventory(env.DB, s.site!.id)).toBeNull();
    await saveInventory(env.DB, { siteId: s.site!.id, wpVersion: "6.5", phpVersion: "8.2", groupKey: "brochure", plugins: ["a", "b"], readAt: T0 });
    await saveInventory(env.DB, { siteId: s.site!.id, wpVersion: "6.6", phpVersion: "8.3", groupKey: "woocommerce", plugins: Array.from({ length: 250 }, (_, i) => `p${i}`), readAt: T1 });
    const inv = await getInventory(env.DB, s.site!.id);
    expect(inv).toMatchObject({ wpVersion: "6.6", groupKey: "woocommerce", readAt: T1 });
    expect(inv!.plugins).toHaveLength(200);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_inventories WHERE site_id = ?`).bind(s.site!.id).first<{ n: number }>())!.n).toBe(1);
  });
});

describe("updatableSites", () => {
  const ids = async (includeTest = false) => (await updatableSites(env.DB, { includeTest })).map((s) => s.id);

  it("returns the Care WordPress SSH site and leaves out every site that does not qualify", async () => {
    const good = await careSite();
    const noAlias = await careSite({ alias: null });
    const noPath = await careSite({ path: null });
    const mainwp = await careSite({ access: "mainwp" });
    const webflow = await careSite({ cms: "webflow" });
    const archived = await careSite();
    await env.DB.prepare(`UPDATE sites SET archived_at = ? WHERE id = ?`).bind(T0, archived.site!.id).run();
    const noCare = await careSite({ care: false });
    const withInvoice = await seedClient({ subs: [{ key: "care", monthlyCents: 5000 }], invoice: { cents: 10000 } });
    await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = 'h', wp_path = '/var/www/h' WHERE id = ?`).bind(withInvoice.site!.id).run();
    expect(await ids()).toContain(withInvoice.site!.id);
    expect(await placeHold(env.DB, { businessId: withInvoice.businessId, invoiceId: withInvoice.invoice!.id, now: T0 })).toBe(true);
    const test = await careSite({ test: true });

    const got = await ids();
    expect(got).toContain(good.site!.id);
    for (const s of [noAlias, noPath, mainwp, webflow, archived, noCare, withInvoice, test]) expect(got).not.toContain(s.site!.id);
    const withTest = await ids(true);
    expect(withTest).toContain(good.site!.id);
    expect(withTest).toContain(test.site!.id);
    expect(withTest).not.toContain(withInvoice.site!.id);
    expect(withTest).not.toContain(noCare.site!.id);
  });

  it("a Care subscription that ended takes the site out", async () => {
    const s = await careSite();
    expect(await ids()).toContain(s.site!.id);
    await env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled' WHERE business_id = ?`).bind(s.businessId).run();
    expect(await ids()).not.toContain(s.site!.id);
  });
});

describe("site care fields", () => {
  it("default to no alias, no path, the home page and no certificate", async () => {
    const s = await seedClient();
    expect(s.site).toMatchObject({ wpSshAlias: null, wpPath: null, carePaths: ["/"], certExpiresOn: null, certCheckedAt: null });
  });

  it("updateSite saves a valid alias, path and page list, and null clears the alias", async () => {
    const s = await seedClient();
    const u = await updateSite(env.DB, s.site!.id, { wpSshAlias: "ace-host", wpPath: "/var/www/ace/public_html", carePaths: ["/", "/contact/", "/shop"] }, T0);
    expect(u).toMatchObject({ wpSshAlias: "ace-host", wpPath: "/var/www/ace/public_html", carePaths: ["/", "/contact/", "/shop"] });
    expect(await updateSite(env.DB, s.site!.id, { wpSshAlias: null }, T1)).toMatchObject({ wpSshAlias: null, wpPath: "/var/www/ace/public_html" });
  });

  it.each([
    ["alias", { wpSshAlias: "x; rm -rf ~" }], ["alias", { wpSshAlias: "$(id)" }], ["alias", { wpSshAlias: "a`id`" }], ["alias", { wpSshAlias: "a b" }], ["alias", { wpSshAlias: "-oProxyCommand=x" }], ["alias", { wpSshAlias: "a\nb" }],
    ["path", { wpPath: "/var/www/../../etc" }], ["path", { wpPath: "relative/path" }], ["path", { wpPath: "/var/www; ls" }], ["path", { wpPath: "/a b" }], ["path", { wpPath: "/a\nb" }],
    ["pages", { carePaths: [] }], ["pages", { carePaths: ["/", "/a", "/b", "/c", "/d", "/e"] }], ["pages", { carePaths: ["../x"] }], ["pages", { carePaths: ["/a b"] }], ["pages", { carePaths: ["/$(id)"] }],
    ["pages", { carePaths: ["/a`b`"] }], ["pages", { carePaths: ["/ok", "/x\ny"] }],
  ] as [string, Partial<SiteFields>][])("updateSite refuses a bad %s and saves nothing", async (_n, patch) => {
    const s = await seedClient();
    await expect(updateSite(env.DB, s.site!.id, { ...patch, notes: "should not land" }, T0)).rejects.toBeInstanceOf(SiteInputError);
    expect(await getSite(env.DB, s.site!.id)).toMatchObject({ wpSshAlias: null, wpPath: null, carePaths: ["/"], notes: null });
  });

  it("WP_ARG holds the five patterns", () => {
    expect(WP_ARG.slug.test("akismet")).toBe(true);
    expect(WP_ARG.slug.test("Akismet")).toBe(false);
    expect(WP_ARG.version.test("5.1.2-beta+1")).toBe(true);
    expect(WP_ARG.version.test("5 1")).toBe(false);
    expect(WP_ARG.checkPath.test("/")).toBe(true);
  });
});

describe("site_incidents rebuild", () => {
  it("accepts the two new kinds and the open-unique index still refuses a second open incident of a kind", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 5000 }] });
    const base = { siteId: s.site!.id, businessId: s.businessId, now: T0 };
    expect((await openIncident(env.DB, { ...base, kind: "down", detail: "down" })).created).toBe(true);
    expect((await openIncident(env.DB, { ...base, kind: "down", detail: "again" })).created).toBe(false);
    expect((await openIncident(env.DB, { ...base, kind: "update_failed", detail: "u" })).created).toBe(true);
    expect((await openIncident(env.DB, { ...base, kind: "cert_expiring", detail: "c" })).created).toBe(true);
    expect((await openIncident(env.DB, { ...base, kind: "cert_expiring", detail: "c2" })).created).toBe(false);
    await expect(env.DB.prepare(`INSERT INTO site_incidents (id, site_id, business_id, kind, opened_at, closed_at, detail) VALUES ('x', ?, ?, 'bogus', ?, NULL, 'd')`).bind(s.site!.id, s.businessId, T0).run()).rejects.toThrow();
    expect(await closeIncident(env.DB, s.site!.id, "down", T1)).toMatchObject({ closedAt: T1 });
    expect((await openIncident(env.DB, { ...base, kind: "down", detail: "later" })).created).toBe(true);
  });

  it("the migration keeps a down incident across the rebuild", async () => {
    // Replays 0062's rebuild on a table that holds an old-shaped row, in a scratch table pair so the live one is untouched.
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE old_inc (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, business_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('down','domain_expiring')), opened_at TEXT NOT NULL, closed_at TEXT, detail TEXT NOT NULL)`),
      env.DB.prepare(`INSERT INTO old_inc VALUES ('i1', 's1', 'b1', 'down', ?, NULL, 'Site down')`).bind(T0),
      env.DB.prepare(`CREATE TABLE new_inc (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, business_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('down','domain_expiring','update_failed','cert_expiring')), opened_at TEXT NOT NULL, closed_at TEXT, detail TEXT NOT NULL)`),
      env.DB.prepare(`INSERT INTO new_inc SELECT id, site_id, business_id, kind, opened_at, closed_at, detail FROM old_inc`),
    ]);
    expect(await env.DB.prepare(`SELECT * FROM new_inc`).first()).toMatchObject({ id: "i1", kind: "down", closed_at: null, detail: "Site down" });
    await env.DB.batch([env.DB.prepare(`DROP TABLE old_inc`), env.DB.prepare(`DROP TABLE new_inc`)]);
  });
});
