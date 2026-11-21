import { z } from "zod";
import type { Env } from "../env";
import { logActivity } from "../db/activity";
import { insertMeetingIfNew, knownMeetilyIds, meetingByMeetilyId } from "../db/meetings";
import { enqueueHelperJob } from "../helper/jobs";
import { HelperRefused, registerHelperKind, type HelperKindDef } from "../helper/registry";
import type { Fetch } from "../google/oauth";
import { cleanText } from "../onboarding/templates";
import { requestMeetingSummary } from "../queue/meetingSummary";
import type { TranscriptFile } from "./summary";
import { meetingWindows, type MeetingWindow } from "./windows";

/** The Mac helper reads Meetily's recordings, matches them to the meeting windows the worker sends, and uploads the matches in one file. */
export const MEETILY_SYNC_KIND = "meetily.sync";

/** How far back the pull looks, in hours: the same stretch `meetingWindows` covers. */
const LOOKBACK_HOURS = 72;
/** A recording may start this long before its window opens or after it closes (people start early and late) and still count. */
const SLACK_MS = 15 * 60_000;

/**
 * Rule R8, the same two conditions the helper applies before it uploads anything (helper/src/meetily/match.ts), checked again because the helper is not trusted for which meeting belongs where:
 * the recording overlaps the booked time itself by a positive amount, AND more than half of its length lies inside the window widened by 15 minutes on each side. A recording with no length matches nothing.
 */
function matchesWindow(start: number, end: number, from: number, to: number): boolean {
  if (![start, end, from, to].every(Number.isFinite) || !(end > start)) return false;
  if (!(Math.min(end, to) - Math.max(start, from) > 0)) return false;
  return Math.min(end, to + SLACK_MS) - Math.max(start, from - SLACK_MS) > (end - start) / 2;
}
export const MAX_WINDOWS = 100;
export const MAX_KNOWN_IDS = 2000;
const MAX_MEETINGS = 50;
/** The most transcript lines the whole file may hold, across all its meetings. */
export const MAX_TOTAL_LINES = 50_000;
/** The biggest sync file the worker will read. The helper keeps its upload under 10 MB, so this is room to spare; a bigger one is refused before it is read into memory. */
export const MAX_SYNC_FILE_BYTES = 12 * 1024 * 1024;

const WindowSchema = z.object({
  key: z.string().min(1), businessId: z.string().min(1), startAt: z.string().min(1), endAt: z.string().min(1),
  bookingId: z.string().min(1).nullable(), source: z.enum(["booking", "calendar"]),
});

export const MeetilySyncPayload = z.object({
  syncId: z.string().min(1),
  since: z.string().min(1),
  windows: z.array(WindowSchema).max(MAX_WINDOWS),
  knownMeetilyIds: z.array(z.string().min(1)).max(MAX_KNOWN_IDS),
});
export type MeetilySyncPayload = z.infer<typeof MeetilySyncPayload>;

/** `key` is the one output file, or null (and nothing uploaded) when no recording matched a window. */
export const MeetilySyncResult = z.object({ scanned: z.number().int().nonnegative(), matched: z.number().int().nonnegative(), key: z.string().min(1).nullable() });
export type MeetilySyncResult = z.infer<typeof MeetilySyncResult>;

/** What the helper uploads: the recordings that matched a window. Nothing in it says which business a meeting is for; the payload's window does that. */
export const MatchedMeetingsFile = z.object({
  meetings: z.array(z.object({
    meetilyId: z.string().min(1),
    windowKey: z.string().min(1),
    title: z.string().max(300),
    startedAt: z.string(),
    endedAt: z.string(),
    notes: z.string().max(50_000).nullable(),
    transcript: z.array(z.object({ speaker: z.string().nullable(), atSec: z.number().nullable(), text: z.string().max(5_000) })).max(20_000),
  })).max(MAX_MEETINGS),
}).refine((f) => f.meetings.reduce((n, m) => n + m.transcript.length, 0) <= MAX_TOTAL_LINES, { message: `the transcripts together have more than ${MAX_TOTAL_LINES.toLocaleString("en-US")} lines` });
export type MatchedMeetingsFile = z.infer<typeof MatchedMeetingsFile>;

/** Where the helper puts the matches of one sync. */
export const syncFileKey = (syncId: string): string => `meetings/sync/${syncId}.json`;
/** Where a meeting's transcript (a `TranscriptFile`) is kept. */
export const transcriptKey = (meetingId: string): string => `meetings/${meetingId}/transcript.json`;

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `- ${i.path.join(".") || "value"}: ${i.message}`).join("\n");
const utc = (s: string): string | null => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/**
 * Queues one sync job for the windows of the last 72 hours, unless there are none or one is already open (it is the cron's job to ask again in 15 minutes). A window that appears twice
 * is sent once: the helper matches nothing when two windows tie for a recording.
 */
export async function requestMeetilySync(env: Env, now: Date, o: { f?: Fetch } = {}): Promise<{ queued: boolean; reason?: "no windows" | "already queued" }> {
  const seen = new Set<string>();
  const windows = (await meetingWindows(env, now, { lookbackHours: LOOKBACK_HOURS, f: o.f })).filter((w) => !seen.has(w.key) && !!seen.add(w.key)).slice(-MAX_WINDOWS);
  if (windows.length === 0) return { queued: false, reason: "no windows" };
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString();
  const payload: MeetilySyncPayload = { syncId: crypto.randomUUID(), since, windows, knownMeetilyIds: (await knownMeetilyIds(env.DB, since)).slice(0, MAX_KNOWN_IDS) };
  const { created } = await enqueueHelperJob(env.DB, MEETILY_SYNC_KIND, payload, { dedupeKey: MEETILY_SYNC_KIND });
  return created ? { queued: true } : { queued: false, reason: "already queued" };
}

type Entry = MatchedMeetingsFile["meetings"][number];
type Accepted = { entry: Entry; window: MeetingWindow; startedAt: string; endedAt: string };

/** The entries the worker believes: it trusts the helper for the recording's own words and dates only. Which business and booking a meeting belongs to comes from the payload's window. */
function accept(p: MeetilySyncPayload, entries: Entry[]): { kept: Accepted[]; dropped: number } {
  const windows = new Map(p.windows.map((w) => [w.key, w]));
  const known = new Set(p.knownMeetilyIds);
  const kept: Accepted[] = [];
  for (const entry of entries) {
    const window = windows.get(entry.windowKey);
    const startedAt = utc(entry.startedAt), endedAt = utc(entry.endedAt);
    if (!window || known.has(entry.meetilyId) || !startedAt || !endedAt || endedAt < startedAt) continue;
    if (!matchesWindow(Date.parse(startedAt), Date.parse(endedAt), Date.parse(window.startAt), Date.parse(window.endAt))) continue;
    kept.push({ entry, window, startedAt, endedAt });
  }
  return { kept, dropped: entries.length - kept.length };
}

/**
 * Records one accepted meeting, safe to run again after a crash: the transcript goes to R2 BEFORE the row (a row never points at a missing object); a meeting that is already recorded is
 * not written again; and a recorded meeting that is still waiting for its summary is asked for again, which does nothing while a summary task for it is open.
 */
async function record(env: Env, a: Accepted): Promise<void> {
  const { entry, window } = a;
  const existing = await meetingByMeetilyId(env.DB, entry.meetilyId);
  if (existing) {
    if (existing.status === "received") await requestMeetingSummary(env.DB, existing.id);
    return;
  }
  const id = crypto.randomUUID();
  const file: TranscriptFile = { lines: entry.transcript.map((l) => ({ speaker: l.speaker, atSec: l.atSec, text: l.text })) };
  await env.RAW.put(transcriptKey(id), JSON.stringify(file), { httpMetadata: { contentType: "application/json" } });
  const title = cleanText(entry.title, 300) || "Untitled meeting";
  const { meeting, created } = await insertMeetingIfNew(env.DB, {
    id, meetilyId: entry.meetilyId, businessId: window.businessId, bookingId: window.bookingId, windowKey: window.key, title,
    startedAt: a.startedAt, endedAt: a.endedAt, transcriptKey: transcriptKey(id), notes: entry.notes === null ? null : cleanText(entry.notes, 50_000) || null,
  });
  if (!created) {
    // Another request recorded it between the check and the insert: ours is the copy nobody points at.
    await env.RAW.delete(transcriptKey(id));
    if (meeting.status === "received") await requestMeetingSummary(env.DB, meeting.id);
    return;
  }
  await logActivity(env.DB, meeting.businessId, "meeting_recorded", `Meeting recorded: ${cleanText(title, 120)}`);
  await requestMeetingSummary(env.DB, meeting.id);
}

const meetilySync: HelperKindDef<MeetilySyncPayload, MeetilySyncResult> = {
  kind: MEETILY_SYNC_KIND,
  payload: MeetilySyncPayload,
  result: MeetilySyncResult,
  inputs: () => [],
  outputs: (p) => [syncFileKey(p.syncId)],

  /**
   * Turns the matched recordings into meetings: a row, a transcript in R2, a line on the client's timeline and a summary task each. Only approvals and tasks come of it; nothing is sent.
   * The sync file is deleted last, so a crash before that is retried from the top.
   */
  async apply(env, p, r) {
    if (r.key === null) return;
    const expected = syncFileKey(p.syncId);
    if (r.key !== expected) throw new HelperRefused(`that is not this job's output: the matches go to ${expected}`);
    const obj = await env.RAW.get(expected);
    if (!obj) throw new HelperRefused(`the matched meetings file was never uploaded to ${expected}`);
    // The size is on the object, so a file too big for the Worker's memory is turned away before its body is read.
    if (obj.size > MAX_SYNC_FILE_BYTES) throw new HelperRefused(`the matched meetings file is too big (${Math.ceil(obj.size / 1024 / 1024)} MB): it may be at most ${MAX_SYNC_FILE_BYTES / 1024 / 1024} MB`);
    let json: unknown;
    try { json = await obj.json(); } catch { throw new HelperRefused("the matched meetings file is not valid JSON"); }
    const file = MatchedMeetingsFile.safeParse(json);
    if (!file.success) throw new HelperRefused(`the matched meetings file is not what was expected:\n${issues(file.error)}`);

    const { kept, dropped } = accept(p, file.data.meetings);
    if (dropped) console.warn(`meetily sync: left out ${dropped} of ${file.data.meetings.length} matched meetings (no such window, outside its window, already known or unreadable dates)`);
    for (const a of kept) await record(env, a);
    await env.RAW.delete(expected);
  },
  // onFail and onExpire do nothing: the next 15-minute tick queues a fresh job.
};
registerHelperKind(meetilySync);
