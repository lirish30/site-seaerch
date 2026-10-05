import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { estimateSearchCost } from "../src/worker/cost";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const EST = estimateSearchCost(50);
let orig: any;

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM searches`), env.DB.prepare(`DELETE FROM usage`)]);
  await saveSettings(env.DB, { physical_address: "1 Main St", opt_out_line: "Reply no.", monthly_spend_limit_usd: EST * 1.5 });
  orig = env.SEARCH_WORKFLOW.create;
  (env.SEARCH_WORKFLOW as any).create = async () => ({}) as any;
});
afterEach(() => { (env.SEARCH_WORKFLOW as any).create = orig; });

const estimate = () => api("/api/searches/estimate?maxResults=50").then((r) => r.json<any>());
const start = () => api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "plumber", maxResults: 50 }) });

describe("GET /api/searches/estimate agrees with the POST guard", () => {
  it("nothing in flight: ok, inFlightUsd 0, existing keys unchanged, and POST succeeds", async () => {
    expect(await estimate()).toEqual({ estUsd: EST, inFlightUsd: 0, ok: true, spent: 0, limit: EST * 1.5 });
    expect((await start()).status).toBe(201);
  });

  it("a running search is reported and flips ok, exactly when POST would answer 402", async () => {
    await createSearch(env.DB, { location: "Other", businessType: "roofer", radiusKm: 15, maxResults: 50 });
    const e = await estimate();
    expect(e).toMatchObject({ ok: false, spent: 0, inFlightUsd: EST });
    expect((await start()).status).toBe(402);
  });
});
