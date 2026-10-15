import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { seedBusiness, seedLeadAudit } from "./fixtures/cro";
import { getCareerSource, listUndiscovered, saveCareerSource } from "../src/worker/db/jobs";
import { saveSettings } from "../src/worker/db/settings";
import { DISCOVER_PER_TICK, jobDeps, runJobWatch } from "../src/worker/jobs/run";
import worker, { JOB_WATCH_CRON } from "../src/worker/index";
import type { JobDeps } from "../src/worker/jobs/sync";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const GH = (t: string) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`;
const deps = (f: JobDeps["fetch"]): JobDeps => ({ db: env.DB, fetch: f, now: () => NOW, userAgent: "UA" });
const empty = async () => Response.json({ jobs: [] });

beforeEach(async () => { for (const t of ["job_postings", "career_sources", "audits", "activity", "radars", "searches"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

const dueSource = (id: string, token: string, nextCheck = "2026-10-14T00:00:00.000Z") =>
  saveCareerSource(env.DB, { business_id: id, status: "active", ats: "greenhouse", token, careers_url: null, checked_at: nextCheck, next_check_at: nextCheck });

describe("runJobWatch", () => {
  it("syncs due boards, oldest first, and respects the cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { const b = await seedBusiness(); ids.push(b.id); await dueSource(b.id, `t${i}`, `2026-10-14T0${i}:00:00.000Z`); }
    const urls: string[] = [];
    const r = await runJobWatch(deps(async (u) => { urls.push(u); return empty(); }), { max: 3 });
    expect(r).toEqual({ synced: 3, discovered: 0, failed: 0 });
    expect(urls).toEqual([GH("t0"), GH("t1"), GH("t2")]);
    expect((await getCareerSource(env.DB, ids[3]))!.checked_at).toBe("2026-10-14T03:00:00.000Z"); // untouched
  });

  it("uses the room left after syncing to discover boards for scanned leads", async () => {
    const synced = await seedBusiness(); await dueSource(synced.id, "t0");
    const fresh = await seedBusiness(); await seedLeadAudit(fresh.id);
    await env.DB.prepare(`UPDATE audits SET site_links = ? WHERE business_id = ?`).bind(JSON.stringify({ careers: "https://boards.greenhouse.io/acme" }), fresh.id).run();
    const r = await runJobWatch(deps(empty), { max: 2 });
    expect([r.synced, r.discovered]).toEqual([1, 1]);
    expect((await getCareerSource(env.DB, fresh.id))!.status).toBe("active");
  });

  it("discovers no more than DISCOVER_PER_TICK leads in a tick", async () => {
    expect(DISCOVER_PER_TICK).toBe(15);
    for (let i = 0; i < 17; i++) await seedLeadAudit((await seedBusiness()).id);
    expect((await runJobWatch(deps(empty))).discovered).toBe(15);
  });

  it("counts a board that errors as failed and keeps going", async () => {
    const a = await seedBusiness(), b = await seedBusiness();
    await dueSource(a.id, "bad", "2026-10-14T00:00:00.000Z"); await dueSource(b.id, "good", "2026-10-14T01:00:00.000Z");
    const r = await runJobWatch(deps(async (u) => (u === GH("bad") ? new Response("x", { status: 500 }) : empty())));
    expect(r).toEqual({ synced: 1, discovered: 0, failed: 1 });
  });

  it("survives a thrown error from one lead", async () => {
    const a = await seedBusiness(), b = await seedBusiness();
    await dueSource(a.id, "boom"); await dueSource(b.id, "fine", "2026-10-14T01:00:00.000Z");
    const r = await runJobWatch(deps(async (u) => { if (u === GH("boom")) throw new Error("reset"); return empty(); }));
    expect(r.synced + r.failed).toBe(2);
    expect(r.failed).toBe(1);
  });
});

// A D1 that works except where told to fail, so a throw comes out of syncSource/discoverSource themselves rather than from fetch.
const flaky = (f: { prepare?: RegExp; batch?: boolean }): D1Database => ({
  prepare: (q: string) => { if (f.prepare?.test(q)) throw new Error("d1 down"); return env.DB.prepare(q); },
  batch: (s: D1PreparedStatement[]) => (f.batch ? Promise.reject(new Error("d1 down")) : env.DB.batch(s)),
}) as unknown as D1Database;
const T24 = "2026-10-15T12:00:00.000Z";

describe("runJobWatch poison pills", () => {
  it("pushes a due board whose sync throws out by a day, records why, and still syncs the next one", async () => {
    const a = await seedBusiness(), b = await seedBusiness();
    await dueSource(a.id, "boom", "2026-10-14T00:00:00.000Z"); await dueSource(b.id, "fine", "2026-10-14T01:00:00.000Z");
    const posting = { jobs: [{ id: 1, title: "Dev", absolute_url: "https://boards.greenhouse.io/boom/jobs/1" }] };
    const r = await runJobWatch({ ...deps(async (u) => (u === GH("boom") ? Response.json(posting) : empty())), db: flaky({ batch: true }) });
    expect(r).toEqual({ synced: 1, discovered: 0, failed: 1 });
    const bad = (await getCareerSource(env.DB, a.id))!;
    expect([bad.status, bad.token, bad.next_check_at, bad.checked_at]).toEqual(["active", "boom", T24, NOW.toISOString()]);
    expect(bad.last_error).toContain("d1 down");
    expect((await getCareerSource(env.DB, b.id))!.checked_at).toBe(NOW.toISOString());
  });

  it("parks a lead whose discovery throws as an error for a day so it stops heading the queue", async () => {
    const lead = await seedBusiness(); await seedLeadAudit(lead.id);
    expect(await listUndiscovered(env.DB, NOW.toISOString(), 5)).toEqual([{ id: lead.id }]);
    const r = await runJobWatch({ ...deps(empty), db: flaky({ prepare: /SELECT \* FROM audits/ }) });
    expect(r).toEqual({ synced: 0, discovered: 0, failed: 1 });
    const s = (await getCareerSource(env.DB, lead.id))!;
    expect([s.status, s.next_check_at]).toEqual(["error", T24]);
    expect(s.last_error).toContain("d1 down");
    expect(await listUndiscovered(env.DB, NOW.toISOString(), 5)).toEqual([]);
  });
});

describe("jobDeps", () => {
  it("identifies the owner in the user agent: contact email, else business name, else 'owner'", async () => {
    await saveSettings(env.DB, { contact_email: "me@example.com", business_name: "Acme" });
    expect((await jobDeps(env)).userAgent).toContain("me@example.com");
    await saveSettings(env.DB, { contact_email: "", business_name: "Acme" });
    expect((await jobDeps(env)).userAgent).toContain("Acme");
    await saveSettings(env.DB, { contact_email: "", business_name: "" });
    expect((await jobDeps(env)).userAgent).toContain("(+contact: owner)");
  });
});

describe("scheduled", () => {
  it("the job-watch cron runs the watcher and leaves radars alone; any other cron still runs radars", async () => {
    await env.DB.prepare(
      `INSERT INTO radars (id, location, business_type, radius_km, max_results, interval_days, enabled, next_run_at, created_at) VALUES ('r1','Boise','plumber',15,50,30,1,'2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`).run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: JOB_WATCH_CRON, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare(`SELECT last_search_id FROM radars WHERE id = 'r1'`).first<{ last_search_id: string | null }>())!.last_search_id).toBeNull();
  });
});
