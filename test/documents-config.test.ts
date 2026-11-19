import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getSettings } from "../src/worker/db/settings";
import { DEFAULT_DOCUMENTS_CONFIG, DocumentsConfigSchema, legalGate, parseDocumentsConfig } from "../src/worker/documents/config";

describe("documents config", () => {
  it("empty settings parse to the defaults", () => {
    expect(DEFAULT_DOCUMENTS_CONFIG).toEqual({ legalReviewedAt: null, legalReviewer: "", lateFeePercentMonthly: 1.5, expiryDays: 30 });
    expect(parseDocumentsConfig("")).toEqual(DEFAULT_DOCUMENTS_CONFIG);
    expect(parseDocumentsConfig("{}")).toEqual(DEFAULT_DOCUMENTS_CONFIG);
    expect(parseDocumentsConfig("not json")).toEqual(DEFAULT_DOCUMENTS_CONFIG);
    expect(parseDocumentsConfig(JSON.stringify({ expiryDays: 45 })).expiryDays).toBe(45);
  });

  it("a review date without a reviewer is rejected", () => {
    const bad = { ...DEFAULT_DOCUMENTS_CONFIG, legalReviewedAt: "2026-12-01T00:00:00.000Z", legalReviewer: "" };
    expect(DocumentsConfigSchema.safeParse(bad).success).toBe(false);
    expect(DocumentsConfigSchema.safeParse({ ...bad, legalReviewer: "   " }).success).toBe(false);
    expect(DocumentsConfigSchema.safeParse({ ...bad, legalReviewer: "A. Lawyer, Portland OR" }).success).toBe(true);
    expect(DocumentsConfigSchema.safeParse({ ...bad, legalReviewer: "x".repeat(121) }).success).toBe(false);
    expect(DocumentsConfigSchema.safeParse({ ...bad, legalReviewedAt: "yesterday", legalReviewer: "A" }).success).toBe(false);
  });

  it("legalGate refuses until a review is recorded", () => {
    expect(legalGate(DEFAULT_DOCUMENTS_CONFIG)).toMatch(/lawyer/i);
    expect(legalGate(parseDocumentsConfig(""))).not.toBeNull();
  });

  it("legalGate passes once reviewed", () => {
    expect(legalGate({ ...DEFAULT_DOCUMENTS_CONFIG, legalReviewedAt: "2026-12-01T00:00:00.000Z", legalReviewer: "A. Lawyer" })).toBeNull();
  });

  it("expiryDays outside 7-90 is rejected", () => {
    const with_ = (o: object) => DocumentsConfigSchema.safeParse({ ...DEFAULT_DOCUMENTS_CONFIG, ...o }).success;
    expect(with_({ expiryDays: 6 })).toBe(false); expect(with_({ expiryDays: 7 })).toBe(true);
    expect(with_({ expiryDays: 90 })).toBe(true); expect(with_({ expiryDays: 91 })).toBe(false);
    expect(with_({ expiryDays: 30.5 })).toBe(false);
    expect(with_({ lateFeePercentMonthly: -0.1 })).toBe(false); expect(with_({ lateFeePercentMonthly: 0 })).toBe(true);
    expect(with_({ lateFeePercentMonthly: 10 })).toBe(true); expect(with_({ lateFeePercentMonthly: 10.5 })).toBe(false);
  });
});

describe("PUT /api/settings documents_config", () => {
  let cookie = "";
  const put = (body: unknown) => SELF.fetch("https://x/api/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });

  it("starts empty, stores a valid document, and reads it back", async () => {
    expect((await getSettings(env.DB)).documents_config).toBe("{}");
    const cfg = { ...DEFAULT_DOCUMENTS_CONFIG, legalReviewedAt: "2026-12-01T00:00:00.000Z", legalReviewer: "A. Lawyer", expiryDays: 45 };
    expect((await put({ documents_config: JSON.stringify(cfg) })).status).toBe(200);
    expect(parseDocumentsConfig((await getSettings(env.DB)).documents_config)).toEqual(cfg);
    expect((await put({ documents_config: "{}" })).status).toBe(200);
    expect(parseDocumentsConfig((await getSettings(env.DB)).documents_config)).toEqual(DEFAULT_DOCUMENTS_CONFIG);
  });

  it("rejects an invalid document with a 400 and the reason, and keeps what was saved", async () => {
    const before = (await getSettings(env.DB)).documents_config;
    const r = await put({ documents_config: JSON.stringify({ ...DEFAULT_DOCUMENTS_CONFIG, legalReviewedAt: "2026-12-01T00:00:00.000Z" }) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Name who reviewed the clauses", fields: ["documents_config"] });
    expect((await put({ documents_config: JSON.stringify({ expiryDays: 3 }) })).status).toBe(400);
    expect((await put({ documents_config: "not json" })).status).toBe(400);
    expect((await put({ documents_config: "[]" })).status).toBe(400);
    expect((await getSettings(env.DB)).documents_config).toBe(before);
  });
});
