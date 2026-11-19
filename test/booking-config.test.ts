import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getSettings } from "../src/worker/db/settings";
import { BookingConfigSchema, DEFAULT_CONFIG, DURATION_MIN, parseConfig } from "../src/worker/booking/config";

describe("booking config", () => {
  it("the defaults are valid and the calls are 20 and 30 minutes", () => {
    expect(BookingConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
    expect(DURATION_MIN).toEqual({ discovery: 20, recommendation: 30 });
    expect(DEFAULT_CONFIG.windows).toEqual([]);
    expect(DEFAULT_CONFIG.budgetOptions.map((b) => b.minCents)).toEqual([79700, 200000, 500000]);
  });

  it("lowest budget option below the minimum engagement is rejected", () => {
    const r = BookingConfigSchema.safeParse({ ...DEFAULT_CONFIG, budgetOptions: [{ id: "low", label: "Under $500", minCents: 50000 }, ...DEFAULT_CONFIG.budgetOptions] });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain("The lowest budget option must be at least the minimum engagement");
    // At the minimum is fine, whatever order the options are listed in.
    expect(BookingConfigSchema.safeParse({ ...DEFAULT_CONFIG, budgetOptions: [...DEFAULT_CONFIG.budgetOptions].reverse() }).success).toBe(true);
  });

  it("a window that ends before it starts is rejected", () => {
    const bad = { ...DEFAULT_CONFIG, windows: [{ weekday: 2, start: "17:00", end: "09:00" }] };
    expect(BookingConfigSchema.safeParse(bad).success).toBe(false);
    expect(BookingConfigSchema.safeParse({ ...DEFAULT_CONFIG, windows: [{ weekday: 2, start: "09:00", end: "09:00" }] }).success).toBe(false);
    expect(BookingConfigSchema.safeParse({ ...DEFAULT_CONFIG, windows: [{ weekday: 2, start: "09:00", end: "17:00" }] }).success).toBe(true);
  });

  it("holds the numeric limits and a real time zone", () => {
    const with_ = (o: object) => BookingConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...o }).success;
    expect(with_({ minNoticeHours: 0 })).toBe(false); expect(with_({ minNoticeHours: 169 })).toBe(false); expect(with_({ minNoticeHours: 168 })).toBe(true);
    expect(with_({ horizonDays: 0 })).toBe(false); expect(with_({ horizonDays: 61 })).toBe(false); expect(with_({ horizonDays: 60 })).toBe(true);
    expect(with_({ bufferMin: -1 })).toBe(false); expect(with_({ bufferMin: 61 })).toBe(false); expect(with_({ bufferMin: 0 })).toBe(true);
    expect(with_({ slotStepMin: 25 })).toBe(false); expect(with_({ slotStepMin: 30 })).toBe(true);
    expect(with_({ budgetOptions: [] })).toBe(false);
    expect(with_({ timezone: "Nowhere/Land" })).toBe(false);
    expect(with_({ windows: [{ weekday: 7, start: "09:00", end: "10:00" }] })).toBe(false);
    expect(with_({ windows: [{ weekday: 1, start: "9:00", end: "10:00" }] })).toBe(false);
  });

  it("empty settings parse to the defaults", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("{}")).toEqual(DEFAULT_CONFIG);
  });

  it("a saved document is read back, and one that no longer validates falls back to no windows", () => {
    const saved = { ...DEFAULT_CONFIG, windows: [{ weekday: 2 as const, start: "09:00", end: "11:00" }], bufferMin: 15 };
    expect(parseConfig(JSON.stringify(saved))).toEqual(saved);
    expect(parseConfig(JSON.stringify({ windows: [{ weekday: 2, start: "09:00", end: "11:00" }] })).windows).toHaveLength(1);
    expect(parseConfig("not json")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(JSON.stringify({ bufferMin: 500 }))).toEqual(DEFAULT_CONFIG);
  });
});

describe("PUT /api/settings booking_config", () => {
  let cookie = "";
  const put = (body: unknown) => SELF.fetch("https://x/api/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });

  it("stores a valid document and reads it back as JSON text", async () => {
    expect((await getSettings(env.DB)).booking_config).toBe("{}");
    const cfg = { ...DEFAULT_CONFIG, windows: [{ weekday: 2, start: "09:00", end: "11:00" }] };
    expect((await put({ booking_config: JSON.stringify(cfg) })).status).toBe(200);
    expect(parseConfig((await getSettings(env.DB)).booking_config)).toEqual(cfg);
    expect((await put({ booking_config: "{}" })).status).toBe(200);
    expect(parseConfig((await getSettings(env.DB)).booking_config)).toEqual(DEFAULT_CONFIG);
  });

  it("rejects an invalid document with a 400 and the reason, and keeps what was saved", async () => {
    const before = (await getSettings(env.DB)).booking_config;
    const low = { ...DEFAULT_CONFIG, budgetOptions: [{ id: "a", label: "Cheap", minCents: 10000 }] };
    const r = await put({ booking_config: JSON.stringify(low) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "The lowest budget option must be at least the minimum engagement", fields: ["booking_config"] });
    const backwards = await put({ booking_config: JSON.stringify({ ...DEFAULT_CONFIG, windows: [{ weekday: 1, start: "12:00", end: "09:00" }] }) });
    expect(backwards.status).toBe(400);
    expect((await backwards.json<any>()).error).toBe("A window must end after it starts");
    expect((await put({ booking_config: "not json" })).status).toBe(400);
    expect((await put({ booking_config: "[]" })).status).toBe(400);
    expect((await getSettings(env.DB)).booking_config).toBe(before);
  });
});
