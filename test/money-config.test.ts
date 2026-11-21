import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MONEY_CONFIG, MoneyConfigSchema, parseMoneyConfig } from "../src/worker/money/config";
import { getSettings } from "../src/worker/db/settings";

describe("parseMoneyConfig", () => {
  it("gives the $5,000 default for an empty, {} or non-JSON value", () => {
    for (const raw of ["", "  ", "{}", "not json", "[]", "null"]) expect(parseMoneyConfig(raw)).toEqual({ freedomMrrCents: 500_000 });
  });

  it("reads a stored target", () => {
    expect(parseMoneyConfig(JSON.stringify({ freedomMrrCents: 750_000 }))).toEqual({ freedomMrrCents: 750_000 });
  });

  it("falls back to the default for a negative, fractional or out-of-range target", () => {
    for (const v of [-1, 1.5, 10_000_001, "5000", null]) expect(parseMoneyConfig(JSON.stringify({ freedomMrrCents: v }))).toEqual(DEFAULT_MONEY_CONFIG);
  });

  it("returns a fresh object each call, never the shared defaults", () => {
    const a = parseMoneyConfig("");
    a.freedomMrrCents = 1;
    expect(parseMoneyConfig("").freedomMrrCents).toBe(500_000);
    expect(DEFAULT_MONEY_CONFIG.freedomMrrCents).toBe(500_000);
    expect(parseMoneyConfig("")).not.toBe(DEFAULT_MONEY_CONFIG);
  });

  it("the schema bounds are whole cents from 0 to 10,000,000", () => {
    expect(MoneyConfigSchema.safeParse({ freedomMrrCents: 0 }).success).toBe(true);
    expect(MoneyConfigSchema.safeParse({ freedomMrrCents: 10_000_000 }).success).toBe(true);
    expect(MoneyConfigSchema.safeParse({ freedomMrrCents: -1 }).success).toBe(false);
    expect(MoneyConfigSchema.safeParse({ freedomMrrCents: 0.5 }).success).toBe(false);
  });
});

describe("PUT /api/settings money_config", () => {
  let cookie = "";
  const put = (body: unknown) => SELF.fetch("https://x/api/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });

  it("starts as the empty document, saves a valid one, and an empty value resets", async () => {
    expect((await getSettings(env.DB)).money_config).toBe("{}");
    expect((await put({ money_config: JSON.stringify({ freedomMrrCents: 750_000 }) })).status).toBe(200);
    expect(parseMoneyConfig((await getSettings(env.DB)).money_config)).toEqual({ freedomMrrCents: 750_000 });
    expect((await put({ money_config: "" })).status).toBe(200);
    expect((await getSettings(env.DB)).money_config).toBe("{}");
  });

  it("answers 400 with the schema's message and keeps what was saved", async () => {
    await put({ money_config: JSON.stringify({ freedomMrrCents: 600_000 }) });
    const before = (await getSettings(env.DB)).money_config;
    const neg = await put({ money_config: JSON.stringify({ freedomMrrCents: -1 }) });
    expect(neg.status).toBe(400);
    expect(await neg.json<any>()).toEqual({ error: "The freedom number cannot be negative", fields: ["money_config"] });
    const frac = await put({ money_config: JSON.stringify({ freedomMrrCents: 1.5 }) });
    expect(frac.status).toBe(400);
    expect((await frac.json<any>()).error).toBe("The freedom number must be whole cents");
    for (const bad of ["not json", "[]"]) expect((await put({ money_config: bad })).status).toBe(400);
    expect((await getSettings(env.DB)).money_config).toBe(before);
    await put({ money_config: "{}" });
  });
});
