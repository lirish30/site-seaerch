import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["billing_holds", "invoice_nudges", "invoices", "subscriptions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await resetProjectWork();
  await saveSettings(env.DB, { money_config: "{}" });
});

const get = (auth = true) => SELF.fetch("https://x/api/money", { headers: auth ? { cookie } : {} });

describe("GET /api/money", () => {
  it("is 401 without the owner session", async () => {
    expect((await get(false)).status).toBe(401);
  });

  it("returns the dashboard with a seeded client in it", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }], invoice: { cents: 100_000, dueOn: "2020-01-01" } });
    const r = await get();
    expect(r.status).toBe(200);
    const d = await r.json<any>();
    expect(d.mrr).toMatchObject({ cents: 12_900, subscriptions: 1 });
    expect(d.ar.openCents).toBe(100_000);
    expect(d.ar.oldest[0]).toMatchObject({ businessId: s.businessId, amountCents: 100_000 });
    expect(d.freedom).toMatchObject({ targetCents: 500_000, mrrCents: 12_900 });
    expect(d.revenue.months).toHaveLength(6);
  });
});
