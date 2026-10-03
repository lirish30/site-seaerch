import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { estimateSearchCost } from "../src/worker/cost";
import { checkSearchGuards, startSearchRun, IN_FLIGHT_WINDOW_HOURS } from "../src/worker/search-start";

const INPUT = { location: "Boise", businessType: "plumber", maxResults: 50 };
const EST = estimateSearchCost(50);
const HOUR = 3600000;

async function running(o: { status?: string; hoursAgo?: number; max?: number } = {}) {
  const s = await createSearch(env.DB, { location: "Other", businessType: "roofer", radiusKm: 15, maxResults: o.max ?? 50 });
  await env.DB.prepare(`UPDATE searches SET status = ?, created_at = ? WHERE id = ?`)
    .bind(o.status ?? "running", new Date(Date.now() - (o.hoursAgo ?? 0) * HOUR).toISOString(), s.id).run();
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM searches`), env.DB.prepare(`DELETE FROM usage`)]);
  await saveSettings(env.DB, { physical_address: "1 Main St", opt_out_line: "Reply no.", monthly_spend_limit_usd: EST * 1.5 });
});
afterAll(() => saveSettings(env.DB, { monthly_spend_limit_usd: 25 }));

describe("in-flight spend guard", () => {
  it("a running search inside the window blocks a search that would pass the limit", async () => {
    expect((await checkSearchGuards(env.DB, INPUT)).ok).toBe(true);
    await running();
    const g = await checkSearchGuards(env.DB, INPUT);
    expect(g).toMatchObject({ ok: false, kind: "spend" });
  });

  it("uses the same 402 body shape: spent and limit from usage, not the in-flight estimate", async () => {
    await running();
    const g = await checkSearchGuards(env.DB, INPUT) as any;
    expect(g.spend).toEqual({ ok: false, spent: 0, limit: EST * 1.5 });
  });

  it("ignores searches older than the window and finished or failed ones", async () => {
    expect(IN_FLIGHT_WINDOW_HOURS).toBe(6);
    await running({ hoursAgo: 7 });
    await running({ status: "done" });
    await running({ status: "failed" });
    expect((await checkSearchGuards(env.DB, INPUT)).ok).toBe(true);
    await running({ hoursAgo: 5 });
    expect((await checkSearchGuards(env.DB, INPUT)).ok).toBe(false);
  });

  it("sums the estimates of every in-flight search", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: estimateSearchCost(10) * 3.5 + estimateSearchCost(20) });
    await running({ max: 10 }); await running({ max: 10 });
    expect((await checkSearchGuards(env.DB, { ...INPUT, maxResults: 20 })).ok).toBe(true); // 10+10+20 fits
    await running({ max: 10 }); await running({ max: 10 });
    expect((await checkSearchGuards(env.DB, { ...INPUT, maxResults: 20 })).ok).toBe(false);
  });
});

describe("startSearchRun start failures", () => {
  it.each([["a string", "plain string"], ["null", null], ["an Error", new Error("boom")]])("marks the search failed when the workflow throws %s", async (_n, thrown) => {
    const r = await startSearchRun({ db: env.DB, startWorkflow: async () => { throw thrown; } }, INPUT);
    expect(r).toMatchObject({ ok: false, kind: "start_failed" });
    const rows = (await env.DB.prepare(`SELECT status, error FROM searches`).all<any>()).results;
    expect(rows).toEqual([{ status: "failed", error: thrown instanceof Error ? "boom" : String(thrown) }]);
  });
});

// Simulates a competing request that inserts its own 'running' search right after ours is inserted, i.e. after our
// pre-check read the in-flight total but before our re-check.
function withRacer(): D1Database {
  return new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => {
      const st = t.prepare(sql);
      if (!sql.startsWith("INSERT INTO searches")) return st;
      return { bind: (...a: unknown[]) => { const b = st.bind(...a); return { run: async () => { const r = await b.run(); await running(); return r; } }; } };
    };
    const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v;
  } }) as D1Database;
}

describe("spend re-check after insert", () => {
  it("alone: a search that fits starts, counting its own estimate exactly once", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: EST }); // exactly one search fits
    const calls: string[] = [];
    const r = await startSearchRun({ db: env.DB, startWorkflow: async (id) => { calls.push(id); } }, INPUT);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a competing running search inserted before the re-check fails this one with the 402 shape and starts nothing", async () => {
    const calls: string[] = [];
    const r = await startSearchRun({ db: withRacer(), startWorkflow: async (id) => { calls.push(id); } }, INPUT);
    expect(r).toMatchObject({ ok: false, kind: "spend", spend: { ok: false, spent: 0, limit: EST * 1.5 } });
    expect(calls).toEqual([]);
    const mine = (await env.DB.prepare(`SELECT status, error FROM searches WHERE location = 'Boise'`).all<any>()).results;
    expect(mine).toEqual([{ status: "failed", error: "spend limit" }]);
  });
});

describe("newOnly pass-through", () => {
  const newOnlyRows = async () => (await env.DB.prepare(`SELECT new_only FROM searches WHERE location = 'Boise'`).all<{ new_only: number }>()).results.map((r) => r.new_only);

  it("startSearchRun stores new_only 1 only when asked; the default is 0", async () => {
    // Each started search stays 'running' and would count as in flight; finish it so the next one fits the limit.
    const start = async () => { await env.DB.prepare(`UPDATE searches SET status = 'done'`).run(); };
    expect((await startSearchRun({ db: env.DB, startWorkflow: start }, INPUT)).ok).toBe(true);
    expect((await startSearchRun({ db: env.DB, startWorkflow: start }, INPUT, { newOnly: false })).ok).toBe(true);
    const r = await startSearchRun({ db: env.DB, startWorkflow: start }, INPUT, { newOnly: true });
    expect(r.ok && r.search.new_only).toBe(1);
    expect(await newOnlyRows()).toEqual([0, 0, 1]);
  });

  it.each([[false], [true]])("guards, estimate and 402 are identical with newOnly %s", async (newOnly) => {
    await running(); // one in-flight search at the full estimate: the next one no longer fits
    const calls: string[] = [];
    const r = await startSearchRun({ db: env.DB, startWorkflow: async (id) => { calls.push(id); } }, INPUT, { newOnly });
    expect(r).toMatchObject({ ok: false, kind: "spend", spend: { ok: false, spent: 0, limit: EST * 1.5 } });
    expect(calls).toEqual([]);
    expect(await newOnlyRows()).toEqual([]); // rejected by the pre-check: nothing inserted
    expect(await startSearchRun({ db: env.DB, startWorkflow: async () => {} }, { ...INPUT, location: "" }, { newOnly })).toMatchObject({ ok: false, kind: "invalid" });
    await saveSettings(env.DB, { physical_address: "", opt_out_line: "" });
    expect(await startSearchRun({ db: env.DB, startWorkflow: async () => {} }, INPUT, { newOnly })).toMatchObject({ ok: false, kind: "compliance" });
    await saveSettings(env.DB, { physical_address: "1 Main St", opt_out_line: "Reply no." });
  });

  it.each([[false], [true]])("the post-insert recheck still fails the search with newOnly %s", async (newOnly) => {
    const r = await startSearchRun({ db: withRacer(), startWorkflow: async () => {} }, INPUT, { newOnly });
    expect(r).toMatchObject({ ok: false, kind: "spend" });
    expect((await env.DB.prepare(`SELECT status, error, new_only FROM searches WHERE location = 'Boise'`).all<any>()).results)
      .toEqual([{ status: "failed", error: "spend limit", new_only: newOnly ? 1 : 0 }]);
  });
});
