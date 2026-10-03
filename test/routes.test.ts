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

async function seedLead() {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Ace", category: null, address: null, phone: null, websiteUrl: "https://ace.com", mapsUrl: null, rating: null, reviewCount: null }, s.id);
  const a = await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: true, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
    https: false, has_title: true, has_meta_description: true, has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0,
    score: 15, offer: "seo_basics", findings: [{ code: "no_https", group: "basics", severity: "high", points: 15, evidence: "Not secure" }], raw_r2_key: null });
  const [c] = await replaceContacts(env.DB, b.id, [{ type: "email", value: "info@ace.com", source_url: null, person_name: null, role: null, confidence: 0.7 }]);
  await insertDraft(env.DB, { business_id: b.id, audit_id: a.id, to_contact_id: c.id, recipient_reason: "r", subject: "S", body: "B", offer: "seo_basics", steering_note: null });
  return { s, b };
}

describe("routes", () => {
  it("validates new search input", async () => {
    expect((await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "", businessType: "x" }) })).status).toBe(400);
    expect((await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Boise", businessType: "x", maxResults: 500 }) })).status).toBe(400);
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

  it("settings round trip with usage", async () => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ your_name: "Logan" }) });
    const r = await (await api("/api/settings")).json<any>();
    expect(r.settings.your_name).toBe("Logan");
    expect(Array.isArray(r.usage)).toBe(true);
  });
});
