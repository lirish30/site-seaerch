import { describe, expect, it } from "vitest";
import { lostNumbers, nonFinitePaths } from "./fixtures/numbers";

// The helpers the money tests lean on must really see what a regex over JSON text cannot: JSON.stringify writes NaN and Infinity as null.
describe("number helpers", () => {
  it("finds a NaN or Infinity anywhere in an object, and says where", () => {
    expect(nonFinitePaths({ a: 1, b: [2, { c: NaN }], d: { e: Infinity, f: -Infinity } })).toEqual(["$.b[1].c = NaN", "$.d.e = Infinity", "$.d.f = -Infinity"]);
    expect(nonFinitePaths({ a: 0, b: [null, "x", true], c: { d: -3.5 } })).toEqual([]);
  });

  it("shows that JSON hides a NaN, and that comparing with the original does not", () => {
    const original = { pct: NaN, cents: 5, rows: [{ n: Infinity }], missing: null };
    expect(JSON.stringify(original)).not.toMatch(/NaN|Infinity/); // the vacuous check
    const parsed = JSON.parse(JSON.stringify(original));
    expect(lostNumbers(parsed, original)).toEqual(["$.pct: expected a finite number, got null", "$.rows[0].n: expected a finite number, got null"]);
    expect(lostNumbers(parsed, { cents: 5, missing: null })).toEqual([]);
  });
});
