import { describe, expect, it } from "vitest";
import { parseSpendLimit } from "../src/client/spend";

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
