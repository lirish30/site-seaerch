import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness, getBusiness, listBusinessesForSearch, findBusinessCandidates, loadMatchPool } from "../src/worker/db/businesses";
import { listActivity } from "../src/worker/db/activity";
import { addSuppression } from "../src/worker/db/suppression";
import { MAX_IMPORT_ROWS } from "../src/worker/import/parse";
import type { Listing } from "../src/worker/types";

let cookie = "";
const api = (path: string, body?: unknown) =>
  SELF.fetch(`https://x${path}`, { method: "POST", body: JSON.stringify(body ?? {}), headers: { cookie, "content-type": "application/json" } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

const L = (o: Partial<Listing> = {}): Listing => ({ placeId: null, name: "Seed", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null, ...o });
async function seed(o: Partial<Listing>) {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  return upsertBusiness(env.DB, L(o), s.id);
}
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
const counts = async () => ({ businesses: await count("businesses"), searches: await count("searches"), activity: await count("activity"), results: await count("search_results") });

async function withWorkflow<T>(create: (o: any) => Promise<unknown>, fn: () => Promise<T>) {
  const { create: origCreate, get: origGet } = env.LEAD_WORKFLOW;
  (env.LEAD_WORKFLOW as any).create = create;
  (env.LEAD_WORKFLOW as any).get = async () => { throw new Error("instance.not_found"); }; // a failed create is not an already-started one
  try { return await fn(); } finally { (env.LEAD_WORKFLOW as any).create = origCreate; (env.LEAD_WORKFLOW as any).get = origGet; }
}
const okWorkflow = () => { const made: any[] = []; return { made, create: async (o: any) => { made.push(o); return { id: o.id }; } }; };

describe("POST /api/import/preview", () => {
  it("classifies new, exact, ambiguous, duplicate_in_file, suppressed and invalid rows, and writes nothing", async () => {
    const exact = await seed({ name: "Pv Exact Co", websiteUrl: "https://pv-exact.com" });
    const amb = await seed({ name: "Pv Ambiguous Co", websiteUrl: "https://pv-amb-old.com" });
    await addSuppression(env.DB, { kind: "domain", value: "pv-blocked.com", reason: "client" });
    const csv = [
      "name,website",
      "Pv New Co,https://pv-new.com",
      "Pv Exact Co,http://www.pv-exact.com/",
      "Pv Ambiguous Co,https://pv-amb-new.com",
      "Pv Dup First,https://pv-dup.com",
      "Pv Dup Second,https://www.pv-dup.com/about",
      "Pv Blocked Co,https://pv-blocked.com",
      ",https://pv-nameless.com",
      "Pv Bad Site,not a website",
    ].join("\n");
    const before = await counts();
    const r = await api("/api/import/preview", { text: csv, source: "Referral" });
    expect(r.status).toBe(200);
    const { rows } = await r.json<any>();
    expect(await counts()).toEqual(before);
    expect(rows.map((x: any) => x.kind)).toEqual(["new", "exact", "ambiguous", "new", "duplicate_in_file", "suppressed", "invalid", "invalid"]);
    expect(rows[1].candidates.map((c: any) => c.id)).toEqual([exact.id]);
    expect(rows[2].candidates.map((c: any) => c.id)).toEqual([amb.id]);
    expect(rows[4].reason).toMatch(/row 4|same website/i);
    expect(rows[5].reason).toMatch(/client/i);
    expect(rows[6].reason).toMatch(/name/i);
    expect(rows[7].reason).toMatch(/website/i);
    expect(rows[0].row).toMatchObject({ name: "Pv New Co", url: "https://pv-new.com", source: "Referral" });
    expect(rows.map((x: any) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("a single url becomes one row named after its domain, or the given name", async () => {
    let r = await (await api("/api/import/preview", { url: "https://www.pv-single.com/", source: "Referral" })).json<any>();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ kind: "new", row: { name: "pv-single.com", url: "https://www.pv-single.com/" }, nameDerived: true });
    r = await (await api("/api/import/preview", { url: "pv-single2.com", name: "Single Two", source: "Referral" })).json<any>();
    expect(r.rows[0]).toMatchObject({ kind: "new", row: { name: "Single Two" } });
    expect(r.rows[0].nameDerived).toBeFalsy();
  });

  it("a single social-only url without a name is invalid (it does not identify the business)", async () => {
    const r = await (await api("/api/import/preview", { url: "https://facebook.com/someone", source: "Referral" })).json<any>();
    expect(r.rows[0].kind).toBe("invalid");
  });

  it("a row with no website matched only by name is ambiguous", async () => {
    await seed({ name: "Pv Nameonly Co", websiteUrl: "https://pv-nameonly.com" });
    const r = await (await api("/api/import/preview", { text: "name\nPv Nameonly Co", source: "Referral" })).json<any>();
    expect(r.rows[0].kind).toBe("ambiguous");
  });

  it("flags a repeated no-website row as a duplicate", async () => {
    const r = await (await api("/api/import/preview", { text: "name,address\nPv Walkin Co,1 A St\nPv Walkin Co,1 A St\nPv Walkin Co,2 B St", source: "x" })).json<any>();
    expect(r.rows.map((x: any) => x.kind)).toEqual(["new", "duplicate_in_file", "new"]);
  });

  it("answers bad input with a friendly 400", async () => {
    for (const body of [{}, { text: "", source: "x" }, { text: "name\nA", source: "" }, { text: "name\nA", source: "x".repeat(81) }, { url: "x.com" }]) {
      const r = await api("/api/import/preview", body);
      expect(r.status).toBe(400);
      expect(typeof (await r.json<any>()).error).toBe("string");
    }
    let r = await api("/api/import/preview", { text: "website\nx.com", source: "x" });
    expect(r.status).toBe(400);
    expect((await r.json<any>()).error).toMatch(/name/i);
    r = await api("/api/import/preview", { text: "name\n" + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `B${i}`).join("\n"), source: "x" });
    expect(r.status).toBe(400);
    expect((await r.json<any>()).error).toMatch(/rows/i);
  });

  it("requires login", async () => {
    const r = await SELF.fetch("https://x/api/import/preview", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
  });
});

const INTERNAL = ["http://127.0.0.1:8787/", "169.254.169.254", "http://localhost", "printer.local", "https://user:pw@acme.com", "https://acme.com:8443", "ftp://acme.com", "httpx://a.com"];

describe("internal and non-http addresses", () => {
  it("preview marks them invalid with a reason, and accepts httpbin.org", async () => {
    const text = "name,website\n" + INTERNAL.map((u, i) => `Int ${i},${u.includes(",") ? `"${u}"` : u}`).join("\n") + "\nInt Ok,httpbin.org";
    const { rows } = await (await api("/api/import/preview", { text, source: "x" })).json<any>();
    expect(rows.slice(0, INTERNAL.length).map((r: any) => r.kind)).toEqual(INTERNAL.map(() => "invalid"));
    for (const r of rows.slice(0, INTERNAL.length)) expect(r.reason.length).toBeGreaterThan(10);
    expect(rows[INTERNAL.length]).toMatchObject({ kind: "new", row: { url: "https://httpbin.org" } });
  });
  it("a single internal url is invalid", async () => {
    const { rows } = await (await api("/api/import/preview", { url: "http://127.0.0.1:8787/", name: "Local", source: "x" })).json<any>();
    expect(rows[0].kind).toBe("invalid");
  });
  it("commit refuses them even when the client says create: no business written, no workflow started", async () => {
    const before = await counts();
    const wf = okWorkflow();
    const res = await withWorkflow(wf.create, () => api("/api/import/commit", { source: "x",
      rows: INTERNAL.map((u, i) => ({ row: { name: `Int Commit ${i}`, url: u, source: "x" }, action: "create" })) }));
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ created: 0, auditsQueued: 0, searchId: null });
    expect(body.failures).toHaveLength(INTERNAL.length);
    expect(await counts()).toEqual(before);
    expect(wf.made).toHaveLength(0);
  });
  it("commit stores a scheme-less address as https://", async () => {
    const wf = okWorkflow();
    await withWorkflow(wf.create, () => api("/api/import/commit", { source: "x", rows: [{ row: { name: "Cm Scheme", url: "HTTP://Cm-scheme.com/a" }, action: "create" }] }));
    const b = await env.DB.prepare(`SELECT website_url, domain FROM businesses WHERE name = 'Cm Scheme'`).first<any>();
    expect(b).toEqual({ website_url: "http://Cm-scheme.com/a", domain: "cm-scheme.com" });
  });
});

describe("POST /api/import/commit", () => {
  const R = (name: string, url: string | null, source = "Referral") => ({ name, url, source });

  it("creates only the rows marked create, inside a finished 'Import' container search, and queues a quick audit per lead", async () => {
    const wf = okWorkflow();
    const before = await counts();
    const res = await withWorkflow(wf.create, () => api("/api/import/commit", { source: "Referral", rows: [
      { row: R("Cm Create One", "https://cm-one.com"), action: "create" },
      { row: R("Cm Skipped", "https://cm-skipped.com"), action: "skip" },
      { row: R("Cm Create Two", null), action: "create" },
    ] }));
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ created: 2, linked: 0, alreadyExisted: 0, skipped: 1, auditsQueued: 2, refused: [], failures: [] });
    const c = await counts();
    expect(c.businesses - before.businesses).toBe(2);
    expect(c.searches - before.searches).toBe(1);

    const search = (await env.DB.prepare(`SELECT * FROM searches WHERE id = ?`).bind(body.searchId).first<any>())!;
    expect(search).toMatchObject({ business_type: "import", status: "done", found_count: 2, processed_count: 2 });
    expect(search.location).toMatch(/^Import/);
    const inContainer = await listBusinessesForSearch(env.DB, body.searchId, { hideSkipped: false });
    expect(inContainer.map((b) => b.name).sort()).toEqual(["Cm Create One", "Cm Create Two"]);
    expect(await env.DB.prepare(`SELECT 1 FROM businesses WHERE name = 'Cm Skipped'`).first()).toBeNull();

    expect(wf.made).toHaveLength(2);
    for (const call of wf.made) expect(call.params).toMatchObject({ searchId: null, forceDraft: false, stage: "quick" });
    expect(wf.made.map((m) => m.params.businessId).sort()).toEqual(inContainer.map((b) => b.id).sort());
    expect(new Set(wf.made.map((m) => m.id)).size).toBe(2);

    const act = await listActivity(env.DB, inContainer[0].id);
    expect(act.map((a) => a.detail)).toContain("Imported from Referral");
  });

  it("resolves an ambiguous row to link: records a note and never overwrites the existing lead", async () => {
    const ex = await seed({ name: "Cm Link Co", websiteUrl: "https://cm-link.com", phone: "111", category: "Roofer" });
    const before = await counts();
    const wf = okWorkflow();
    const res = await withWorkflow(wf.create, () => api("/api/import/commit", { source: "Chamber list", rows: [
      { row: { ...R("Cm Link Co LLC", "https://cm-link.com", "Chamber list"), phone: "999", category: "Other", address: "new addr" }, action: "link", businessId: ex.id },
    ] }));
    const body = await res.json<any>();
    expect(body).toMatchObject({ created: 0, linked: 1, skipped: 0, auditsQueued: 0 });
    expect(wf.made).toHaveLength(0);
    const after = await getBusiness(env.DB, ex.id);
    expect(after).toEqual(ex);
    expect((await listActivity(env.DB, ex.id)).map((a) => a.detail)).toContain("Also imported from Chamber list");
    const c = await counts();
    expect(c.businesses).toBe(before.businesses);
    expect(c.searches).toBe(before.searches); // no container when nothing was created
    expect(body.searchId).toBeNull();
  });

  it("a create for a domain that already exists is converted to a link, never an overwrite", async () => {
    const ex = await seed({ name: "Cm Existing Co", websiteUrl: "https://cm-existing.com", phone: "111" });
    const before = await counts();
    const wf = okWorkflow();
    const res = await withWorkflow(wf.create, () => api("/api/import/commit", { source: "Referral", rows: [
      { row: R("Totally Different Name", "http://www.cm-existing.com/x"), action: "create" },
    ] }));
    const body = await res.json<any>();
    expect(body).toMatchObject({ created: 0, alreadyExisted: 1, auditsQueued: 0 });
    expect(await getBusiness(env.DB, ex.id)).toEqual(ex);
    expect((await listActivity(env.DB, ex.id)).map((a) => a.detail)).toContain("Also imported from Referral");
    expect((await counts()).businesses).toBe(before.businesses);
    expect(wf.made).toHaveLength(0);
  });

  it("two creates for one domain in the same request make one lead", async () => {
    const wf = okWorkflow();
    const res = await withWorkflow(wf.create, () => api("/api/import/commit", { source: "Referral", rows: [
      { row: R("Cm Twin", "https://cm-twin.com"), action: "create" },
      { row: R("Cm Twin Again", "https://www.cm-twin.com/"), action: "create" },
    ] }));
    expect(await res.json<any>()).toMatchObject({ created: 1, alreadyExisted: 1, auditsQueued: 1 });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM businesses WHERE domain = 'cm-twin.com'`).first<any>()).n).toBe(1);
  });

  it("refuses a suppressed row even when the client says create (or link)", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "cm-blocked.com", reason: "opt_out" });
    const other = await seed({ name: "Cm Other", websiteUrl: "https://cm-other.com" });
    const before = await counts();
    const wf = okWorkflow();
    const res = await withWorkflow(wf.create, () => api("/api/import/commit", { source: "Referral", rows: [
      { row: R("Cm Blocked", "https://www.cm-blocked.com/"), action: "create" },
      { row: R("Cm Blocked 2", "https://cm-blocked.com"), action: "link", businessId: other.id },
    ] }));
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ created: 0, linked: 0, auditsQueued: 0 });
    expect(body.refused).toHaveLength(2);
    expect(body.refused[0]).toMatchObject({ index: 0, name: "Cm Blocked" });
    expect(body.refused[0].reason).toMatch(/opt_out|opted/i);
    expect(await counts()).toEqual(before);
    expect(wf.made).toHaveLength(0);
  });

  it("a workflow that fails to start is reported and the lead is kept", async () => {
    const created: string[] = [];
    const res = await withWorkflow(async (o: any) => {
      if (o.params.businessId && created.length === 0) { created.push(o.params.businessId); throw new Error("workflow unavailable"); }
      return { id: o.id };
    }, () => api("/api/import/commit", { source: "Referral", rows: [
      { row: R("Cm Wf One", "https://cm-wf-one.com"), action: "create" },
      { row: R("Cm Wf Two", "https://cm-wf-two.com"), action: "create" },
    ] }));
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ created: 2, auditsQueued: 1 });
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({ index: 0, name: "Cm Wf One", kind: "audit" });
    expect(body.failures[0].error).toMatch(/workflow unavailable/);
    expect(await env.DB.prepare(`SELECT 1 FROM businesses WHERE name = 'Cm Wf One'`).first()).not.toBeNull();
  });

  it("a link to a business that does not exist is a per-row failure, not a crash", async () => {
    const wf = okWorkflow();
    const res = await withWorkflow(wf.create, () => api("/api/import/commit", { source: "Referral", rows: [
      { row: R("Cm Ghost", "https://cm-ghost.com"), action: "link", businessId: "nope" },
      { row: R("Cm After Ghost", "https://cm-after-ghost.com"), action: "create" },
    ] }));
    const body = await res.json<any>();
    expect(body).toMatchObject({ created: 1, linked: 0 });
    expect(body.failures[0]).toMatchObject({ index: 0, kind: "row" });
  });

  it("rejects malformed bodies with a friendly 400 and writes nothing", async () => {
    const before = await counts();
    const bad: unknown[] = [
      {}, { source: "x", rows: [] }, { source: "", rows: [{ row: R("A", null), action: "create" }] },
      { source: "x", rows: [{ row: R("A", null), action: "merge" }] },
      { source: "x", rows: [{ row: R("A", null), action: "link" }] },
      { source: "x", rows: [{ row: R("", null), action: "create" }] },
      { source: "x", rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({ row: R("A", null), action: "skip" })) },
    ];
    for (const b of bad) {
      const r = await api("/api/import/commit", b);
      expect(r.status).toBe(400);
      expect(typeof (await r.json<any>()).error).toBe("string");
    }
    expect(await counts()).toEqual(before);
  });

  it("accepts a skipped row with no name (an invalid CSV row the client skips) but not a nameless row that would be written", async () => {
    const ok = await api("/api/import/commit", { source: "x", rows: [{ row: { name: "", url: "https://cm-nameless.com" }, action: "skip" }] });
    expect(ok.status).toBe(200);
    expect(await ok.json<any>()).toMatchObject({ created: 0, skipped: 1 });
    const no = await api("/api/import/commit", { source: "x", rows: [{ row: R("Fine", null), action: "skip" }, { row: R("", null), action: "create" }] });
    expect(no.status).toBe(400);
    expect((await no.json<any>()).error).toMatch(/^row 2: each row needs a name/);
  });

  it("a create whose website is not a usable address is a row failure", async () => {
    const res = await withWorkflow(okWorkflow().create, () => api("/api/import/commit", { source: "x", rows: [{ row: R("Cm Badsite", "not a website"), action: "create" }] }));
    const body = await res.json<any>();
    expect(body.created).toBe(0);
    expect(body.failures[0]).toMatchObject({ index: 0, kind: "row" });
  });
});

describe("findBusinessCandidates", () => {
  it("returns businesses by normalized domain and by similar name, and accepts a preloaded pool", async () => {
    const byDomain = await seed({ name: "Fc Domain Holder", websiteUrl: "https://www.fc-domain.com/" });
    const byName = await seed({ name: "Fc Named Roofing", websiteUrl: "https://fc-elsewhere.com" });
    await seed({ name: "Fc Unrelated", websiteUrl: "https://fc-unrelated.com" });
    const ids = (await findBusinessCandidates(env.DB, { name: "Something Else", url: "http://FC-domain.com/x" })).map((b) => b.id);
    expect(ids).toEqual([byDomain.id]);
    const named = (await findBusinessCandidates(env.DB, { name: "fc named roofing llc", url: null })).map((b) => b.id);
    expect(named).toEqual([byName.id]);
    const pool = await loadMatchPool(env.DB);
    expect((await findBusinessCandidates(env.DB, { name: "Fc Named Roofing", url: null }, pool)).map((b) => b.id)).toEqual([byName.id]);
    expect(await findBusinessCandidates(env.DB, { name: "Nothing Like It", url: "https://facebook.com/x" })).toEqual([]);
  });
});

describe("import audits are queued once per lead", () => {
  it("a create that throws for an instance that already exists counts as queued", async () => {
    const orig = { create: env.LEAD_WORKFLOW.create, get: env.LEAD_WORKFLOW.get };
    (env.LEAD_WORKFLOW as any).create = async () => { throw new Error("already exists"); };
    (env.LEAD_WORKFLOW as any).get = async (id: string) => ({ id });
    try {
      const body = await (await api("/api/import/commit", { source: "x", rows: [{ row: { name: "Qa Once", url: "https://qa-once.com" }, action: "create" }] })).json<any>();
      expect(body).toMatchObject({ created: 1, auditsQueued: 1, failures: [] });
    } finally { (env.LEAD_WORKFLOW as any).create = orig.create; (env.LEAD_WORKFLOW as any).get = orig.get; }
  });
});
