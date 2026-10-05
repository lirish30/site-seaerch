import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { diffFindings, findingKey } from "../src/worker/audit/diff";
import { insertAudit, listAudits } from "../src/worker/db/audits";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import type { Finding } from "../src/worker/types";

const f = (code: string, evidence = code): Finding =>
  ({ code: code as Finding["code"], category: "technical", severity: "important", points: 5, evidence, recommendation: "", source: "rule" });

describe("diffFindings", () => {
  it("keys a finding on its code", () => expect(findingKey(f("no_https"))).toBe("no_https"));

  it("identical code sets are all unchanged", () => {
    const d = diffFindings([f("a"), f("b")], [f("a"), f("b")]);
    expect(d.added).toEqual([]);
    expect(d.resolved).toEqual([]);
    expect(d.unchanged.map((x) => x.code)).toEqual(["a", "b"]);
  });

  it("an empty prev makes everything added", () => {
    const d = diffFindings([], [f("a"), f("b")]);
    expect(d.added.map((x) => x.code)).toEqual(["a", "b"]);
    expect(d.resolved).toEqual([]);
    expect(d.unchanged).toEqual([]);
  });

  it("an empty next makes everything resolved", () => {
    const d = diffFindings([f("a"), f("b")], []);
    expect(d.resolved.map((x) => x.code)).toEqual(["a", "b"]);
    expect(d.added).toEqual([]);
    expect(d.unchanged).toEqual([]);
  });

  it("a vanished code is resolved and a new code is added", () => {
    const d = diffFindings([f("a"), f("b")], [f("b"), f("c")]);
    expect(d.resolved.map((x) => x.code)).toEqual(["a"]);
    expect(d.added.map((x) => x.code)).toEqual(["c"]);
    expect(d.unchanged.map((x) => x.code)).toEqual(["b"]);
  });

  it("matches by code, not position, and unchanged holds the next objects", () => {
    const next = [f("b", "new evidence"), f("a")];
    const d = diffFindings([f("a"), f("b", "old evidence")], next);
    expect(d.added).toEqual([]);
    expect(d.resolved).toEqual([]);
    expect(d.unchanged).toHaveLength(2);
    expect(d.unchanged[0]).toBe(next[0]);
    expect(d.unchanged[1]).toBe(next[1]);
  });
});

describe("listAudits", () => {
  it("returns newest first and respects limit", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Hist", category: null, address: null, phone: null, websiteUrl: "https://hist.com", mapsUrl: null, rating: null, reviewCount: null }, s.id);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: false, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
        https: true, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
        platform: null, seo_score: null, accessibility_score: null, mail_warning: null,
        score: i, offer: "care_plan", findings: [], raw_r2_key: null, health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
      await env.DB.prepare(`UPDATE audits SET created_at = ? WHERE id = ?`).bind(`2026-03-0${i + 1}T00:00:00.000Z`, a.id).run();
      ids.push(a.id);
    }
    expect((await listAudits(env.DB, b.id)).map((a) => a.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect((await listAudits(env.DB, b.id, 2)).map((a) => a.id)).toEqual([ids[2], ids[1]]);
    expect(await listAudits(env.DB, "no-such-business")).toEqual([]);
  });
});
