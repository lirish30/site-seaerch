import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getSettings } from "../db/settings";
import "../helper/kinds"; // a helper job is only valid for a registered kind
import { chooseVoice, clearVoice, createVoiceTest, isLabel, latestVoiceTest, voiceClip, VoiceTestError } from "../video/voiceTest";
import { readUpTo } from "./helper";

/** The owner's reference recording, the blind voice test and its clips. Mounted at /api, behind the login cookie. */
export const voiceTestRoutes = new Hono<{ Bindings: Env }>();

export const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;
export const REFERENCE_SECONDS = { min: 30, max: 120 } as const;
const EXTENSIONS: Record<string, "wav" | "webm" | "mp3" | "m4a"> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav",
  "audio/webm": "webm", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
};
const CONTENT_TYPES = { wav: "audio/wav", webm: "audio/webm", mp3: "audio/mpeg", m4a: "audio/mp4" } as const;
const referenceKey = (ext: keyof typeof CONTENT_TYPES) => `voice-reference/reference.${ext}`;

/**
 * Stores the reference recording: the raw audio as the body and how long it runs (the browser measured it) in `x-duration-ms`, 30 to 120 seconds.
 * It replaces the one before, whose file is deleted. The helper checks the length again when it reads the file.
 */
voiceTestRoutes.put("/settings/voice-reference", async (c) => {
  const ext = EXTENSIONS[(c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase()];
  if (!ext) return c.json({ error: "The recording must be a wav, webm, mp3 or m4a file" }, 415);
  const ms = Number(c.req.header("x-duration-ms"));
  if (!Number.isFinite(ms) || ms < REFERENCE_SECONDS.min * 1000 || ms > REFERENCE_SECONDS.max * 1000) {
    return c.json({ error: `The recording must run ${REFERENCE_SECONDS.min} to ${REFERENCE_SECONDS.max} seconds` }, 400);
  }
  const tooBig = { error: `The recording may be at most ${MAX_REFERENCE_BYTES / 1024 / 1024} MB` };
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REFERENCE_BYTES) return c.json(tooBig, 413);
  const data = await readUpTo(c.req.raw.body, MAX_REFERENCE_BYTES);
  if (!data) return c.json(tooBig, 413);
  if (data.byteLength === 0) return c.json({ error: "The recording is empty" }, 400);

  const key = referenceKey(ext);
  const before = (await getSettings(c.env.DB)).voice_ref_key;
  await c.env.RAW.put(key, data, { httpMetadata: { contentType: CONTENT_TYPES[ext] } });
  await c.env.DB.prepare(`UPDATE settings SET voice_ref_key = ? WHERE id = 1`).bind(key).run();
  if (before && before !== key) await c.env.RAW.delete(before).catch(() => {});
  return c.json({ voice_ref_key: key });
});

/** Plays the reference recording back on the page. */
voiceTestRoutes.get("/settings/voice-reference", async (c) => {
  const key = (await getSettings(c.env.DB)).voice_ref_key;
  const obj = key ? await c.env.RAW.get(key) : null;
  if (!key || !obj) return c.json({ error: "not found" }, 404);
  const ext = key.split(".").pop() as keyof typeof CONTENT_TYPES;
  return new Response(obj.body, { headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream", "cache-control": "private, no-cache" } });
});

const fail = (c: { json: (b: unknown, s: 400 | 404 | 409) => Response }, e: unknown) => {
  if (e instanceof VoiceTestError) return c.json({ error: e.message }, e.status);
  throw e;
};

const StartBody = z.object({ line: z.string().trim().max(2000).optional() });

voiceTestRoutes.post("/voice-tests", async (c) => {
  const body = StartBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid", fields: ["line"] }, 400);
  try { return c.json(await createVoiceTest(c.env, body.data.line), 202); } catch (e) { return fail(c, e); }
});

/** The newest test, or `{ test: null }`. Which engine is behind which label is left out until a pick. */
voiceTestRoutes.get("/voice-tests/latest", async (c) => c.json({ test: await latestVoiceTest(c.env) }));

/** "None of these": the owner records their own lines, so the cloned voice is switched off. */
voiceTestRoutes.post("/voice-tests/none", async (c) => { await clearVoice(c.env.DB); return c.json({ ok: true }); });

voiceTestRoutes.post("/voice-tests/:id/choose", async (c) => {
  const body = z.object({ label: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success || !isLabel(body.data.label)) return c.json({ error: "label must be A, B or C" }, 400);
  try { return c.json(await chooseVoice(c.env.DB, c.req.param("id"), body.data.label)); } catch (e) { return fail(c, e); }
});

/** One clip by label, never by engine name. */
voiceTestRoutes.get("/voice-tests/:id/clips/:label", async (c) => {
  const obj = await voiceClip(c.env, c.req.param("id"), c.req.param("label"));
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": "audio/wav", "cache-control": "private, no-store" } });
});
