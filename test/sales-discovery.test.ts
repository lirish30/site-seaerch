import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { BASE_PUSHBACKS, DISCOVERY_QUESTIONS, DISCOVERY_STRUCTURE, mergePrices } from "../src/worker/sales/discovery";
import { listCurrentPackages } from "../src/worker/db/packages";

describe("discovery constants", () => {
  it("there are exactly ten questions and four structure blocks summing to 20 minutes", () => {
    expect(DISCOVERY_QUESTIONS).toHaveLength(10);
    expect(DISCOVERY_QUESTIONS[0]).toBe("What services make you the most money, and which ones do you want more of?");
    expect(DISCOVERY_QUESTIONS[9]).toBe("What would stop you from moving ahead if the plan made sense?");
    expect(DISCOVERY_STRUCTURE).toHaveLength(4);
    expect(DISCOVERY_STRUCTURE.map((b) => [b.fromMin, b.toMin])).toEqual([[0, 3], [3, 13], [13, 17], [17, 20]]);
    // Contiguous and ending at 20: the blocks add up to the 20-minute call.
    expect(DISCOVERY_STRUCTURE.reduce((m, b) => m + (b.toMin - b.fromMin), 0)).toBe(20);
    expect(DISCOVERY_STRUCTURE.every((b, i) => i === 0 || b.fromMin === DISCOVERY_STRUCTURE[i - 1].toMin)).toBe(true);
  });

  it("the six pushbacks carry merge fields and no hard-coded price", () => {
    expect(BASE_PUSHBACKS).toHaveLength(6);
    const all = BASE_PUSHBACKS.map((p) => p.answer).join("\n");
    expect(all).toContain("{{quick_fix}}");
    expect(all).toContain("{{care}}");
    expect(all).not.toMatch(/\$\s?\d/);
  });
});

describe("mergePrices", () => {
  it("fills quick_fix and care from the catalog", async () => {
    const catalog = await listCurrentPackages(env.DB);
    expect(mergePrices("Quick Fix is {{quick_fix}} and Care is {{care}}.", catalog)).toBe("Quick Fix is $797 and Care is $129/mo.");
    expect(mergePrices("no fields here", catalog)).toBe("no fields here");
  });

  it("throws on an unknown package key", async () => {
    const catalog = await listCurrentPackages(env.DB);
    expect(() => mergePrices("It is {{platinum}}.", catalog)).toThrow(/platinum/);
    // A real key that the catalog handed in does not hold is unknown too.
    expect(() => mergePrices("{{care}}", catalog.filter((p) => p.key !== "care"))).toThrow(/care/);
  });
});
