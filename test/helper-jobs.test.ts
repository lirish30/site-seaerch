import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  CLAIM_TTL_MS, MAX_ATTEMPTS, cancelHelperJobsFor, claimHelperJob, completeHelperJob, enqueueHelperJob, expireOldHelperJobs, failHelperJob, getHelperJob, helperStatus,
} from "../src/worker/helper/jobs";
import { createDevice } from "../src/worker/helper/auth";
import { VOICE_SEGMENT_KIND } from "../src/worker/helper/kinds";
import { createVideoAudit, getVideoAudit, savePlan, setVideoStatus } from "../src/worker/db/videoAudits";
import { listAgentActions } from "../src/worker/db/agentActions";
import { hashText, type Segment, type VideoPlan } from "../src/worker/video/plan";
import { productionDeps, startProduction } from "../src/worker/video/production";
import { helperKindLog, registerHelperTestKinds, resetHelperKindLog, unregisterHelperTestKinds } from "./helper-kinds";

const NOW = new Date("2026-11-18T18:00:00.000Z");
const MIN = 60_000, DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const all = async () => (await env.DB.prepare(`SELECT * FROM helper_jobs ORDER BY created_at, id`).all<Record<string, any>>()).results;

let devA = "", devB = "";
beforeAll(registerHelperTestKinds);
afterAll(unregisterHelperTestKinds);
beforeEach(async () => {
  await env.DB.prepare(`UPDATE settings SET voice_engine = 'qwen3-tts', voice_ref_key = 'voice-reference/reference.wav' WHERE id = 1`).run(); // the cloned voice is set up
  resetHelperKindLog();
  await env.DB.batch(["helper_jobs", "helper_devices", "agent_actions", "video_audits"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  devA = (await createDevice(env.DB, "Mac A")).device.id;
  devB = (await createDevice(env.DB, "Mac B")).device.id;
});

describe("the helper job queue", () => {
  it("enqueue twice with one key creates one job", async () => {
    const a = await enqueueHelperJob(env.DB, "test.helper", { n: 1 }, { dedupeKey: "k1" });
    const b = await enqueueHelperJob(env.DB, "test.helper", { n: 2 }, { dedupeKey: "k1" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(await all()).toHaveLength(1);
    // A finished job frees the key.
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE id = ?`).bind(a.id).run();
    const c = await enqueueHelperJob(env.DB, "test.helper", { n: 3 }, { dedupeKey: "k1" });
    expect(c.created).toBe(true);
    expect(c.id).not.toBe(a.id);
  });

  it("refuses a kind nobody registered and a payload the kind does not accept", async () => {
    await expect(enqueueHelperJob(env.DB, "nope", {})).rejects.toThrow(/unknown helper kind/);
    await expect(enqueueHelperJob(env.DB, "test.helper", { n: "x" })).rejects.toThrow(/invalid payload/);
    expect(await all()).toHaveLength(0);
  });

  it("claim is atomic across two devices", async () => {
    await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    const [a, b] = await Promise.all([claimHelperJob(env.DB, devA, NOW), claimHelperJob(env.DB, devB, NOW)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const job = (a ?? b)!;
    expect(job).toMatchObject({ status: "claimed", attempts: 1, payload: { n: 1 } });
    expect(job.claimed_by).toBe(a ? devA : devB);
    expect(await claimHelperJob(env.DB, devA, NOW)).toBeNull();
  });

  it("claims the oldest job first and honours the kinds filter", async () => {
    await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    expect(await claimHelperJob(env.DB, devA, NOW, ["render"])).toBeNull();
    expect(await claimHelperJob(env.DB, devA, NOW, [])).toBeNull();
    expect(await claimHelperJob(env.DB, devA, NOW, ["test.helper"])).not.toBeNull();
  });

  it("stale claim is reclaimed and attempts counted", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    expect((await claimHelperJob(env.DB, devA, NOW))!.attempts).toBe(1);
    expect(CLAIM_TTL_MS).toBe(20 * MIN);
    expect(await claimHelperJob(env.DB, devB, at(19 * MIN))).toBeNull(); // still held
    const again = (await claimHelperJob(env.DB, devB, at(21 * MIN)))!;
    expect(again).toMatchObject({ id, attempts: 2, claimed_by: devB, status: "claimed" });
  });

  it("fourth reclaim fails the job", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    expect(MAX_ATTEMPTS).toBe(4);
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await claimHelperJob(env.DB, devA, at(i * 21 * MIN)))!.attempts).toBe(i + 1);
    expect(await claimHelperJob(env, devA, at(MAX_ATTEMPTS * 21 * MIN))).toBeNull();
    const job = (await getHelperJob(env.DB, id))!;
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/gave up/);
    expect(helperKindLog.failed).toHaveLength(1); // the kind's hook ran once, since the whole env was passed
  });

  it("invalid result is rejected and applies nothing", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    await claimHelperJob(env.DB, devA, NOW);
    const r = await completeHelperJob(env, id, devA, { ok: "yes" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/invalid result/);
    expect(helperKindLog.applied).toHaveLength(0);
    expect((await getHelperJob(env.DB, id))!.status).toBe("claimed"); // the helper can fix it and try again
    expect(await completeHelperJob(env, id, devA, { ok: true })).toEqual({ ok: true });
    expect(helperKindLog.applied).toHaveLength(1);
  });

  it("completing twice applies once", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    await claimHelperJob(env.DB, devA, NOW);
    const [a, b] = await Promise.all([completeHelperJob(env, id, devA, { ok: true }), completeHelperJob(env, id, devA, { ok: true })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(await completeHelperJob(env, id, devA, { ok: true })).toEqual({ ok: false, error: "already done" });
    expect(helperKindLog.applied).toHaveLength(1);
    const job = (await getHelperJob(env.DB, id))!;
    expect(job).toMatchObject({ status: "done", result: { ok: true } });
    expect(job.done_at).toBeTruthy();
  });

  it("completion from a device that does not hold the claim is refused", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    await claimHelperJob(env.DB, devA, NOW);
    const r = await completeHelperJob(env, id, devB, { ok: true });
    expect(r).toEqual({ ok: false, error: "this job is not claimed by this device" });
    expect(await failHelperJob(env, id, devB, "nope")).toBe(false);
    expect(helperKindLog.applied).toHaveLength(0);
    expect((await getHelperJob(env.DB, id))!).toMatchObject({ status: "claimed", claimed_by: devA });
    expect(await completeHelperJob(env, "missing", devA, { ok: true })).toEqual({ ok: false, error: "job not found" });
  });

  it("a device that lost its claim to a reclaim cannot complete", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    await claimHelperJob(env.DB, devA, NOW);
    await claimHelperJob(env.DB, devB, at(21 * MIN));
    expect((await completeHelperJob(env, id, devA, { ok: true })).ok).toBe(false);
    expect(await completeHelperJob(env, id, devB, { ok: true })).toEqual({ ok: true });
  });

  it("logs one agent action per claim and per completion, as the helper", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 1 });
    await claimHelperJob(env.DB, devA, NOW);
    await completeHelperJob(env, id, devA, { ok: true });
    const actions = await listAgentActions(env.DB, {});
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.actor === "helper")).toBe(true);
    expect(actions.map((a) => a.tool).sort()).toEqual(["helper.claim", "helper.complete"]);
  });

  it("a failed job runs its kind's hook and cannot be completed", async () => {
    const { id } = await enqueueHelperJob(env.DB, "test.helper", { n: 7 });
    await claimHelperJob(env.DB, devA, NOW);
    expect(await failHelperJob(env, id, devA, "ffmpeg is missing")).toBe(true);
    expect(await failHelperJob(env, id, devA, "again")).toBe(false);
    expect(await getHelperJob(env.DB, id)).toMatchObject({ status: "failed", error: "ffmpeg is missing" });
    expect(helperKindLog.failed).toEqual([{ payload: { n: 7 }, error: "ffmpeg is missing" }]);
    expect((await completeHelperJob(env, id, devA, { ok: true })).ok).toBe(false);
  });

  it("expireOldHelperJobs expires after 14 days", async () => {
    const old = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
    const seed = (id: string, status: string, created: string) =>
      env.DB.prepare(`INSERT INTO helper_jobs (id, kind, payload, status, attempts, created_at) VALUES (?, 'test.helper', '{"n":1}', ?, 0, ?)`).bind(id, status, created).run();
    await seed("old-pending", "pending", old(15)); await seed("old-claimed", "claimed", old(20)); await seed("new", "pending", old(13)); await seed("old-done", "done", old(30));
    expect(await expireOldHelperJobs(env, NOW)).toBe(2);
    const status = async (id: string) => (await getHelperJob(env.DB, id))!.status;
    expect(await status("old-pending")).toBe("expired");
    expect(await status("old-claimed")).toBe("expired");
    expect(await status("new")).toBe("pending");
    expect(await status("old-done")).toBe("done");
    expect(helperKindLog.expired).toHaveLength(2);
  });

  it("cancelHelperJobsFor closes the open jobs of one video and no others", async () => {
    await enqueueHelperJob(env.DB, "test.helper", { n: 1 }, { videoId: "v1", dedupeKey: "a" });
    await enqueueHelperJob(env.DB, "test.helper", { n: 2 }, { videoId: "v1", dedupeKey: "b" });
    const other = await enqueueHelperJob(env.DB, "test.helper", { n: 3 }, { videoId: "v2", dedupeKey: "c" });
    expect(await cancelHelperJobsFor(env.DB, "v1")).toBe(2);
    expect((await getHelperJob(env.DB, other.id))!.status).toBe("pending");
    expect((await all()).filter((j) => j.video_id === "v1").every((j) => j.status === "expired")).toBe(true);
  });

  it("helperStatus: online within 3 minutes of a check-in, and what is waiting per kind", async () => {
    await enqueueHelperJob(env.DB, "test.helper", { n: 1 }, { dedupeKey: "a" });
    await enqueueHelperJob(env.DB, "test.helper", { n: 2 }, { dedupeKey: "b" });
    expect(await helperStatus(env.DB, NOW)).toEqual({ online: false, lastSeenAt: null, pending: { "test.helper": 2 } });
    await env.DB.prepare(`UPDATE helper_devices SET last_seen_at = ? WHERE id = ?`).bind(at(-2 * MIN).toISOString(), devA).run();
    expect(await helperStatus(env.DB, NOW)).toMatchObject({ online: true, lastSeenAt: at(-2 * MIN).toISOString() });
    expect((await helperStatus(env.DB, at(2 * MIN))).online).toBe(false);
    // A revoked device does not count, however recently it was seen.
    await env.DB.prepare(`UPDATE helper_devices SET revoked_at = ? WHERE id = ?`).bind(NOW.toISOString(), devA).run();
    expect((await helperStatus(env.DB, NOW)).online).toBe(false);
  });
});

describe("producing a video", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  const shot = { id: "d1", viewport: "desktop" as const, scrollY: 0, width: 1280, height: 720, fullKey: "f", previewKey: "p" };
  const seg = (id: string, text: string, o: Partial<Segment> = {}): Segment => ({ id, role: "problem", findingCode: "x", text, shotId: "d1", markups: [], ...o });
  const recorded = (id: string, text: string) => ({ key: `video/v/recordings/${id}.wav`, source: "recorded" as const, durationMs: 4000, textHash: hashText(text) });
  const cloned = (id: string, text: string) => ({ key: `video/v/audio/${id}-${hashText(text)}.wav`, source: "clone" as const, durationMs: 4000, textHash: hashText(text) });

  /** A video in review whose plan has the given segments. */
  async function inReview(segments: Segment[], narration: VideoPlan["narration"] = "clone") {
    const v = (await createVideoAudit(env.DB, { businessId: "b1", auditId: crypto.randomUUID() }))!;
    await savePlan(env.DB, v.id, { shots: [shot], segments, narration, version: 0 });
    await setVideoStatus(env.DB, v.id, "review");
    return v.id;
  }
  const renders: string[] = [];
  const realRender = productionDeps.enqueueRender;
  beforeEach(() => { renders.length = 0; productionDeps.enqueueRender = async (_env, videoId) => { renders.push(videoId); }; });
  afterEach(() => { productionDeps.enqueueRender = realRender; });
  const jobs = async () => (await all()).filter((j) => j.kind === VOICE_SEGMENT_KIND);
  const key = (videoId: string, s: Segment) => `video/${videoId}/audio/${s.id}-${hashText(s.text)}.wav`;

  it("startProduction enqueues one voice job per stale cloned line and none for recorded lines", async () => {
    const lines = [seg("s1", "Hello there friend"), seg("s2", "A recorded line", { audio: recorded("s2", "A recorded line") }), seg("s3", "An edited line", { audio: { ...cloned("s3", "old words"), textHash: hashText("old words") } }), seg("s4", "Already voiced", { audio: cloned("s4", "Already voiced") })];
    const id = await inReview(lines);
    expect(await startProduction(env, id)).toBe(true);
    expect((await getVideoAudit(env.DB, id))!.status).toBe("producing");
    const rows = await jobs();
    expect(rows.map((j) => JSON.parse(j.payload).segmentId).sort()).toEqual(["s1", "s3"]);
    expect(rows.every((j) => j.video_id === id && j.status === "pending")).toBe(true);
    expect(rows.map((j) => j.dedupe_key).sort()).toEqual([`${id}:s1:${hashText("Hello there friend")}`, `${id}:s3:${hashText("An edited line")}`]);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ videoId: id, engine: expect.any(String), text: expect.any(String) });
    expect(renders).toEqual([]); // there is voice work to wait for
    // A second approve does nothing more.
    expect(await startProduction(env, id)).toBe(false);
    expect(await jobs()).toHaveLength(2);
  });

  it("startProduction goes straight to the render when every line already has audio", async () => {
    const id = await inReview([seg("s1", "Spoken by me", { audio: recorded("s1", "Spoken by me") }), seg("s2", "Spoken by me too", { audio: recorded("s2", "Spoken by me too") })], "recorded");
    await startProduction(env, id);
    expect(await jobs()).toHaveLength(0);
    expect(renders).toEqual([id]);
  });

  /** Runs the next voice job the way the helper would: claim it, put the wav in R2, complete it. Says which line it was for. */
  async function voice(videoId: string, lines: Segment[], o: { key?: string } = {}) {
    const job = (await claimHelperJob(env.DB, devA, NOW, [VOICE_SEGMENT_KIND]))!;
    const seg = lines.find((l) => l.id === (job.payload as { segmentId: string }).segmentId)!;
    const out = o.key ?? key(videoId, seg);
    await env.RAW.put(out, new Uint8Array([1, 2, 3]));
    return { job, seg, result: await completeHelperJob(env, job.id, devA, { key: out, durationMs: 4200 }) };
  }

  it("a finished voice job puts the audio on its line", async () => {
    const lines = [seg("s1", "First line here"), seg("s2", "Second line here")];
    const id = await inReview(lines);
    await startProduction(env, id);
    const done = await voice(id, lines);
    expect(done.result).toEqual({ ok: true });
    const plan = (await getVideoAudit(env.DB, id))!.plan!;
    const [mine, other] = done.seg.id === "s1" ? plan.segments : [...plan.segments].reverse();
    expect(mine.audio).toEqual({ key: key(id, done.seg), source: "clone", durationMs: 4200, textHash: hashText(done.seg.text) });
    expect(other.audio).toBeUndefined();
    expect(renders).toEqual([]);
  });

  it("finishing the last line enqueues one render", async () => {
    const lines = [seg("s1", "First line here"), seg("s2", "Second line here"), seg("s3", "Kept recording", { audio: recorded("s3", "Kept recording") })];
    const id = await inReview(lines);
    await startProduction(env, id);
    await voice(id, lines);
    expect(renders).toEqual([]);
    await voice(id, lines);
    expect(renders).toEqual([id]);
    expect((await getVideoAudit(env.DB, id))!.status).toBe("producing");
  });

  it("two lines finishing at the same moment both keep their audio", async () => {
    const lines = [seg("s1", "First line here"), seg("s2", "Second line here")];
    const id = await inReview(lines);
    await startProduction(env, id);
    const claimed = [(await claimHelperJob(env.DB, devA, NOW))!, (await claimHelperJob(env.DB, devA, NOW))!];
    for (const s of lines) await env.RAW.put(key(id, s), new Uint8Array([1]));
    await Promise.all(claimed.map((j) => completeHelperJob(env, j.id, devA, { key: key(id, lines[(j.payload as { segmentId: string }).segmentId === "s1" ? 0 : 1]), durationMs: 1000 })));
    const plan = (await getVideoAudit(env.DB, id))!.plan!;
    expect(plan.segments.map((s) => s.audio?.source)).toEqual(["clone", "clone"]);
  });

  it("a late result for an edited line is discarded", async () => {
    const lines = [seg("s1", "First line here")];
    const id = await inReview(lines);
    await startProduction(env, id);
    const job = (await claimHelperJob(env.DB, devA, NOW))!;
    // The words change while the Mac works (the plan is rewritten by hand here; the editor itself only allows it in review).
    const v = (await getVideoAudit(env.DB, id))!;
    await savePlan(env.DB, id, { ...v.plan!, segments: [{ ...lines[0], text: "Completely different words" }] });
    await env.RAW.put(key(id, lines[0]), new Uint8Array([1]));
    expect(await completeHelperJob(env, job.id, devA, { key: key(id, lines[0]), durationMs: 1000 })).toEqual({ ok: true });
    expect((await getVideoAudit(env.DB, id))!.plan!.segments[0].audio).toBeUndefined();
    expect(renders).toEqual([]);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("done");
  });

  it("a result for a video that is no longer producing, or a line that is gone, is discarded", async () => {
    const lines = [seg("s1", "First line here"), seg("s2", "Second line here")];
    const id = await inReview(lines);
    await startProduction(env, id);
    await setVideoStatus(env.DB, id, "cancelled");
    expect((await voice(id, lines)).result).toEqual({ ok: true });
    const plan = (await getVideoAudit(env.DB, id))!.plan!;
    expect(plan.segments.every((s) => !s.audio)).toBe(true);
    expect(renders).toEqual([]);
  });

  it("a result naming some other file is refused and the job stays claimed", async () => {
    const lines = [seg("s1", "First line here")];
    const id = await inReview(lines);
    await startProduction(env, id);
    const { job, result } = await voice(id, lines, { key: "video/other/secret.wav" });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/output/);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("claimed");
    expect((await getVideoAudit(env.DB, id))!.plan!.segments[0].audio).toBeUndefined();
  });

  it("a result for a file that was never uploaded is refused", async () => {
    const lines = [seg("s1", "First line here")];
    const id = await inReview(lines);
    await startProduction(env, id);
    const job = (await claimHelperJob(env.DB, devA, NOW))!;
    const r = await completeHelperJob(env, job.id, devA, { key: key(id, lines[0]), durationMs: 1000 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/upload/);
  });

  it("a voice job that fails ends the video and closes its other jobs", async () => {
    const lines = [seg("s1", "First line here"), seg("s2", "Second line here")];
    const id = await inReview(lines);
    await startProduction(env, id);
    const job = (await claimHelperJob(env.DB, devA, NOW))!;
    await failHelperJob(env, job.id, devA, "the engine is not installed");
    const v = (await getVideoAudit(env.DB, id))!;
    expect(v.status).toBe("failed");
    expect(v.error).toMatch(/the engine is not installed/);
    expect((await jobs()).filter((j) => j.status === "pending")).toHaveLength(0);
  });
});
