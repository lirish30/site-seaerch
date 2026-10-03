import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { insertAudit, latestAudit } from "../src/worker/db/audits";
import { replaceContacts } from "../src/worker/db/contacts";
import { insertDraft } from "../src/worker/db/drafts";
import { saveSettings } from "../src/worker/db/settings";
import { REPORT_TTL_DAYS } from "../src/worker/db/reports";
import type { Finding } from "../src/worker/types";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const pub = (token: string) => SELF.fetch(`https://x/api/public/report/${token}`); // no cookie

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
  await saveSettings(env.DB, { your_name: "Logan Irish", business_name: "Irish Web", contact_email: "logan@irish.example", logo_url: "https://irish.example/logo.png",
    services_blurb: "SECRET-BLURB", signature: "SECRET-SIG", physical_address: "SECRET-SENDER-ADDR" });
});

const fnd = (code: Finding["code"], severity: Finding["severity"], points: number, evidence: string): Finding => ({ code, group: "basics", severity, points, evidence });
const FINDINGS = [
  fnd("no_title_or_meta", "low", 3, "Low one"), fnd("no_https", "high", 15, "High one"), fnd("slow_mobile", "medium", 8, "Medium one"),
  fnd("no_h1", "low", 2, "Low two"), fnd("slow_lcp", "high", 11, "High two"),
];
const wait = () => new Promise((r) => setTimeout(r, 5));

async function seedAudit(businessId: string, o: { findings?: Finding[]; partial?: boolean; score?: number } = {}) {
  await wait();
  return insertAudit(env.DB, { business_id: businessId, site_status: "ok", partial: o.partial ?? false, pagespeed_mobile: 31, lcp_ms: 4100, cls: 0.2, mobile_friendly: null,
    https: false, has_title: true, has_meta_description: true, has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0, platform: "wix",
    seo_score: 62, accessibility_score: 71, score: o.score ?? 8675, offer: "new_site", findings: o.findings ?? FINDINGS, raw_r2_key: "raw/SECRET-R2-KEY", mail_warning: "SECRET-MAIL-WARNING no mail records bounce" });
}

async function seedLead(name = "Ace Plumbing") {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const b = await upsertBusiness(env.DB, { placeId: `SECRET-PLACE-${crypto.randomUUID()}`, name, category: "SECRET-CATEGORY", address: "SECRET-ADDRESS 12 Elm", phone: "SECRET-555-0100",
    websiteUrl: "https://secret-site.example", mapsUrl: "https://maps.example/SECRET-MAPS", rating: 4.9, reviewCount: 4242 }, s.id);
  await env.DB.prepare(`UPDATE businesses SET notes = ? WHERE id = ?`).bind("SECRET-NOTES", b.id).run();
  const a = await seedAudit(b.id);
  const [c] = await replaceContacts(env.DB, b.id, [{ type: "email", value: "secret-owner@secret-site.example", source_url: null, person_name: "SECRET-PERSON", role: null, confidence: 0.7 }]);
  await insertDraft(env.DB, { business_id: b.id, audit_id: a.id, to_contact_id: c.id, recipient_reason: "SECRET-REASON", subject: "SECRET-SUBJECT", body: "SECRET-BODY", offer: "new_site", steering_note: null });
  return { b, a };
}

describe("report management API", () => {
  it("creates (201), reuses (200, same token) and creates a new one for a new audit", async () => {
    const { b, a } = await seedLead();
    const r1 = await api(`/api/leads/${b.id}/report`, { method: "POST" });
    expect(r1.status).toBe(201);
    const j1 = await r1.json<any>();
    expect(j1.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(j1.url).toBe(`/r/${j1.token}`);
    const days = (Date.parse(j1.expiresAt) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(REPORT_TTL_DAYS - 0.01); expect(days).toBeLessThanOrEqual(REPORT_TTL_DAYS);
    const row = await env.DB.prepare(`SELECT * FROM audit_reports WHERE token = ?`).bind(j1.token).first<any>();
    expect(row).toMatchObject({ business_id: b.id, audit_id: a.id, revoked: 0 });

    const r2 = await api(`/api/leads/${b.id}/report`, { method: "POST" });
    expect(r2.status).toBe(200);
    expect((await r2.json<any>()).token).toBe(j1.token);

    await seedAudit(b.id, { findings: [fnd("no_h1", "low", 2, "Newer")] });
    const r3 = await api(`/api/leads/${b.id}/report`, { method: "POST" });
    expect(r3.status).toBe(201);
    expect((await r3.json<any>()).token).not.toBe(j1.token);
    // GET reflects the latest audit's report only
    expect((await (await api(`/api/leads/${b.id}/report`)).json<any>()).report.token).not.toBe(j1.token);
  });

  it("does not reuse an expired report", async () => {
    const { b } = await seedLead();
    const j1 = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token = ?`).bind("2020-01-01T00:00:00.000Z", j1.token).run();
    const r = await api(`/api/leads/${b.id}/report`, { method: "POST" });
    expect(r.status).toBe(201);
    expect((await r.json<any>()).token).not.toBe(j1.token);
  });

  it("404s for unknown business or business without an audit", async () => {
    expect((await api(`/api/leads/nope/report`, { method: "POST" })).status).toBe(404);
    const s = await createSearch(env.DB, { location: "Boise", businessType: "x", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "NoAudit", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id);
    expect((await api(`/api/leads/${b.id}/report`, { method: "POST" })).status).toBe(404);
    expect((await (await api(`/api/leads/${b.id}/report`)).json<any>())).toEqual({ report: null, otherActive: 0 });
  });

  it("GET returns the active report or null; DELETE revokes all and the public page 404s", async () => {
    const { b } = await seedLead();
    expect(await (await api(`/api/leads/${b.id}/report`)).json()).toEqual({ report: null, otherActive: 0 });
    const j = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    expect(await (await api(`/api/leads/${b.id}/report`)).json()).toEqual({ report: { token: j.token, url: j.url, expiresAt: j.expiresAt }, otherActive: 0 });
    expect((await pub(j.token)).status).toBe(200);
    const d = await api(`/api/leads/${b.id}/report`, { method: "DELETE" });
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ ok: true });
    expect(await (await api(`/api/leads/${b.id}/report`)).json()).toEqual({ report: null, otherActive: 0 });
    expect((await pub(j.token)).status).toBe(404);
    // a fresh POST after revoke creates a new token
    const j2 = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    expect(j2.token).not.toBe(j.token);
  });

  it("DELETE only touches the named business", async () => {
    const [x, y] = [await seedLead("X Co"), await seedLead("Y Co")];
    const jx = await (await api(`/api/leads/${x.b.id}/report`, { method: "POST" })).json<any>();
    const jy = await (await api(`/api/leads/${y.b.id}/report`, { method: "POST" })).json<any>();
    await api(`/api/leads/${x.b.id}/report`, { method: "DELETE" });
    expect((await pub(jx.token)).status).toBe(404);
    expect((await pub(jy.token)).status).toBe(200);
  });

  it("GET counts other active links (older audits) but not expired, revoked or the returned one", async () => {
    const { b } = await seedLead();
    const old1 = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    await seedAudit(b.id, { findings: [fnd("no_h1", "low", 2, "Second")] });
    const old2 = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    await seedAudit(b.id, { findings: [fnd("no_h1", "low", 2, "Third")] });
    // old links are still live but belong to earlier audits
    expect(await (await api(`/api/leads/${b.id}/report`)).json()).toEqual({ report: null, otherActive: 2 });
    const cur = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    expect((await (await api(`/api/leads/${b.id}/report`)).json<any>())).toMatchObject({ report: { token: cur.token }, otherActive: 2 });
    await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token = ?`).bind("2020-01-01T00:00:00.000Z", old1.token).run();
    expect((await (await api(`/api/leads/${b.id}/report`)).json<any>()).otherActive).toBe(1);
    await env.DB.prepare(`UPDATE audit_reports SET revoked = 1 WHERE token = ?`).bind(old2.token).run();
    expect((await (await api(`/api/leads/${b.id}/report`)).json<any>()).otherActive).toBe(0);
    // another business's links are never counted
    const other = await seedLead("Other Co");
    await api(`/api/leads/${other.b.id}/report`, { method: "POST" });
    expect((await (await api(`/api/leads/${b.id}/report`)).json<any>()).otherActive).toBe(0);
    // DELETE revokes the old ones too
    await api(`/api/leads/${b.id}/report`, { method: "DELETE" });
    expect(await (await api(`/api/leads/${b.id}/report`)).json()).toEqual({ report: null, otherActive: 0 });
  });

  it("requires auth", async () => {
    expect((await SELF.fetch("https://x/api/leads/abc/report", { method: "POST" })).status).toBe(401);
    expect((await SELF.fetch("https://x/api/leads/abc/report")).status).toBe(401);
    expect((await SELF.fetch("https://x/api/leads/abc/report", { method: "DELETE" })).status).toBe(401);
  });
});

describe("public report endpoint", () => {
  const KEYS = ["auditedAt", "businessName", "counts", "expiresAt", "findings", "partial", "sender"];

  it("returns exactly the documented key set, ordered high -> low, with no internal data", async () => {
    const { b, a } = await seedLead("Ace Plumbing");
    const j = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    const res = await pub(j.token);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(KEYS);
    expect(Object.keys(body.counts).sort()).toEqual(["high", "low", "medium"]);
    expect(Object.keys(body.sender).sort()).toEqual(["businessName", "email", "logoUrl", "name"]);
    for (const f of body.findings) expect(Object.keys(f).sort()).toEqual(["evidence", "severity"]);
    expect(body).toMatchObject({
      businessName: "Ace Plumbing", auditedAt: a.created_at, partial: false, expiresAt: j.expiresAt, counts: { high: 2, medium: 1, low: 2 },
      sender: { name: "Logan Irish", businessName: "Irish Web", email: "logan@irish.example", logoUrl: "https://irish.example/logo.png" },
    });
    expect(body.findings).toEqual([
      { severity: "high", evidence: "High one" }, { severity: "high", evidence: "High two" }, { severity: "medium", evidence: "Medium one" },
      { severity: "low", evidence: "Low one" }, { severity: "low", evidence: "Low two" },
    ]);
    // nothing internal anywhere in the serialized body
    for (const s of ["SECRET", "8675", "points", "no_https", "slow_mobile", "basics", "score", b.id, a.id, "raw/", "wix", "new_site", "reviewed", "4242"]) {
      expect(text, s).not.toContain(s);
    }
    // the owner-only mail note is stored on the audit and must stay out of the public report
    expect((await latestAudit(env.DB, b.id))!.mail_warning).toContain("SECRET-MAIL-WARNING");
    expect(text).not.toMatch(/mail_warning|mail records|bounce/i);
  });

  it("shows partial and handles zero findings; hides a non-https logo", async () => {
    const { b } = await seedLead();
    await seedAudit(b.id, { findings: [], partial: true, score: 0 });
    await saveSettings(env.DB, { logo_url: "http://irish.example/logo.png" });
    try {
      const j = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
      const body = await (await pub(j.token)).json<any>();
      expect(body.partial).toBe(true);
      expect(body.findings).toEqual([]);
      expect(body.counts).toEqual({ high: 0, medium: 0, low: 0 });
      expect(body.sender.logoUrl).toBe("");
    } finally { await saveSettings(env.DB, { logo_url: "https://irish.example/logo.png" }); }
  });

  it("serves the audit the report was made for, not a later one", async () => {
    const { b } = await seedLead();
    const j = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    await seedAudit(b.id, { findings: [fnd("no_h1", "low", 2, "Newer")] });
    const body = await (await pub(j.token)).json<any>();
    expect(body.findings.map((f: any) => f.evidence)).toContain("High one");
  });

  it("sets privacy headers on success and on 404", async () => {
    const { b } = await seedLead();
    const j = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    for (const res of [await pub(j.token), await pub("A".repeat(43))]) {
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("returns an identical 404 for unknown, expired, revoked and malformed tokens", async () => {
    const { b } = await seedLead();
    const expired = await (await api(`/api/leads/${b.id}/report`, { method: "POST" })).json<any>();
    await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token = ?`).bind("2020-01-01T00:00:00.000Z", expired.token).run();
    const { b: b2 } = await seedLead();
    const revoked = await (await api(`/api/leads/${b2.id}/report`, { method: "POST" })).json<any>();
    await api(`/api/leads/${b2.id}/report`, { method: "DELETE" });
    const tokens = ["A".repeat(43), "A".repeat(42), crypto.randomUUID().replace(/-/g, ""), expired.token, revoked.token, "a".repeat(65), "bad.token", "bad%20token", "%E2%9C%93"];
    const bodies: string[] = [];
    for (const t of tokens) {
      const r = await pub(t);
      expect(r.status, t).toBe(404);
      bodies.push(await r.text());
    }
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: "not found" })]));
  });

  it("404s when a report row's audit belongs to a different business", async () => {
    const x = await seedLead("X Co"), y = await seedLead("Y Co");
    const token = "M".repeat(43);
    await env.DB.prepare(`INSERT INTO audit_reports (token, business_id, audit_id, created_at, expires_at, revoked) VALUES (?,?,?,?,?,0)`)
      .bind(token, x.b.id, y.a.id, new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    expect((await pub(token)).status).toBe(404);
  });

  it("does not query the DB for malformed tokens", async () => {
    const orig = env.DB.prepare.bind(env.DB);
    let calls = 0;
    (env.DB as any).prepare = (q: string) => { calls++; return orig(q); };
    try {
      expect((await pub("a".repeat(65))).status).toBe(404);
      expect((await pub("bad.token")).status).toBe(404);
      expect((await pub("A".repeat(42))).status).toBe(404);
      expect(calls).toBe(0);
    } finally { (env.DB as any).prepare = orig; }
  });
});
