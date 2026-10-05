import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import { FULL_SCAN_ADDS, fullScanErrorText, fullScanLabel, parseMinFit, promisingPath } from "../src/client/promising";

describe("parseMinFit", () => {
  it("empty means no filter", () => {
    expect(parseMinFit("")).toEqual({ ok: true, value: null });
    expect(parseMinFit("  ")).toEqual({ ok: true, value: null });
  });
  it("accepts 0 to 100 and rounds", () => {
    expect(parseMinFit("0")).toEqual({ ok: true, value: 0 });
    expect(parseMinFit("50")).toEqual({ ok: true, value: 50 });
    expect(parseMinFit("100")).toEqual({ ok: true, value: 100 });
    expect(parseMinFit("49.6")).toEqual({ ok: true, value: 50 });
  });
  it("rejects out-of-range and non-numeric text with a readable message", () => {
    for (const bad of ["-1", "101", "abc", "1e999"]) expect(parseMinFit(bad)).toMatchObject({ ok: false, error: expect.stringMatching(/0 to 100/) });
  });
});

describe("promising helpers", () => {
  it("builds the queue path", () => {
    expect(promisingPath(null)).toBe("/leads/promising");
    expect(promisingPath(0)).toBe("/leads/promising?minFit=0");
    expect(promisingPath(60)).toBe("/leads/promising?minFit=60");
  });
  it("shows the API's message for a failed scan, else a generic one", () => {
    expect(fullScanErrorText(new ApiError(502, "workflow unavailable"))).toBe("workflow unavailable");
    expect(fullScanErrorText(new Error("network"))).toBe("Couldn't start the full scan.");
  });
  it("words a spend-limit 402 readably instead of showing the raw API error", () => {
    expect(fullScanErrorText(new ApiError(402, "spend limit"))).toBe("Monthly spend limit reached \u2014 raise it in Settings or wait until next month.");
  });
  it("names each button and says what a full scan adds", () => {
    expect(fullScanLabel("Ace")).toBe("Run full scan for Ace");
    expect(FULL_SCAN_ADDS).toMatch(/screenshots.*pagespeed.*review.*draft/i);
  });
});
