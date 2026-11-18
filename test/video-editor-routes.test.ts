import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { insertAudit } from "../src/worker/db/audits";
import { createVideoAudit, getVideoAudit, savePlan, setVideoStatus, type VideoStatus } from "../src/worker/db/videoAudits";
import { startProduction } from "../src/worker/video/production";
import { hashText, type Segment, type Shot, type VideoPlan } from "../src/worker/video/plan";
import { seedBusiness } from "./fixtures/cro";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const put = (path: string, body: unknown) => api(path, { method: "PUT", body: JSON.stringify(body) });
const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["claude_tasks", "agent_actions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const FINDINGS = [
  { code: "no_https", category: "technical", severity: "critical", points: 15, evidence: "no padlock", recommendation: "Add HTTPS", source: "rule" },
  { code: "no_cta", category: "cro", severity: "critical", points: 10, evidence: "no button", recommendation: "Add a button", source: "rule" },
  { code: "slow_mobile", category: "speed", severity: "important", points: 8, evidence: "slow", recommendation: "Compress", source: "rule" },
] as const;
const insertTestAudit = (businessId: string) => insertAudit(env.DB, {
  business_id: businessId, site_status: "ok", partial: false, pagespeed_mobile: 60, lcp_ms: null, cls: null, mobile_friendly: true,
  https: false, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
  score: 70, offer: "seo_basics", findings: FINDINGS as any, raw_r2_key: null, health_score: 50, niche: "trades", category_scores: {}, ai_review: null,
  screenshots: { desktop: null, mobile: null }, site_links: {}, platform: null, seo_score: null, accessibility_score: null, mail_warning: null,
});

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");
const shot = (id: string): Shot => ({ id, viewport: "desktop", scrollY: 0, width: 1280, height: 720, fullKey: `video/v/shots/${id}.jpg`, previewKey: `video/v/shots/${id}.preview.jpg` });
const seg = (id: string, o: Partial<Segment> = {}): Segment => ({ id, role: "problem", findingCode: "no_cta", text: words(50), shotId: "d1", markups: [], ...o });
const SEGMENTS = (): Segment[] => [
  seg("s1", { role: "hook", findingCode: undefined, text: words(30) }),
  seg("s2", { findingCode: "no_https" }),
  seg("s3", { findingCode: "no_cta", shotId: "d2" }),
  seg("s4", { findingCode: "slow_mobile" }),
  seg("s5", { role: "offer", findingCode: undefined, text: words(40) }),
  seg("s6", { role: "cta", findingCode: undefined, text: words(30) }),
];

/** A video in review with a good plan (about 100 seconds), a real audit behind it, and its two shot previews in R2. */
async function reviewing(o: { narration?: VideoPlan["narration"]; status?: VideoStatus; segments?: Segment[] } = {}) {
  const b = await seedBusiness();
  const audit = await insertTestAudit(b.id);
  const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: audit.id }))!;
  const shots = [shot("d1"), shot("d2")].map((s) => ({ ...s, fullKey: s.fullKey.replace("/v/", `/${v.id}/`), previewKey: s.previewKey.replace("/v/", `/${v.id}/`) }));
  for (const s of shots) await env.RAW.put(s.previewKey, new Uint8Array([9, 9, 9]), { httpMetadata: { contentType: "image/jpeg" } });
  await savePlan(env.DB, v.id, { shots, segments: o.segments ?? SEGMENTS(), narration: o.narration ?? "recorded", version: 0 });
  await setVideoStatus(env.DB, v.id, o.status ?? "review");
  return { b, audit, v: (await getVideoAudit(env.DB, v.id))!, shots };
}

const bytes = (n: number) => new Uint8Array(n).fill(7);
const record = (videoId: string, segId: string, body: BodyInit, headers: Record<string, string> = {}) =>
  api(`/api/video-audits/${videoId}/segments/${segId}/recording`, { method: "PUT", body, headers: { "content-type": "audio/webm", "x-duration-ms": "9000", ...headers } });

describe("PUT plan", () => {
  it("plan edit outside review is refused", async () => {
    const { v } = await reviewing({ status: "producing" });
    const r = await put(`/api/video-audits/${v.id}/plan`, { segments: SEGMENTS(), narration: "recorded" });
    expect(r.status).toBe(409);
    expect((await getVideoAudit(env.DB, v.id))!.plan!.version).toBe(v.plan!.version);
    expect((await put(`/api/video-audits/nope/plan`, { segments: SEGMENTS(), narration: "recorded" })).status).toBe(404);
  });

  it("unchanged line keeps its audio, edited line loses it", async () => {
    const segments = SEGMENTS();
    segments[0].audio = { key: "video/x/recordings/s1-a.webm", source: "recorded", durationMs: 12000, textHash: hashText(segments[0].text) };
    segments[1].audio = { key: "video/x/recordings/s2-b.webm", source: "recorded", durationMs: 20000, textHash: hashText(segments[1].text) };
    const { v } = await reviewing({ segments });

    const edited = SEGMENTS();
    edited[1].text = `${words(49)} changed`;
    edited[2].markups = [{ type: "callout", x: 0.4, y: 0.4, text: "No booking button" }];
    // A client cannot invent audio: whatever it sends in `audio` is ignored.
    edited[3].audio = { key: "evil", source: "recorded", durationMs: 1, textHash: hashText(edited[3].text) };
    const r = await put(`/api/video-audits/${v.id}/plan`, { segments: edited, narration: "recorded" });
    expect(r.status).toBe(200);

    const plan = (await getVideoAudit(env.DB, v.id))!.plan!;
    expect(plan.segments[0].audio).toEqual(segments[0].audio);
    expect(plan.segments[1].text).toBe(edited[1].text);
    expect(plan.segments[1].audio).toBeUndefined();
    expect(plan.segments[3].audio).toBeUndefined();
    expect(plan.segments[2].markups).toEqual(edited[2].markups);
    expect(plan.version).toBeGreaterThan(v.plan!.version);
    expect(plan.shots).toEqual(v.plan!.shots); // the shots are not the editor's to change
    expect((await r.json<any>()).plan.version).toBe(plan.version);
  });

  it("keeps audio when only the narration source changes, and an empty callout draft is saved", async () => {
    const segments = SEGMENTS();
    segments[0].audio = { key: "k", source: "recorded", durationMs: 1000, textHash: hashText(segments[0].text) };
    const { v } = await reviewing({ segments });
    const next = SEGMENTS();
    next[1].markups = [{ type: "callout", x: 0.5, y: 0.5, text: "" }];
    expect((await put(`/api/video-audits/${v.id}/plan`, { segments: next, narration: "clone" })).status).toBe(200);
    const plan = (await getVideoAudit(env.DB, v.id))!.plan!;
    expect(plan.narration).toBe("clone");
    expect(plan.segments[0].audio).toEqual(segments[0].audio);
    expect(plan.segments[1].markups).toEqual([{ type: "callout", x: 0.5, y: 0.5, text: "" }]);
  });

  it("a script that is still too short saves (it blocks approval, not editing)", async () => {
    const { v } = await reviewing();
    const short = SEGMENTS();
    short[1].text = words(10);
    expect((await put(`/api/video-audits/${v.id}/plan`, { segments: short, narration: "recorded" })).status).toBe(200);
  });

  it("refuses a plan that points at a missing shot or finding, a bad markup, duplicate ids and too many markups", async () => {
    const { v } = await reviewing();
    const bad = async (mutate: (s: Segment[]) => void) => {
      const s = SEGMENTS(); mutate(s);
      const r = await put(`/api/video-audits/${v.id}/plan`, { segments: s, narration: "recorded" });
      expect(r.status).toBe(400);
      expect((await r.json<any>()).error).toBeTruthy();
    };
    await bad((s) => { s[0].shotId = "gone"; });
    await bad((s) => { s[1].findingCode = "made_up"; });
    await bad((s) => { s[1].markups = [{ type: "circle", x: 2, y: 0.5, r: 0.1 }]; });
    await bad((s) => { s[1].markups = [{ type: "callout", x: 0.5, y: 0.5, text: "x".repeat(61) }]; });
    await bad((s) => { s[1].id = "s1"; });
    await bad((s) => { s[1].markups = Array.from({ length: 7 }, () => ({ type: "circle" as const, x: 0.5, y: 0.5, r: 0.1 })); });
    expect((await put(`/api/video-audits/${v.id}/plan`, { segments: [], narration: "recorded" })).status).toBe(400);
    expect((await put(`/api/video-audits/${v.id}/plan`, { segments: SEGMENTS(), narration: "robot" })).status).toBe(400);
    expect((await getVideoAudit(env.DB, v.id))!.plan!.version).toBe(v.plan!.version);
  });

  it("refuses a save made from an older copy of the plan", async () => {
    const { v } = await reviewing();
    const first = await put(`/api/video-audits/${v.id}/plan`, { segments: SEGMENTS(), narration: "recorded", version: v.plan!.version });
    expect(first.status).toBe(200);
    const stale = await put(`/api/video-audits/${v.id}/plan`, { segments: SEGMENTS(), narration: "recorded", version: v.plan!.version });
    expect(stale.status).toBe(409);
  });
});

describe("recordings", () => {
  it("stores a recording, marks the line recorded and keeps it through an unrelated edit", async () => {
    const { v } = await reviewing();
    const r = await record(v.id, "s2", bytes(1000), { "content-type": "audio/webm;codecs=opus", "x-duration-ms": "19500" });
    expect(r.status).toBe(200);
    const plan = (await getVideoAudit(env.DB, v.id))!.plan!;
    const text = plan.segments[1].text;
    expect(plan.segments[1].audio).toEqual({ key: `video/${v.id}/recordings/s2-${hashText(text)}.webm`, source: "recorded", durationMs: 19500, textHash: hashText(text) });
    const stored = await env.RAW.get(plan.segments[1].audio!.key);
    expect(stored?.size).toBe(1000);
    expect(plan.segments[0].audio).toBeUndefined();

    const get = await api(`/api/video-audits/${v.id}/segments/s2/recording`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("audio/webm");
    expect((await get.arrayBuffer()).byteLength).toBe(1000);
  });

  it("takes a wav and names the file by its kind", async () => {
    const { v } = await reviewing();
    expect((await record(v.id, "s1", bytes(50), { "content-type": "audio/wav" })).status).toBe(200);
    expect((await getVideoAudit(env.DB, v.id))!.plan!.segments[0].audio!.key).toMatch(/\/recordings\/s1-[0-9a-f]{8}\.wav$/);
  });

  it("a second take replaces the first and removes its file", async () => {
    const { v } = await reviewing();
    await record(v.id, "s1", bytes(100));
    const first = (await getVideoAudit(env.DB, v.id))!.plan!.segments[0].audio!.key;
    await record(v.id, "s1", bytes(120), { "content-type": "audio/wav" });
    const second = (await getVideoAudit(env.DB, v.id))!.plan!.segments[0].audio!.key;
    expect(second).not.toBe(first);
    expect(await env.RAW.get(first)).toBeNull();
    expect((await env.RAW.get(second))?.size).toBe(120);
  });

  it("recording upload over 8 MB is refused", async () => {
    const { v } = await reviewing();
    const r = await record(v.id, "s1", bytes(8 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect((await getVideoAudit(env.DB, v.id))!.plan!.segments[0].audio).toBeUndefined();
    const ok = await record(v.id, "s1", bytes(8 * 1024 * 1024));
    expect(ok.status).toBe(200);
  });

  it("refuses other types, a missing duration, an unknown line, an empty body, and any status but review", async () => {
    const { v } = await reviewing();
    expect((await record(v.id, "s1", bytes(10), { "content-type": "audio/mpeg" })).status).toBe(415);
    expect((await record(v.id, "s1", bytes(10), { "content-type": "video/webm" })).status).toBe(415);
    expect((await record(v.id, "s1", bytes(10), { "x-duration-ms": "abc" })).status).toBe(400);
    expect((await record(v.id, "s1", bytes(10), { "x-duration-ms": "0" })).status).toBe(400);
    expect((await record(v.id, "nope", bytes(10))).status).toBe(404);
    expect((await record("nope", "s1", bytes(10))).status).toBe(404);
    expect((await record(v.id, "s1", new Uint8Array(0))).status).toBe(400);
    await setVideoStatus(env.DB, v.id, "producing");
    expect((await record(v.id, "s1", bytes(10))).status).toBe(409);
  });
});

describe("removing a recording", () => {
  it("takes the line's recording and its file away", async () => {
    const { v } = await reviewing();
    await record(v.id, "s1", bytes(100));
    const key = (await getVideoAudit(env.DB, v.id))!.plan!.segments[0].audio!.key;
    const r = await api(`/api/video-audits/${v.id}/segments/s1/recording`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect((await getVideoAudit(env.DB, v.id))!.plan!.segments[0].audio).toBeUndefined();
    expect(await env.RAW.get(key)).toBeNull();
    expect((await api(`/api/video-audits/${v.id}/segments/s1/recording`, { method: "DELETE" })).status).toBe(200); // nothing left to take: fine
    expect((await api(`/api/video-audits/${v.id}/segments/nope/recording`, { method: "DELETE" })).status).toBe(404);
    await setVideoStatus(env.DB, v.id, "producing");
    expect((await api(`/api/video-audits/${v.id}/segments/s1/recording`, { method: "DELETE" })).status).toBe(409);
  });

  it("an edit that changes a line's words removes its recording file too", async () => {
    const { v } = await reviewing();
    await record(v.id, "s2", bytes(100));
    const key = (await getVideoAudit(env.DB, v.id))!.plan!.segments[1].audio!.key;
    const edited = SEGMENTS();
    edited[1].text = `${words(49)} changed`;
    await put(`/api/video-audits/${v.id}/plan`, { segments: edited, narration: "recorded" });
    expect(await env.RAW.get(key)).toBeNull();
  });
});

describe("approve", () => {
  const recordAll = async (id: string) => {
    for (const s of SEGMENTS()) expect((await record(id, s.id, bytes(100))).status).toBe(200);
  };

  it("approve is refused with blockers and returns them", async () => {
    const { v } = await reviewing(); // recorded narration, no recordings yet
    const r = await post(`/api/video-audits/${v.id}/approve`);
    expect(r.status).toBe(409);
    const body = await r.json<{ error: string; blockers: string[] }>();
    expect(body.blockers).toHaveLength(6);
    expect(body.blockers[0]).toMatch(/line 1.*recording/i);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("review");
  });

  it("is refused for an empty callout and for a length outside the window", async () => {
    const withCallout = SEGMENTS();
    withCallout[1].markups = [{ type: "callout", x: 0.5, y: 0.5, text: "" }];
    const { v } = await reviewing({ narration: "clone", segments: withCallout });
    const r = await post(`/api/video-audits/${v.id}/approve`);
    expect(r.status).toBe(409);
    expect((await r.json<any>()).blockers.join(" ")).toMatch(/callout/i);

    const short = SEGMENTS(); for (const i of [1, 2, 3]) short[i].text = words(10); // about 52 seconds
    const t = await reviewing({ narration: "clone", segments: short });
    const r2 = await post(`/api/video-audits/${t.v.id}/approve`);
    expect(r2.status).toBe(409);
    expect((await r2.json<any>()).blockers.join(" ")).toMatch(/seconds/);
  });

  it("is refused outside review and for an unknown video", async () => {
    const { v } = await reviewing({ narration: "clone", status: "scripting" });
    expect((await post(`/api/video-audits/${v.id}/approve`)).status).toBe(409);
    expect((await post(`/api/video-audits/nope/approve`)).status).toBe(404);
  });

  it("starts production when nothing blocks it", async () => {
    const { v } = await reviewing();
    await recordAll(v.id);
    const r = await post(`/api/video-audits/${v.id}/approve`);
    expect(r.status).toBe(202);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("producing");
  });

  it("approve twice starts production once", async () => {
    const { v } = await reviewing({ narration: "clone" });
    const [a, b] = await Promise.all([post(`/api/video-audits/${v.id}/approve`), post(`/api/video-audits/${v.id}/approve`)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect((await post(`/api/video-audits/${v.id}/approve`)).status).toBe(409);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("producing");
  });

  it("startProduction only moves a video that is in review, and says whether it did", async () => {
    const { v } = await reviewing({ narration: "clone" });
    const results = await Promise.all([startProduction(env, v.id), startProduction(env, v.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("producing");
    expect(await startProduction(env, "nope")).toBe(false);
  });
});

describe("cancel", () => {
  it("cancel frees the audit for a new video", async () => {
    const { b, audit, v } = await reviewing();
    expect(await createVideoAudit(env.DB, { businessId: b.id, auditId: audit.id })).toBeNull();
    const r = await post(`/api/video-audits/${v.id}/cancel`);
    expect(r.status).toBe(200);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("cancelled");
    expect(await createVideoAudit(env.DB, { businessId: b.id, auditId: audit.id })).not.toBeNull();
  });

  it("works from every open status", async () => {
    for (const status of ["capturing", "scripting", "review", "producing", "rendered"] as const) {
      const { v } = await reviewing({ status });
      expect((await post(`/api/video-audits/${v.id}/cancel`)).status, status).toBe(200);
    }
  });

  it("cancel after published is refused", async () => {
    const { v } = await reviewing({ status: "published" });
    expect((await post(`/api/video-audits/${v.id}/cancel`)).status).toBe(409);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("published");
    for (const status of ["failed", "cancelled"] as const) {
      const t = await reviewing({ status });
      expect((await post(`/api/video-audits/${t.v.id}/cancel`)).status, status).toBe(409);
    }
    expect((await post(`/api/video-audits/nope/cancel`)).status).toBe(404);
  });
});

describe("write it myself", () => {
  it("drops the queued script and goes back to editing the current plan", async () => {
    const { v } = await reviewing();
    expect((await post(`/api/video-audits/${v.id}/regenerate-script`)).status).toBe(202);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("scripting");
    const r = await post(`/api/video-audits/${v.id}/keep-script`);
    expect(r.status).toBe(200);
    expect((await getVideoAudit(env.DB, v.id))!).toMatchObject({ status: "review", plan: v.plan });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks WHERE status IN ('pending','claimed')`).first<{ n: number }>())!.n).toBe(0);
    expect((await put(`/api/video-audits/${v.id}/plan`, { segments: SEGMENTS(), narration: "recorded" })).status).toBe(200);
  });

  it("is refused outside a regenerate, and when there is no plan yet", async () => {
    const { v } = await reviewing();
    expect((await post(`/api/video-audits/${v.id}/keep-script`)).status).toBe(409);
    const first = await reviewing({ segments: [], status: "scripting" });
    expect((await post(`/api/video-audits/${first.v.id}/keep-script`)).status).toBe(409);
    expect((await post(`/api/video-audits/nope/keep-script`)).status).toBe(404);
  });

  it("cancel also closes a queued script", async () => {
    const { v } = await reviewing();
    await post(`/api/video-audits/${v.id}/regenerate-script`);
    expect((await post(`/api/video-audits/${v.id}/cancel`)).status).toBe(200);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks WHERE status IN ('pending','claimed')`).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("what the pages read", () => {
  it("GET carries the audit's finding codes and the lead's name for the editor", async () => {
    const { v, b } = await reviewing();
    const body = await (await api(`/api/video-audits/${v.id}`)).json<any>();
    expect(body.findingCodes).toEqual(["no_https", "no_cta", "slow_mobile"]);
    expect(body.business).toMatchObject({ id: b.id });
    expect(body.helperOnline).toBe(false);
  });

  it("shows a shot preview image", async () => {
    const { v } = await reviewing();
    const r = await api(`/api/video-audits/${v.id}/shots/d1/preview`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect((await r.arrayBuffer()).byteLength).toBe(3);
    expect((await api(`/api/video-audits/${v.id}/shots/zz/preview`)).status).toBe(404);
    expect((await api(`/api/video-audits/nope/shots/d1/preview`)).status).toBe(404);
  });

  it("GET /leads/:id/video returns the newest video or null", async () => {
    const b = await seedBusiness();
    const none = await api(`/api/leads/${b.id}/video`);
    expect(none.status).toBe(200);
    expect((await none.json<any>()).video).toBeNull();
    const t = await reviewing();
    const r = await api(`/api/leads/${t.b.id}/video`);
    expect((await r.json<any>()).video).toMatchObject({ id: t.v.id, status: "review" });
    expect((await api(`/api/leads/nope/video`)).status).toBe(404);
  });
});
