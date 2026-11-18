import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { recordUsage } from "../src/worker/db/usage";
import { setFixedCostActive } from "../src/worker/db/fixedCosts";
import { allowOptionalJob, serviceSpend } from "../src/worker/spend";
import { runDueRadars } from "../src/worker/radar-run";
import { levelWord, parseCapInput, serviceCapLine, serviceLabel } from "../src/client/spendView";

// Read before any test clears the table, so it shows what the migration seeded.
const seeded = (await env.DB.prepare(`SELECT service, monthly_usd FROM spend_caps ORDER BY service`).all<{ service: string; monthly_usd: number }>()).results;

const NOW = new Date();
let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const setCap = (service: string, usd: number) =>
  env.DB.prepare(`INSERT OR REPLACE INTO spend_caps (service, monthly_usd) VALUES (?, ?)`).bind(service, usd).run();

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM usage`), env.DB.prepare(`DELETE FROM radars`), env.DB.prepare(`DELETE FROM searches`),
    env.DB.prepare(`DELETE FROM spend_caps`),
  ]);
  await saveSettings(env.DB, { monthly_spend_limit_usd: 150, physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks'." });
  await setFixedCostActive(env.DB, "google-workspace", false);
});

const addDueRadar = () =>
  env.DB.prepare(
    `INSERT INTO radars (id, location, business_type, radius_km, max_results, interval_days, enabled, next_run_at, created_at) VALUES ('r1','Boise, ID','plumber',15,50,30,1,?,?)`,
  ).bind(new Date(NOW.getTime() - 86400000).toISOString(), new Date(NOW.getTime() - 86400000 * 50).toISOString()).run();

describe("spend_caps table", () => {
  it("is seeded with brightdata and places at 15", () => {
    expect(seeded).toEqual([{ service: "brightdata", monthly_usd: 15 }, { service: "places", monthly_usd: 15 }]);
  });
  it("rejects a negative cap", async () => {
    await expect(setCap("places", -1)).rejects.toThrow();
  });
});

describe("serviceSpend", () => {
  it("service at 80% is warn, over is capped, below is ok", async () => {
    await setCap("brightdata", 10); await setCap("places", 10); await setCap("pagespeed", 10);
    await recordUsage(env.DB, "brightdata", 1, 8);
    await recordUsage(env.DB, "places", 1, 10.01);
    await recordUsage(env.DB, "pagespeed", 1, 7.9);
    const rows = await serviceSpend(env.DB, NOW);
    const by = Object.fromEntries(rows.map((r) => [r.service, r]));
    expect(by.brightdata).toMatchObject({ spentUsd: 8, capUsd: 10, level: "warn" });
    expect(by.places.level).toBe("capped");
    expect(by.pagespeed.level).toBe("ok");
  });

  it("exactly at the cap is warn, not capped (same boundary as the total)", async () => {
    await setCap("brightdata", 10);
    await recordUsage(env.DB, "brightdata", 1, 10);
    expect((await serviceSpend(env.DB, NOW))[0].level).toBe("warn");
  });

  it("service without a cap is never capped", async () => {
    await recordUsage(env.DB, "claude", 1, 500);
    const rows = await serviceSpend(env.DB, NOW);
    expect(rows).toEqual([{ service: "claude", spentUsd: 500, capUsd: null, level: "ok" }]);
  });

  it("lists the union of used and capped services, sorted by name", async () => {
    await setCap("places", 15);
    await recordUsage(env.DB, "pagespeed", 1, 1);
    await recordUsage(env.DB, "brightdata", 2, 3);
    const rows = await serviceSpend(env.DB, NOW);
    expect(rows.map((r) => r.service)).toEqual(["brightdata", "pagespeed", "places"]);
    expect(rows.find((r) => r.service === "places")).toMatchObject({ spentUsd: 0, capUsd: 15, level: "ok" });
  });

  it("a cap of 0 is capped only once something is spent", async () => {
    await setCap("places", 0);
    expect((await serviceSpend(env.DB, NOW))[0]).toMatchObject({ capUsd: 0, level: "ok" });
    await recordUsage(env.DB, "places", 1, 0.01);
    expect((await serviceSpend(env.DB, NOW))[0].level).toBe("capped");
  });

  it("only counts the current UTC month", async () => {
    await setCap("brightdata", 10);
    await env.DB.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES ('old','2020-01','brightdata',1,99,'2020-01-05T00:00:00Z')`).run();
    expect((await serviceSpend(env.DB, NOW))[0]).toMatchObject({ spentUsd: 0, level: "ok" });
  });
});

describe("allowOptionalJob with services", () => {
  it("without services ignores sub-caps", async () => {
    await setCap("brightdata", 1);
    await recordUsage(env.DB, "brightdata", 1, 5);
    expect(await allowOptionalJob(env.DB, NOW)).toBe(true);
    expect(await allowOptionalJob(env.DB, NOW, [])).toBe(true);
  });

  it("false when a listed service is capped, true when only an unlisted one is", async () => {
    await setCap("brightdata", 1); await setCap("pagespeed", 1);
    await recordUsage(env.DB, "brightdata", 1, 5);
    expect(await allowOptionalJob(env.DB, NOW, ["places", "brightdata"])).toBe(false);
    expect(await allowOptionalJob(env.DB, NOW, ["places", "pagespeed"])).toBe(true);
  });

  it("still false when the total is capped, whatever the services", async () => {
    await recordUsage(env.DB, "claude_agent", 1, 144);
    expect(await allowOptionalJob(env.DB, NOW, ["places"])).toBe(false);
  });
});

describe("radar runs and sub-caps", () => {
  it("service over its cap pauses optional radar runs with skipped \"spend_cap\" even when the total is fine", async () => {
    await setCap("brightdata", 5);
    await recordUsage(env.DB, "brightdata", 1, 6);
    await addDueRadar();
    const logs: string[] = [];
    const orig = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    const started: string[] = [];
    let r;
    try { r = await runDueRadars({ db: env.DB, now: () => NOW, startWorkflow: async (id) => { started.push(id); } }); } finally { console.log = orig; }
    expect(r.skipped).toBe("spend_cap");
    expect(started).toHaveLength(0);
    expect(logs.some((l) => l.includes("brightdata"))).toBe(true);
    // the radar was not claimed: it is still due
    expect((await env.DB.prepare(`SELECT next_run_at FROM radars WHERE id='r1'`).first<{ next_run_at: string }>())!.next_run_at < NOW.toISOString()).toBe(true);
  });

  it("a sub-capped service that radars do not use does not pause them", async () => {
    await setCap("pagespeed", 1);
    await recordUsage(env.DB, "pagespeed", 1, 5);
    await addDueRadar();
    const r = await runDueRadars({ db: env.DB, now: () => NOW, startWorkflow: async () => {} });
    expect(r.skipped).not.toBe("spend_cap");
  });
});

describe("spend routes", () => {
  it("GET spend includes services", async () => {
    await setCap("brightdata", 15);
    await recordUsage(env.DB, "brightdata", 1, 12);
    const body = await (await api("/api/spend")).json<any>();
    expect(body.services).toEqual([{ service: "brightdata", spentUsd: 12, capUsd: 15, level: "warn" }]);
  });

  it("PUT caps validates and removes with null", async () => {
    const put = (service: string, body: unknown) => api(`/api/spend/caps/${service}`, { method: "PUT", body: JSON.stringify(body) });
    const ok = await put("places", { monthlyUsd: 20 });
    expect(ok.status).toBe(200);
    expect((await ok.json<any>()).services).toEqual([{ service: "places", spentUsd: 0, capUsd: 20, level: "ok" }]);
    // update in place
    expect((await (await put("places", { monthlyUsd: 0 })).json<any>()).services[0].capUsd).toBe(0);

    for (const bad of [{ monthlyUsd: -1 }, { monthlyUsd: 1001 }, { monthlyUsd: "5" }, {}]) {
      const r = await put("places", bad);
      expect(r.status).toBe(400);
      expect((await r.json<any>()).fields).toBeTruthy();
    }
    expect((await put("nope", { monthlyUsd: 5 })).status).toBe(400);
    expect((await put("places", { monthlyUsd: 1000 })).status).toBe(200);

    const del = await put("places", { monthlyUsd: null });
    expect(del.status).toBe(200);
    expect((await del.json<any>()).services).toEqual([]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM spend_caps`).first<{ n: number }>())!.n).toBe(0);
  });

  it("PUT caps requires auth", async () => {
    const r = await SELF.fetch("https://x/api/spend/caps/places", { method: "PUT", body: JSON.stringify({ monthlyUsd: 5 }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
  });
});

describe("serviceCapLine", () => {
  it("shows spent of cap with whole dollars", () => {
    expect(serviceCapLine({ service: "Bright Data", spentUsd: 11.6, capUsd: 15 })).toBe("Bright Data: $12 of $15");
    expect(serviceCapLine({ service: "places", spentUsd: 0, capUsd: 0 })).toBe("places: $0 of $0");
  });
  it("says no cap when there is none", () => {
    expect(serviceCapLine({ service: "claude", spentUsd: 3.2, capUsd: null })).toBe("claude: $3, no cap");
  });
});

describe("cap view helpers", () => {
  it("labels services and passes unknown keys through", () => {
    expect(serviceLabel("brightdata")).toBe("Bright Data");
    expect(serviceLabel("places")).toBe("Google Places");
    expect(serviceLabel("pagespeed")).toBe("PageSpeed");
    expect(serviceLabel("browser")).toBe("Browser rendering");
    for (const s of ["claude", "claude_cro", "claude_agent"]) expect(serviceLabel(s)).toBe("Claude (subscription)");
    expect(serviceLabel("mystery")).toBe("mystery");
  });
  it("parses the cap box: blank removes, a number sets, junk is an error", () => {
    expect(parseCapInput("  ")).toEqual({ ok: true, value: null });
    expect(parseCapInput("12.5")).toEqual({ ok: true, value: 12.5 });
    expect(parseCapInput("$0")).toEqual({ ok: true, value: 0 });
    for (const bad of ["-1", "1001", "abc", "1e999"]) expect(parseCapInput(bad).ok).toBe(false);
  });
  it("describes levels in words", () => {
    expect([levelWord("ok"), levelWord("warn"), levelWord("capped")]).toEqual(["OK", "Near cap", "Paused"]);
  });
});
