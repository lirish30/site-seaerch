import { describe, expect, it } from "vitest";
import { BillingConfigSchema, DEFAULT_BILLING_CONFIG, parseBillingConfig } from "../src/worker/billing/config";

describe("billing config", () => {
  it("defaults when empty or invalid", () => {
    expect(DEFAULT_BILLING_CONFIG).toEqual({ netDays: 7, reminderOffsets: [-3, 0, 3, 7], pauseAfterDays: 14, termNoticeDays: 30 });
    expect(parseBillingConfig("")).toEqual(DEFAULT_BILLING_CONFIG);
    expect(parseBillingConfig("{}")).toEqual(DEFAULT_BILLING_CONFIG);
    expect(parseBillingConfig("not json")).toEqual(DEFAULT_BILLING_CONFIG);
    expect(parseBillingConfig(JSON.stringify({ netDays: 0 }))).toEqual(DEFAULT_BILLING_CONFIG);
    expect(parseBillingConfig(JSON.stringify({ netDays: 14 }))).toEqual({ ...DEFAULT_BILLING_CONFIG, netDays: 14 });
  });

  it("offsets must increase and the hold must come after the last one", () => {
    const ok = { netDays: 7, reminderOffsets: [-3, 0, 3, 7], pauseAfterDays: 14, termNoticeDays: 30 };
    expect(BillingConfigSchema.safeParse(ok).success).toBe(true);
    expect(BillingConfigSchema.safeParse({ ...ok, reminderOffsets: [0, 0, 3] }).success).toBe(false);
    expect(BillingConfigSchema.safeParse({ ...ok, reminderOffsets: [3, 0] }).success).toBe(false);
    expect(BillingConfigSchema.safeParse({ ...ok, reminderOffsets: [] }).success).toBe(false);
    expect(BillingConfigSchema.safeParse({ ...ok, reminderOffsets: [-31, 0] }).success).toBe(false);
    expect(BillingConfigSchema.safeParse({ ...ok, reminderOffsets: [0, 1, 2, 3, 4, 5, 6] }).success).toBe(false);
    expect(BillingConfigSchema.safeParse({ ...ok, reminderOffsets: [0, 1.5] }).success).toBe(false);
    expect(BillingConfigSchema.safeParse({ ...ok, pauseAfterDays: 7 }).success).toBe(false); // not after the last offset (7)
    expect(BillingConfigSchema.safeParse({ ...ok, pauseAfterDays: 8 }).success).toBe(true);
    expect(BillingConfigSchema.safeParse({ ...ok, pauseAfterDays: 6 }).success).toBe(false); // below the 7-day minimum
    expect(BillingConfigSchema.safeParse({ ...ok, termNoticeDays: 6 }).success).toBe(false);
    expect(BillingConfigSchema.safeParse({ ...ok, termNoticeDays: 91 }).success).toBe(false);
    // A stored document whose hold sits before its last reminder is not trusted: the defaults come back.
    expect(parseBillingConfig(JSON.stringify({ reminderOffsets: [0, 20], pauseAfterDays: 10 }))).toEqual(DEFAULT_BILLING_CONFIG);
  });
});
