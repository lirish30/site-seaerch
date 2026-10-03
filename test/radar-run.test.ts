import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { claimRadar, getRadar } from "../src/worker/db/radar";
import { runDueRadars, DEFAULT_MAX_PER_RUN } from "../src/worker/radar-run";
import { estimateSearchCost } from "../src/worker/cost";
import worker from "../src/worker/index";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (days: number) => iso(NOW.getTime() - days * DAY);
const ahead = (days: number) => iso(NOW.getTime() + days * DAY);

async function seed(o: { id: string; next: string; location?: string; type?: string; enabled?: number; days?: number; max?: number; lastError?: string | null }) {
  await env.DB.prepare(
    `INSERT INTO radars (id, location, business_type, radius_km, max_results, interval_days, enabled, next_run_at, last_error, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(o.id, o.location ?? `City ${o.id}`, o.type ?? "plumber", 15, o.max ?? 50, o.days ?? 30, o.enabled ?? 1, o.next, o.lastError ?? null, iso(NOW.getTime() - 100 * DAY)).run();
}

function fakeStart() {
  const ids: string[] = [];
  const fn = async (searchId: string) => { ids.push(searchId); };
  return { ids, fn };
}
const deps = (startWorkflow: (id: string) => Promise<void>) => ({ db: env.DB, startWorkflow, now: () => NOW });
const searchCount = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM searches`).first<{ n: number }>())!.n;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM radars`), env.DB.prepare(`DELETE FROM searches`), env.DB.prepare(`DELETE FROM usage`)]);
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks'.", monthly_spend_limit_usd: 25 });
});
afterAll(() => saveSettings(env.DB, { monthly_spend_limit_usd: 25 }));

describe("runDueRadars selection", () => {
  it("runs only enabled radars whose next_run_at has passed", async () => {
    await seed({ id: "due", next: ago(1) });
    await seed({ id: "exactly-now", next: NOW.toISOString() });
    await seed({ id: "future", next: ahead(1) });
    await seed({ id: "off", next: ago(5), enabled: 0 });
    const s = fakeStart();
    const r = await runDueRadars(deps(s.fn));
    expect(r).toEqual({ started: 2, skipped: 0, failed: 0 });
    expect(s.ids).toHaveLength(2);
    expect((await getRadar(env.DB, "future"))!.next_run_at).toBe(ahead(1));
    expect((await getRadar(env.DB, "off"))!.next_run_at).toBe(ago(5));
    expect((await getRadar(env.DB, "off"))!.last_search_id).toBeNull();
  });

  it("starts the oldest due radars first and caps a tick at maxPerRun (default 3)", async () => {
    expect(DEFAULT_MAX_PER_RUN).toBe(3);
    for (const [id, d] of [["e", 1], ["a", 9], ["c", 5], ["b", 7], ["d", 3]] as const) await seed({ id, next: ago(d) });
    const s = fakeStart();
    const r = await runDueRadars(deps(s.fn));
    expect(r.started).toBe(3);
    const started = (await env.DB.prepare(`SELECT id FROM radars WHERE last_search_id IS NOT NULL ORDER BY id`).all<{ id: string }>()).results.map((x) => x.id);
    expect(started).toEqual(["a", "b", "c"]); // the two newest-due radars wait for the next tick
    expect((await getRadar(env.DB, "d"))!.next_run_at).toBe(ago(3));
    const r2 = await runDueRadars(deps(fakeStart().fn), { maxPerRun: 1 });
    expect(r2.started).toBe(1);
    expect((await getRadar(env.DB, "d"))!.last_search_id).not.toBeNull();
  });
});

describe("radar-started searches are new-only", () => {
  it("the cron path creates searches with new_only = 1", async () => {
    await seed({ id: "a", next: ago(1) }); await seed({ id: "b", next: ago(2) });
    expect((await runDueRadars(deps(fakeStart().fn))).started).toBe(2);
    const rows = (await env.DB.prepare(`SELECT new_only FROM searches`).all<{ new_only: number }>()).results;
    expect(rows).toEqual([{ new_only: 1 }, { new_only: 1 }]);
  });
});

describe("runDueRadars claim", () => {
  const claim = (id: string, o: { manual?: boolean; at?: Date } = {}) =>
    claimRadar(env.DB, id, ahead(30), (o.at ?? NOW).toISOString(), !o.manual);

  it("claimRadar hands the row to exactly one of two interleaved claims on the same snapshot", async () => {
    for (const manual of [false, true]) {
      await env.DB.prepare(`DELETE FROM radars`).run();
      await seed({ id: "r", next: ago(1) });
      const res = await Promise.all([claim("r", { manual }), claim("r", { manual })]);
      expect(res.filter(Boolean), manual ? "manual" : "due").toHaveLength(1);
      expect(res.find(Boolean)).toMatchObject({ id: "r", next_run_at: ahead(30), claimed_at: NOW.toISOString() });
    }
  });

  it("the cooldown is part of the claim: a second claim within 10s loses, one after it wins", async () => {
    await seed({ id: "r", next: ago(1) });
    expect(await claim("r", { manual: true })).not.toBeNull();
    expect(await claim("r", { manual: true, at: new Date(NOW.getTime() + 5_000) })).toBeNull();
    expect(await claim("r", { manual: true, at: new Date(NOW.getTime() + 11_000) })).not.toBeNull();
  });

  it("a due-only claim needs the radar to be due and enabled; a manual claim needs only enabled", async () => {
    await seed({ id: "later", next: ahead(3) });
    await seed({ id: "off", next: ago(1), enabled: 0 });
    expect(await claim("later")).toBeNull();
    expect(await claim("later", { manual: true })).not.toBeNull();
    expect(await claim("off")).toBeNull();
    expect(await claim("off", { manual: true })).toBeNull();
  });

  it("claiming does not stamp last_run_at (only a started search does)", async () => {
    await seed({ id: "r", next: ago(1) });
    await claim("r");
    expect((await getRadar(env.DB, "r"))!.last_run_at).toBeNull();
  });

  it("overlapping cron deliveries start the radar only once", async () => {
    await seed({ id: "r", next: ago(1) });
    const s = fakeStart();
    const [a, b] = await Promise.all([runDueRadars(deps(s.fn)), runDueRadars(deps(s.fn))]);
    expect(s.ids).toHaveLength(1);
    expect(a.started + b.started).toBe(1);
    expect(await searchCount()).toBe(1);
  });

  it.each([
    ["advanced by another worker's claim", ahead(30)],
    ["blocked by a concurrent run (retry tomorrow)", ahead(1)], // stale snapshot must not turn blocked into started
  ])("a radar %s between select and claim is skipped, not started", async (_n, bumpTo) => {
    await seed({ id: "r", next: ago(1) });
    const s = fakeStart();
    // The other run lands right after our select returns, before our claim.
    const racing = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => {
        const st = t.prepare(sql);
        if (!/FROM radars/.test(sql) || !/next_run_at <=/.test(sql)) return st;
        return { bind: (...a: unknown[]) => { const b = st.bind(...a); return { all: async () => {
          const res = await b.all();
          await env.DB.prepare(`UPDATE radars SET next_run_at = ?, claimed_at = ? WHERE id = 'r'`).bind(bumpTo, NOW.toISOString()).run();
          return res;
        } }; } };
      };
      const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v;
    } }) as D1Database;
    const r = await runDueRadars({ db: racing, startWorkflow: s.fn, now: () => NOW });
    expect(s.ids).toEqual([]);
    expect(r).toEqual({ started: 0, skipped: 1, failed: 0 });
    expect((await getRadar(env.DB, "r"))!.next_run_at).toBe(bumpTo);
  });
});

describe("runDueRadars guards", () => {
  it("spend limit blocks the run: records last_error, retries tomorrow, starts nothing", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: 0 });
    await seed({ id: "r", next: ago(1), days: 30 });
    const s = fakeStart();
    const r = await runDueRadars(deps(s.fn));
    expect(r).toEqual({ started: 0, skipped: 1, failed: 0 });
    expect(s.ids).toEqual([]);
    expect(await searchCount()).toBe(0);
    const row = (await getRadar(env.DB, "r"))!;
    expect(row.last_error).toMatch(/spend limit/i);
    expect(row.next_run_at).toBe(ahead(1)); // retry tomorrow, not a whole interval later
    expect(row.last_search_id).toBeNull();
    expect(row.last_run_at).toBeNull(); // "last run" means a search actually started
  });

  it.each([["physical_address"], ["opt_out_line"]])("missing %s blocks the run the same way", async (field) => {
    await saveSettings(env.DB, { [field]: "  " });
    await seed({ id: "r", next: ago(1) });
    const s = fakeStart();
    const r = await runDueRadars(deps(s.fn));
    expect(r).toEqual({ started: 0, skipped: 1, failed: 0 });
    expect(s.ids).toEqual([]);
    const row = (await getRadar(env.DB, "r"))!;
    expect(row.last_error).toMatch(/Settings/);
    expect(row.next_run_at).toBe(ahead(1));
  });

  it("counts searches already started in the same tick toward the spend limit", async () => {
    const est = estimateSearchCost(50);
    await saveSettings(env.DB, { monthly_spend_limit_usd: est * 1.5 }); // room for one search, not two
    await seed({ id: "a", next: ago(3) });
    await seed({ id: "b", next: ago(2) });
    const s = fakeStart();
    const r = await runDueRadars(deps(s.fn));
    expect(r).toEqual({ started: 1, skipped: 1, failed: 0 });
    expect(s.ids).toHaveLength(1);
    expect((await getRadar(env.DB, "a"))!.last_search_id).not.toBeNull();
    const b = (await getRadar(env.DB, "b"))!;
    expect(b.last_search_id).toBeNull();
    expect(b.last_error).toMatch(/spend limit/i);
    expect(b.next_run_at).toBe(ahead(1));
  });

  it("a radar that failed to start does not count toward the running total", async () => {
    const est = estimateSearchCost(50);
    await saveSettings(env.DB, { monthly_spend_limit_usd: est * 1.5 });
    await seed({ id: "a", next: ago(3) });
    await seed({ id: "b", next: ago(2) });
    const ids: string[] = [];
    const r = await runDueRadars(deps(async (id) => { ids.push(id); if (ids.length === 1) throw new Error("boom"); }));
    expect(r).toEqual({ started: 1, skipped: 0, failed: 1 });
    expect((await getRadar(env.DB, "b"))!.last_search_id).not.toBeNull();
  });
});

describe("runDueRadars failures and success", () => {
  it("one radar failing to start does not stop the next; the error is recorded and retried tomorrow", async () => {
    await seed({ id: "a", next: ago(3) });
    await seed({ id: "b", next: ago(2) });
    const ids: string[] = [];
    const r = await runDueRadars(deps(async (id) => { ids.push(id); if (ids.length === 1) throw new Error("workflow down"); }));
    expect(r).toEqual({ started: 1, skipped: 0, failed: 1 });
    const a = (await getRadar(env.DB, "a"))!;
    expect(a.last_error).toBe("workflow down");
    expect(a.next_run_at).toBe(ahead(1));
    expect(a.last_search_id).toBeNull();
    const failedSearch = await env.DB.prepare(`SELECT status, error FROM searches WHERE id = ?`).bind(ids[0]).first<any>();
    expect(failedSearch).toEqual({ status: "failed", error: "workflow down" });
    expect((await getRadar(env.DB, "b"))!.last_error).toBeNull();
  });

  it("a radar with unusable stored data fails alone and the rest still run", async () => {
    await seed({ id: "bad", next: ago(3), location: "x" });
    await seed({ id: "ok", next: ago(2) });
    const s = fakeStart();
    const r = await runDueRadars(deps(s.fn));
    expect(r).toEqual({ started: 1, skipped: 0, failed: 1 });
    const bad = (await getRadar(env.DB, "bad"))!;
    expect(bad.last_error).toBeTruthy();
    expect(bad.next_run_at).toBe(ahead(1));
  });

  it("an unexpected throw while running one radar is contained", async () => {
    await seed({ id: "a", next: ago(3) });
    await seed({ id: "b", next: ago(2) });
    let calls = 0;
    const flaky = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => {
        if (sql.startsWith("INSERT INTO searches") && ++calls === 1) throw new Error("d1 hiccup");
        return t.prepare(sql);
      };
      const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v;
    } }) as D1Database;
    const s = fakeStart();
    const r = await runDueRadars({ db: flaky, startWorkflow: s.fn, now: () => NOW });
    expect(r).toEqual({ started: 1, skipped: 0, failed: 1 });
    const a = (await getRadar(env.DB, "a"))!;
    expect(a.last_error).toBe("d1 hiccup");
    expect(a.next_run_at).toBe(ahead(1));
  });

  it("success advances next_run_at by interval_days, records the search and clears last_error", async () => {
    await seed({ id: "r", next: ago(2), days: 14, lastError: "old problem" });
    const s = fakeStart();
    const r = await runDueRadars(deps(s.fn));
    expect(r).toEqual({ started: 1, skipped: 0, failed: 0 });
    const row = (await getRadar(env.DB, "r"))!;
    expect(row.next_run_at).toBe(ahead(14));
    expect(row.last_run_at).toBe(NOW.toISOString());
    expect(row.last_error).toBeNull();
    expect(row.last_search_id).toBe(s.ids[0]);
    const search = await env.DB.prepare(`SELECT * FROM searches WHERE id = ?`).bind(s.ids[0]).first<any>();
    expect(search).toMatchObject({ location: "City r", business_type: "plumber", radius_km: 15, max_results: 50, status: "running" });
  });

  it("returns zeros and starts nothing when no radar is due", async () => {
    await seed({ id: "later", next: ahead(3) });
    const s = fakeStart();
    expect(await runDueRadars(deps(s.fn))).toEqual({ started: 0, skipped: 0, failed: 0 });
    expect(s.ids).toEqual([]);
  });
});

describe("a failure to record a started search", () => {
  const failingRecordOnce = () => {
    let thrown = false;
    return new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => {
        if (sql.startsWith("UPDATE radars SET last_run_at") && !thrown) { thrown = true; throw new Error("d1 hiccup"); }
        return t.prepare(sql);
      };
      const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v;
    } }) as D1Database;
  };

  it("still counts as started, keeps the schedule one interval out, and is not re-run the next day", async () => {
    await seed({ id: "r", next: ago(1), days: 30 });
    const s = fakeStart();
    const r = await runDueRadars({ db: failingRecordOnce(), startWorkflow: s.fn, now: () => NOW });
    expect(r).toEqual({ started: 1, skipped: 0, failed: 0 });
    const row = (await getRadar(env.DB, "r"))!;
    expect(row.next_run_at).toBe(ahead(30)); // NOT tomorrow
    expect(row.last_error).toBeNull();
    const tomorrow = new Date(NOW.getTime() + DAY);
    const again = await runDueRadars({ db: env.DB, startWorkflow: s.fn, now: () => tomorrow });
    expect(again).toEqual({ started: 0, skipped: 0, failed: 0 });
    expect(s.ids).toHaveLength(1);
    expect(await searchCount()).toBe(1);
  });

  it("its spend still counts against the next radar in the same tick", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: estimateSearchCost(50) * 1.5 });
    await seed({ id: "a", next: ago(3) });
    await seed({ id: "b", next: ago(2) });
    const s = fakeStart();
    const r = await runDueRadars({ db: failingRecordOnce(), startWorkflow: s.fn, now: () => NOW });
    expect(r).toEqual({ started: 1, skipped: 1, failed: 0 });
    expect((await getRadar(env.DB, "b"))!.last_error).toMatch(/spend limit/i);
  });
});

describe("in-flight spend across ticks", () => {
  it("a search still running from an earlier tick counts toward the limit", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: estimateSearchCost(50) * 1.5 });
    await createSearch(env.DB, { location: "Elsewhere", businessType: "roofer", radiusKm: 15, maxResults: 50 }); // running, no usage recorded yet
    await seed({ id: "r", next: ago(1) });
    const s = fakeStart();
    expect(await runDueRadars(deps(s.fn))).toEqual({ started: 0, skipped: 1, failed: 0 });
    expect(s.ids).toEqual([]);
  });
});

describe("a spend block found by the post-insert re-check", () => {
  it("is treated like any spend block: last_error, retry tomorrow, no workflow", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: estimateSearchCost(50) * 1.5 });
    await seed({ id: "r", next: ago(1) });
    const racer = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => {
        const st = t.prepare(sql);
        if (!sql.startsWith("INSERT INTO searches")) return st;
        return { bind: (...a: unknown[]) => { const b = st.bind(...a); return { run: async () => { const x = await b.run(); await createSearch(env.DB, { location: "Racer", businessType: "x", radiusKm: 15, maxResults: 50 }); return x; } }; } };
      };
      const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v;
    } }) as D1Database;
    const s = fakeStart();
    const r = await runDueRadars({ db: racer, startWorkflow: s.fn, now: () => NOW });
    expect(r).toEqual({ started: 0, skipped: 1, failed: 0 });
    expect(s.ids).toEqual([]);
    const row = (await getRadar(env.DB, "r"))!;
    expect(row.last_error).toMatch(/spend limit/i);
    expect(row.next_run_at).toBe(ahead(1));
    expect(row.last_search_id).toBeNull();
  });
});

describe("scheduled handler", () => {
  it("default export has fetch and scheduled", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });

  it("scheduled() runs due radars and starts their workflow with a deterministic id", async () => {
    await seed({ id: "r", next: ago(1) });
    const created: any[] = [];
    const orig = env.SEARCH_WORKFLOW.create;
    (env.SEARCH_WORKFLOW as any).create = async (o: any) => { created.push(o); return {} as any; };
    try {
      const ctx = createExecutionContext();
      await worker.scheduled!(createScheduledController({ scheduledTime: Date.now(), cron: "17 13 * * *" }), env, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      (env.SEARCH_WORKFLOW as any).create = orig;
    }
    const row = (await env.DB.prepare(`SELECT last_search_id, last_error FROM radars WHERE id = 'r'`).first<any>())!;
    expect(row.last_search_id).toBeTruthy();
    expect(created).toEqual([{ id: `search-${row.last_search_id}`, params: { searchId: row.last_search_id } }]);
  });

  it("scheduled() swallows a runner crash instead of failing the cron", async () => {
    const broken = { ...env, DB: { prepare() { throw new Error("db down"); } } } as any;
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: Date.now() }), broken, ctx);
    await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
  });
});
