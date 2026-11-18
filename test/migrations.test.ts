import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
describe("migrations", () => {
  it("numbers from 0023 on are unique", () => {
    const nums = env.TEST_MIGRATIONS.map((m) => m.name.slice(0, 4)).filter((n) => Number(n) >= 23);
    expect(new Set(nums).size).toBe(nums.length);
  });
});
