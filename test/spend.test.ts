import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { recordUsage } from "../src/worker/db/usage";
import { setFixedCostActive } from "../src/worker/db/fixedCosts";
import { spendStatus, allowOptionalJob } from "../src/worker/spend";
import { runDueRadars } from "../src/worker/radar-run";

const NOW = new Date();
let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM usage`), env.DB.prepare(`DELETE FROM radars`), env.DB.prepare(`DELETE FROM searches`)]);
  await saveSettings(env.DB, { monthly_spend_limit_usd: 150, physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks'." });
  await setFixedCostActive(env.DB, "google-workspace", false);
});

describe("spend cap with fixed costs", () => {
  it("inactive fixed cost not counted", async () => {
    const s = await spendStatus(env.DB, NOW);
    expect(s.fixedUsd).toBe(7);
    expect(s.limitUsd).toBe(150);
    expect(s.level).toBe("ok");
  });

  it("warn at 80 percent", async () => {
    await recordUsage(env.DB, "claude", 1, 113);
    const s = await spendStatus(env.DB, NOW);
    expect(s.spentUsd).toBe(120);
    expect(s.level).toBe("warn");
    expect(s.ok).toBe(true);
  });

  it("capped month skips optional radar run", async () => {
    await recordUsage(env.DB, "claude_agent", 1, 144);
    expect(await allowOptionalJob(env.DB, NOW)).toBe(false);
    await env.DB.prepare(
      `INSERT INTO radars (id, location, business_type, radius_km, max_results, interval_days, enabled, next_run_at, created_at) VALUES ('r1','Boise, ID','plumber',15,50,30,1,?,?)`,
    ).bind(new Date(NOW.getTime() - 86400000).toISOString(), new Date(NOW.getTime() - 86400000 * 50).toISOString()).run();
    const started: string[] = [];
    const r = await runDueRadars({ db: env.DB, now: () => NOW, startWorkflow: async (id) => { started.push(id); } });
    expect(r.skipped).toBe("spend_cap");
    expect(started).toHaveLength(0);
  });

  it("extra pushes over cap", async () => {
    await recordUsage(env.DB, "claude", 1, 140);
    const s = await spendStatus(env.DB, NOW, 5);
    expect(s.level).toBe("capped");
    expect(s.ok).toBe(false);
  });

  it("GET /api/spend returns status and fixed costs; PATCH toggles one", async () => {
    const g = await api("/api/spend");
    expect(g.status).toBe(200);
    const body = await g.json<any>();
    expect(body.limitUsd).toBe(150);
    expect(body.fixedCosts).toHaveLength(3);
    const p = await api("/api/spend/fixed-costs/google-workspace", { method: "PATCH", body: JSON.stringify({ active: true }) });
    expect(p.status).toBe(200);
    expect((await (await api("/api/spend")).json<any>()).fixedUsd).toBe(21);
    expect((await api("/api/spend/fixed-costs/nope", { method: "PATCH", body: JSON.stringify({ active: true }) })).status).toBe(404);
    expect((await api("/api/spend/fixed-costs/domains", { method: "PATCH", body: JSON.stringify({ active: "x" }) })).status).toBe(400);
  });
});
