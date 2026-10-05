import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness, getBusiness } from "../src/worker/db/businesses";
import { insertAudit } from "../src/worker/db/audits";
import { replaceContacts } from "../src/worker/db/contacts";
import { insertDraft } from "../src/worker/db/drafts";
import { saveSettings } from "../src/worker/db/settings";
import { leadRows } from "../src/worker/routes/leads";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks' and I won't email again." });
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

async function seedLead(o: { platform?: "wix" | null; rating?: number | null; reviewCount?: number | null } = {}) {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Ace", category: null, address: null, phone: null, websiteUrl: "https://ace.com", mapsUrl: null, rating: o.rating ?? null, reviewCount: o.reviewCount ?? null }, s.id);
  const a = await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: true, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
    https: false, has_title: true, has_meta_description: true, has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0,
    platform: o.platform ?? null, seo_score: null, accessibility_score: null, mail_warning: null,
    score: 15, offer: "seo_basics", findings: [{ code: "no_https", category: "technical", severity: "critical", points: 15, evidence: "Not secure", recommendation: "", source: "rule" }], raw_r2_key: null, health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
  const [c] = await replaceContacts(env.DB, b.id, [{ type: "email", value: "info@ace.com", source_url: null, person_name: null, role: null, confidence: 0.7 }]);
  await insertDraft(env.DB, { business_id: b.id, audit_id: a.id, to_contact_id: c.id, recipient_reason: "r", subject: "S", body: "B", offer: "seo_basics", steering_note: null });
  return { s, b };
}

describe("routes", () => {
  it("serves the latest audit's screenshots and 404s when there are none", async () => {
    const { b } = await seedLead();
    expect((await api(`/api/leads/${b.id}/screenshot/desktop`)).status).toBe(404);
    await env.RAW.put("shots/t-desktop.jpg", new Uint8Array([1, 2, 3]));
    await env.DB.prepare(`UPDATE audits SET screenshots = ? WHERE business_id = ?`).bind(JSON.stringify({ desktop: "shots/t-desktop.jpg" }), b.id).run();
    const r = await api(`/api/leads/${b.id}/screenshot/desktop`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await api(`/api/leads/${b.id}/screenshot/other`)).status).toBe(404);
  });

  it("validates new search input", async () => {
    expect((await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "", businessType: "x" }) })).status).toBe(400);
    expect((await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "x", maxResults: 500 }) })).status).toBe(400);
  });

  it("a manual search is not new-only", async () => {
    const r = await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "plumber", maxResults: 10 }) });
    expect(r.status).toBe(201);
    const { id, new_only } = await r.json<any>();
    expect(new_only).toBe(0);
    expect(await env.DB.prepare(`SELECT new_only FROM searches WHERE id = ?`).bind(id).first()).toEqual({ new_only: 0 });
  });

  it("blocks search over spend limit with 402", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: 0 });
    const r = await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "plumber", maxResults: 10 }) });
    expect(r.status).toBe(402);
    await saveSettings(env.DB, { monthly_spend_limit_usd: 25 });
  });

  it("marks search failed and returns 502 when workflow create throws", async () => {
    const orig = env.SEARCH_WORKFLOW.create;
    (env.SEARCH_WORKFLOW as any).create = async () => { throw new Error("boom"); };
    try {
      const r = await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "failcase", maxResults: 5 }) });
      expect(r.status).toBe(502);
    } finally {
      (env.SEARCH_WORKFLOW as any).create = orig;
    }
    const row = await env.DB.prepare(`SELECT status, error FROM searches WHERE business_type = 'failcase'`).first<any>();
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom");
  });

  it("estimate falls back to 50 on non-numeric maxResults", async () => {
    const r = await (await api("/api/searches/estimate?maxResults=abc")).json<any>();
    expect(Number.isFinite(r.estUsd)).toBe(true);
  });

  it("search detail returns lead rows with score, top finding, best contact, partial", async () => {
    const { s } = await seedLead();
    const r = await (await api(`/api/searches/${s.id}`)).json<any>();
    expect(r.leads[0].score).toBe(15);
    expect(r.leads[0].topFinding).toBe("Not secure");
    expect(r.leads[0].bestContact).toBe("info@ace.com");
    expect(r.leads[0].hasEmail).toBe(true);
    expect(r.leads[0].partial).toBe(true);
  });

  it("lead rows expose platform, rating and reviewCount (null when absent)", async () => {
    const { s, b } = await seedLead({ platform: "wix", rating: 3.8, reviewCount: 12 });
    const detail = await (await api(`/api/searches/${s.id}`)).json<any>();
    expect(detail.leads[0]).toMatchObject({ platform: "wix", rating: 3.8, reviewCount: 12 });
    const all = (await (await api(`/api/leads?limit=500`)).json<any[]>()).find((r) => r.business.id === b.id);
    expect(all).toMatchObject({ platform: "wix", rating: 3.8, reviewCount: 12 });
    const bare = await seedLead();
    const bareRow = (await (await api(`/api/searches/${bare.s.id}`)).json<any>()).leads[0];
    expect(bareRow).toMatchObject({ platform: null, rating: null, reviewCount: null });
    const bareAll = (await (await api(`/api/leads?limit=500`)).json<any[]>()).find((r) => r.business.id === bare.b.id);
    expect(bareAll).toMatchObject({ platform: null, rating: null, reviewCount: null });
  });

  it("lead rows for a business with no audit keep rating/reviewCount and null platform/score", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "noaudit", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "NoAudit", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: 4.2, reviewCount: 7 }, s.id);
    const want = { platform: null, score: null, offer: null, rating: 4.2, reviewCount: 7 };
    expect((await (await api(`/api/searches/${s.id}`)).json<any>()).leads[0]).toMatchObject(want);
    expect((await (await api(`/api/leads?limit=500`)).json<any[]>()).find((r) => r.business.id === b.id)).toMatchObject(want);
  });

  it("opening a lead marks it reviewed and returns draft + recipient", async () => {
    const { b } = await seedLead();
    const r = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(r.draft.subject).toBe("S");
    expect(r.toContact.value).toBe("info@ace.com");
    expect((await getBusiness(env.DB, b.id))!.lead_status).toBe("reviewed");
  });

  it("patch status to contacted sets contacted_at; draft edit marks edited", async () => {
    const { b } = await seedLead();
    const r = await (await api(`/api/leads/${b.id}`, { method: "PATCH", body: JSON.stringify({ leadStatus: "contacted" }) })).json<any>();
    expect(r.contacted_at).not.toBeNull();
    expect((await api(`/api/leads/${b.id}/draft`, { method: "PATCH", body: JSON.stringify({ subject: "S2", body: "B2" }) })).status).toBe(200);
    const d = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(d.draft.edited).toBe(true);
  });

  it("lead detail carries a finding diff against the previous audit, null with one audit", async () => {
    const { b } = await seedLead();
    expect((await (await api(`/api/leads/${b.id}`)).json<any>()).changes).toBeNull();
    const fnd = (code: string) => ({ code, category: "technical", severity: "important", points: 5, evidence: code, recommendation: "", source: "rule" });
    await env.DB.prepare(`UPDATE audits SET created_at = ?, findings = ? WHERE business_id = ?`)
      .bind("2026-03-01T00:00:00.000Z", JSON.stringify([fnd("no_https"), fnd("slow_lcp")]), b.id).run();
    await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: true, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
      https: false, has_title: true, has_meta_description: true, has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0,
      platform: null, seo_score: null, accessibility_score: null, mail_warning: null,
      score: 10, offer: "seo_basics", findings: [fnd("slow_lcp") as any, fnd("no_contact_form") as any], raw_r2_key: null, health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
    const { changes } = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(changes.since).toBe("2026-03-01T00:00:00.000Z");
    expect(changes.added.map((x: any) => x.code)).toEqual(["no_contact_form"]);
    expect(changes.resolved.map((x: any) => x.code)).toEqual(["no_https"]);
    expect(changes.unchangedCount).toBe(1);
  });

  it("lead detail flags stale findings per finding and returns urgency", async () => {
    const day = 86_400_000, ago = (n: number) => new Date(Date.now() - n * day).toISOString();
    const fnd = (code: string, severity: string, observed_at?: string) =>
      ({ code, category: "technical", severity, points: 5, evidence: code, recommendation: "", source: "rule", ...(observed_at ? { observed_at } : {}) });
    const { b } = await seedLead();
    await env.DB.prepare(`UPDATE audits SET findings = ? WHERE business_id = ?`)
      .bind(JSON.stringify([fnd("old", "critical", ago(45)), fnd("fresh", "important", ago(1)), fnd("legacy", "nice")]), b.id).run();
    const r = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(r.audit.findings.map((f: any) => [f.code, f.stale])).toEqual([["old", true], ["fresh", false], ["legacy", false]]);
    expect(r.urgency).toBe(30 + 12 + 3);
    // A legacy finding has no observed_at, so it is as old as its audit, not as old as now.
    await env.DB.prepare(`UPDATE audits SET created_at = ? WHERE business_id = ?`).bind(ago(45), b.id).run();
    const old = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(old.audit.findings.map((f: any) => [f.code, f.stale])).toEqual([["old", true], ["fresh", false], ["legacy", true]]);
  });

  it("lead detail carries the best first offer with its supporting findings, null with no audit", async () => {
    const { b } = await seedLead();
    const r = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(r.best_offer.service.key).toBe("hosting-maintenance");
    expect(r.best_offer.because.map((f: any) => f.code)).toEqual(["no_https"]);
    expect(r.best_offer.because[0].stale).toBe(false);
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const bare = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Bare2", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id);
    expect((await (await api(`/api/leads/${bare.id}`)).json<any>()).best_offer).toBeNull();
  });

  it("lead detail urgency is 0 with no audit", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Bare", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id);
    const r = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(r.audit).toBeNull();
    expect(r.urgency).toBe(0);
  });

  it("leadRows batches audits/contacts correctly for ~150 businesses (latest audit wins)", async () => {
    const s = await createSearch(env.DB, { location: "Bulk", businessType: "bulk", radiusKm: 1, maxResults: 200 });
    const ids: string[] = [];
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 150; i++) {
      const id = `bulk-${i}`; ids.push(id);
      stmts.push(env.DB.prepare(`INSERT INTO businesses (id, place_id, domain, name, website_url, created_at) VALUES (?,?,?,?,?,?)`)
        .bind(id, `bulk-place-${i}`, `bulk${i}.com`, `Bulk ${i}`, `https://bulk${i}.com`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
      const audit = (aid: string, score: number, at: string) => env.DB.prepare(
        `INSERT INTO audits (id, business_id, created_at, site_status, partial, score, offer, findings) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(aid, id, at, "ok", i % 2, score, "care_plan", JSON.stringify([{ code: "no_https", group: "basics", severity: "high", points: 15, evidence: `old ${i}` }]));
      stmts.push(audit(`bulk-a-old-${i}`, 1, "2026-01-01T00:00:00.000Z"));
      if (i % 3 !== 0) stmts.push(audit(`bulk-a-new-${i}`, i, "2026-02-01T00:00:00.000Z"));
      if (i % 5 !== 0) stmts.push(env.DB.prepare(`INSERT INTO contacts (id, business_id, type, value, confidence) VALUES (?,?,?,?,?)`)
        .bind(`bulk-c-${i}`, id, "email", `info@bulk${i}.com`, 0.7));
    }
    await env.DB.batch(stmts);
    const businesses = (await env.DB.prepare(`SELECT * FROM businesses WHERE id LIKE 'bulk-%'`).all<any>()).results;
    const rows = await leadRows(env.DB, businesses);
    expect(rows).toHaveLength(150);
    for (const r of rows) {
      const i = Number(r.business.id.slice(5));
      expect(r.score).toBe(i % 3 !== 0 ? i : 1);
      expect(r.partial).toBe(i % 2 === 1);
      expect(r.topFinding).toBe(`old ${i}`);
      expect(r.bestContact).toBe(i % 5 !== 0 ? `info@bulk${i}.com` : null);
      expect(r.hasEmail).toBe(i % 5 !== 0);
    }
    const page1 = await (await api(`/api/leads?limit=100`)).json<any[]>();
    expect(page1).toHaveLength(100);
    const page2 = await (await api(`/api/leads?limit=100&offset=100`)).json<any[]>();
    expect(page2.length).toBeGreaterThan(50);
    expect(new Set([...page1, ...page2].map((r) => r.business.id)).size).toBe(page1.length + page2.length);
    expect((await (await api(`/api/leads?limit=99999`)).json<any[]>()).length).toBeLessThanOrEqual(500);
    expect((await api(`/api/leads?limit=abc`)).status).toBe(200);
  });

  it("rejects invalid lead status", async () => {
    const { b } = await seedLead();
    expect((await api(`/api/leads/${b.id}`, { method: "PATCH", body: JSON.stringify({ leadStatus: "bogus" }) })).status).toBe(400);
  });

  it("refuses searches, regenerate and re-audit until physical address and opt-out line are set", async () => {
    const { b } = await seedLead();
    const msg = "Fill in your physical address and opt-out line in Settings first";
    const calls = () => [
      api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "compliance", maxResults: 5 }) }),
      api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: JSON.stringify({}) }),
      api(`/api/leads/${b.id}/reaudit`, { method: "POST", body: JSON.stringify({}) }),
    ];
    try {
      for (const blank of [{ physical_address: "", opt_out_line: "Reply stop" }, { physical_address: "1 Main", opt_out_line: "   " }]) {
        await saveSettings(env.DB, blank);
        for (const r of await Promise.all(calls())) {
          expect(r.status).toBe(400);
          expect(await r.json()).toEqual({ error: msg });
        }
      }
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM searches WHERE business_type = 'compliance'`).first<number>("n")).toBe(0);
    } finally {
      await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks' and I won't email again." });
    }
  });

  it("validates logo_url: https or empty only", async () => {
    const put = (logo_url: string) => api("/api/settings", { method: "PUT", body: JSON.stringify({ logo_url }) });
    expect((await put("https://example.com/logo.png")).status).toBe(200);
    expect((await (await api("/api/settings")).json<any>()).settings.logo_url).toBe("https://example.com/logo.png");
    for (const bad of ["http://example.com/l.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://x.com/a", "example.com/l.png", "https://", "https://exa mple.com/a", `https://example.com/${"a".repeat(500)}`]) {
      expect((await put(bad)).status, bad).toBe(400);
    }
    const bad = await put("http://example.com/l.png");
    expect(await bad.json()).toEqual({ error: "invalid", fields: ["logo_url"] });
    expect((await put("  https://example.com/trimmed.png  ")).status).toBe(200);
    expect((await (await api("/api/settings")).json<any>()).settings.logo_url).toBe("https://example.com/trimmed.png");
    const other = await api("/api/settings", { method: "PUT", body: JSON.stringify({ your_name: 5 }) });
    expect(other.status).toBe(400);
    expect((await other.json<any>()).fields).toEqual(["your_name"]);
    // A non-object body has no field path: report an empty list, never the string "undefined".
    const nonObject = await api("/api/settings", { method: "PUT", body: JSON.stringify([1]) });
    expect(nonObject.status).toBe(400);
    expect((await nonObject.json<any>()).fields).toEqual([]);
    expect((await put("")).status).toBe(200);
    expect((await (await api("/api/settings")).json<any>()).settings.logo_url).toBe("");
  });

  it("settings round trip with usage", async () => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ your_name: "Logan" }) });
    const r = await (await api("/api/settings")).json<any>();
    expect(r.settings.your_name).toBe("Logan");
    expect(Array.isArray(r.usage)).toBe(true);
  });

  it("archive hides a lead from All Leads and search results; restore brings it back; both are logged", async () => {
    const { s, b } = await seedLead();
    const ids = async (q = "") => (await (await api(`/api/leads?limit=500${q}`)).json<any[]>()).map((r) => r.business.id);
    expect(await ids()).toContain(b.id);
    expect((await (await api(`/api/leads/${b.id}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) })).json<any>()).archived_at).not.toBeNull();
    expect(await ids()).not.toContain(b.id);
    expect(await ids("&archived=1")).toContain(b.id);
    expect((await (await api(`/api/searches/${s.id}`)).json<any>()).leads.map((r: any) => r.business.id)).not.toContain(b.id);
    await api(`/api/leads/${b.id}/archive`, { method: "POST", body: JSON.stringify({ archived: false }) });
    expect(await ids()).toContain(b.id);
    const detail = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(detail.activity.map((a: any) => a.kind)).toEqual(["restored", "archived"]);
  });

  it("delete removes the lead and its audit, contacts, draft, people, activity and report links", async () => {
    const { b } = await seedLead();
    await api(`/api/leads/${b.id}/people`, { method: "POST", body: JSON.stringify({ name: "Ann Lee" }) });
    expect((await api(`/api/leads/${b.id}/report`, { method: "POST" })).status).toBe(201);
    expect((await api(`/api/leads/${b.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/leads/${b.id}`)).status).toBe(404);
    for (const t of ["audits", "contacts", "drafts", "people", "activity", "search_results", "audit_reports"])
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE business_id = ?`).bind(b.id).first<number>("n")).toBe(0);
    expect((await api(`/api/leads/${b.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("people CRUD keeps a single point of contact", async () => {
    const { b } = await seedLead();
    const add = async (body: object) => api(`/api/leads/${b.id}/people`, { method: "POST", body: JSON.stringify(body) });
    expect((await add({ name: "" })).status).toBe(400);
    expect((await add({ name: "X", email: "not-an-email" })).status).toBe(400);
    const ann = await (await add({ name: "Ann Lee", role: "Owner", email: "ann@ace.com", is_poc: true })).json<any>();
    const bob = await (await add({ name: "Bob", email: "", source: "site" })).json<any>();
    expect(bob.email).toBeNull();
    await api(`/api/leads/${b.id}/people/${bob.id}`, { method: "PATCH", body: JSON.stringify({ is_poc: true }) });
    const people = (await (await api(`/api/leads/${b.id}`)).json<any>()).people;
    expect(people.map((p: any) => [p.name, p.is_poc])).toEqual([["Bob", true], ["Ann Lee", false]]);
    const [row] = await leadRows(env.DB, [(await getBusiness(env.DB, b.id))!]);
    expect(row.poc).toEqual({ name: "Bob", email: null });
    expect((await api(`/api/leads/${b.id}/people/${ann.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/leads/other/people/${bob.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("patch sets follow-up, deal value and website (logged); rejects bad values", async () => {
    const { b } = await seedLead();
    const patch = (body: object) => api(`/api/leads/${b.id}`, { method: "PATCH", body: JSON.stringify(body) });
    const r = await (await patch({ followUpAt: "2026-11-01", dealValue: 2500, websiteUrl: "acenew.com" })).json<any>();
    expect([r.follow_up_at, r.deal_value, r.website_url, r.domain]).toEqual(["2026-11-01", 2500, "acenew.com", "acenew.com"]);
    expect((await patch({ followUpAt: "next week" })).status).toBe(400);
    expect((await patch({ websiteUrl: "not a url" })).status).toBe(400);
    expect((await (await patch({ followUpAt: null, dealValue: null })).json<any>()).follow_up_at).toBeNull();
    const kinds = (await (await api(`/api/leads/${b.id}`)).json<any>()).activity.map((a: any) => a.kind);
    expect(kinds).toContain("website");
  });

  it("re-audit with a reason is logged as a flagged score", async () => {
    const { b } = await seedLead();
    const orig = env.LEAD_WORKFLOW.create;
    (env.LEAD_WORKFLOW as any).create = async () => ({ id: "x" });
    try {
      expect((await api(`/api/leads/${b.id}/reaudit`, { method: "POST", body: JSON.stringify({ reason: "Site loads fine for me" }) })).status).toBe(202);
    } finally { (env.LEAD_WORKFLOW as any).create = orig; }
    const a = (await (await api(`/api/leads/${b.id}`)).json<any>()).activity[0];
    expect([a.kind, a.detail]).toEqual(["score_flagged", "Site loads fine for me"]);
  });

  it("report.html renders the deck with escaped content; 404 without an audit", async () => {
    const { b } = await seedLead();
    await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind("Ace <script>alert(1)</script>", b.id).run();
    const r = await api(`/api/leads/${b.id}/report.html`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Website audit &amp; proposal");
    expect(html).toContain("Ace &lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Not secure");
    expect((await api(`/api/leads/nope/report.html`)).status).toBe(404);
  });

  it("google: status reports unconfigured; exports need a connection; callback is public but rejects bad state", async () => {
    const st = await (await api("/api/google/status")).json<any>();
    expect(st).toEqual({ configured: false, connected: false, email: null });
    expect((await api("/api/google/connect")).status).toBe(501);
    const { b } = await seedLead();
    const g = await api(`/api/leads/${b.id}/gmail-draft`, { method: "POST", body: "{}" });
    expect(g.status).toBe(400);
    expect((await g.json<any>()).error).toMatch(/Connect your Google account/);
    expect((await api(`/api/leads/${b.id}/drive`, { method: "POST", body: "{}" })).status).toBe(400);
    const cb = await SELF.fetch("https://x/api/google/callback?code=c&state=bad", { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/settings?google=failed");
  });
});
