import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/worker/queue/kinds";
import { listActivity } from "../src/worker/db/activity";
import { insertBookingIfFree } from "../src/worker/db/bookings";
import { insertMeetingIfNew, meetingByMeetilyId } from "../src/worker/db/meetings";
import { createDevice } from "../src/worker/helper/auth";
import { claimHelperJob, completeHelperJob, getHelperJob, type HelperJob } from "../src/worker/helper/jobs";
import { HelperRefused, getHelperKind, registeredHelperKinds } from "../src/worker/helper/kinds";
import {
  MEETILY_SYNC_KIND, MatchedMeetingsFile, requestMeetilySync, syncFileKey, transcriptKey, type MeetilySyncPayload,
} from "../src/worker/meetings/syncKind";
import { MEETING_SUMMARIZE_KIND } from "../src/worker/queue/meetingSummary";
import { MAIL_SYNC_CRON, runScheduled } from "../src/worker/schedule";
import { TranscriptFileSchema } from "../src/worker/meetings/summary";
import { saveGoogleAuth } from "../src/worker/db/google";
import { encryptSecret } from "../src/worker/google/crypto";
import { seedBusiness } from "./fixtures/cro";
import { seedClient } from "./fixtures/clients";

const NOW = new Date("2026-12-01T20:00:00.000Z");
const START = "2026-12-01T17:00:00.000Z"; // the window: 17:00 to 17:20
const END = "2026-12-01T17:20:00.000Z";
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

let cookie = "";
let device = "";
let logs: unknown[][] = [], errors: unknown[][] = [];
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["helper_jobs", "helper_devices", "meetings", "bookings", "claude_tasks", "agent_actions", "google_auth"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const o of (await env.RAW.list({ prefix: "meetings/" })).objects) await env.RAW.delete(o.key);
  device = (await createDevice(env.DB, "Mac")).device.id;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  logs = []; errors = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
});
afterEach(() => vi.restoreAllMocks());

const book = (businessId: string, startAt = START, endAt = END) =>
  insertBookingIfFree(env.DB, { businessId, dealId: null, kind: "discovery", startAt, endAt, contactName: "Pat Jones", contactEmail: "pat@ace.test", contactPhone: null, answers: null, source: "visitor" });

const entry = (over: Record<string, unknown> = {}) => ({
  meetilyId: "m-1", windowKey: "", title: "Kickoff call", startedAt: "2026-12-01T17:01:30.123456+00:00", endedAt: "2026-12-01T17:19:00.000000+00:00",
  notes: "Bring the brand guide", transcript: [{ speaker: "Pat", atSec: 3, text: "We want a store." }, { speaker: null, atSec: null, text: "Okay." }], ...over,
});

/** A business with one booking, a queued sync job claimed by the device, and the booking's window key. */
async function claimed() {
  const b = await seedBusiness();
  const booking = (await book(b.id))!;
  const q = await requestMeetilySync(env, NOW);
  expect(q).toEqual({ queued: true });
  const job = (await claimHelperJob(env, device, NOW, [MEETILY_SYNC_KIND]))!;
  const payload = job.payload as MeetilySyncPayload;
  return { b, booking, job, payload, key: `booking:${booking.id}`, file: syncFileKey(payload.syncId) };
}
const upload = (key: string, body: unknown) => env.RAW.put(key, typeof body === "string" ? body : JSON.stringify(body));
const meetings = async () => (await env.DB.prepare(`SELECT * FROM meetings ORDER BY meetily_id`).all<Record<string, any>>()).results;
const summaryTasks = async () => (await env.DB.prepare(`SELECT * FROM claude_tasks WHERE kind = ?`).bind(MEETING_SUMMARIZE_KIND).all<Record<string, any>>()).results;
const jobs = async () => (await env.DB.prepare(`SELECT * FROM helper_jobs`).all<Record<string, any>>()).results;
const done = (job: HelperJob, key: string | null, over: Record<string, unknown> = {}) => completeHelperJob(env, job.id, device, { scanned: 3, matched: 1, key, ...over });
/** The kind's own `apply`, as a crash-retry reaches it (the job queue would refuse a second completion). */
const apply = (payload: MeetilySyncPayload, key: string | null, e: typeof env = env) => getHelperKind(MEETILY_SYNC_KIND)!.apply(e, payload, { scanned: 1, matched: 1, key });
/** The env with every R2 call counted. */
function countingEnv() {
  const calls = { get: 0, put: 0, delete: 0 };
  const RAW = { get: (k: string) => { calls.get++; return env.RAW.get(k); }, put: (k: string, v: any, o?: any) => { calls.put++; return env.RAW.put(k, v, o); }, delete: (k: string) => { calls.delete++; return env.RAW.delete(k); }, head: (k: string) => env.RAW.head(k) } as unknown as R2Bucket;
  return { e: { ...env, RAW } as typeof env, calls };
}

describe("the kind", () => {
  it("is registered with no inputs and only the sync file as its output", () => {
    expect(MEETILY_SYNC_KIND).toBe("meetily.sync");
    expect(registeredHelperKinds()).toContain("meetily.sync");
    const def = getHelperKind(MEETILY_SYNC_KIND)!;
    const p: MeetilySyncPayload = { syncId: "abc", since: "2026-11-28T20:00:00.000Z", windows: [], knownMeetilyIds: [] };
    expect(def.inputs(p)).toEqual([]);
    expect(def.outputs(p)).toEqual(["meetings/sync/abc.json"]);
    expect(syncFileKey("abc")).toBe("meetings/sync/abc.json");
    expect(transcriptKey("m1")).toBe("meetings/m1/transcript.json");
  });

  it("checks the file the helper uploads against the contract's limits", () => {
    expect(MatchedMeetingsFile.safeParse({ meetings: [entry({ windowKey: "w" })] }).success).toBe(true);
    expect(MatchedMeetingsFile.safeParse({ meetings: [entry({ windowKey: "w", title: "x".repeat(301) })] }).success).toBe(false);
    expect(MatchedMeetingsFile.safeParse({ meetings: [entry({ windowKey: "w", notes: "x".repeat(50_001) })] }).success).toBe(false);
    expect(MatchedMeetingsFile.safeParse({ meetings: [entry({ windowKey: "w", notes: null })] }).success).toBe(true);
    expect(MatchedMeetingsFile.safeParse({ meetings: [entry({ windowKey: "w", transcript: [{ speaker: null, atSec: null, text: "x".repeat(5_001) }] })] }).success).toBe(false);
    expect(MatchedMeetingsFile.safeParse({ meetings: Array.from({ length: 51 }, () => entry({ windowKey: "w" })) }).success).toBe(false);
  });
});

describe("requestMeetilySync", () => {
  it("queues one job with the windows, the known ids and a fresh sync id, and a second call while it is open queues nothing", async () => {
    const b = await seedBusiness();
    const booking = (await book(b.id))!;
    await insertMeetingIfNew(env.DB, { meetilyId: "known-1", businessId: b.id, bookingId: null, windowKey: "x", title: "t", startedAt: "2026-11-30T10:00:00.000Z", endedAt: "2026-11-30T10:30:00.000Z", transcriptKey: "meetings/k/transcript.json", notes: null });
    await insertMeetingIfNew(env.DB, { meetilyId: "ancient", businessId: b.id, bookingId: null, windowKey: "x", title: "t", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:30:00.000Z", transcriptKey: "meetings/a/transcript.json", notes: null });

    expect(await requestMeetilySync(env, NOW)).toEqual({ queued: true });
    expect(await requestMeetilySync(env, NOW)).toEqual({ queued: false, reason: "already queued" });

    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "meetily.sync", status: "pending" });
    const p = JSON.parse(all[0].payload) as MeetilySyncPayload;
    expect(p.since).toBe("2026-11-28T20:00:00.000Z");
    expect(p.syncId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.windows).toEqual([{ key: `booking:${booking.id}`, businessId: b.id, startAt: START, endAt: END, bookingId: booking.id, source: "booking" }]);
    expect(p.knownMeetilyIds).toEqual(["known-1"]);
  });

  it("queues nothing when there is no window", async () => {
    expect(await requestMeetilySync(env, NOW)).toEqual({ queued: false, reason: "no windows" });
    await book((await seedBusiness()).id, "2026-11-20T17:00:00.000Z", "2026-11-20T17:20:00.000Z"); // older than 72 hours
    expect(await requestMeetilySync(env, NOW)).toEqual({ queued: false, reason: "no windows" });
    expect(await jobs()).toHaveLength(0);
  });

  it("sends each window once even when the calendar lists the same event twice", async () => {
    const SCOPE = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
    await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), SCOPE);
    const s = await seedClient({ site: false });
    await env.DB.prepare(`UPDATE people SET email = ? WHERE id = ?`).bind("dana@ace.test", s.person.id).run();
    const ev = { id: "e1", status: "confirmed", summary: "Call", start: { dateTime: START }, end: { dateTime: END }, attendees: [{ email: "dana@ace.test" }] };
    const f = async (url: string) => url.startsWith("https://oauth2.googleapis.com/token") ? Response.json({ access_token: "tok", expires_in: 3600 }) : Response.json({ items: [ev, ev] });
    const E = { ...env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };
    expect(await requestMeetilySync(E, NOW, { f })).toEqual({ queued: true });
    const p = JSON.parse((await jobs())[0].payload) as MeetilySyncPayload;
    expect(p.windows.map((w) => w.key)).toEqual(["event:e1"]);
  });
});

describe("applying the helper's result", () => {
  it("stores one meeting per entry with the business and booking of its window, the transcript in R2, one activity line and one summary task, then deletes the sync file", async () => {
    const { b, booking, job, key, file } = await claimed();
    await upload(file, { meetings: [
      entry({ windowKey: key, businessId: "someone-else", bookingId: "not-this-one" }),
      entry({ meetilyId: "m-2", windowKey: key, title: "Second ‮one\u0007", startedAt: "2026-12-01T09:05:00-08:00", endedAt: "2026-12-01T17:15:00.000Z", notes: null, transcript: [] }),
    ] });

    expect(await done(job, file)).toEqual({ ok: true });

    const rows = await meetings();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      meetily_id: "m-1", business_id: b.id, booking_id: booking.id, window_key: key, title: "Kickoff call", status: "received", notes: "Bring the brand guide",
      started_at: "2026-12-01T17:01:30.123Z", ended_at: "2026-12-01T17:19:00.000Z",
    });
    expect(rows[1]).toMatchObject({ meetily_id: "m-2", business_id: b.id, booking_id: booking.id, title: "Second one", notes: null, started_at: "2026-12-01T17:05:00.000Z", ended_at: "2026-12-01T17:15:00.000Z" });
    expect(rows[0].transcript_key).toBe(`meetings/${rows[0].id}/transcript.json`);
    expect(rows[0].transcript_key).toBe(transcriptKey(rows[0].id));

    const stored = TranscriptFileSchema.parse(await (await env.RAW.get(rows[0].transcript_key))!.json());
    expect(stored).toEqual({ lines: [{ speaker: "Pat", atSec: 3, text: "We want a store." }, { speaker: null, atSec: null, text: "Okay." }] });
    expect(TranscriptFileSchema.parse(await (await env.RAW.get(rows[1].transcript_key))!.json())).toEqual({ lines: [] });

    const lines = (await listActivity(env.DB, b.id)).filter((a) => a.kind === "meeting_recorded");
    expect(lines.map((a) => a.detail).sort()).toEqual(["Meeting recorded: Kickoff call", "Meeting recorded: Second one"]);
    expect(JSON.stringify(lines)).not.toContain("store"); // never the transcript

    const tasks = await summaryTasks();
    expect(tasks.map((t) => JSON.parse(t.payload).meetingId).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(tasks.every((t) => t.status === "pending")).toBe(true);

    expect(await env.RAW.head(file)).toBeNull();
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("done");
  });

  it("makes no second meeting, transcript write, activity line or task when the apply runs again after a crash", async () => {
    const { b, payload, key, file } = await claimed();
    const sync = { meetings: [entry({ windowKey: key })] };
    await upload(file, sync);
    const { e, calls } = countingEnv();
    await apply(payload, file, e);
    expect(calls.put).toBe(1);
    // The crash came after everything but the job's own `done`: the file is gone, so it comes back as the helper uploads it again.
    await upload(file, sync);
    await apply(payload, file, e);

    expect(await meetings()).toHaveLength(1);
    expect(calls.put).toBe(1);
    expect(await summaryTasks()).toHaveLength(1);
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "meeting_recorded")).toHaveLength(1);
    expect((await env.RAW.list({ prefix: "meetings/" })).objects).toHaveLength(1); // the one transcript: the sync file is gone and no second transcript was left behind
  });

  it("queues the summary a crash left out when the row exists but its task was never made, still without writing the transcript again", async () => {
    const { payload, key, file } = await claimed();
    const w = payload.windows[0];
    const { meeting } = await insertMeetingIfNew(env.DB, {
      id: "pre-id", meetilyId: "m-1", businessId: w.businessId, bookingId: w.bookingId, windowKey: key, title: "Kickoff call",
      startedAt: "2026-12-01T17:01:30.123Z", endedAt: "2026-12-01T17:19:00.000Z", transcriptKey: transcriptKey("pre-id"), notes: null,
    });
    await upload(file, { meetings: [entry({ windowKey: key })] });
    const { e, calls } = countingEnv();
    await apply(payload, file, e);
    expect(calls.put).toBe(0);
    expect(await meetings()).toHaveLength(1);
    expect((await summaryTasks()).map((t) => JSON.parse(t.payload).meetingId)).toEqual([meeting.id]);
    await upload(file, { meetings: [entry({ windowKey: key })] });
    await apply(payload, file, e);
    expect(await summaryTasks()).toHaveLength(1);
  });

  it("does not queue a summary again for a meeting that is already summarized", async () => {
    const { payload, key, file } = await claimed();
    const w = payload.windows[0];
    const { meeting } = await insertMeetingIfNew(env.DB, {
      meetilyId: "m-1", businessId: w.businessId, bookingId: w.bookingId, windowKey: key, title: "Kickoff call",
      startedAt: "2026-12-01T17:01:30.123Z", endedAt: "2026-12-01T17:19:00.000Z", transcriptKey: "meetings/x/transcript.json", notes: null,
    });
    await env.DB.prepare(`UPDATE meetings SET status = 'summarized' WHERE id = ?`).bind(meeting.id).run();
    await upload(file, { meetings: [entry({ windowKey: key })] });
    await apply(payload, file);
    expect(await summaryTasks()).toHaveLength(0);
  });

  it("drops an entry whose window is not in the payload, that starts too far outside its window, that Meetily already gave, or whose dates do not parse", async () => {
    const { b, job, key, file } = await claimed();
    await upload(file, { meetings: [
      entry({ meetilyId: "ok-edge-early", windowKey: key, startedAt: plus(START, -15), endedAt: plus(START, 5) }),
      entry({ meetilyId: "ok-edge-late", windowKey: key, startedAt: plus(END, 15), endedAt: plus(END, 40) }),
      entry({ meetilyId: "ok-inside", windowKey: key }),
      entry({ meetilyId: "too-early", windowKey: key, startedAt: plus(START, -16), endedAt: plus(START, 5) }),
      entry({ meetilyId: "too-late", windowKey: key, startedAt: plus(END, 16), endedAt: plus(END, 40) }),
      entry({ meetilyId: "other-window", windowKey: "booking:nope" }),
      entry({ meetilyId: "bad-start", windowKey: key, startedAt: "yesterday-ish" }),
      entry({ meetilyId: "bad-end", windowKey: key, endedAt: "" }),
      entry({ meetilyId: "backwards", windowKey: key, startedAt: plus(START, 10), endedAt: plus(START, 5) }),
    ] });
    expect(await done(job, file)).toEqual({ ok: true });
    expect((await meetings()).map((m) => m.meetily_id)).toEqual(["ok-edge-early", "ok-edge-late", "ok-inside"]);
    expect(await summaryTasks()).toHaveLength(3);
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "meeting_recorded")).toHaveLength(3);
    expect(await env.RAW.head(file)).toBeNull();
  });

  it("drops an entry whose Meetily id the payload listed as known", async () => {
    const b = await seedBusiness();
    await book(b.id);
    await insertMeetingIfNew(env.DB, { meetilyId: "known-1", businessId: b.id, bookingId: null, windowKey: "x", title: "t", startedAt: "2026-12-01T09:00:00.000Z", endedAt: "2026-12-01T09:30:00.000Z", transcriptKey: "meetings/k/transcript.json", notes: null });
    await requestMeetilySync(env, NOW);
    const job = (await claimHelperJob(env, device, NOW, [MEETILY_SYNC_KIND]))!;
    const p = job.payload as MeetilySyncPayload;
    expect(p.knownMeetilyIds).toEqual(["known-1"]);
    await upload(syncFileKey(p.syncId), { meetings: [entry({ meetilyId: "known-1", windowKey: p.windows[0].key, title: "Replaced" })] });
    expect(await done(job, syncFileKey(p.syncId))).toEqual({ ok: true });
    expect((await meetingByMeetilyId(env.DB, "known-1"))!.title).toBe("t");
    expect(await summaryTasks()).toHaveLength(0);
  });

  it("stores one meeting when the file lists the same Meetily id twice", async () => {
    const { job, key, file } = await claimed();
    await upload(file, { meetings: [entry({ windowKey: key }), entry({ windowKey: key, title: "Again" })] });
    expect(await done(job, file)).toEqual({ ok: true });
    expect(await meetings()).toHaveLength(1);
    expect(await summaryTasks()).toHaveLength(1);
  });

  it("completes with no R2 read when nothing matched", async () => {
    const { job } = await claimed();
    const { e, calls } = countingEnv();
    expect(await completeHelperJob(e, job.id, device, { scanned: 4, matched: 0, key: null })).toEqual({ ok: true });
    expect(calls).toEqual({ get: 0, put: 0, delete: 0 });
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("done");
    expect(await meetings()).toHaveLength(0);
  });
});

describe("refusing a result", () => {
  it("refuses a key that is not this job's sync file, and reads nothing", async () => {
    const { job, payload, key } = await claimed();
    await upload("meetings/sync/other.json", { meetings: [entry({ windowKey: key })] });
    const r = await done(job, "meetings/sync/other.json");
    expect(r).toEqual({ ok: false, error: expect.stringContaining(syncFileKey(payload.syncId)) });
    await expect(apply(payload, "meetings/sync/other.json")).rejects.toBeInstanceOf(HelperRefused);
    expect(await meetings()).toHaveLength(0);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("claimed");
  });

  it("refuses a missing file", async () => {
    const { job, payload, file } = await claimed();
    const r = await done(job, file);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/never uploaded|missing/i) });
    await expect(apply(payload, file)).rejects.toBeInstanceOf(HelperRefused);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("claimed");
  });

  it("refuses a file that is not JSON", async () => {
    const { job, file } = await claimed();
    await upload(file, "{ nope");
    const r = await done(job, file);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/i) });
    expect(await env.RAW.head(file)).not.toBeNull();
  });

  it("refuses a file that fails the contract, with the reason, and stores nothing", async () => {
    const { job, key, file } = await claimed();
    await upload(file, { meetings: [entry({ windowKey: key }), entry({ meetilyId: "m-2", windowKey: key, title: "x".repeat(301) })] });
    const r = await done(job, file);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("meetings.1.title");
    expect(await meetings()).toHaveLength(0);
    expect(await summaryTasks()).toHaveLength(0);
    expect((await getHelperJob(env.DB, job.id))!.status).toBe("claimed");
  });

  it("refuses a result that does not fit the result contract", async () => {
    const { job } = await claimed();
    expect((await done(job, "k", { scanned: "many" })).ok).toBe(false);
  });
});

describe("POST /api/meetings/sync", () => {
  const post = (auth = true) => SELF.fetch("https://x/api/meetings/sync", { method: "POST", headers: auth ? { cookie } : {} });

  it("needs the owner session", async () => {
    expect((await post(false)).status).toBe(401);
    expect(await jobs()).toHaveLength(0);
  });

  it("queues one job, and says so when one is already open or there is nothing to match", async () => {
    expect(await (await post()).json()).toEqual({ queued: false, reason: "no windows" });
    const start = new Date(Date.now() - 3_600_000);
    await book((await seedBusiness()).id, start.toISOString(), new Date(start.getTime() + 20 * 60_000).toISOString());
    const first = await post();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ queued: true });
    expect(await (await post()).json()).toEqual({ queued: false, reason: "already queued" });
    expect(await jobs()).toHaveLength(1);
  });
});

describe("the 15-minute cron", () => {
  const logged = () => logs.map((c) => String(c[0]));

  it("queues one job when a window exists and says so", async () => {
    await book((await seedBusiness()).id);
    await runScheduled(env, MAIL_SYNC_CRON, NOW);
    await runScheduled(env, MAIL_SYNC_CRON, NOW);
    expect(await jobs()).toHaveLength(1);
    expect(logged().filter((l) => l === "meeting sync")).toHaveLength(1); // the second tick found one open and stayed quiet
  });

  it("logs nothing and queues nothing when there is no window", async () => {
    await runScheduled(env, MAIL_SYNC_CRON, NOW);
    expect(await jobs()).toHaveLength(0);
    expect(logged().filter((l) => l.startsWith("meeting sync"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("contains a failure of the meeting sync", async () => {
    const broken = { ...env, DB: new Proxy(env.DB, { get(t, p) { if (p === "prepare") return (sql: string) => { if (/FROM bookings/.test(sql)) throw new Error("db down"); return t.prepare(sql); }; const v = (t as any)[p]; return typeof v === "function" ? v.bind(t) : v; } }) } as typeof env;
    await expect(runScheduled(broken, MAIL_SYNC_CRON, NOW)).resolves.toBeUndefined();
    expect(errors.some((c) => c[0] === "meeting sync failed")).toBe(true);
  });
});
