import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { CURRENCY, refuseCurrency } from "../src/worker/sales/currency";
import { PackageInputError, getPackage, listCurrentPackages, savePackage, snapshotOf } from "../src/worker/db/packages";

describe("package catalog", () => {
  it("seed has every spec row at version 1", async () => {
    const rows = await listCurrentPackages(env.DB);
    expect(rows.map((p) => p.key)).toEqual([
      "quick_fix", "starter_site", "growth_site", "website_subscription", "care", "care_plus", "care_fallback",
      "client_hosted_surcharge", "local_seo", "local_seo_growth", "reviews_addon", "hourly",
    ]);
    expect(rows.every((p) => p.version === 1 && p.active)).toBe(true);
    const by = Object.fromEntries(rows.map((p) => [p.key, p]));
    expect(by.quick_fix).toMatchObject({ kind: "one_time", priceCents: 79700, setupCents: 0, fromPrice: false });
    expect(by.starter_site).toMatchObject({ kind: "one_time", priceCents: 399700, fromPrice: true });
    expect(by.growth_site).toMatchObject({ priceCents: 699700, fromPrice: true });
    expect(by.website_subscription).toMatchObject({ kind: "subscription", priceCents: 29700, setupCents: 49700, termMonths: 24 });
    expect(by.care).toMatchObject({ kind: "monthly", priceCents: 12900, wordpressOnly: true, publicOffer: true });
    expect(by.care_plus).toMatchObject({ priceCents: 24900, wordpressOnly: true });
    expect(by.care_fallback).toMatchObject({ priceCents: 7900, publicOffer: false, wordpressOnly: false });
    expect(by.client_hosted_surcharge.priceCents).toBe(3000);
    expect(by.local_seo).toMatchObject({ priceCents: 79700, setupCents: 75000, termMonths: 6 });
    expect(by.local_seo_growth.priceCents).toBe(149700);
    expect(by.reviews_addon.priceCents).toBe(9900);
    expect(by.hourly).toMatchObject({ kind: "hourly", priceCents: 12500, altPriceCents: 9500 });
    expect(by.quick_fix.includes.length).toBeGreaterThan(0);
    expect(by.care.includes.join(" ")).toMatch(/weekly updates/i);
  });

  it("no seeded summary or inclusion carries a price: prices come from the price columns only", async () => {
    const rows = (await env.DB.prepare(`SELECT key, summary, includes FROM packages WHERE version = 1`).all<{ key: string; summary: string; includes: string }>()).results;
    expect(rows).toHaveLength(12);
    for (const r of rows) {
      const texts = [r.summary, ...(JSON.parse(r.includes) as string[])];
      expect(refuseCurrency(texts, new Set()), r.key).toBeNull();
      for (const t of texts) expect(t, `${r.key}: ${t}`).not.toMatch(CURRENCY);
    }
    expect(rows.find((r) => r.key === "care")!.summary).toBe("Keeps the site updated, backed up and watched.");
  });

  it("savePackage inserts version 2 and listCurrentPackages returns it", async () => {
    const saved = await savePackage(env.DB, "quick_fix", { priceCents: 89700, summary: "Top audit problems, fixed." });
    expect(saved).toMatchObject({ key: "quick_fix", version: 2, priceCents: 89700, summary: "Top audit problems, fixed." });
    const current = (await listCurrentPackages(env.DB)).find((p) => p.key === "quick_fix")!;
    expect(current.version).toBe(2);
    expect(current.priceCents).toBe(89700);
    expect(current.name).toBe("Quick Fix");
    const rows = await env.DB.prepare(`SELECT version FROM packages WHERE key = 'quick_fix' ORDER BY version`).all<{ version: number }>();
    expect(rows.results.map((r) => r.version)).toEqual([1, 2]);
  });

  it("getPackage with an old version still returns the old price", async () => {
    await savePackage(env.DB, "care", { priceCents: 13900 });
    expect((await getPackage(env.DB, "care", 1))?.priceCents).toBe(12900);
    expect((await getPackage(env.DB, "care"))?.priceCents).toBe(13900);
    expect(await getPackage(env.DB, "care", 99)).toBeNull();
    const snap = snapshotOf((await getPackage(env.DB, "care", 1))!);
    expect(snap).toEqual({ key: "care", version: 1, name: "Care", kind: "monthly", priceCents: 12900, setupCents: 0, termMonths: null, fromPrice: false });
  });

  it("savePackage rejects a negative or non-integer price", async () => {
    await expect(savePackage(env.DB, "care_plus", { priceCents: -1 })).rejects.toBeInstanceOf(PackageInputError);
    await expect(savePackage(env.DB, "care_plus", { priceCents: 249.5 })).rejects.toBeInstanceOf(PackageInputError);
    await expect(savePackage(env.DB, "care_plus", { setupCents: -5 })).rejects.toBeInstanceOf(PackageInputError);
    await expect(savePackage(env.DB, "care_plus", { termMonths: 0 })).rejects.toBeInstanceOf(PackageInputError);
    const v = await env.DB.prepare(`SELECT COUNT(*) AS n FROM packages WHERE key = 'care_plus'`).first<{ n: number }>();
    expect(v?.n).toBe(1);
  });
});
