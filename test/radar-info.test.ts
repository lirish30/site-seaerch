import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import wrangler from "../wrangler.jsonc?raw";
import { saveSettings } from "../src/worker/db/settings";
import { MAX_RADARS } from "../src/worker/db/radar";
import { DEFAULT_MAX_PER_RUN, RADAR_CHECK_UTC } from "../src/worker/radar-run";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const patch = (path: string, body: unknown) => api(path, { method: "PATCH", body: JSON.stringify(body) });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM radars`), env.DB.prepare(`DELETE FROM searches`), env.DB.prepare(`DELETE FROM usage`)]);
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks'.", monthly_spend_limit_usd: 150 });
});

describe("GET /api/radar/info", () => {
  it("needs a login", async () => expect((await SELF.fetch("https://x/api/radar/info")).status).toBe(401));

  it("states the radar limit, the daily start cap, the check time and the monthly spend limit", async () => {
    const r = await api("/api/radar/info");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ maxRadars: MAX_RADARS, maxPerDay: DEFAULT_MAX_PER_RUN, checkAtUtc: { hour: 13, minute: 17 }, monthlyLimitUsd: 150 });
  });

  it("reports the check time the cron trigger actually fires at", () => {
    const m = /"crons"\s*:\s*\[\s*"(\d+) (\d+) \* \* \*"/.exec(wrangler);
    expect(m).not.toBeNull();
    expect({ hour: Number(m![2]), minute: Number(m![1]) }).toEqual(RADAR_CHECK_UTC);
  });
});

describe("PATCH /api/radar/:id with search settings", () => {
  const make = async () => (await (await api("/api/radar", { method: "POST", body: JSON.stringify({ location: "Boise, ID", businessType: "plumber" }) })).json()) as any;

  it("changes max results and radius without touching the schedule or enabled flag", async () => {
    const r = await make();
    const p = await (await patch(`/api/radar/${r.id}`, { maxResults: 100, radiusKm: 30 })).json<any>();
    expect(p).toMatchObject({ max_results: 100, radius_km: 30, interval_days: 30, enabled: 1, next_run_at: r.next_run_at });
  });

  it("validates the ranges", async () => {
    const r = await make();
    for (const b of [{ maxResults: 0 }, { maxResults: 201 }, { maxResults: 1.5 }, { radiusKm: 0 }, { radiusKm: 101 }]) expect((await patch(`/api/radar/${r.id}`, b)).status, JSON.stringify(b)).toBe(400);
  });
});
