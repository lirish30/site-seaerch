import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createDevice } from "../src/worker/helper/auth";
import { claimHelperJob, completeHelperJob, expireOldHelperJobs, failHelperJob, getHelperJob, helperJobsForVideo } from "../src/worker/helper/jobs";
import { VOICE_SEGMENT_KIND, getHelperKind, voiceSegmentKey } from "../src/worker/helper/kinds";
import { createVideoAudit, getVideoAudit, savePlan, setVideoStatus } from "../src/worker/db/videoAudits";
import { RENDER_KIND, renderKeys, type RenderPayload } from "../src/worker/video/renderJob";
import { hashText, type Segment, type Shot, type VideoPlan } from "../src/worker/video/plan";
import { enqueueRender, startProduction } from "../src/worker/video/production";
import { insertTestAudit } from "./fixtures/video";
import { seedBusiness } from "./fixtures/cro";

const renderJobs = async (videoId?: string) =>
  (await env.DB.prepare(`SELECT * FROM helper_jobs WHERE kind = 'render' ${videoId ? "AND video_id = ?" : ""} ORDER BY created_at, id`).bind(...(videoId ? [videoId] : [])).all<Record<string, any>>()).results;
const approvals = async () => (await env.DB.prepare(`SELECT * FROM approvals WHERE kind = 'video.publish'`).all<Record<string, any>>()).results;

let devA = "";
let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.prepare(`UPDATE settings SET voice_engine = 'qwen3-tts', voice_ref_key = 'voice-reference/reference.wav', your_name = 'Logan Irish', business_name = 'Siteline', booking_url = 'https://hellositeline.com/book' WHERE id = 1`).run();
  await env.DB.batch(["helper_jobs", "helper_devices", "agent_actions", "approvals"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  devA = (await createDevice(env.DB, "Mac A")).device.id;
});

const api = (path: string, init: RequestInit = {}) => SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

/** A video with a plan of the given lines (over one desktop shot), in the given status. `voiced` puts a cloned-voice file on every line. */
async function video(o: { status?: "review" | "producing" | "rendered" | "cancelled"; lines?: number; voiced?: boolean; narration?: VideoPlan["narration"] } = {}) {
  const b = await seedBusiness({ name: "Ace Plumbing" });
  const audit = await insertTestAudit(b.id);
  const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: audit.id }))!;
  const shots: Shot[] = [{ id: "d1", viewport: "desktop", scrollY: 0, width: 1280, height: 2400, fullKey: `video/${v.id}/shots/d1.jpg`, previewKey: `video/${v.id}/shots/d1.preview.jpg` }];
  const n = o.lines ?? 2;
  const segments: Segment[] = Array.from({ length: n }, (_, i) => {
    const text = `${words(9)} number ${i + 1}`;
    const s: Segment = { id: `s${i + 1}`, role: i === 0 ? "hook" : i === n - 1 ? "cta" : "problem", text, shotId: "d1", markups: i === 0 ? [{ type: "circle", x: 0.5, y: 0.2, r: 0.1 }] : [] };
    if (s.role === "problem") s.findingCode = "no_https";
    if (o.voiced) s.audio = { key: voiceSegmentKey({ videoId: v.id, segmentId: s.id, text }), source: "clone", durationMs: 4000, textHash: hashText(text) };
    return s;
  });
  await savePlan(env.DB, v.id, { shots, segments, narration: o.narration ?? "clone", version: 0 });
  await setVideoStatus(env.DB, v.id, o.status ?? "producing");
  return { b, v: (await getVideoAudit(env.DB, v.id))!, shots, segments };
}

/** The three files a render job may write. */
const outputsOf = (videoId: string, version: number) => renderKeys(videoId, version);
const putOutputs = async (videoId: string, version: number) => {
  const k = outputsOf(videoId, version);
  for (const key of [k.mp4, k.gif, k.jpg]) await env.RAW.put(key, new Uint8Array([1, 2, 3]));
  return k;
};
const resultFor = (videoId: string, version: number) => {
  const k = outputsOf(videoId, version);
  return { videoKey: k.mp4, gifKey: k.gif, posterKey: k.jpg, durationMs: 95_000, bytes: 3 };
};
const claimRender = async () => (await claimHelperJob(env.DB, devA, new Date(), [RENDER_KIND]))!;

describe("enqueueRender", () => {
  it("queues one render job for a video whose lines all have audio, with everything the helper needs", async () => {
    const { v, shots, segments } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const rows = await renderJobs(v.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "render", video_id: v.id, status: "pending", dedupe_key: `${v.id}:${v.plan!.version}` });
    const p = JSON.parse(rows[0].payload) as RenderPayload;
    expect(p).toMatchObject({ videoId: v.id, planVersion: v.plan!.version, brand: { name: "Logan Irish", business: "Siteline" } });
    expect(p.ctaText).toContain("hellositeline.com/book");
    expect(p.plan.shots).toEqual(shots);
    expect(p.plan.segments.map((s) => s.id)).toEqual(segments.map((s) => s.id));
    expect(p.inputs).toEqual([shots[0].fullKey, ...segments.map((s) => voiceSegmentKey({ videoId: v.id, segmentId: s.id, text: s.text }))]);
    // what the helper is handed: the same inputs and the three output files, computed here
    const job = await claimRender();
    const def = getHelperKind(RENDER_KIND)!;
    expect(def.inputs(job.payload)).toEqual(p.inputs);
    expect(def.outputs(job.payload)).toEqual([`video/${v.id}/out/v${v.plan!.version}.mp4`, `video/${v.id}/out/v${v.plan!.version}.gif`, `video/${v.id}/out/v${v.plan!.version}.jpg`]);
  });

  it("a recorded line's file is an input as well", async () => {
    const { v, segments } = await video({ voiced: true });
    const rec = { key: `video/${v.id}/recordings/s1-${hashText(segments[0].text)}.webm`, source: "recorded" as const, durationMs: 3000, textHash: hashText(segments[0].text) };
    await savePlan(env.DB, v.id, { ...v.plan!, segments: v.plan!.segments.map((s) => (s.id === "s1" ? { ...s, audio: rec } : s)) });
    await enqueueRender(env, v.id);
    expect((JSON.parse((await renderJobs(v.id))[0].payload) as RenderPayload).inputs).toContain(rec.key);
  });

  it("a render job is not enqueued until every line has audio", async () => {
    const { v } = await video({ voiced: false });
    await enqueueRender(env, v.id);
    expect(await renderJobs()).toHaveLength(0);
    // one of two lines voiced is still not enough
    const half = await video({ voiced: false });
    const s1 = half.segments[0];
    await savePlan(env.DB, half.v.id, { ...half.v.plan!, segments: half.v.plan!.segments.map((s) => (s.id === "s1" ? { ...s, audio: { key: "k", source: "clone" as const, durationMs: 1, textHash: hashText(s1.text) } } : s)) });
    await enqueueRender(env, half.v.id);
    expect(await renderJobs()).toHaveLength(0);
    // a line whose audio is for older words does not count either
    const stale = await video({ voiced: true });
    await savePlan(env.DB, stale.v.id, { ...stale.v.plan!, segments: stale.v.plan!.segments.map((s) => (s.id === "s2" ? { ...s, text: "completely different words for this line" } : s)) });
    await enqueueRender(env, stale.v.id);
    expect(await renderJobs()).toHaveLength(0);
  });

  it("nothing is queued for a video that is not producing", async () => {
    for (const status of ["review", "cancelled", "rendered"] as const) {
      const { v } = await video({ voiced: true, status });
      await enqueueRender(env, v.id);
    }
    expect(await renderJobs()).toHaveLength(0);
    await expect(enqueueRender(env, "nope")).resolves.toBeUndefined();
  });

  it("calling it again for the same plan does not queue a second job", async () => {
    const { v } = await video({ voiced: true });
    await Promise.all([enqueueRender(env, v.id), enqueueRender(env, v.id), enqueueRender(env, v.id)]);
    await enqueueRender(env, v.id);
    expect(await renderJobs(v.id)).toHaveLength(1);
  });

  it("a render job is enqueued once for two simultaneous last lines", async () => {
    const { v } = await video({ voiced: false, lines: 2, status: "review" });
    expect(await startProduction(env, v.id)).toBe(true);
    const claimed = [(await claimHelperJob(env.DB, devA, new Date(), [VOICE_SEGMENT_KIND]))!, (await claimHelperJob(env.DB, devA, new Date(), [VOICE_SEGMENT_KIND]))!];
    expect(claimed.every(Boolean)).toBe(true);
    const text = (j: { payload: unknown }) => (j.payload as { text: string; segmentId: string });
    for (const j of claimed) await env.RAW.put(voiceSegmentKey({ videoId: v.id, segmentId: text(j).segmentId, text: text(j).text }), new Uint8Array([1]));
    const results = await Promise.all(claimed.map((j) => completeHelperJob(env, j.id, devA, { key: voiceSegmentKey({ videoId: v.id, segmentId: text(j).segmentId, text: text(j).text }), durationMs: 4000 })));
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(await renderJobs(v.id)).toHaveLength(1);
    // a crash-retried apply of the last line (the worker died after writing the audio) is no second render either
    const def = getHelperKind(VOICE_SEGMENT_KIND)!;
    const last = claimed[1];
    const before = (await getVideoAudit(env.DB, v.id))!.plan!.version;
    await def.apply(env, last.payload, { key: voiceSegmentKey({ videoId: v.id, segmentId: text(last).segmentId, text: text(last).text }), durationMs: 4000 });
    expect((await getVideoAudit(env.DB, v.id))!.plan!.version).toBe(before); // the same audio is not written again
    expect(await renderJobs(v.id)).toHaveLength(1);
  });
});

describe("the render job", () => {
  it("render result sets rendered and creates one publish approval", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const job = await claimRender();
    const k = await putOutputs(v.id, v.plan!.version);
    expect(await completeHelperJob(env, job.id, devA, resultFor(v.id, v.plan!.version))).toEqual({ ok: true });
    const after = (await getVideoAudit(env.DB, v.id))!;
    expect(after).toMatchObject({ status: "rendered", video_key: k.mp4, gif_key: k.gif, poster_key: k.jpg, duration_ms: 95_000, error: null });
    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "video.publish", status: "pending", id: after.publish_approval_id });
    expect(JSON.parse(rows[0].payload)).toEqual({ videoId: v.id });
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("done");
  });

  it("a second apply after a crash makes no second approval, and finishes one a crash cut short", async () => {
    const { v } = await video({ voiced: true });
    const version = v.plan!.version;
    await enqueueRender(env, v.id);
    const job = await claimRender();
    await putOutputs(v.id, version);
    await completeHelperJob(env, job.id, devA, resultFor(v.id, version));
    const def = getHelperKind(RENDER_KIND)!;
    await def.apply(env, job.payload, resultFor(v.id, version)); // the retry
    expect(await approvals()).toHaveLength(1);
    // The crash happened after `rendered` was written and before the approval was: the retry makes it.
    await env.DB.prepare(`DELETE FROM approvals`).run();
    await env.DB.prepare(`UPDATE video_audits SET publish_approval_id = NULL WHERE id = ?`).bind(v.id).run();
    await def.apply(env, job.payload, resultFor(v.id, version));
    await def.apply(env, job.payload, resultFor(v.id, version));
    expect(await approvals()).toHaveLength(1);
    expect((await getVideoAudit(env.DB, v.id))!.publish_approval_id).not.toBeNull();
  });

  it("render result for an older plan version is discarded", async () => {
    const { v } = await video({ voiced: true });
    const old = v.plan!.version;
    await enqueueRender(env, v.id);
    const job = await claimRender();
    await putOutputs(v.id, old);
    // the plan changed while the Mac was rendering
    await savePlan(env.DB, v.id, (await getVideoAudit(env.DB, v.id))!.plan!);
    expect(await completeHelperJob(env, job.id, devA, resultFor(v.id, old))).toEqual({ ok: true });
    const after = (await getVideoAudit(env.DB, v.id))!;
    expect(after.status).toBe("producing");
    expect(after.video_key).toBeNull();
    expect(await approvals()).toHaveLength(0);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("done");
  });

  it("a render result for a video that is no longer producing is discarded", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const job = await claimRender();
    await putOutputs(v.id, v.plan!.version);
    await setVideoStatus(env.DB, v.id, "cancelled");
    expect(await completeHelperJob(env, job.id, devA, resultFor(v.id, v.plan!.version))).toEqual({ ok: true });
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("cancelled");
    expect(await approvals()).toHaveLength(0);
  });

  it("a result that names some other file is refused and the job stays claimed", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const job = await claimRender();
    await putOutputs(v.id, v.plan!.version);
    const bad = { ...resultFor(v.id, v.plan!.version), videoKey: "video/someone-else/out/v1.mp4" };
    const r = await completeHelperJob(env, job.id, devA, bad);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/output/);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("claimed");
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("producing");
  });

  it("a result for files that were never uploaded is refused", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const job = await claimRender();
    const r = await completeHelperJob(env, job.id, devA, resultFor(v.id, v.plan!.version));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/never uploaded/);
    expect(await approvals()).toHaveLength(0);
  });

  it("a failed render sets failed with the helper's error", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const job = await claimRender();
    expect(await failHelperJob(env, job.id, devA, "hyperframes exited with code 1: Chrome not found")).toBe(true);
    const after = (await getVideoAudit(env.DB, v.id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toContain("Chrome not found");
    expect(await approvals()).toHaveLength(0);
  });

  it("a failed render does not touch a video that moved on", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const job = await claimRender();
    await setVideoStatus(env.DB, v.id, "cancelled");
    await failHelperJob(env, job.id, devA, "too late");
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("cancelled");
  });

  it("a render nobody picked up fails the video with a reason the owner can act on", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    await expireOldHelperJobs(env, new Date(Date.now() + 30 * 86_400_000));
    const after = (await getVideoAudit(env.DB, v.id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/helper/i);
  });
});

describe("editing the plan after production started", () => {
  const SEGMENTS = (): Segment[] => [
    { id: "s1", role: "hook", text: words(30), shotId: "d1", markups: [] },
    { id: "s2", role: "problem", findingCode: "no_https", text: words(50), shotId: "d1", markups: [] },
    { id: "s3", role: "problem", findingCode: "no_cta", text: words(50), shotId: "d1", markups: [] },
    { id: "s4", role: "problem", findingCode: "slow_mobile", text: words(50), shotId: "d1", markups: [] },
    { id: "s5", role: "offer", text: words(40), shotId: "d1", markups: [] },
    { id: "s6", role: "cta", text: words(30), shotId: "d1", markups: [] },
  ];

  it("editing the plan cancels open jobs and returns to review", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    // another voice line still waiting
    await env.DB.prepare(`INSERT INTO helper_jobs (id, kind, video_id, payload, status, dedupe_key, attempts, created_at) VALUES ('vj', 'voice.segment', ?, '{}', 'pending', 'x', 0, ?)`).bind(v.id, new Date().toISOString()).run();
    const segments = v.plan!.segments.map((s) => ({ ...s, text: s.id === "s1" ? `${s.text} edited` : s.text }));
    const r = await api(`/api/video-audits/${v.id}/plan`, { method: "PUT", body: JSON.stringify({ segments, narration: "clone" }) });
    expect(r.status).toBe(200);
    const after = (await getVideoAudit(env.DB, v.id))!;
    expect(after.status).toBe("review");
    expect(after.plan!.version).toBeGreaterThan(v.plan!.version);
    expect(after.plan!.segments[0].audio).toBeUndefined(); // the edited line lost its audio, the other kept it
    expect(after.plan!.segments[1].audio).toBeDefined();
    const jobs = await helperJobsForVideo(env.DB, v.id);
    expect(jobs.map((j) => j.status)).toEqual(["expired", "expired"]);
    // and a render result that arrives late is discarded
    expect(await approvals()).toHaveLength(0);
  });

  it("a render that finishes after the edit is thrown away", async () => {
    const { v } = await video({ voiced: true });
    await enqueueRender(env, v.id);
    const job = await claimRender(); // claimed: the Mac is rendering right now
    const segments = v.plan!.segments.map((s) => ({ ...s, markups: s.id === "s2" ? [{ type: "circle" as const, x: 0.3, y: 0.3, r: 0.1 }] : s.markups }));
    expect((await api(`/api/video-audits/${v.id}/plan`, { method: "PUT", body: JSON.stringify({ segments, narration: "clone" }) })).status).toBe(200);
    await putOutputs(v.id, v.plan!.version);
    const r = await completeHelperJob(env, job.id, devA, resultFor(v.id, v.plan!.version));
    expect(r.ok).toBe(false); // the job was closed with the edit
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("review");
    expect(await approvals()).toHaveLength(0);
  });

  it("a plan can still be edited in review, and a rendered or cancelled video refuses it", async () => {
    for (const status of ["rendered", "cancelled"] as const) {
      const { v } = await video({ voiced: true, status });
      const r = await api(`/api/video-audits/${v.id}/plan`, { method: "PUT", body: JSON.stringify({ segments: v.plan!.segments, narration: "clone" }) });
      expect(r.status).toBe(409);
    }
    const { v } = await video({ voiced: true, status: "review" });
    expect((await api(`/api/video-audits/${v.id}/plan`, { method: "PUT", body: JSON.stringify({ segments: v.plan!.segments, narration: "clone" }) })).status).toBe(200);
  });

  it("approve refuses a saved plan that is not a hook, three problems, an offer and a cta", async () => {
    const { v } = await video({ voiced: true, status: "review", lines: 6 });
    const bad = SEGMENTS().map((s) => ({ ...s, audio: undefined }));
    bad[4] = { ...bad[4], role: "hook" }; // two hooks, no offer
    await savePlan(env.DB, v.id, { ...v.plan!, segments: bad, narration: "clone" });
    // the shots/findings of this video do not matter here: a structure problem is listed whatever else is
    const r = await api(`/api/video-audits/${v.id}/approve`, { method: "POST", body: "{}" });
    expect(r.status).toBe(409);
    const body = await r.json<{ blockers: string[] }>();
    const text = body.blockers.join(" ");
    expect(text).toMatch(/exactly one hook/);
    expect(text).toMatch(/exactly one offer/);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("review");
  });
});
