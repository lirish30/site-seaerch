import type { Env } from "../env";
import { getSettings } from "../db/settings";
import { cancelOpenHelperJobsOfKind, enqueueHelperJob, helperStatus } from "../helper/jobs";
import { VOICE_ENGINES, VOICE_SAMPLE_KIND, voiceSampleKey, type VoiceEngine } from "../helper/kinds";

export { VOICE_SAMPLE_KIND };

/** A blind test's three clips are labelled with these, in this order. */
export const LABELS = ["A", "B", "C"] as const;
export type VoiceLabel = (typeof LABELS)[number];
export const isLabel = (v: unknown): v is VoiceLabel => LABELS.includes(v as VoiceLabel);

/** What each engine reads in the test: a paragraph of about 55 words, which runs about 20 seconds at the pace of a video. */
export const DEFAULT_VOICE_LINE =
  "Hi, I had a look at your website this morning. The first thing I noticed is that a visitor can't tell how to book a call, " +
  "and on a phone the menu is hard to tap. These are small fixes, and I'd be glad to walk you through exactly what I would change for you.";

/** An error a route turns into its status and message. */
export class VoiceTestError extends Error { constructor(public status: 400 | 404 | 409, message: string) { super(message); } }

const randomUnit = (): number => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

/** The three engines in a random order (Fisher-Yates). `rand` is a number in [0, 1); tests pass their own. */
export function shuffleEngines(rand: () => number = randomUnit): VoiceEngine[] {
  const a: VoiceEngine[] = [...VOICE_ENGINES];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface TestRow { id: string; created_at: string; line_text: string; labels: string; chosen: VoiceLabel | null }
export type Labels = Record<VoiceLabel, VoiceEngine>;
const labelsOf = (r: TestRow): Labels => JSON.parse(r.labels) as Labels;

async function latestRow(db: D1Database): Promise<TestRow | null> {
  return db.prepare(`SELECT * FROM voice_tests ORDER BY created_at DESC, rowid DESC LIMIT 1`).first<TestRow>();
}

/** Takes every clip of an earlier test out of storage. A file that will not go is left for a later sweep. */
async function dropClips(raw: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await raw.list({ prefix: "voice-tests/", cursor });
    if (page.objects.length) await raw.delete(page.objects.map((o) => o.key)).catch(() => {});
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * Starts a blind test: the same line read in the owner's cloned voice by all three engines, labelled A, B and C in a random order. Needs a reference
 * recording. A test that is still running is replaced: its open jobs are closed and its clips removed, so the Mac spends no more time on it.
 */
export async function createVoiceTest(env: Env, lineText?: string): Promise<{ id: string }> {
  const settings = await getSettings(env.DB);
  const refKey = settings.voice_ref_key;
  if (!refKey) throw new VoiceTestError(409, "Record your voice first: add a reference recording, then run the test.");
  const line = lineText?.trim() || DEFAULT_VOICE_LINE;
  await cancelOpenHelperJobsOfKind(env.DB, VOICE_SAMPLE_KIND, "a newer voice test replaced it");
  await dropClips(env.RAW);

  const id = crypto.randomUUID();
  const order = shuffleEngines();
  const labels = Object.fromEntries(LABELS.map((l, i) => [l, order[i]])) as Labels;
  await env.DB.prepare(`INSERT INTO voice_tests (id, created_at, line_text, labels) VALUES (?, ?, ?, ?)`).bind(id, new Date().toISOString(), line, JSON.stringify(labels)).run();
  try {
    for (const engine of order) await enqueueHelperJob(env.DB, VOICE_SAMPLE_KIND, { testId: id, engine, line, refKey }, { dedupeKey: `${id}:${engine}` });
  } catch (e) {
    await cancelOpenHelperJobsOfKind(env.DB, VOICE_SAMPLE_KIND, "the test could not be started");
    await env.DB.prepare(`DELETE FROM voice_tests WHERE id = ?`).bind(id).run();
    throw e;
  }
  return { id };
}

/**
 * The owner's pick: the engine behind a label becomes the voice for new videos. Only the newest test can be picked from, and only once.
 * Everything that stops it is a `VoiceTestError`.
 */
export async function chooseVoice(env: Env, testId: string, label: VoiceLabel): Promise<{ engine: VoiceEngine }> {
  const db = env.DB;
  if (!isLabel(label)) throw new VoiceTestError(400, "label must be A, B or C");
  const row = await db.prepare(`SELECT * FROM voice_tests WHERE id = ?`).bind(testId).first<TestRow>();
  if (!row) throw new VoiceTestError(404, "not found");
  if (row.chosen) throw new VoiceTestError(409, "You already picked from this test.");
  if ((await latestRow(db))?.id !== testId) throw new VoiceTestError(409, "A newer test replaced this one.");
  const engine = labelsOf(row)[label];
  // Only a clip that was heard can be picked: its job is done and its file is there. The other two need not be ready (an engine that cannot run must not block a choice).
  if ((await clipState(env, row.id, engine, await clipJobs(db, row.id))).status !== "ready") throw new VoiceTestError(409, "That clip isn't ready yet.");
  const marked = await db.prepare(`UPDATE voice_tests SET chosen = ? WHERE id = ? AND chosen IS NULL`).bind(label, testId).run();
  if ((marked.meta.changes ?? 0) === 0) throw new VoiceTestError(409, "You already picked from this test.");
  await db.prepare(`UPDATE settings SET voice_engine = ? WHERE id = 1`).bind(engine).run();
  return { engine };
}

/** "None of these": no cloned voice, so new videos are narrated from the owner's own recordings. The reference recording stays. */
export async function clearVoice(db: D1Database): Promise<void> {
  await db.prepare(`UPDATE settings SET voice_engine = NULL WHERE id = 1`).run();
}

export type ClipStatus = "ready" | "pending" | "failed";
export interface VoiceTestView {
  id: string; createdAt: string; line: string; chosen: VoiceLabel | null; pending: number; helperOnline: boolean;
  /** One per label, in order. `error` is why a failed clip failed. The URL is by label: it never carries an engine's name. */
  clips: { label: VoiceLabel; url: string; status: ClipStatus; error?: string }[];
  /** Only once a pick is made: which engine each label was. */
  engines?: Labels;
}

interface ClipJob { status: string; error: string | null; engine: VoiceEngine }
async function clipJobs(db: D1Database, testId: string): Promise<Map<VoiceEngine, ClipJob>> {
  const rows = (await db.prepare(`SELECT status, error, json_extract(payload, '$.engine') AS engine FROM helper_jobs WHERE kind = ? AND json_extract(payload, '$.testId') = ? ORDER BY created_at, id`).bind(VOICE_SAMPLE_KIND, testId).all<ClipJob>()).results;
  return new Map(rows.map((r) => [r.engine, r]));
}

/** Where one clip stands. `error` is the raw reason a failed clip failed; it can name an engine, so a caller must not show it before a pick. */
async function clipState(env: Env, testId: string, engine: VoiceEngine, jobs: Map<VoiceEngine, ClipJob>): Promise<{ status: ClipStatus; error?: string }> {
  const job = jobs.get(engine);
  if (!job) return { status: "failed", error: "this clip was never queued" };
  if (job.status === "done") {
    return (await env.RAW.head(voiceSampleKey({ testId, engine }))) ? { status: "ready" } : { status: "failed", error: "your Mac finished the clip but it was never uploaded" };
  }
  if (job.status === "failed" || job.status === "expired") return { status: "failed", error: job.error ?? "your Mac could not make this clip" };
  return { status: "pending" };
}

/** What a failed clip says before a pick. The helper's own words can name the engine, which would undo the blind test. */
export const GENERIC_CLIP_ERROR = "Your Mac couldn't make this clip.";

/** The newest test as the page sees it. Which engine is behind which label stays out of it until a pick is made. */
export async function latestVoiceTest(env: Env, now: Date = new Date()): Promise<VoiceTestView | null> {
  const row = await latestRow(env.DB);
  if (!row) return null;
  const labels = labelsOf(row);
  const jobs = await clipJobs(env.DB, row.id);
  const clips: VoiceTestView["clips"] = [];
  for (const label of LABELS) {
    const state = await clipState(env, row.id, labels[label], jobs);
    const error = state.status === "failed" ? (row.chosen ? state.error : GENERIC_CLIP_ERROR) : undefined;
    clips.push({ label, url: `/api/voice-tests/${row.id}/clips/${label}`, status: state.status, ...(error ? { error } : {}) });
  }
  return {
    id: row.id, createdAt: row.created_at, line: row.line_text, chosen: row.chosen, pending: clips.filter((c) => c.status !== "ready").length,
    helperOnline: (await helperStatus(env.DB, now)).online, clips, ...(row.chosen ? { engines: labels } : {}),
  };
}

/** The audio of one clip of a test, by label, or null when it is not there (unknown test, or the Mac has not finished it). */
export async function voiceClip(env: Env, testId: string, label: string): Promise<R2ObjectBody | null> {
  if (!isLabel(label)) return null;
  const row = await env.DB.prepare(`SELECT * FROM voice_tests WHERE id = ?`).bind(testId).first<TestRow>();
  if (!row) return null;
  const engine = labelsOf(row)[label];
  if ((await clipJobs(env.DB, testId)).get(engine)?.status !== "done") return null;
  return env.RAW.get(voiceSampleKey({ testId, engine }));
}
