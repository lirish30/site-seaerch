import { Hono } from "hono";
import type { Env } from "../env";
import { getMeeting, listMeetings, type Meeting, type MeetingStatus } from "../db/meetings";
import { MEETILY_SYNC_KIND, requestMeetilySync } from "../meetings/syncKind";
import { readTranscriptText, type MeetingSummary } from "../meetings/summary";
import { MEETING_SUMMARIZE_KIND, requestMeetingSummary } from "../queue/meetingSummary";

/** Mounted at /api (behind requireAuth): /meetings/sync, and the rest of the meetings routes beside it. */
export const meetingRoutes = new Hono<{ Bindings: Env }>();

/** One line of a client's meeting list. Never the transcript, its key or Meetily's notes. */
export interface MeetingListItem {
  id: string; title: string; startedAt: string; endedAt: string; status: MeetingStatus;
  /** The summary's first sentence; null until there is one. */
  summary: string | null;
  actionItems: number; changeOrders: number; followupSent: boolean;
}

/** One meeting in full, as the panel shows it. The transcript is not here: it comes only when asked for (`?transcript=1`). */
export interface MeetingDetail {
  id: string; businessId: string; title: string; startedAt: string; endedAt: string; status: MeetingStatus;
  notes: string | null; summary: MeetingSummary | null; followupSentAt: string | null;
  /** The follow-up email's approval is waiting for a decision in Home. */
  followupPending: boolean;
  /** A summary task is queued or being worked on right now. */
  summarizing: boolean;
}

/** What `GET /api/meetings/:id` returns; `transcript` and `truncated` only come with `?transcript=1`. */
export interface MeetingDetailResponse { meeting: MeetingDetail; transcript?: string; truncated?: boolean }

/** GET /api/meetings/sync-status. */
export interface MeetilySyncStatus { lastSyncAt: string | null; lastStatus: "done" | "failed" | "pending" | null; pending: boolean }

/** The most transcript text one response carries, in characters. */
export const TRANSCRIPT_RESPONSE_CAP = 60_000;
const HEADLINE_CAP = 200;

/** The first sentence of a summary, at most 200 characters, for the list's one line. */
function headline(s: string): string {
  const text = s.replace(/\s+/g, " ").trim();
  const first = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return first.length > HEADLINE_CAP ? `${first.slice(0, HEADLINE_CAP - 1).trimEnd()}…` : first;
}

const listItem = (m: Meeting): MeetingListItem => ({
  id: m.id, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, status: m.status,
  summary: m.summary ? headline(m.summary.summary) || null : null,
  actionItems: m.summary?.actionItems.length ?? 0, changeOrders: m.summary?.possibleChangeOrders.length ?? 0, followupSent: m.followupSentAt !== null,
});

async function detail(db: D1Database, m: Meeting): Promise<MeetingDetail> {
  const [pending, task] = await Promise.all([
    db.prepare(`SELECT 1 AS x FROM approvals WHERE kind = 'meeting.followup' AND record_type = 'meeting' AND record_id = ? AND status = 'pending' LIMIT 1`).bind(m.id).first(),
    db.prepare(`SELECT 1 AS x FROM claude_tasks WHERE kind = ? AND dedupe_key = ? AND status IN ('pending','claimed') LIMIT 1`).bind(MEETING_SUMMARIZE_KIND, m.id).first(),
  ]);
  return {
    id: m.id, businessId: m.businessId, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, status: m.status, notes: m.notes, summary: m.summary,
    followupSentAt: m.followupSentAt, followupPending: !!pending, summarizing: !!task,
  };
}

/** "Sync now": asks the Mac helper to pull Meetily's recent recordings, as the 15-minute cron does. Says whether a job was queued, and why not. */
meetingRoutes.post("/meetings/sync", async (c) => c.json(await requestMeetilySync(c.env, new Date())));

/**
 * When Meetily was last synced, from the helper's latest `meetily.sync` job. `lastStatus` is that job's state (done, failed, or pending while it is open; an expired one reads failed),
 * `lastSyncAt` is when the latest finished job finished, and `pending` is whether any job is open. Registered before `/meetings/:id`, which would otherwise take "sync-status" for an id.
 */
meetingRoutes.get("/meetings/sync-status", async (c) => {
  const [latest, finished, open] = await Promise.all([
    c.env.DB.prepare(`SELECT status FROM helper_jobs WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`).bind(MEETILY_SYNC_KIND).first<{ status: string }>(),
    c.env.DB.prepare(`SELECT done_at FROM helper_jobs WHERE kind = ? AND status IN ('done','failed','expired') AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 1`).bind(MEETILY_SYNC_KIND).first<{ done_at: string }>(),
    c.env.DB.prepare(`SELECT 1 AS x FROM helper_jobs WHERE kind = ? AND status IN ('pending','claimed') LIMIT 1`).bind(MEETILY_SYNC_KIND).first(),
  ]);
  const lastStatus: MeetilySyncStatus["lastStatus"] = !latest ? null : latest.status === "done" ? "done" : latest.status === "pending" || latest.status === "claimed" ? "pending" : "failed";
  const body: MeetilySyncStatus = { lastSyncAt: finished?.done_at ?? null, lastStatus, pending: !!open };
  return c.json(body);
});

/** A client's meetings, newest first (`?businessId=`; without it, everyone's). */
meetingRoutes.get("/meetings", async (c) => {
  const businessId = c.req.query("businessId") || undefined;
  return c.json({ meetings: (await listMeetings(c.env.DB, { businessId })).map(listItem) });
});

/** One meeting with its summary and Meetily's notes. The transcript text comes only with `?transcript=1`, cut at 60 000 characters (`truncated: true`). The transcript's storage key is never sent. */
meetingRoutes.get("/meetings/:id", async (c) => {
  const m = await getMeeting(c.env.DB, c.req.param("id"));
  if (!m) return c.json({ error: "That meeting was not found." }, 404);
  const body: MeetingDetailResponse = { meeting: await detail(c.env.DB, m) };
  if (c.req.query("transcript") === "1") {
    const text = await readTranscriptText(c.env, m);
    body.transcript = text.slice(0, TRANSCRIPT_RESPONSE_CAP);
    body.truncated = text.length > TRANSCRIPT_RESPONSE_CAP;
  }
  return c.json(body);
});

/**
 * "Summarize again": queues a new summary for a failed meeting, or a received one nothing is working on. A summarized meeting answers 409 (applying a second summary would
 * duplicate its tasks and approvals), and so does one whose summary task is already open.
 */
meetingRoutes.post("/meetings/:id/summarize", async (c) => {
  const m = await getMeeting(c.env.DB, c.req.param("id"));
  if (!m) return c.json({ error: "That meeting was not found." }, 404);
  if (m.status === "summarized") return c.json({ error: "This meeting is already summarized." }, 409);
  const { taskId, created } = await requestMeetingSummary(c.env.DB, m.id);
  if (!created) return c.json({ error: "A summary is already on its way for this meeting." }, 409);
  return c.json({ queued: true, taskId });
});
