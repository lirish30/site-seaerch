import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAudit } from "../src/worker/db/audits";
import { saveSettings } from "../src/worker/db/settings";
import { createPost, getPost, patchPost } from "../src/worker/db/studio";
import { studioRoutes } from "../src/worker/routes/studio";
import { seedBusiness } from "./fixtures/cro";
import { seedClient } from "./fixtures/clients";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });

const call = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x${path}`, { method, headers: { ...(auth ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const T0 = "2026-12-01T10:00:00.000Z";
const COPY = { headline: "Three fixes", caption: "Plain tips.", slides: [{ title: "One", body: "Do it." }, { title: "Two", body: "Do it too." }], tags: ["plumber"] };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function audit(businessId: string, evidence = "The phone number is hard to find") {
  return insertAudit(env.DB, {
    business_id: businessId, site_status: "ok", partial: false, pagespeed_mobile: 31, lcp_ms: 4100, cls: 0.2, mobile_friendly: null, https: true, has_title: true, has_meta_description: true, has_contact_form: false,
    copyright_year: null, latest_content_date: null, broken_link_count: 0, platform: "wix", seo_score: 62, accessibility_score: 71, score: 8000, offer: "new_site",
    findings: [{ code: "no_cta", category: "cro", severity: "important", points: 5, evidence, recommendation: "Show it at the top.", source: "rule" }],
    raw_r2_key: null, mail_warning: null, health_score: 40, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {},
  } as never);
}
const upload = (id: string, slot: string, file: Blob | null, name = "x.png") => {
  const fd = new FormData();
  if (file) fd.set("file", file, name);
  return SELF.fetch(`https://x/api/studio/${id}/upload/${slot}`, { method: "POST", headers: { cookie }, body: fd });
};

describe("studio routes", () => {
  it("every route needs a session", async () => {
    const post = await createPost(env.DB, { kind: "before_after", source: {}, anonymize: true }, T0);
    for (const [m, p] of [["GET", "/api/studio"], ["POST", "/api/studio"], ["POST", `/api/studio/${post.id}/write`], ["POST", `/api/studio/${post.id}/upload/before`], ["POST", `/api/studio/${post.id}/render`],
      ["GET", `/api/studio/${post.id}/image/1`], ["PUT", `/api/studio/${post.id}/copy`], ["POST", `/api/studio/${post.id}/posted`], ["POST", `/api/studio/${post.id}/discard`]] as const) {
      expect((await call(m, p, m === "GET" ? undefined : {}, false)).status, `${m} ${p}`).toBe(401);
    }
  });

  it("create audit_tip needs an audit and 422s without one", async () => {
    const none = await call("POST", "/api/studio", { kind: "audit_tip" });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { error: string }).error).toMatch(/audit/i);
    expect((await call("POST", "/api/studio", { kind: "audit_tip", auditId: "nope" })).status).toBe(422);
    expect((await call("POST", "/api/studio", { kind: "nonsense" })).status).toBe(400);
    const b = await seedBusiness();
    const a = await audit(b.id);
    const ok = await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id });
    expect(ok.status).toBe(201);
    const post = (await ok.json()) as any;
    expect(post).toMatchObject({ kind: "audit_tip", status: "draft", anonymize: true, agreedAt: null, businessId: b.id, source: { auditId: a.id } });
    // never an R2 key in a response
    expect(JSON.stringify(post)).not.toMatch(/studio\//);
    expect(post).not.toHaveProperty("imageKeys");
    expect(post.images).toBe(0);
    const list = (await (await call("GET", "/api/studio")).json()) as { posts: any[] };
    expect(list.posts.map((p) => p.id)).toContain(post.id);
  });

  it("an audit whose findings name the business without a way to scrub them is a 422 with a plain sentence", async () => {
    const b = await seedBusiness();
    const a = await audit(b.id, "Ace is hard to find on Google");
    const r = await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toMatch(/whose site/);
    // with anonymity off and the client agreeing it is made
    expect((await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id, anonymize: false, agreed: true })).status).toBe(201);
  });

  it("turning anonymize off without agreed is 422, with agreed stamps agreed_at", async () => {
    const b = await seedBusiness();
    const a = await audit(b.id);
    const without = await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id, anonymize: false });
    expect(without.status).toBe(422);
    expect((await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id, anonymize: false, agreed: false })).status).toBe(422);
    const ok = await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id, anonymize: false, agreed: true });
    expect(ok.status).toBe(201);
    const post = (await ok.json()) as any;
    expect(post.anonymize).toBe(false);
    expect(post.agreedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect((await getPost(env.DB, post.id))!.agreedAt).toBe(post.agreedAt);
    // agreed does nothing to an anonymous post
    const anon = (await (await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id, agreed: true })).json()) as any;
    expect(anon.agreedAt).toBeNull();
  });

  it("a case study needs a client with finished work, and a before and after needs nothing", async () => {
    const lead = await seedBusiness();
    expect((await call("POST", "/api/studio", { kind: "case_study" })).status).toBe(422);
    expect((await call("POST", "/api/studio", { kind: "case_study", businessId: lead.id })).status).toBe(422);
    const s = await seedClient();
    await env.DB.prepare(`UPDATE projects SET status = 'done' WHERE business_id = ?`).bind(s.businessId).run();
    expect((await call("POST", "/api/studio", { kind: "case_study", businessId: s.businessId })).status).toBe(201);
    expect((await call("POST", "/api/studio", { kind: "before_after" })).status).toBe(201);
    expect((await call("POST", "/api/studio", { kind: "before_after", businessId: "nope" })).status).toBe(422);
  });

  it("write queues the copy once and sets writing; a post that has its copy cannot be queued again", async () => {
    const b = await seedBusiness();
    const a = await audit(b.id);
    const post = (await (await call("POST", "/api/studio", { kind: "audit_tip", auditId: a.id })).json()) as any;
    const w = await call("POST", `/api/studio/${post.id}/write`);
    expect(w.status).toBe(200);
    const body = (await w.json()) as any;
    expect(body.status).toBe("writing");
    expect(body.claudeTaskId).toBeTruthy();
    expect((await call("POST", `/api/studio/${post.id}/write`)).status).toBe(200);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks WHERE kind = 'studio.copy' AND target_id = ?`).bind(post.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
    await patchPost(env.DB, post.id, { status: "review" }, T0);
    expect((await call("POST", `/api/studio/${post.id}/write`)).status).toBe(409);
    expect((await call("POST", "/api/studio/nope/write")).status).toBe(404);
  });

  it("upload refuses a non-image and a file over 1 MB", async () => {
    const post = await createPost(env.DB, { kind: "before_after", source: {}, anonymize: true }, T0);
    const text = await upload(post.id, "before", new Blob(["hello"], { type: "text/plain" }), "x.txt");
    expect(text.status).toBe(422);
    expect(((await text.json()) as { error: string }).error).toMatch(/PNG, JPEG or WebP/);
    // claims to be a PNG but is not
    expect((await upload(post.id, "before", new Blob(["not really a png"], { type: "image/png" }))).status).toBe(422);
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    const over = await upload(post.id, "before", new Blob([big], { type: "image/png" }));
    expect(over.status).toBe(422);
    expect(((await over.json()) as { error: string }).error).toMatch(/1 MB/);
    expect((await upload(post.id, "before", null)).status).toBe(422);
    expect(await env.RAW.get(`studio/${post.id}/before`)).toBeNull();
    const ok = await upload(post.id, "before", new Blob([PNG], { type: "image/png" }));
    expect(ok.status).toBe(200);
    expect(await env.RAW.get(`studio/${post.id}/before`)).not.toBeNull();
    expect(JSON.stringify(await ok.json())).not.toMatch(/studio\//);
  });

  it("upload takes only the before or after slot, and only on a before and after post", async () => {
    const post = await createPost(env.DB, { kind: "before_after", source: {}, anonymize: true }, T0);
    for (const slot of ["1.png", "1", "cover", "BEFORE", "..%2F1.png"]) {
      const r = await upload(post.id, slot, new Blob([PNG], { type: "image/png" }));
      expect(r.status, slot).toBe(422);
    }
    expect(await env.RAW.get(`studio/${post.id}/1.png`)).toBeNull();
    const tip = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, T0);
    expect((await upload(tip.id, "before", new Blob([PNG], { type: "image/png" }))).status).toBe(422);
    expect((await upload("nope", "before", new Blob([PNG], { type: "image/png" }))).status).toBe(404);
  });

  it("image route needs a session and 404s an unknown index", async () => {
    const post = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, T0);
    await env.RAW.put(`studio/${post.id}/1.png`, PNG, { httpMetadata: { contentType: "image/png" } });
    await env.RAW.put(`studio/${post.id}/before`, PNG, { httpMetadata: { contentType: "image/png" } });
    await patchPost(env.DB, post.id, { imageKeys: [`studio/${post.id}/1.png`, `studio/${post.id}/2.png`] }, T0);
    expect((await call("GET", `/api/studio/${post.id}/image/1`, undefined, false)).status).toBe(401);
    const ok = await call("GET", `/api/studio/${post.id}/image/1`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([...PNG]);
    for (const n of ["0", "3", "99", "-1", "x", "1.png", "before", "../1"]) expect((await call("GET", `/api/studio/${post.id}/image/${n}`)).status, n).toBe(404);
    expect((await call("GET", `/api/studio/${post.id}/image/2`)).status).toBe(404); // listed but never stored
    expect((await call("GET", "/api/studio/nope/image/1")).status).toBe(404);
  });

  it("render is 501 without the browser binding, 422 when the post is not ready, and draws with one", async () => {
    const tip = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, T0);
    expect((await call("POST", "/api/studio/nope/render")).status).toBe(404);
    const noBrowser = { ...env, BROWSER: undefined } as typeof env;
    const r501 = await studioRoutes().request(`/${tip.id}/render`, { method: "POST" }, noBrowser);
    expect(r501.status).toBe(501);
    expect(((await r501.json()) as { error: string }).error).toMatch(/Browser Rendering/);

    // with a browser: the routes app is built with a fake renderer, as the deck's is
    const app = studioRoutes({ png: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]) });
    const withBrowser = { ...env, BROWSER: {} as Fetcher } as typeof env;
    const notReady = await app.request(`/${tip.id}/render`, { method: "POST" }, withBrowser);
    expect(notReady.status).toBe(422);
    expect(((await notReady.json()) as { error: string }).error).toMatch(/Write the copy/);
    await patchPost(env.DB, tip.id, { copy: COPY, status: "review" }, T0);
    const ok = await app.request(`/${tip.id}/render`, { method: "POST" }, withBrowser);
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as any;
    expect(view.images).toBe(4); // cover, two tips, close
    expect(JSON.stringify(view)).not.toMatch(/studio\//);
    expect((await getPost(env.DB, tip.id))!.imageKeys).toHaveLength(4);
  });

  it("copy edit with a link is 422", async () => {
    const post = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, T0);
    await patchPost(env.DB, post.id, { copy: COPY, status: "review" }, T0);
    for (const bad of [{ ...COPY, caption: "Visit https://x.example" }, { ...COPY, headline: "x".repeat(61) }, { ...COPY, tags: ["#tag"] }, { ...COPY, slides: [] }, { ...COPY, headline: "We are #1" }]) {
      expect((await call("PUT", `/api/studio/${post.id}/copy`, bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(422);
    }
    expect((await getPost(env.DB, post.id))!.copy).toEqual(COPY);
    const next = { ...COPY, headline: "A better headline" };
    const ok = await call("PUT", `/api/studio/${post.id}/copy`, next);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).copy.headline).toBe("A better headline");
    expect((await call("PUT", "/api/studio/nope/copy", next)).status).toBe(404);
    await patchPost(env.DB, post.id, { status: "approved" }, T0);
    expect((await call("PUT", `/api/studio/${post.id}/copy`, next)).status).toBe(409);
  });

  it("posted stamps posted_on in the booking zone", async () => {
    const post = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, T0);
    expect((await call("POST", `/api/studio/${post.id}/posted`)).status).toBe(409); // not approved yet
    await patchPost(env.DB, post.id, { copy: COPY, status: "approved" }, T0);
    // The test clock is the real one: work out what today is in Tokyo and in Honolulu, whose dates differ by one day for most of the day.
    const today = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "Pacific/Kiritimati" }) });
    const r = await call("POST", `/api/studio/${post.id}/posted`);
    expect(r.status).toBe(200);
    const done = (await r.json()) as any;
    expect(done.status).toBe("posted");
    expect(done.postedOn).toBe(today("Pacific/Kiritimati"));
    // again is a no-op
    expect(((await (await call("POST", `/api/studio/${post.id}/posted`)).json()) as any).postedOn).toBe(done.postedOn);
    await saveSettings(env.DB, { booking_config: "{}" });
  });

  it("discard marks a post discarded, and a posted one cannot be discarded", async () => {
    const post = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, T0);
    const r = await call("POST", `/api/studio/${post.id}/discard`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).status).toBe("discarded");
    expect((await call("POST", `/api/studio/${post.id}/discard`)).status).toBe(200);
    const posted = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: true }, T0);
    await patchPost(env.DB, posted.id, { status: "posted" }, T0);
    expect((await call("POST", `/api/studio/${posted.id}/discard`)).status).toBe(409);
    expect((await call("POST", "/api/studio/nope/discard")).status).toBe(404);
  });
});
