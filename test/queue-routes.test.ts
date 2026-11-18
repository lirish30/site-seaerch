import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MAX_ATTEMPTS, claimNextTask, enqueueTask, getTask } from "../src/worker/queue/db";
import { registerTestKinds, unregisterTestKinds, resetTestKindLog, testKindLog } from "./queue-kinds";
import { insertAudit } from "../src/worker/db/audits";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import "../src/worker/queue/siteReview"; // registers site.review

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const NOW = new Date("2026-11-18T18:00:00.000Z");

beforeAll(async () => {
  registerTestKinds();
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
afterAll(unregisterTestKinds);
beforeEach(async () => { resetTestKindLog(); await env.DB.prepare(`DELETE FROM claude_tasks`).run(); });

describe("auth", () => {
  it.each([["GET", "/api/queue"], ["POST", "/api/queue/abc/release"], ["POST", "/api/queue/cancel"]])("%s %s needs a session", async (method, path) => {
    const r = await SELF.fetch(`https://x${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    expect(r.status).toBe(401);
  });
});

describe("GET /api/queue", () => {
  it("is empty when nothing is open", async () => {
    const r = await api("/api/queue");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ counts: {}, labels: {}, oldestPendingAt: null });
  });

  it("counts open tasks by kind and ignores closed ones", async () => {
    const a = await enqueueTask(env.DB, "test.echo", { text: "a" });
    await enqueueTask(env.DB, "test.echo", { text: "b" });
    await enqueueTask(env.DB, "test.stale", {});
    await claimNextTask(env.DB, NOW); // claims the oldest: a
    const done = await enqueueTask(env.DB, "test.echo", { text: "done" });
    await env.DB.prepare(`UPDATE claude_tasks SET status = 'done' WHERE id = ?`).bind(done.id).run();
    const gone = await enqueueTask(env.DB, "test.echo", { text: "expired" });
    await env.DB.prepare(`UPDATE claude_tasks SET status = 'expired' WHERE id = ?`).bind(gone.id).run();
    const body = (await (await api("/api/queue")).json()) as any;
    expect(body.counts).toEqual({ "test.echo": { pending: 1, claimed: 1 }, "test.stale": { pending: 1, claimed: 0 } });
    expect(body.labels).toEqual({ "test.echo": "Echo (test)", "test.stale": "Stale (test)" });
    expect(a.created).toBe(true);
  });

  it("leaves out kinds nobody can work, and reports the oldest pending task", async () => {
    await env.DB.prepare(`INSERT INTO claude_tasks (id, kind, payload, status, attempts, created_at) VALUES ('o1','nobody.registered','{}','pending',0,'2026-11-01T00:00:00.000Z')`).run();
    await env.DB.prepare(`INSERT INTO claude_tasks (id, kind, payload, status, attempts, created_at) VALUES ('o2','test.echo','{}','pending',0,'2026-11-05T00:00:00.000Z')`).run();
    await env.DB.prepare(`INSERT INTO claude_tasks (id, kind, payload, status, attempts, created_at, claimed_at) VALUES ('o3','test.echo','{}','claimed',1,'2026-11-02T00:00:00.000Z','2026-11-02T01:00:00.000Z')`).run();
    const body = (await (await api("/api/queue")).json()) as any;
    expect(body.counts).toEqual({ "test.echo": { pending: 1, claimed: 1 } });
    expect(body.oldestPendingAt).toBe("2026-11-05T00:00:00.000Z");
  });

  it("returns no payload or result", async () => {
    await enqueueTask(env.DB, "test.echo", { text: "SECRET-SCRAPED-TEXT" });
    expect(JSON.stringify(await (await api("/api/queue")).json())).not.toContain("SECRET-SCRAPED-TEXT");
  });
});

describe("POST /api/queue/:id/release", () => {
  it("returns a claimed task to pending", async () => {
    const { id } = await enqueueTask(env.DB, "test.echo", { text: "a" });
    await claimNextTask(env.DB, NOW);
    const r = await post(`/api/queue/${id}/release`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const t = (await getTask(env.DB, id))!;
    expect(t.status).toBe("pending");
    expect(t.claimed_at).toBeNull();
  });

  it("is 404 for an unknown task and 409 for one that is not claimed", async () => {
    expect((await post("/api/queue/nope/release")).status).toBe(404);
    const { id } = await enqueueTask(env.DB, "test.echo", { text: "a" });
    const r = await post(`/api/queue/${id}/release`);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "that task is not being worked on" });
    expect((await getTask(env.DB, id))!.status).toBe("pending");
    await env.DB.prepare(`UPDATE claude_tasks SET status = 'done' WHERE id = ?`).bind(id).run();
    expect((await post(`/api/queue/${id}/release`)).status).toBe(409);
  });

  it("fails a task that has used all its claims, and runs its onFail hook", async () => {
    const { id } = await enqueueTask(env.DB, "test.echo", { text: "a" });
    await claimNextTask(env.DB, NOW);
    await env.DB.prepare(`UPDATE claude_tasks SET attempts = ? WHERE id = ?`).bind(MAX_ATTEMPTS, id).run();
    expect((await post(`/api/queue/${id}/release`)).status).toBe(200);
    expect((await getTask(env.DB, id))!.status).toBe("failed");
    expect(testKindLog.failed.map((f) => f.id)).toEqual([id]);
  });
});

describe("POST /api/queue/cancel", () => {
  it("closes the open tasks about one target and says how many", async () => {
    await enqueueTask(env.DB, "test.echo", { text: "a" }, { targetType: "lead", targetId: "L1" });
    await enqueueTask(env.DB, "test.echo", { text: "b" }, { targetType: "lead", targetId: "L1" });
    const other = await enqueueTask(env.DB, "test.echo", { text: "c" }, { targetType: "lead", targetId: "L2" });
    const r = await post("/api/queue/cancel", { targetType: "lead", targetId: "L1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cancelled: 2 });
    expect((await getTask(env.DB, other.id))!.status).toBe("pending");
    expect(await (await post("/api/queue/cancel", { targetType: "lead", targetId: "L1" })).json()).toEqual({ cancelled: 0 });
  });

  it("is 400 without a target", async () => {
    for (const body of [undefined, {}, { targetType: "lead" }, { targetType: "", targetId: "x" }, { targetType: 1, targetId: "x" }]) {
      expect((await post("/api/queue/cancel", body)).status).toBe(400);
    }
  });
});

describe("GET /api/leads/:id reviewPending", () => {
  async function lead() {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Acme", category: null, address: null, phone: null, websiteUrl: "https://acme.test", mapsUrl: null, rating: null, reviewCount: null }, s.id);
    const audit = async () => insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: false, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
      https: true, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
      platform: null, seo_score: null, accessibility_score: null, mail_warning: null,
      score: 1, offer: "care_plan", findings: [], raw_r2_key: null, health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
    return { b, audit };
  }
  const pending = async (id: string) => ((await (await api(`/api/leads/${id}`)).json()) as any).reviewPending;

  it("is true while a site.review task is open for the latest audit, false otherwise", async () => {
    const { b, audit } = await lead();
    expect(await pending(b.id)).toBe(false); // no audit yet
    const a = await audit();
    expect(await pending(b.id)).toBe(false); // audited, no review queued
    const t = await enqueueTask(env.DB, "site.review", { auditId: a.id }, { dedupeKey: a.id, targetType: "lead", targetId: b.id });
    expect(await pending(b.id)).toBe(true);
    await claimNextTask(env.DB, NOW, ["site.review"]);
    expect(await pending(b.id)).toBe(true); // being worked still counts
    await env.DB.prepare(`UPDATE claude_tasks SET status = 'done' WHERE id = ?`).bind(t.id).run();
    expect(await pending(b.id)).toBe(false);
  });

  it("ignores a review task of an older audit", async () => {
    const { b, audit } = await lead();
    const old = await audit();
    await env.DB.prepare(`UPDATE audits SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).bind(old.id).run();
    await enqueueTask(env.DB, "site.review", { auditId: old.id }, { dedupeKey: old.id, targetType: "lead", targetId: b.id });
    await audit();
    expect(await pending(b.id)).toBe(false);
  });
});
