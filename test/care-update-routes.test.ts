import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker/index";
import "../src/worker/approvals/careUpdates";
import { onInventoryDone } from "../src/worker/care/batch";
import { getBatch, insertPageChecks, insertRun, createSingleBatch, saveInventory, setRunStatus, upsertSeen, availableFor } from "../src/worker/db/careUpdates";
import { placeHold } from "../src/worker/db/holds";
import { openIncident } from "../src/worker/db/monitoring";
import { archiveSite, getSite } from "../src/worker/db/sites";
import { ensureSeedSops } from "../src/worker/db/sops";
import "../src/worker/helper/kinds";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";

// The Care updates routes through the owner's session: the board, the two marks, starting a batch, a one-site run, a run's detail with its pictures and closing an update incident.
const ALIAS = "alpha-ALIAS-host";
const WPPATH = "/var/www/alpha-PATH";
const ctx = () => createExecutionContext();
let cookie = "";
const call = async (method: string, path: string, body?: unknown, session = true) => {
  if (session && !cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  return worker.fetch(new Request(`https://x/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(session ? { cookie } : {}), "content-type": "application/json" },
  }), E, ctx());
};
const json = async <T = any>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await call(method, path, body);
  const text = await r.text();
  expect(r.status, `${method} ${path}: ${text.slice(0, 200)}`).toBe(status);
  return JSON.parse(text) as T;
};

beforeEach(async () => {
  await env.DB.batch([
    "care_page_checks", "care_runs", "care_batches", "care_updates", "site_inventories", "helper_jobs", "approvals", "site_incidents",
  ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`UPDATE sites SET archived_at = '2020-01-01T00:00:00.000Z' WHERE archived_at IS NULL`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});

/** A real client with live Care, a WordPress site read over SSH, an inventory and one waiting update. */
async function wp(domain = "alpha.com", o: { test?: boolean; slugs?: string[] } = {}) {
  const s = await seedClient({ test: o.test, subs: [{ key: "care", monthlyCents: 12_900, test: o.test }] });
  await env.DB.prepare(`UPDATE sites SET domain = ?, cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = ?, wp_path = ?, care_paths = '["/"]' WHERE id = ?`).bind(domain, ALIAS, WPPATH, s.site!.id).run();
  await saveInventory(env.DB, { siteId: s.site!.id, wpVersion: "6.4", phpVersion: "8.2", groupKey: "brochure", plugins: [], readAt: new Date().toISOString() });
  await upsertSeen(env.DB, s.site!.id, (o.slugs ?? ["akismet"]).map((slug) => ({ type: "plugin" as const, slug, name: slug, fromVersion: "1.0", toVersion: "1.1", risk: "minor" as const, rollbackable: true })), new Date().toISOString());
  return { siteId: s.site!.id, businessId: s.businessId };
}

type Board = { batch: { period: string; status: string } | null; sites: { siteId: string; domain: string | null; group: string | null; canUpdate: boolean; why: string | null; updates: { id: string; slug: string; held: boolean; due: boolean }[]; lastRun: { status: string } | null; openIncident: { id: string; detail: string } | null }[] };

describe("GET /care/updates", () => {
  it("lists a MainWP site as unable to update, and a WordPress SSH site with its updates, never the alias or folder", async () => {
    const a = await wp("alpha.com");
    const m = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }] });
    await env.DB.prepare(`UPDATE sites SET domain = 'mainwp.com', cms = 'wordpress', access_method = 'mainwp' WHERE id = ?`).bind(m.site!.id).run();
    const r = await call("GET", "/care/updates");
    const text = await r.text();
    expect(r.status).toBe(200);
    const b = JSON.parse(text) as Board;
    expect(b.batch).toBeNull();
    expect(b.sites.find((s) => s.siteId === m.site!.id)).toMatchObject({ domain: "mainwp.com", canUpdate: false, why: "no SSH access", updates: [], lastRun: null });
    expect(b.sites.find((s) => s.siteId === a.siteId)).toMatchObject({ domain: "alpha.com", group: "brochure", canUpdate: true, why: null, updates: [expect.objectContaining({ slug: "akismet", held: false, due: true })] });
    for (const bad of [ALIAS, WPPATH, "wp_ssh_alias", "wpSshAlias", "wpPath", "wp_path"]) expect(text).not.toContain(bad);
  });

  it("an update that failed last time is back on the board with the day it failed and needs Logan's OK (I3)", async () => {
    const a = await wp("alpha.com");
    const at = "2026-11-18T20:00:00.000Z";
    await env.DB.prepare(`UPDATE care_updates SET status = 'failed', last_failed_at = ? WHERE site_id = ?`).bind(at, a.siteId).run();
    await upsertSeen(env.DB, a.siteId, [{ type: "plugin", slug: "akismet", name: "akismet", fromVersion: "1.0", toVersion: "1.1", risk: "minor", rollbackable: true }], new Date().toISOString());
    const b = await json<Board>("GET", "/care/updates");
    expect(b.sites.find((x) => x.siteId === a.siteId)!.updates).toEqual([expect.objectContaining({ slug: "akismet", lastFailedAt: at, needsTick: true })]);
  });

  it("says a client on billing hold cannot update", async () => {
    const a = await wp("alpha.com");
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }], invoice: { cents: 50_000 } });
    await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = 'h', wp_path = '/w' WHERE id = ?`).bind(s.site!.id).run();
    expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice!.id, now: new Date().toISOString() })).toBe(true);
    const b = await json<Board>("GET", "/care/updates");
    expect(b.sites.find((x) => x.siteId === s.site!.id)).toMatchObject({ canUpdate: false, why: "on billing hold" });
    expect(b.sites.find((x) => x.siteId === a.siteId)).toMatchObject({ canUpdate: true });
  });

  it("gives the other plain reasons: not WordPress, and a missing alias or folder", async () => {
    const a = await wp("alpha.com");
    await env.DB.prepare(`UPDATE sites SET cms = 'webflow' WHERE id = ?`).bind(a.siteId).run();
    const b2 = await wp("beta.com");
    await env.DB.prepare(`UPDATE sites SET wp_path = NULL WHERE id = ?`).bind(b2.siteId).run();
    const b = await json<Board>("GET", "/care/updates");
    expect(b.sites.find((s) => s.siteId === a.siteId)).toMatchObject({ canUpdate: false, why: "not WordPress" });
    expect(b.sites.find((s) => s.siteId === b2.siteId)).toMatchObject({ canUpdate: false, why: "SSH alias or path missing" });
  });

  it("leaves out test clients, archived sites and shows this week's batch and an open update_failed", async () => {
    const a = await wp("alpha.com");
    const t = await wp("rehearse.com", { test: true });
    const gone = await wp("gone.com");
    await archiveSite(env.DB, gone.siteId, new Date().toISOString());
    await json("POST", "/care/batches", undefined, 201);
    await openIncident(env.DB, { siteId: a.siteId, businessId: a.businessId, kind: "update_failed", detail: "updates rolled back: akismet failed", now: new Date().toISOString() });
    const b = await json<Board>("GET", "/care/updates");
    expect(b.batch).toMatchObject({ status: expect.any(String), period: expect.any(String) });
    expect(b.sites.map((s) => s.siteId)).toEqual([a.siteId]);
    expect(b.sites.some((s) => s.siteId === t.siteId)).toBe(false);
    expect(b.sites[0].openIncident).toMatchObject({ detail: "updates rolled back: akismet failed" });
  });

  it("needs the owner's session", async () => {
    expect((await call("GET", "/care/updates", undefined, false)).status).toBe(401);
  });
});

describe("PUT /care/updates/:id", () => {
  it("holds an update, and a held one stays out of the next draft; releasing it puts it back", async () => {
    const a = await wp("alpha.com", { slugs: ["akismet", "yoast"] });
    const [u1] = await availableFor(env.DB, a.siteId);
    const held = await json<{ update: { held: boolean; due: boolean } }>("PUT", `/care/updates/${u1.id}`, { held: true });
    expect(held.update).toMatchObject({ held: true, due: false });
    const { batch } = await json<{ batch: { id: string } }>("POST", "/care/batches", undefined, 201);
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE kind = 'care.inventory'`).run();
    await onInventoryDone(env, batch.id);
    const ap = await env.DB.prepare(`SELECT payload FROM approvals WHERE kind = 'care.updates'`).first<{ payload: string }>();
    const slugs = (JSON.parse(ap!.payload) as { sites: { updates: { slug: string }[] }[] }).sites.flatMap((s) => s.updates.map((u) => u.slug));
    expect(slugs).toEqual(["yoast"]);
    expect((await json<{ update: { held: boolean } }>("PUT", `/care/updates/${u1.id}`, { held: false })).update.held).toBe(false);
  });

  it("marks a security fix, 404s an unknown id and refuses an empty or unknown body", async () => {
    const a = await wp("alpha.com");
    const [u] = await availableFor(env.DB, a.siteId);
    expect((await json<{ update: { security: boolean; risk: string } }>("PUT", `/care/updates/${u.id}`, { security: true })).update).toMatchObject({ security: true, risk: "security" });
    await json("PUT", "/care/updates/nope", { held: true }, 404);
    await json("PUT", `/care/updates/${u.id}`, {}, 400);
    await json("PUT", `/care/updates/${u.id}`, { held: "yes" }, 400);
    await json("PUT", `/care/updates/${u.id}`, { alias: "x" }, 400);
  });
});

describe("POST /care/batches", () => {
  it("starts this week's batch on any weekday: 201, then 409 for the same week", async () => {
    await wp("alpha.com");
    const first = await json<{ batch: { kind: string; status: string }; queued: number }>("POST", "/care/batches", undefined, 201);
    expect(first).toMatchObject({ batch: { kind: "weekly" }, queued: 1 });
    const again = await json<{ error: string }>("POST", "/care/batches", undefined, 409);
    expect(again.error).toMatch(/already/);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM care_batches WHERE kind = 'weekly'`).first<{ n: number }>())!.n).toBe(1);
  });
});

describe("POST /sites/:id/care-run", () => {
  it("starts a one-site run on a test site (201), refuses an archived site (409) and an unknown one (404)", async () => {
    const t = await wp("rehearse.com", { test: true });
    const r = await json<{ batch: { id: string; kind: string; siteId: string } }>("POST", `/sites/${t.siteId}/care-run`, undefined, 201);
    expect(r.batch).toMatchObject({ kind: "single", siteId: t.siteId });
    expect((await getBatch(env.DB, r.batch.id))!.status).toBe("inventory");
    // a second press while the first is still being read is a plain 409 and makes nothing
    expect((await json<{ error: string }>("POST", `/sites/${t.siteId}/care-run`, undefined, 409)).error).toBe("This site's updates are already being read.");
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM care_batches WHERE kind = 'single' AND site_id = ?`).bind(t.siteId).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM helper_jobs WHERE kind = 'care.inventory'`).first<{ n: number }>())!.n).toBe(1);
    const a = await wp("alpha.com");
    await archiveSite(env.DB, a.siteId, new Date().toISOString());
    expect((await json<{ error: string }>("POST", `/sites/${a.siteId}/care-run`, undefined, 409)).error).toMatch(/cannot take updates/);
    await json("POST", "/sites/nope/care-run", undefined, 404);
  });
});

describe("GET /care/runs/:id and the pictures", () => {
  async function runWithPage() {
    const a = await wp("alpha.com");
    const batch = await createSingleBatch(env.DB, a.siteId, "2027-W05", new Date().toISOString());
    const run = await insertRun(env.DB, { batchId: batch.id, siteId: a.siteId, wave: 0, now: new Date().toISOString() });
    await setRunStatus(env.DB, run.id, ["queued"], "changed", { summary: "1 applied", backupFile: "siteline-backups/a-1.sql.gz" }, new Date().toISOString());
    const keys = ["before", "after", "diff"].map((k) => `care/${run.id}/0-${k}.jpg`);
    for (const k of keys.slice(0, 2)) await env.RAW.put(k, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { httpMetadata: { contentType: "image/jpeg" } });
    await insertPageChecks(env.DB, run.id, [{ path: "/contact", beforeKey: keys[0], afterKey: keys[1], diffKey: keys[2], statusBefore: 200, statusAfter: 200, formsBefore: 1, formsAfter: 1, ssim: 0.9, verdict: "changed", review: "pending" }]);
    return { a, run, keys };
  }

  it("shows the run with its backup file name and page checks as picture links, never a storage key, the alias or the folder", async () => {
    const { run, keys } = await runWithPage();
    const r = await call("GET", `/care/runs/${run.id}`);
    const text = await r.text();
    expect(r.status).toBe(200);
    const v = JSON.parse(text).run;
    expect(v).toMatchObject({ id: run.id, status: "changed", backupFile: "siteline-backups/a-1.sql.gz", summary: "1 applied" });
    expect(v.pages).toEqual([expect.objectContaining({ path: "/contact", review: "pending", pictures: { before: expect.stringMatching(/^\/api\/care\/pictures\/.+\/before$/), after: expect.stringMatching(/\/after$/), diff: expect.stringMatching(/\/diff$/) } })]);
    for (const bad of [ALIAS, WPPATH, ...keys, `care/${run.id}`]) expect(text).not.toContain(bad);
    await json("GET", "/care/runs/nope", undefined, 404);
  });

  it("streams a picture that belongs to a page check, 404 for a missing file, an unknown check or another kind", async () => {
    const { run } = await runWithPage();
    const page = (await json<{ run: { pages: { id: string; pictures: { before: string } }[] } }>("GET", `/care/runs/${run.id}`)).run.pages[0];
    const r = await call("GET", page.pictures.before.replace(/^\/api/, ""));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect((await r.arrayBuffer()).byteLength).toBe(4);
    expect((await call("GET", `/care/pictures/${page.id}/diff`)).status).toBe(404); // never uploaded
    expect((await call("GET", `/care/pictures/${page.id}/other`)).status).toBe(404);
    expect((await call("GET", `/care/pictures/nope/before`)).status).toBe(404);
    expect((await call("GET", `/care/pictures/${page.id}/before`, undefined, false)).status).toBe(401);
  });

  it("never reads a key that is not a care picture of that run", async () => {
    const { run } = await runWithPage();
    await env.RAW.put("transcript.json", "SECRET", { httpMetadata: { contentType: "application/json" } });
    const page = (await json<{ run: { pages: { id: string }[] } }>("GET", `/care/runs/${run.id}`)).run.pages[0];
    await env.DB.prepare(`UPDATE care_page_checks SET before_key = 'transcript.json' WHERE id = ?`).bind(page.id).run();
    expect((await call("GET", `/care/pictures/${page.id}/before`)).status).toBe(404);
    await env.DB.prepare(`UPDATE care_page_checks SET before_key = 'care/other-run/0-before.jpg' WHERE id = ?`).bind(page.id).run();
    expect((await call("GET", `/care/pictures/${page.id}/before`)).status).toBe(404);
  });
});

describe("PATCH /sites/:id with the Care updates access", () => {
  it("saves a good alias, folder and pages, refuses shell syntax with the sentence, and clears with null", async () => {
    const s = await seedClient();
    const id = s.site!.id;
    const bad = await json<{ error: string }>("PATCH", `/sites/${id}`, { wpSshAlias: "a;b" }, 400);
    expect(bad.error).toMatch(/SSH alias/);
    expect((await getSite(env.DB, id))!.wpSshAlias).toBeNull();
    const good = await json<{ site: { wpSshAlias: string; wpPath: string; carePaths: string[] } }>("PATCH", `/sites/${id}`, { wpSshAlias: "client-1", wpPath: "/var/www/client-1", carePaths: ["/", "/contact"] });
    expect(good.site).toMatchObject({ wpSshAlias: "client-1", wpPath: "/var/www/client-1", carePaths: ["/", "/contact"] });
    await json("PATCH", `/sites/${id}`, { wpPath: "/var/www/../etc" }, 400);
    await json("PATCH", `/sites/${id}`, { wpPath: "relative" }, 400);
    expect((await json<{ error: string }>("PATCH", `/sites/${id}`, { carePaths: ["/a", "/b", "/c", "/d", "/e", "/f"] }, 400)).error).toMatch(/one to five pages/);
    await json("PATCH", `/sites/${id}`, { carePaths: ["//evil.com"] }, 400);
    await json("PATCH", `/sites/${id}`, { carePaths: ["/ok", "//evil.com"] }, 400);
    await json("PATCH", `/sites/${id}`, { carePaths: [] }, 400);
    expect((await getSite(env.DB, id))!.carePaths).toEqual(["/", "/contact"]);
    const cleared = await json<{ site: { wpSshAlias: string | null } }>("PATCH", `/sites/${id}`, { wpSshAlias: null });
    expect(cleared.site.wpSshAlias).toBeNull();
  });
});

describe("POST /incidents/:id/close", () => {
  it("closes an update_failed, refuses a down (409), an already closed one (409) and an unknown id (404)", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }] });
    const now = new Date().toISOString();
    const upd = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now });
    const down = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "HTTP 503", now });
    expect((await json<{ error: string }>("POST", `/incidents/${down.incident.id}/close`, undefined, 409)).error).toMatch(/closes by itself/);
    expect((await env.DB.prepare(`SELECT closed_at FROM site_incidents WHERE id = ?`).bind(down.incident.id).first<{ closed_at: string | null }>())!.closed_at).toBeNull();
    expect(await json("POST", `/incidents/${upd.incident.id}/close`)).toEqual({ ok: true });
    expect((await env.DB.prepare(`SELECT closed_at FROM site_incidents WHERE id = ?`).bind(upd.incident.id).first<{ closed_at: string | null }>())!.closed_at).not.toBeNull();
    await json("POST", `/incidents/${upd.incident.id}/close`, undefined, 409);
    await json("POST", "/incidents/nope/close", undefined, 404);
  });
});

describe("the health score agrees everywhere", () => {
  it("an open update_failed takes 15 on the board, the client record and get_care_overview", async () => {
    const a = await wp("alpha.com");
    const { ok } = await import("./fixtures/mcp");
    for (const k of ["hosting", "dns", "registrar", "admin", "gbp", "analytics"]) await env.DB.prepare(`UPDATE site_access_items SET status = 'received' WHERE site_id = ? AND key = ?`).bind(a.siteId, k).run();
    await openIncident(env.DB, { siteId: a.siteId, businessId: a.businessId, kind: "update_failed", detail: "update failed on the Mac helper", now: new Date().toISOString() });
    await openIncident(env.DB, { siteId: a.siteId, businessId: a.businessId, kind: "cert_expiring", detail: "certificate expires in 5 days", now: new Date().toISOString() });
    const board = (await json<{ clients: { businessId: string; health: { score: number; reasons: string[] } }[] }>("GET", "/care")).clients.find((c) => c.businessId === a.businessId)!;
    expect(board.health.score).toBe(70);
    expect(board.health.reasons).toEqual(["Updates need a look", "Certificate is expiring"]);
    const overview = (await ok<{ clients: { clientId: string; healthScore: number; reasons: string[] }[] }>("get_care_overview", {})).clients.find((c) => c.clientId === a.businessId)!;
    expect(overview).toMatchObject({ healthScore: 70, reasons: board.health.reasons });
    const record = await json<{ client: { health: { score: number } } }>("GET", `/clients/${a.businessId}`);
    expect(record.client.health.score).toBe(70);
  });
});
