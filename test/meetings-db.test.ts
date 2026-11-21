import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { deleteBusiness } from "../src/worker/db/businesses";
import { insertBookingIfFree } from "../src/worker/db/bookings";
import { getMeeting, insertMeetingIfNew, knownMeetilyIds, listMeetings, markFollowupSent, meetingForBooking, saveSummary } from "../src/worker/db/meetings";
import type { MeetingSummary } from "../src/worker/meetings/summary";
import { seedBusiness } from "./fixtures/cro";

const summary = (): MeetingSummary => ({
  summary: "Agreed scope for the new site.", decisions: ["Start in January"],
  actionItems: [{ title: "Send the logo files", owner: "client", dueOn: "2026-12-05" }, { title: "Draft the sitemap", owner: "logan", dueOn: null }],
  possibleChangeOrders: [{ title: "Add a store", summary: "Client wants to sell prints", reason: "Not in the signed scope", hours: 12 }],
  followUp: { subject: "Recap of today", body: "Thanks for the time today." }, generatedAt: "2026-12-01T20:00:00.000Z",
});

type Input = Parameters<typeof insertMeetingIfNew>[1];
const input = (businessId: string, over: Partial<Input> = {}): Input => ({
  meetilyId: "m-1", businessId, bookingId: null, windowKey: "2026-12-01T17:00", title: "Kickoff call",
  startedAt: "2026-12-01T17:00:00.000Z", endedAt: "2026-12-01T17:30:00.000Z", transcriptKey: "meetings/m-1/transcript.txt", notes: null, ...over,
});

beforeEach(async () => { await env.DB.batch([env.DB.prepare(`DELETE FROM meetings`), env.DB.prepare(`DELETE FROM bookings`)]); });

describe("insertMeetingIfNew", () => {
  it("creates once per Meetily id and returns the same row the second time", async () => {
    const b = await seedBusiness();
    const first = await insertMeetingIfNew(env.DB, input(b.id, { notes: "Bring the brand guide" }));
    expect(first.created).toBe(true);
    expect(first.meeting).toMatchObject({ meetilyId: "m-1", businessId: b.id, bookingId: null, windowKey: "2026-12-01T17:00", title: "Kickoff call",
      startedAt: "2026-12-01T17:00:00.000Z", endedAt: "2026-12-01T17:30:00.000Z", transcriptKey: "meetings/m-1/transcript.txt", notes: "Bring the brand guide",
      status: "received", summary: null, followupSentAt: null, summarizedAt: null });
    const second = await insertMeetingIfNew(env.DB, input(b.id, { title: "Changed" }));
    expect(second.created).toBe(false);
    expect(second.meeting.id).toBe(first.meeting.id);
    expect(second.meeting.title).toBe("Kickoff call");
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM meetings`).first<{ n: number }>())!.n).toBe(1);
  });
});

describe("reading meetings", () => {
  it("getMeeting is null for an unknown id", async () => {
    expect(await getMeeting(env.DB, "nope")).toBeNull();
  });

  it("knownMeetilyIds returns only ids that started at or after the cut-off", async () => {
    const b = await seedBusiness();
    await insertMeetingIfNew(env.DB, input(b.id, { meetilyId: "old", startedAt: "2026-11-01T10:00:00.000Z" }));
    await insertMeetingIfNew(env.DB, input(b.id, { meetilyId: "edge", startedAt: "2026-11-15T00:00:00.000Z" }));
    await insertMeetingIfNew(env.DB, input(b.id, { meetilyId: "new", startedAt: "2026-12-01T10:00:00.000Z" }));
    expect((await knownMeetilyIds(env.DB, "2026-11-15T00:00:00.000Z")).sort()).toEqual(["edge", "new"]);
  });

  it("listMeetings is newest first, filters by business and honours the limit", async () => {
    const [x, y] = [await seedBusiness({ name: "X Co" }), await seedBusiness({ name: "Y Co" })];
    const a = (await insertMeetingIfNew(env.DB, input(x.id, { meetilyId: "a", startedAt: "2026-12-01T10:00:00.000Z" }))).meeting;
    const c = (await insertMeetingIfNew(env.DB, input(x.id, { meetilyId: "c", startedAt: "2026-12-03T10:00:00.000Z" }))).meeting;
    const other = (await insertMeetingIfNew(env.DB, input(y.id, { meetilyId: "o", startedAt: "2026-12-02T10:00:00.000Z" }))).meeting;
    expect((await listMeetings(env.DB, { businessId: x.id })).map((m) => m.id)).toEqual([c.id, a.id]);
    expect((await listMeetings(env.DB, {})).map((m) => m.id)).toEqual([c.id, other.id, a.id]);
    expect((await listMeetings(env.DB, { limit: 1 })).map((m) => m.id)).toEqual([c.id]);
  });

  it("meetingForBooking finds the meeting made with that booking", async () => {
    const b = await seedBusiness();
    const booking = (await insertBookingIfFree(env.DB, { businessId: b.id, dealId: null, kind: "discovery", startAt: "2026-12-01T17:00:00.000Z", endAt: "2026-12-01T17:20:00.000Z",
      contactName: "Pat", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "logan" }))!;
    expect(await meetingForBooking(env.DB, booking.id)).toBeNull();
    const made = (await insertMeetingIfNew(env.DB, input(b.id, { bookingId: booking.id }))).meeting;
    expect((await meetingForBooking(env.DB, booking.id))!.id).toBe(made.id);
    expect((await getMeeting(env.DB, made.id))!.bookingId).toBe(booking.id);
  });

  it("deleting the business deletes its meetings; deleting the booking only clears the link", async () => {
    const b = await seedBusiness();
    const booking = (await insertBookingIfFree(env.DB, { businessId: b.id, dealId: null, kind: "discovery", startAt: "2026-12-01T17:00:00.000Z", endAt: "2026-12-01T17:20:00.000Z",
      contactName: "Pat", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "logan" }))!;
    const made = (await insertMeetingIfNew(env.DB, input(b.id, { bookingId: booking.id }))).meeting;
    await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(booking.id).run();
    expect((await getMeeting(env.DB, made.id))!.bookingId).toBeNull();
    await deleteBusiness(env.DB, b.id);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM meetings`).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("saveSummary", () => {
  it("is true only for the call that summarizes, and stores the summary", async () => {
    const b = await seedBusiness();
    const { meeting } = await insertMeetingIfNew(env.DB, input(b.id));
    expect(await saveSummary(env.DB, meeting.id, summary(), "2026-12-01T20:00:00.000Z")).toBe(true);
    expect(await saveSummary(env.DB, meeting.id, { ...summary(), summary: "second" }, "2026-12-01T21:00:00.000Z")).toBe(false);
    const got = (await getMeeting(env.DB, meeting.id))!;
    expect(got).toMatchObject({ status: "summarized", summarizedAt: "2026-12-01T20:00:00.000Z" });
    expect(got.summary).toEqual(summary());
  });

  it("also takes a failed meeting, and is false for an unknown id", async () => {
    const b = await seedBusiness();
    const { meeting } = await insertMeetingIfNew(env.DB, input(b.id));
    await env.DB.prepare(`UPDATE meetings SET status = 'failed' WHERE id = ?`).bind(meeting.id).run();
    expect(await saveSummary(env.DB, meeting.id, summary(), "2026-12-01T20:00:00.000Z")).toBe(true);
    expect(await saveSummary(env.DB, "nope", summary(), "2026-12-01T20:00:00.000Z")).toBe(false);
  });

  it("reads a damaged summary column as null instead of throwing", async () => {
    const b = await seedBusiness();
    const { meeting } = await insertMeetingIfNew(env.DB, input(b.id));
    await env.DB.prepare(`UPDATE meetings SET summary = 'not json' WHERE id = ?`).bind(meeting.id).run();
    expect((await getMeeting(env.DB, meeting.id))!.summary).toBeNull();
  });
});

describe("markFollowupSent", () => {
  it("is true the first time and false after", async () => {
    const b = await seedBusiness();
    const { meeting } = await insertMeetingIfNew(env.DB, input(b.id));
    expect(await markFollowupSent(env.DB, meeting.id, "2026-12-01T22:00:00.000Z")).toBe(true);
    expect(await markFollowupSent(env.DB, meeting.id, "2026-12-01T23:00:00.000Z")).toBe(false);
    expect((await getMeeting(env.DB, meeting.id))!.followupSentAt).toBe("2026-12-01T22:00:00.000Z");
  });
});
