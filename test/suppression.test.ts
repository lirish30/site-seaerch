import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { addSuppression, isSuppressed, listSuppressions, removeSuppression, InvalidSuppression } from "../src/worker/db/suppression";
import { isDuplicateKey } from "../src/worker/db/services";
import { createSearch, getSearch } from "../src/worker/db/searches";
import { upsertBusiness, listBusinessesForSearch } from "../src/worker/db/businesses";
import { insertAudit } from "../src/worker/db/audits";
import { insertDraft } from "../src/worker/db/drafts";
import { saveSettings } from "../src/worker/db/settings";
import { runSearch } from "../src/worker/pipeline/search";
import { runLead, type LeadDeps } from "../src/worker/pipeline/lead";
import { latestAudit } from "../src/worker/db/audits";
import { latestDraft } from "../src/worker/db/drafts";
import { FakeListingSource } from "../src/worker/listings/fake";
import type { StepLike } from "../src/worker/pipeline/lead";
import type { Listing } from "../src/worker/types";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks' and I won't email again." });
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
afterEach(async () => { await env.DB.prepare(`DELETE FROM suppressions`).run(); });

const L = (o: Partial<Listing> & { placeId: string }): Listing => ({ name: `B-${o.placeId}`, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null, ...o });

describe("isSuppressed", () => {
  it("matches a messy URL against a normalized domain row", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "acme.com", reason: "client" });
    const hit = await isSuppressed(env.DB, { websiteUrl: "https://www.Acme.com/" });
    expect(hit?.reason).toBe("client");
    expect((await isSuppressed(env.DB, { domain: "WWW.ACME.COM" }))?.value).toBe("acme.com");
  });
  it("matches by place id", async () => {
    await addSuppression(env.DB, { kind: "place_id", value: "ChIJ-abc", reason: "opt_out", note: "asked to stop" });
    const hit = await isSuppressed(env.DB, { placeId: "ChIJ-abc" });
    expect(hit).toMatchObject({ kind: "place_id", reason: "opt_out", note: "asked to stop" });
  });
  it("returns null for an unrelated lead or empty input", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "acme.com", reason: "client" });
    await addSuppression(env.DB, { kind: "place_id", value: "ChIJ-abc", reason: "client" });
    expect(await isSuppressed(env.DB, { domain: "other.com", placeId: "ChIJ-zzz", websiteUrl: "https://notacme.com" })).toBeNull();
    expect(await isSuppressed(env.DB, {})).toBeNull();
    expect(await isSuppressed(env.DB, { domain: null, placeId: null, websiteUrl: null })).toBeNull();
  });
  it("never matches on a social-only host", async () => {
    await env.DB.prepare(`INSERT INTO suppressions (id, kind, value, reason, created_at) VALUES ('x','domain','facebook.com','other','t')`).run();
    expect(await isSuppressed(env.DB, { websiteUrl: "https://facebook.com/somebiz" })).toBeNull();
  });
});

describe("addSuppression", () => {
  it("normalizes domains and lists newest first", async () => {
    const a = await addSuppression(env.DB, { kind: "domain", value: " https://www.Acme.COM/about ", reason: "client" });
    expect(a.value).toBe("acme.com");
    await addSuppression(env.DB, { kind: "domain", value: "beta.com", reason: "competitor" });
    expect((await listSuppressions(env.DB)).map((s) => s.value).sort()).toEqual(["acme.com", "beta.com"]);
  });
  it("rejects a duplicate cleanly (also after normalization)", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "acme.com", reason: "client" });
    const err = await addSuppression(env.DB, { kind: "domain", value: "https://www.acme.com", reason: "other" }).catch((e) => e);
    expect(isDuplicateKey(err)).toBe(true);
    expect(await listSuppressions(env.DB)).toHaveLength(1);
  });
  it("rejects empty or invalid values, social-only hosts and unknown reasons", async () => {
    for (const value of ["", "   ", "not a domain", "localhost", "facebook.com", "https://www.yelp.com/biz/x"]) {
      await expect(addSuppression(env.DB, { kind: "domain", value, reason: "client" })).rejects.toBeInstanceOf(InvalidSuppression);
    }
    await expect(addSuppression(env.DB, { kind: "place_id", value: "  ", reason: "client" })).rejects.toBeInstanceOf(InvalidSuppression);
    await expect(addSuppression(env.DB, { kind: "domain", value: "ok.com", reason: "bogus" as any })).rejects.toBeInstanceOf(InvalidSuppression);
    expect(await listSuppressions(env.DB)).toHaveLength(0);
  });
  it("removes by id and reports unknown ids", async () => {
    const s = await addSuppression(env.DB, { kind: "domain", value: "acme.com", reason: "client" });
    expect(await removeSuppression(env.DB, s.id)).toBe(true);
    expect(await removeSuppression(env.DB, s.id)).toBe(false);
    expect(await isSuppressed(env.DB, { domain: "acme.com" })).toBeNull();
  });
});

const recorder = () => { const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} }; return step; };

describe("search pipeline", () => {
  it("skips suppressed domains and place ids, never starts them, and still finishes done with correct counts", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "clientco.com", reason: "client" });
    await addSuppression(env.DB, { kind: "place_id", value: "SUP-PLACE", reason: "opt_out" });
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    await runSearch({ db: env.DB, startLead: async (p) => { started.push(p.businessId); },
      source: new FakeListingSource([
        L({ placeId: "SUP-DOM", websiteUrl: "https://www.ClientCo.com/" }), // suppressed by domain
        L({ placeId: "SUP-PLACE", websiteUrl: "https://elsewhere.com" }), // suppressed by place id
        L({ placeId: "SUP-PLACE", websiteUrl: "https://elsewhere.com" }), // duplicate listing counts once
        L({ placeId: "OK-1", websiteUrl: "https://fine.com" }), L({ placeId: "OK-2" }),
      ]) }, recorder(), s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after.status).toBe("done");
    expect(after.found_count).toBe(4);
    expect(started).toHaveLength(2);
    // Suppressed ones count as processed, so the UI's done condition (processed >= found) holds once the 2 real leads finish.
    expect(after.processed_count).toBe(2);
    expect(after.processed_count + started.length).toBe(after.found_count);
    const linked = await listBusinessesForSearch(env.DB, s.id, { hideSkipped: false });
    expect(linked.map((b) => b.place_id).sort()).toEqual(["OK-1", "OK-2"]);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM businesses WHERE place_id IN ('SUP-DOM','SUP-PLACE')`).first<number>("n")).toBe(0);
  });
  it("a search whose results are all suppressed is complete immediately", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "only.com", reason: "competitor" });
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const started: string[] = [];
    await runSearch({ db: env.DB, startLead: async (p) => { started.push(p.businessId); },
      source: new FakeListingSource([L({ placeId: "ONLY-1", websiteUrl: "only.com" })]) }, recorder(), s.id);
    const after = (await getSearch(env.DB, s.id))!;
    expect(after).toMatchObject({ status: "done", found_count: 1, processed_count: 1 });
    expect(started).toHaveLength(0);
  });
});

async function seedLead(o: { website?: string | null; placeId?: string | null } = {}) {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const b = await upsertBusiness(env.DB, { placeId: o.placeId === undefined ? crypto.randomUUID() : o.placeId, name: "Ace", category: null, address: null, phone: null,
    websiteUrl: o.website === undefined ? `https://${crypto.randomUUID()}.example.com` : o.website, mapsUrl: null, rating: null, reviewCount: null }, s.id);
  const a = await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: true, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
    https: false, has_title: true, has_meta_description: true, has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0,
    platform: null, seo_score: null, accessibility_score: null, mail_warning: null, score: 15, offer: "seo_basics",
    findings: [{ code: "no_https", category: "technical", severity: "critical", points: 15, evidence: "Not secure", recommendation: "", source: "rule" }],
    raw_r2_key: null, health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
  await insertDraft(env.DB, { business_id: b.id, audit_id: a.id, to_contact_id: null, recipient_reason: "r", subject: "S", body: "B", offer: "seo_basics", steering_note: null });
  return b;
}

describe("suppression routes", () => {
  it("GET/POST/DELETE /api/suppressions with validation, 409 on duplicate and 404 on unknown id", async () => {
    expect(await (await api("/api/suppressions")).json()).toEqual([]);
    const r = await post("/api/suppressions", { value: "https://www.Acme.com/", reason: "client", note: "signed 2026" });
    expect(r.status).toBe(201);
    const created = await r.json<any>();
    expect(created).toMatchObject({ kind: "domain", value: "acme.com", reason: "client", note: "signed 2026" });
    expect((await post("/api/suppressions", { value: "acme.com", reason: "other" })).status).toBe(409);
    expect((await post("/api/suppressions", { value: "", reason: "client" })).status).toBe(400);
    expect((await post("/api/suppressions", { value: "acme2.com", reason: "bogus" })).status).toBe(400);
    expect((await post("/api/suppressions", { value: "acme2.com" })).status).toBe(400);
    expect((await post("/api/suppressions", { value: "facebook.com", reason: "client" })).status).toBe(400);
    expect((await post("/api/suppressions", { value: "nodots", reason: "client" })).status).toBe(400);
    expect((await (await api("/api/suppressions")).json<any[]>()).map((s) => s.value)).toEqual(["acme.com"]);
    expect((await api(`/api/suppressions/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/suppressions/${created.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("POST /api/leads/:id/suppress adds domain and place_id rows, skips existing ones, and logs activity", async () => {
    const b = await seedLead({ website: "https://www.Gone.example.org/", placeId: "PID-1" });
    await addSuppression(env.DB, { kind: "domain", value: "gone.example.org", reason: "client" }); // pre-existing: skipped, not an error
    expect((await post(`/api/leads/${b.id}/suppress`, { reason: "bogus" })).status).toBe(400);
    expect((await post(`/api/leads/nope/suppress`, { reason: "opt_out" })).status).toBe(404);
    const r = await post(`/api/leads/${b.id}/suppress`, { reason: "opt_out", note: "replied stop" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, added: 1 });
    const rows = await listSuppressions(env.DB);
    expect(rows.map((x) => `${x.kind}:${x.value}:${x.reason}`).sort()).toEqual(["domain:gone.example.org:client", "place_id:PID-1:opt_out"]);
    const detail = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(detail.suppressed).toBeTruthy();
    expect(detail.activity.map((a: any) => a.kind)).toContain("suppressed");
    expect((await post(`/api/leads/${b.id}/suppress`, { reason: "opt_out" })).status).toBe(200); // idempotent
    expect(await listSuppressions(env.DB)).toHaveLength(2);
  });

  it("a lead with nothing to match on (no domain, no place id) cannot be suppressed", async () => {
    const b = await seedLead({ website: null, placeId: null });
    expect((await post(`/api/leads/${b.id}/suppress`, { reason: "client" })).status).toBe(400);
  });

  it("a lead whose website is a social page is suppressed by place id only", async () => {
    const b = await seedLead({ website: "https://facebook.com/ace", placeId: "PID-FB" });
    expect((await post(`/api/leads/${b.id}/suppress`, { reason: "client" })).status).toBe(200);
    expect((await listSuppressions(env.DB)).map((x) => `${x.kind}:${x.value}`)).toEqual(["place_id:PID-FB"]);
  });

  it("detail reports suppressed: null for a normal lead", async () => {
    const b = await seedLead();
    expect((await (await api(`/api/leads/${b.id}`)).json<any>()).suppressed).toBeNull();
  });

  it("drafting and export routes return 409 for a suppressed lead and work again after the suppression is removed", async () => {
    const b = await seedLead();
    await post(`/api/leads/${b.id}/suppress`, { reason: "competitor" });
    const blocked = [
      api(`/api/leads/${b.id}/regenerate`, { method: "POST", body: "{}" }),
      api(`/api/leads/${b.id}/gmail-draft`, { method: "POST", body: "{}" }),
      api(`/api/leads/${b.id}/drive`, { method: "POST", body: "{}" }),
      api(`/api/leads/${b.id}/report`, { method: "POST" }),
    ];
    for (const r of await Promise.all(blocked)) {
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "suppressed", reason: "competitor" });
    }
    for (const s of await listSuppressions(env.DB)) expect((await api(`/api/suppressions/${s.id}`, { method: "DELETE" })).status).toBe(200);
    // Past the guard: report creation succeeds; the Google routes fail for the unrelated reason that Google isn't connected.
    expect((await api(`/api/leads/${b.id}/report`, { method: "POST" })).status).toBe(201);
    expect((await api(`/api/leads/${b.id}/gmail-draft`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await api(`/api/leads/${b.id}/drive`, { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("suppression by domain also blocks a different lead row on the same domain, matching case-insensitively", async () => {
    const b = await seedLead({ website: "https://shared.example.net" });
    await post("/api/suppressions", { value: "WWW.Shared.Example.NET", reason: "active_deal" });
    const r = await api(`/api/leads/${b.id}/report`, { method: "POST" });
    expect(r.status).toBe(409);
    expect((await r.json<any>()).reason).toBe("active_deal");
  });
});

describe("runLead draft step", () => {
  const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} };
  const page = () => new Response(`<html><head><title>Ace</title><meta name="viewport" content="x"></head><body><p>hi</p></body></html>`, { headers: { "content-type": "text/html" } });
  function deps() {
    const d: any = {
      db: env.DB, raw: env.RAW, pagespeedKey: "K", now: () => new Date("2026-10-02T00:00:00Z"), claudeCalls: 0,
      fetch: async (u: string) => (u.startsWith("https://www.googleapis.com/") ? Response.json({}) : u.startsWith("https://ace-supp.example.com") ? page() : new Response("nf", { status: 404 })),
    };
    d.claude = async () => { d.claudeCalls++; return { subject: "Hi", body: "Body", to_contact_id: null, recipient_reason: "r" }; };
    return d as LeadDeps & { claudeCalls: number };
  }
  const seed = async (placeId: string) => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    return upsertBusiness(env.DB, { placeId, name: "Ace", category: "Plumber", address: "Boise", phone: null, websiteUrl: "https://ace-supp.example.com", mapsUrl: null, rating: null, reviewCount: null }, s.id);
  };
  const drafts = (id: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE business_id = ?`).bind(id).first<number>("n");

  it("a suppressed lead is still re-audited with forceDraft, but gets no draft and no drafting spend", async () => {
    const b = await seed("RL-SUP");
    await addSuppression(env.DB, { kind: "place_id", value: "RL-SUP", reason: "opt_out" });
    const d = deps();
    const r = await runLead(d, step, { businessId: b.id, searchId: null, forceDraft: true });
    expect(r.draftId).toBeNull();
    expect(r.auditId).toBeTruthy();
    expect((await latestAudit(env.DB, b.id))?.id).toBe(r.auditId);
    expect(await latestDraft(env.DB, b.id)).toBeNull();
    expect(await drafts(b.id)).toBe(0);
    expect(d.claudeCalls).toBe(0);
  });

  it("a lead suppressed by domain only (after its workflow was queued) is also not drafted", async () => {
    const b = await seed("RL-SUP-DOM");
    await addSuppression(env.DB, { kind: "domain", value: "ace-supp.example.com", reason: "client" });
    expect((await runLead(deps(), step, { businessId: b.id, searchId: null, forceDraft: true })).draftId).toBeNull();
    expect(await drafts(b.id)).toBe(0);
  });

  it("a lead that is not suppressed still drafts with forceDraft", async () => {
    const b = await seed("RL-OK");
    const d = deps();
    const r = await runLead(d, step, { businessId: b.id, searchId: null, forceDraft: true });
    expect(r.draftId).not.toBeNull();
    expect(await drafts(b.id)).toBe(1);
    expect(d.claudeCalls).toBe(1);
  });
});
