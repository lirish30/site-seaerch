import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import { isSpendLimit, parseSpendLimit, SPEND_LIMIT_REACHED } from "../src/client/spend";

describe("parseSpendLimit", () => {
  it("accepts non-negative numbers up to 10000", () => {
    expect(parseSpendLimit("25")).toBe(25);
    expect(parseSpendLimit(" 12.5 ")).toBe(12.5);
    expect(parseSpendLimit("0")).toBe(0);
    expect(parseSpendLimit(40)).toBe(40);
  });
  it("rejects blank, negative, non-numeric and too-large values instead of saving 0", () => {
    for (const v of ["", "   ", "-1", "abc", "10001", "1e9"]) expect(parseSpendLimit(v)).toBeNull();
  });
});

describe("spend-limit refusal wording for per-lead scans", () => {
  it("recognises a 402 ApiError only", () => {
    expect(isSpendLimit(new ApiError(402, "spend limit"))).toBe(true);
    expect(isSpendLimit(new ApiError(502, "workflow unavailable"))).toBe(false);
    expect(isSpendLimit(new Error("spend limit"))).toBe(false);
  });
  it("says what to do about it", () => {
    expect(SPEND_LIMIT_REACHED).toBe("Monthly spend limit reached \u2014 raise it in Settings or wait until next month.");
  });
});
