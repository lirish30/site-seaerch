import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/worker/queue/kinds";
import { insertMeetingIfNew, saveSummary, setMeetingFailed, markFollowupSent } from "../src/worker/db/meetings";
import { createDevice } from "../src/worker/helper/auth";
import { claimHelperJob, completeHelperJob, enqueueHelperJob, failHelperJob } from "../src/worker/helper/jobs";
import { MEETILY_SYNC_KIND, type MeetilySyncPayload } from "../src/worker/meetings/syncKind";
import { MEETING_SUMMARIZE_KIND } from "../src/worker/queue/meetingSummary";
import type { MeetingSummary } from "../src/worker/meetings/summary";
import { createApprovalUnlessOpen } from "../src/worker/db/approvals";
import { seedBusiness } from "./fixtures/cro";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["helper_jobs", "helper_devices", "meetings", "claude_tasks", "approvals"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const o of (await env.RAW.list({ prefix: "meetings/" })).objects) await env.RAW.delete(o.key);
});
afterEach(() => vi.restoreAllMocks());

const call = (method: string, path: string, o: { auth?: boolean } = {}) => SELF.fetch(`https://x${path}`, { method, headers: o.auth === false ? {} : { cookie } });
const json = async <T,>(r: Response) => (await r.json()) as T;

const SUMMARY: MeetingSummary = {
  summary: "We agreed the scope for the new site. Pat will send the logo files. The launch is set for January.",
  decisions: ["Start in January"],
  actionItems: [{ title: "Send the logo files", owner: "client", dueOn: null }, { title: "Draft the sitemap", owner: "logan", dueOn: null }],
  possibleChangeOrders: [{ title: "Add a store", summary: "Pat wants to sell prints", reason: "Not in the signed scope", hours: 12 }],
  followUp: { subject: "Recap of today", body: "Thanks for the time today." }, generatedAt: "2026-12-01T20:00:00.000Z",
};

async function seedMeeting(businessId: string, o: { id?: string; meetilyId?: string; title?: string; startedAt?: string; notes?: string | null; lines?: { speaker: string | null; atSec: number | null; text: string }[] } = {}) {
  const id = o.id ?? crypto.randomUUID();
  const key = `meetings/${id}/transcript.json`;
  await env.RAW.put(key, JSON.stringify({ lines: o.lines ?? [{ speaker: "Pat", atSec: 3, text: "We want a store." }, { speaker: null, atSec: null, text: "Okay." }] }));
  const { meeting } = await insertMeetingIfNew(env.DB, {
    id, meetilyId: o.meetilyId ?? `m-${id}`, businessId, bookingId: null, windowKey: "w", title: o.title ?? "Kickoff call",
    startedAt: o.startedAt ?? "2026-12-01T17:00:00.000Z", endedAt: "2026-12-01T17:30:00.000Z", transcriptKey: key, notes: o.notes === undefined ? "Secret notes about the build" : o.notes,
  });
  return meeting;
}
const openTasks = async () => (await env.DB.prepare(`SELECT id FROM claude_tasks WHERE kind = ? AND status IN ('pending','claimed')`).bind(MEETING_SUMMARIZE_KIND).all()).results.length;

describe("auth", () => {
  it("every meetings route needs the owner's session", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id);
    expect((await call("GET", `/api/meetings?businessId=${b.id}`, { auth: false })).status).toBe(401);
    expect((await call("GET", `/api/meetings/${m.id}`, { auth: false })).status).toBe(401);
    expect((await call("POST", `/api/meetings/${m.id}/summarize`, { auth: false })).status).toBe(401);
    expect((await call("GET", "/api/meetings/sync-status", { auth: false })).status).toBe(401);
  });
});

describe("GET /meetings", () => {
  it("lists one client's meetings newest first, without the transcript, notes or its key", async () => {
    const b = await seedBusiness({ name: "Ace" });
    const other = await seedBusiness({ name: "Other" });
    const old = await seedMeeting(b.id, { title: "Old call", startedAt: "2026-11-01T17:00:00.000Z" });
    const fresh = await seedMeeting(b.id, { title: "New call", startedAt: "2026-12-01T17:00:00.000Z" });
    await seedMeeting(other.id, { title: "Someone else's call" });
    await saveSummary(env.DB, fresh.id, SUMMARY, "2026-12-01T20:00:00.000Z");
    await markFollowupSent(env.DB, fresh.id, "2026-12-01T21:00:00.000Z");

    const res = await call("GET", `/api/meetings?businessId=${b.id}`);
    expect(res.status).toBe(200);
    const { meetings } = await json<{ meetings: Record<string, unknown>[] }>(res);
    expect(meetings.map((m) => m.id)).toEqual([fresh.id, old.id]);
    expect(meetings[0]).toMatchObject({
      id: fresh.id, title: "New call", startedAt: "2026-12-01T17:00:00.000Z", endedAt: "2026-12-01T17:30:00.000Z", status: "summarized",
      summary: "We agreed the scope for the new site.", actionItems: 2, changeOrders: 1, followupSent: true,
    });
    expect(meetings[1]).toMatchObject({ id: old.id, status: "received", summary: null, actionItems: 0, changeOrders: 0, followupSent: false });
    const text = JSON.stringify(meetings);
    expect(text).not.toContain("transcriptKey");
    expect(text).not.toContain("transcript.json");
    expect(text).not.toContain("Secret notes");
    expect(text).not.toContain("We want a store");
    expect(text).not.toContain("Someone else");
  });

  it("is an empty list for a client with no meetings", async () => {
    const b = await seedBusiness();
    expect(await json(await call("GET", `/api/meetings?businessId=${b.id}`))).toEqual({ meetings: [] });
  });
});

describe("GET /meetings/:id", () => {
  it("is 404 for an unknown id", async () => {
    expect((await call("GET", "/api/meetings/nope")).status).toBe(404);
  });

  it("returns the meeting with its summary and notes but no transcript or key unless asked", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id);
    await saveSummary(env.DB, m.id, SUMMARY, "2026-12-01T20:00:00.000Z");
    const res = await call("GET", `/api/meetings/${m.id}`);
    expect(res.status).toBe(200);
    const body = await json<{ meeting: Record<string, unknown>; transcript?: string; truncated?: boolean }>(res);
    expect(body.meeting).toMatchObject({ id: m.id, businessId: b.id, title: "Kickoff call", status: "summarized", notes: "Secret notes about the build", summary: SUMMARY, followupSentAt: null, followupPending: false, summarizing: false });
    expect(body.transcript).toBeUndefined();
    expect(body.truncated).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("transcriptKey");
    expect(JSON.stringify(body)).not.toContain("transcript.json");
    expect(JSON.stringify(body)).not.toContain("We want a store");
  });

  it("?transcript=1 returns the transcript text", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id);
    const body = await json<{ meeting: Record<string, unknown>; transcript: string; truncated: boolean }>(await call("GET", `/api/meetings/${m.id}?transcript=1`));
    expect(body.transcript).toBe("Pat: We want a store.\nOkay.");
    expect(body.truncated).toBe(false);
    expect(JSON.stringify(body.meeting)).not.toContain("transcriptKey");
  });

  it("cuts a long transcript at 60 000 characters and says so", async () => {
    const b = await seedBusiness();
    const lines = Array.from({ length: 2000 }, (_, i) => ({ speaker: "Pat", atSec: i, text: "x".repeat(60) + ` line ${i}` }));
    const m = await seedMeeting(b.id, { lines });
    const body = await json<{ transcript: string; truncated: boolean }>(await call("GET", `/api/meetings/${m.id}?transcript=1`));
    expect(body.truncated).toBe(true);
    expect(body.transcript.length).toBe(60_000);
    expect(body.transcript.startsWith("Pat: xxxx")).toBe(true);
  });

  it("an empty transcript is an empty string, not truncated", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id, { lines: [] });
    expect(await json(await call("GET", `/api/meetings/${m.id}?transcript=1`))).toMatchObject({ transcript: "", truncated: false });
  });

  it("says whether the follow-up is waiting for approval, and whether a summary is on the way", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id);
    await saveSummary(env.DB, m.id, SUMMARY, "2026-12-01T20:00:00.000Z");
    await createApprovalUnlessOpen(env.DB, { kind: "meeting.followup", title: "Follow-up", preview: "p", payload: { meetingId: m.id }, record_type: "meeting", record_id: m.id, drafted_by: "job" }, 0);
    expect(await json(await call("GET", `/api/meetings/${m.id}`))).toMatchObject({ meeting: { followupPending: true, summarizing: false } });

    const r = await seedMeeting(b.id, { meetilyId: "m-r" });
    expect((await call("POST", `/api/meetings/${r.id}/summarize`)).status).toBe(200);
    expect(await json(await call("GET", `/api/meetings/${r.id}`))).toMatchObject({ meeting: { summarizing: true } });
  });
});

describe("POST /meetings/:id/summarize", () => {
  it("is 404 for an unknown id", async () => {
    expect((await call("POST", "/api/meetings/nope/summarize")).status).toBe(404);
  });

  it("queues exactly one summary task and a second call is 409", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id);
    const first = await call("POST", `/api/meetings/${m.id}/summarize`);
    expect(first.status).toBe(200);
    expect(await openTasks()).toBe(1);
    const second = await call("POST", `/api/meetings/${m.id}/summarize`);
    expect(second.status).toBe(409);
    expect((await json<{ error: string }>(second)).error).toMatch(/already/i);
    expect(await openTasks()).toBe(1);
  });

  it("asks again for a failed meeting", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id);
    await setMeetingFailed(env.DB, m.id);
    expect((await call("POST", `/api/meetings/${m.id}/summarize`)).status).toBe(200);
    expect(await openTasks()).toBe(1);
  });

  it("is 409 for a meeting that is already summarized, and queues nothing", async () => {
    const b = await seedBusiness();
    const m = await seedMeeting(b.id);
    await saveSummary(env.DB, m.id, SUMMARY, "2026-12-01T20:00:00.000Z");
    const res = await call("POST", `/api/meetings/${m.id}/summarize`);
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toMatch(/already summarized/i);
    expect(await openTasks()).toBe(0);
  });
});

describe("GET /meetings/sync-status", () => {
  const payload = (): MeetilySyncPayload => ({ syncId: crypto.randomUUID(), since: "2026-11-28T00:00:00.000Z", windows: [], knownMeetilyIds: [] });

  it("is all null before any job (and is not swallowed by /meetings/:id)", async () => {
    const res = await call("GET", "/api/meetings/sync-status");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ lastSyncAt: null, lastStatus: null, pending: false });
  });

  it("reports pending while a job is open, and done with its finish time after one", async () => {
    const { id } = await enqueueHelperJob(env.DB, MEETILY_SYNC_KIND, payload(), { dedupeKey: MEETILY_SYNC_KIND });
    expect(await json(await call("GET", "/api/meetings/sync-status"))).toEqual({ lastSyncAt: null, lastStatus: "pending", pending: true });

    const device = (await createDevice(env.DB, "Mac")).device.id;
    const job = (await claimHelperJob(env, device, new Date()))!;
    expect(job.id).toBe(id);
    expect((await completeHelperJob(env, job.id, device, { scanned: 0, matched: 0, key: null })).ok).toBe(true);
    const done = await json<{ lastSyncAt: string | null; lastStatus: string; pending: boolean }>(await call("GET", "/api/meetings/sync-status"));
    expect(done).toMatchObject({ lastStatus: "done", pending: false });
    expect(done.lastSyncAt).toBe((await env.DB.prepare(`SELECT done_at FROM helper_jobs WHERE id = ?`).bind(id).first<{ done_at: string }>())!.done_at);
  });

  it("reports failed when the latest job failed, with when it ended", async () => {
    await enqueueHelperJob(env.DB, MEETILY_SYNC_KIND, payload(), { dedupeKey: MEETILY_SYNC_KIND });
    const device = (await createDevice(env.DB, "Mac")).device.id;
    const job = (await claimHelperJob(env, device, new Date()))!;
    expect(await failHelperJob(env, job.id, device, "Meetily was not found")).toBe(true);
    const res = await json<{ lastSyncAt: string | null; lastStatus: string; pending: boolean }>(await call("GET", "/api/meetings/sync-status"));
    expect(res).toMatchObject({ lastStatus: "failed", pending: false });
    expect(res.lastSyncAt).not.toBeNull();
    expect(JSON.stringify(res)).not.toContain("Meetily was not found");
  });

  it("ignores jobs of other kinds", async () => {
    await env.DB.prepare(`INSERT INTO helper_jobs (id, kind, payload, status, attempts, created_at, done_at) VALUES ('j1', 'voice.test', '{}', 'done', 1, '2026-12-01T00:00:00.000Z', '2026-12-01T00:01:00.000Z')`).run();
    expect(await json(await call("GET", "/api/meetings/sync-status"))).toEqual({ lastSyncAt: null, lastStatus: null, pending: false });
  });
});
