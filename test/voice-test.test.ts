import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createDevice } from "../src/worker/helper/auth";
import { claimHelperJob, completeHelperJob, getHelperJob } from "../src/worker/helper/jobs";
import { VOICE_ENGINES, VOICE_SAMPLE_KIND, VOICE_SEGMENT_KIND, getHelperKind } from "../src/worker/helper/kinds";
import { createVideoAudit, getVideoAudit, savePlan, setVideoStatus } from "../src/worker/db/videoAudits";
import { getSettings } from "../src/worker/db/settings";
import { defaultNarration } from "../src/worker/queue/videoScript";
import { DEFAULT_VOICE_LINE, chooseVoice, createVoiceTest, shuffleEngines } from "../src/worker/video/voiceTest";
import { startProduction } from "../src/worker/video/production";
import { WORDS_PER_MINUTE, wordCount, type Segment, type VideoPlan } from "../src/worker/video/plan";

let cookie = "";
const api = (path: string, init: RequestInit = {}) => SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
const put = (path: string, body: unknown) => api(path, { method: "PUT", body: JSON.stringify(body) });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

async function wipeR2(prefix: string) {
  const l = await env.RAW.list({ prefix });
  if (l.objects.length) await env.RAW.delete(l.objects.map((o) => o.key));
}
beforeEach(async () => {
  await env.DB.batch(["voice_tests", "helper_jobs", "helper_devices", "agent_actions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`UPDATE settings SET voice_engine = NULL, voice_ref_key = NULL, booking_url = '', ai_voice_note = 1 WHERE id = 1`).run();
  await wipeR2("voice-reference/"); await wipeR2("voice-tests/");
});

const audio = (n: number) => new Uint8Array(n).fill(5);
/** The reference recording, the way the page sends it: raw audio and its length in a header. */
const reference = (body: BodyInit = audio(2000), headers: Record<string, string> = {}) =>
  api("/api/settings/voice-reference", { method: "PUT", body, headers: { "content-type": "audio/webm", "x-duration-ms": "45000", ...headers } });
const withReference = async () => { expect((await reference()).status).toBe(200); };

type Clip = { label: string; url: string; status: string };
type Latest = { test: null | { id: string; chosen: string | null; pending: number; clips: Clip[]; engines?: Record<string, string>; line: string } };
const latest = async () => (await api("/api/voice-tests/latest")).json<Latest>();
const openJobs = async () => (await env.DB.prepare(`SELECT * FROM helper_jobs WHERE kind = ? ORDER BY created_at, id`).bind(VOICE_SAMPLE_KIND).all<any>()).results;

/** The Mac finishes every clip of a test: the file is uploaded and the job completes. */
async function finishAll(testId: string) {
  const { device } = await createDevice(env.DB, "Mac");
  for (;;) {
    const job = await claimHelperJob(env, device.id, new Date(), [VOICE_SAMPLE_KIND]);
    if (!job) break;
    const p = job.payload as { testId: string; engine: string };
    await env.RAW.put(`voice-tests/${p.testId}/${p.engine}.wav`, audio(300), { httpMetadata: { contentType: "audio/wav" } });
    expect(await completeHelperJob(env, job.id, device.id, { durationMs: 20000 })).toEqual({ ok: true });
  }
  return testId;
}

describe("the reference recording", () => {
  it("is stored under voice-reference/ and its key is set", async () => {
    expect((await reference()).status).toBe(200);
    const s = await getSettings(env.DB);
    expect(s.voice_ref_key).toBe("voice-reference/reference.webm");
    expect(await env.RAW.head("voice-reference/reference.webm")).not.toBeNull();
  });

  it("replacing it deletes the old file", async () => {
    await withReference();
    expect((await reference(audio(500), { "content-type": "audio/wav" })).status).toBe(200);
    expect((await getSettings(env.DB)).voice_ref_key).toBe("voice-reference/reference.wav");
    expect(await env.RAW.head("voice-reference/reference.webm")).toBeNull();
    expect(await env.RAW.head("voice-reference/reference.wav")).not.toBeNull();
  });

  it("reference over 15 MB is refused", async () => {
    const r = await reference(audio(15 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect((await getSettings(env.DB)).voice_ref_key).toBeNull();
    expect((await env.RAW.list({ prefix: "voice-reference/" })).objects).toHaveLength(0);
  });

  it("must run 30 to 120 seconds", async () => {
    for (const ms of ["29999", "120001", "0", "abc", ""]) expect((await reference(audio(100), { "x-duration-ms": ms })).status).toBe(400);
    for (const ms of ["30000", "120000"]) expect((await reference(audio(100), { "x-duration-ms": ms })).status).toBe(200);
  });

  it("takes wav, webm, mp3 and m4a and nothing else", async () => {
    for (const [type, ext] of [["audio/wav", "wav"], ["audio/webm;codecs=opus", "webm"], ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"], ["audio/x-m4a", "m4a"]]) {
      expect((await reference(audio(100), { "content-type": type })).status).toBe(200);
      expect((await getSettings(env.DB)).voice_ref_key).toBe(`voice-reference/reference.${ext}`);
    }
    expect((await reference(audio(100), { "content-type": "video/mp4" })).status).toBe(415);
    expect((await reference(audio(100), { "content-type": "application/json" })).status).toBe(415);
  });

  it("an empty body is refused, and a signed-out request is not allowed", async () => {
    expect((await reference(new Uint8Array(0))).status).toBe(400);
    expect((await SELF.fetch("https://x/api/settings/voice-reference", { method: "PUT", body: audio(10), headers: { "content-type": "audio/webm", "x-duration-ms": "45000" } })).status).toBe(401);
  });

  it("plays back", async () => {
    expect((await api("/api/settings/voice-reference")).status).toBe(404);
    await withReference();
    const r = await api("/api/settings/voice-reference");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/webm");
  });
});

describe("the blind voice test", () => {
  it("test needs a reference recording first", async () => {
    const r = await post("/api/voice-tests");
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error).toMatch(/record/i);
    expect(await openJobs()).toHaveLength(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM voice_tests`).first<{ n: number }>())!.n).toBe(0);
  });

  it("creates three jobs with distinct engines under shuffled labels", async () => {
    await withReference();
    const r = await post("/api/voice-tests");
    expect(r.status).toBe(202);
    const { id } = await r.json<{ id: string }>();
    const jobs = await openJobs();
    expect(jobs).toHaveLength(3);
    const payloads = jobs.map((j) => JSON.parse(j.payload));
    expect(payloads.map((p) => p.engine).sort()).toEqual([...VOICE_ENGINES].sort());
    for (const p of payloads) expect(p).toEqual({ testId: id, engine: p.engine, line: DEFAULT_VOICE_LINE, refKey: "voice-reference/reference.webm" });
    expect(jobs.every((j) => j.status === "pending" && j.video_id === null)).toBe(true);
    const def = getHelperKind(VOICE_SAMPLE_KIND)!;
    for (const p of payloads) {
      expect(def.inputs(p)).toEqual(["voice-reference/reference.webm"]);
      expect(def.outputs(p)).toEqual([`voice-tests/${id}/${p.engine}.wav`]);
    }
    const row = (await env.DB.prepare(`SELECT * FROM voice_tests WHERE id = ?`).bind(id).first<any>())!;
    const labels = JSON.parse(row.labels) as Record<string, string>;
    expect(Object.keys(labels)).toEqual(["A", "B", "C"]);
    expect(Object.values(labels).sort()).toEqual([...VOICE_ENGINES].sort());
    expect(row.chosen).toBeNull();
    expect(row.line_text).toBe(DEFAULT_VOICE_LINE);
  });

  it("shuffles the labels", () => {
    expect(shuffleEngines(() => 0.999)).toEqual([...VOICE_ENGINES]);
    expect(shuffleEngines(() => 0)).toEqual(["chatterbox", "openvoice-v2", "qwen3-tts"]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(shuffleEngines().join());
    expect(seen.size).toBeGreaterThan(1);
    for (const s of seen) expect(s.split(",").sort()).toEqual([...VOICE_ENGINES].sort());
  });

  it("reads a line of about twenty seconds by default, or the one it is given", async () => {
    const seconds = (wordCount(DEFAULT_VOICE_LINE) / WORDS_PER_MINUTE) * 60;
    expect(seconds).toBeGreaterThan(16);
    expect(seconds).toBeLessThan(24);
    await withReference();
    const { id } = await createVoiceTest(env, "Hello, this is my own line.");
    expect(JSON.parse((await openJobs())[0].payload).line).toBe("Hello, this is my own line.");
    expect(id).toBeTruthy();
    expect((await post("/api/voice-tests", { line: "x".repeat(2001) })).status).toBe(400);
  });

  it("labels are hidden until a pick", async () => {
    await withReference();
    const { id } = await (await post("/api/voice-tests")).json<{ id: string }>();
    let body = await latest();
    expect(body.test!.id).toBe(id);
    expect(body.test!.chosen).toBeNull();
    expect(body.test!.pending).toBe(3);
    expect(body.test!.clips.map((c) => [c.label, c.status])).toEqual([["A", "pending"], ["B", "pending"], ["C", "pending"]]);
    expect(body.test!.engines).toBeUndefined();

    await finishAll(id);
    const res = await api("/api/voice-tests/latest");
    const text = await res.text();
    body = JSON.parse(text) as Latest;
    expect(body.test!.pending).toBe(0);
    expect(body.test!.clips.map((c) => c.status)).toEqual(["ready", "ready", "ready"]);
    for (const e of [...VOICE_ENGINES, "qwen", "chatter", "openvoice"]) expect(text.toLowerCase()).not.toContain(e);
    // The clips are served by label, from an authed route.
    for (const c of body.test!.clips) {
      expect(c.url).toBe(`/api/voice-tests/${id}/clips/${c.label}`);
      const clip = await api(c.url);
      expect(clip.status).toBe(200);
      expect(clip.headers.get("content-type")).toBe("audio/wav");
      expect([...clip.headers.keys()].join()).not.toMatch(/qwen|chatterbox|openvoice/);
      expect((await clip.arrayBuffer()).byteLength).toBe(300);
      expect((await SELF.fetch(`https://x${c.url}`)).status).toBe(401);
    }
    expect((await api(`/api/voice-tests/${id}/clips/D`)).status).toBe(404);
    expect((await api(`/api/voice-tests/nope/clips/A`)).status).toBe(404);
  });

  it("a clip whose job has not finished is not served", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    expect((await api(`/api/voice-tests/${id}/clips/A`)).status).toBe(404);
  });

  it("shows nothing when there has been no test", async () => {
    expect(await latest()).toEqual({ test: null });
  });

  const failClip = (engine: string, error: string) =>
    env.DB.prepare(`UPDATE helper_jobs SET status = 'failed', error = ? WHERE kind = ? AND json_extract(payload, '$.engine') = ?`).bind(error, VOICE_SAMPLE_KIND, engine).run();
  const labelOf = async (id: string, engine: string) => {
    const labels = JSON.parse((await env.DB.prepare(`SELECT labels FROM voice_tests WHERE id = ?`).bind(id).first<{ labels: string }>())!.labels) as Record<string, string>;
    return Object.keys(labels).find((l) => labels[l] === engine)!;
  };

  it("reports a clip the Mac gave up on, without naming its engine before a pick", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    await failClip("chatterbox", "chatterbox failed to load: Traceback in qwen3-tts / openvoice-v2");
    const res = await api("/api/voice-tests/latest");
    const text = await res.text();
    const t = (JSON.parse(text) as Latest).test!;
    expect(t.id).toBe(id);
    expect(t.clips.filter((c) => c.status === "failed")).toHaveLength(1);
    expect((t.clips.find((c) => c.status === "failed") as any).error).toBe("Your Mac couldn't make this clip.");
    expect(t.pending).toBe(3);
    for (const e of ["qwen", "chatterbox", "openvoice"]) {
      expect(text.toLowerCase()).not.toContain(e);
      expect([...res.headers.entries()].join().toLowerCase()).not.toContain(e);
    }
  });

  it("a pick from a pending clip is refused", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    const r = await post(`/api/voice-tests/${id}/choose`, { label: "A" });
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error).toBe("That clip isn't ready yet.");
    expect((await getSettings(env.DB)).voice_engine).toBeNull();
    expect((await latest()).test!.chosen).toBeNull();
  });

  it("a pick from a failed clip is refused, but a ready one can still be picked", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    await failClip("chatterbox", "boom");
    await finishAll(id); // the other two clips finish
    const bad = await labelOf(id, "chatterbox");
    const r = await post(`/api/voice-tests/${id}/choose`, { label: bad });
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error).toBe("That clip isn't ready yet.");
    expect((await getSettings(env.DB)).voice_engine).toBeNull();
    const good = await labelOf(id, "qwen3-tts");
    expect((await post(`/api/voice-tests/${id}/choose`, { label: good })).status).toBe(200);
    expect((await getSettings(env.DB)).voice_engine).toBe("qwen3-tts");
    // Once picked, the real reason is shown.
    expect((await latest()).test!.clips.find((c) => c.status === "failed")).toMatchObject({ error: "boom" });
  });

  it("a done job whose file was never uploaded is not ready to pick", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    await env.DB.prepare(`UPDATE helper_jobs SET status = 'done' WHERE kind = ?`).bind(VOICE_SAMPLE_KIND).run();
    expect((await post(`/api/voice-tests/${id}/choose`, { label: "A" })).status).toBe(409);
  });

  it("choosing sets the engine and reveals the names", async () => {
    await withReference();
    const { id } = await (await post("/api/voice-tests")).json<{ id: string }>();
    await finishAll(id);
    const labels = JSON.parse((await env.DB.prepare(`SELECT labels FROM voice_tests WHERE id = ?`).bind(id).first<{ labels: string }>())!.labels);
    const r = await post(`/api/voice-tests/${id}/choose`, { label: "B" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ engine: labels.B });
    expect((await getSettings(env.DB)).voice_engine).toBe(labels.B);
    const t = (await latest()).test!;
    expect(t.chosen).toBe("B");
    expect(t.engines).toEqual(labels);
    expect((await env.DB.prepare(`SELECT chosen FROM voice_tests WHERE id = ?`).bind(id).first<{ chosen: string }>())!.chosen).toBe("B");
  });

  it("choosing twice is refused", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    await finishAll(id);
    expect((await post(`/api/voice-tests/${id}/choose`, { label: "A" })).status).toBe(200);
    const engine = (await getSettings(env.DB)).voice_engine;
    expect((await post(`/api/voice-tests/${id}/choose`, { label: "C" })).status).toBe(409);
    expect((await getSettings(env.DB)).voice_engine).toBe(engine);
    await expect(chooseVoice(env, id, "B")).rejects.toThrow();
  });

  it("refuses a bad label and an unknown test", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    expect((await post(`/api/voice-tests/${id}/choose`, { label: "D" })).status).toBe(400);
    expect((await post(`/api/voice-tests/${id}/choose`, {})).status).toBe(400);
    expect((await post(`/api/voice-tests/nope/choose`, { label: "A" })).status).toBe(404);
    expect((await getSettings(env.DB)).voice_engine).toBeNull();
  });

  it("second test replaces the pending one", async () => {
    await withReference();
    const first = (await (await post("/api/voice-tests")).json<{ id: string }>()).id;
    await env.RAW.put(`voice-tests/${first}/qwen3-tts.wav`, audio(10));
    const second = (await (await post("/api/voice-tests")).json<{ id: string }>()).id;
    expect(second).not.toBe(first);
    const jobs = (await openJobs()).map((j) => ({ testId: JSON.parse(j.payload).testId, status: j.status }));
    expect(jobs.filter((j) => j.testId === first).map((j) => j.status)).toEqual(["expired", "expired", "expired"]);
    expect(jobs.filter((j) => j.testId === second).map((j) => j.status)).toEqual(["pending", "pending", "pending"]);
    expect((await latest()).test!.id).toBe(second);
    // The old clips are cleared away and the old test can no longer be picked from.
    expect((await env.RAW.list({ prefix: `voice-tests/${first}/` })).objects).toHaveLength(0);
    expect((await post(`/api/voice-tests/${first}/choose`, { label: "A" })).status).toBe(409);
    expect((await getSettings(env.DB)).voice_engine).toBeNull();
  });

  it("a cancelled clip job can no longer be completed by the Mac", async () => {
    await withReference();
    await createVoiceTest(env);
    const { device } = await createDevice(env.DB, "Mac");
    const job = (await claimHelperJob(env, device.id, new Date(), [VOICE_SAMPLE_KIND]))!;
    await createVoiceTest(env);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("expired");
    expect(await completeHelperJob(env, job.id, device.id, { durationMs: 1 })).toMatchObject({ ok: false });
  });

  it("none of these clears the voice", async () => {
    await withReference();
    const { id } = await createVoiceTest(env);
    await finishAll(id);
    await chooseVoice(env, id, "A");
    expect((await getSettings(env.DB)).voice_engine).not.toBeNull();
    expect((await post("/api/voice-tests/none")).status).toBe(200);
    const s = await getSettings(env.DB);
    expect(s.voice_engine).toBeNull();
    expect(s.voice_ref_key).toBe("voice-reference/reference.webm");
    expect(defaultNarration(s)).toBe("recorded");
  });

  it("voice.sample finishes with a duration and applies nothing", async () => {
    const def = getHelperKind(VOICE_SAMPLE_KIND)!;
    expect(def.result.safeParse({ durationMs: 19000 }).success).toBe(true);
    expect(def.result.safeParse({}).success).toBe(false);
    expect(def.payload.safeParse({ testId: "t", engine: "gpt", line: "x", refKey: "k" }).success).toBe(false);
    await expect(def.apply(env, { testId: "t", engine: "qwen3-tts", line: "x", refKey: "k" }, { durationMs: 1 })).resolves.toBeUndefined();
  });
});

describe("video settings", () => {
  it("booking link is https only", async () => {
    expect((await put("/api/settings", { booking_url: "https://cal.example.com/me" })).status).toBe(200);
    expect((await getSettings(env.DB)).booking_url).toBe("https://cal.example.com/me");
    for (const bad of ["http://cal.example.com", "cal.example.com", "javascript:alert(1)", "https://", "https://a b.com"]) {
      const r = await put("/api/settings", { booking_url: bad });
      expect(r.status).toBe(400);
      expect((await r.json<any>()).fields).toContain("booking_url");
    }
    expect((await put("/api/settings", { booking_url: "" })).status).toBe(200);
    expect((await getSettings(env.DB)).booking_url).toBe("");
  });

  it("the AI voice note is on unless switched off", async () => {
    expect((await getSettings(env.DB)).ai_voice_note).toBe(1);
    expect((await put("/api/settings", { ai_voice_note: 0 })).status).toBe(200);
    expect((await getSettings(env.DB)).ai_voice_note).toBe(0);
    expect((await put("/api/settings", { ai_voice_note: 2 })).status).toBe(400);
    expect((await put("/api/settings", { ai_voice_note: 1 })).status).toBe(200);
  });

  it("the voice settings cannot be set through the settings route", async () => {
    await put("/api/settings", { voice_engine: "chatterbox", voice_ref_key: "voice-reference/x.wav" });
    const s = await getSettings(env.DB);
    expect(s.voice_engine).toBeNull();
    expect(s.voice_ref_key).toBeNull();
  });
});

describe("making a video in the chosen voice", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  const shot = { id: "d1", viewport: "desktop" as const, scrollY: 0, width: 1280, height: 720, fullKey: "f", previewKey: "p" };
  const seg = (id: string, text: string): Segment => ({ id, role: "problem", findingCode: "x", text, shotId: "d1", markups: [] });
  async function inReview(narration: VideoPlan["narration"] = "clone") {
    const v = (await createVideoAudit(env.DB, { businessId: "b1", auditId: crypto.randomUUID() }))!;
    await savePlan(env.DB, v.id, { shots: [shot], segments: [seg("s1", words(5)), seg("s2", words(6))], narration, version: 0 });
    await setVideoStatus(env.DB, v.id, "review");
    return v.id;
  }
  const setVoice = (engine: string | null, key: string | null) => env.DB.prepare(`UPDATE settings SET voice_engine = ?, voice_ref_key = ? WHERE id = 1`).bind(engine, key).run();

  it("defaultNarration is clone once a voice is picked", async () => {
    expect(defaultNarration(await getSettings(env.DB))).toBe("recorded");
    await setVoice("chatterbox", "voice-reference/reference.wav");
    expect(defaultNarration(await getSettings(env.DB))).toBe("clone");
  });

  it("the voice jobs use the picked engine and read the reference", async () => {
    await setVoice("openvoice-v2", "voice-reference/reference.wav");
    const id = await inReview();
    expect(await startProduction(env, id)).toBe(true);
    const rows = (await env.DB.prepare(`SELECT * FROM helper_jobs WHERE kind = ?`).bind(VOICE_SEGMENT_KIND).all<any>()).results;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      expect(p).toMatchObject({ engine: "openvoice-v2", refKey: "voice-reference/reference.wav" });
      expect(getHelperKind(VOICE_SEGMENT_KIND)!.inputs(p)).toEqual(["voice-reference/reference.wav"]);
    }
  });

  it("a voice job queued before the reference existed still works, with no input", () => {
    const def = getHelperKind(VOICE_SEGMENT_KIND)!;
    const old = { videoId: "v", segmentId: "s", engine: "qwen3-tts", text: "hi" };
    expect(def.payload.safeParse(old).success).toBe(true);
    expect(def.inputs(old)).toEqual([]);
  });

  it("approving a cloned video with no voice picked is refused and starts nothing", async () => {
    const id = await inReview();
    const r = await post(`/api/video-audits/${id}/approve`);
    expect(r.status).toBe(409);
    expect((await r.json<any>()).blockers).toContain("Pick a voice first (Settings > Voice test), or record your own lines.");
    expect((await getVideoAudit(env.DB, id))!.status).toBe("review");
    expect(await env.DB.prepare(`SELECT id FROM helper_jobs`).first()).toBeNull();
    // An engine with no reference to clone is no voice either.
    await setVoice("qwen3-tts", null);
    expect((await post(`/api/video-audits/${id}/approve`)).status).toBe(409);
    expect(await startProduction(env, id)).toBe(false);
    expect((await getVideoAudit(env.DB, id))!.status).toBe("review");
  });

  it("recorded narration needs no voice", async () => {
    const id = await inReview("recorded");
    const r = await post(`/api/video-audits/${id}/approve`);
    expect((await r.json<any>()).blockers.join(" ")).not.toMatch(/Pick a voice/);
  });

});
