import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler, registeredKinds } from "../src/worker/approvals/registry";
import "../src/worker/approvals/meetingFollowup";
import { createApproval } from "../src/worker/db/approvals";
import { listActivity } from "../src/worker/db/activity";
import { insertBookingIfFree } from "../src/worker/db/bookings";
import { getMeeting, insertMeetingIfNew, saveSummary } from "../src/worker/db/meetings";
import { setMailDeps } from "../src/worker/mail/deps";
import type { Env } from "../src/worker/env";
import type { MeetingSummary } from "../src/worker/meetings/summary";
import { seedClient } from "./fixtures/clients";
import { OWNER_EMAIL, readyToSend } from "./fixtures/documents";
import { resetProjectWork } from "./fixtures/projects";

const SUMMARY: MeetingSummary = {
  summary: "Agreed scope.", decisions: [], actionItems: [], possibleChangeOrders: [],
  followUp: { subject: "Recap of today", body: "Hi Pat, thanks for the time today. I will send the sitemap by Thursday." }, generatedAt: "2026-12-01T20:00:00.000Z",
};
let n = 0;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await env.DB.batch(["meetings", "bookings", "approvals", "messages"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(() => { errors.mockRestore(); setMailDeps(null); });

/** A client, a summarized meeting for it (with a booking whose contact is Bea unless `booking: false`), and the pending follow-up approval. */
async function seed(o: { test?: boolean; booking?: boolean; summary?: MeetingSummary | null } = {}) {
  const client = await seedClient({ test: o.test });
  let bookingId: string | null = null;
  if (o.booking !== false) {
    bookingId = (await insertBookingIfFree(env.DB, { businessId: client.businessId, dealId: null, kind: "discovery", startAt: "2026-12-01T17:00:00.000Z", endAt: "2026-12-01T17:20:00.000Z",
      contactName: "Bea Booker", contactEmail: "bea@ace.test", contactPhone: null, answers: null, source: "logan" }))!.id;
  }
  const { meeting } = await insertMeetingIfNew(env.DB, {
    meetilyId: `m-${++n}`, businessId: client.businessId, bookingId, windowKey: `w-${n}`, title: "Kickoff", startedAt: "2026-12-01T17:00:00.000Z", endedAt: "2026-12-01T17:30:00.000Z",
    transcriptKey: `meetings/m-${n}/transcript.json`, notes: null,
  });
  if (o.summary !== null) await saveSummary(env.DB, meeting.id, o.summary ?? SUMMARY, "2026-12-01T20:00:00.000Z");
  const approval = await createApproval(env.DB, { kind: "meeting.followup", title: "Follow-up", preview: "p", payload: { meetingId: meeting.id }, record_type: "meeting", record_id: meeting.id, drafted_by: "job" });
  return { client, meeting, approval };
}

describe("meeting.followup kind", () => {
  it("is registered and labelled", () => {
    expect(registeredKinds()).toContain("meeting.followup");
    expect(getHandler("meeting.followup")!.label).toBe("Send meeting follow-up");
  });

  it("takes only a meeting id", () => {
    const h = getHandler("meeting.followup")!;
    expect(h.parse({ meetingId: "x" })).toEqual({ meetingId: "x" });
    expect(() => h.parse({ meetingId: "" })).toThrow();
    expect(() => h.parse({ meetingId: "x", subject: "Pay me" })).toThrow();
    expect(() => h.parse({})).toThrow();
  });
});

describe("approving the follow-up", () => {
  it("sends one mail from the main mailbox to the booking's contact, with the stored subject and body and the owner's signature", async () => {
    const mail = await readyToSend();
    const s = await seed();
    expect(await approve(env as Env, s.approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "bea@ace.test", subject: "Recap of today" });
    expect(mail.sent[0].text).toContain("Hi Pat, thanks for the time today. I will send the sitemap by Thursday.");
    expect(mail.sent[0].text).toContain("Logan"); // the signature
    expect(mail.sent[0].from.email).toBe((await env.DB.prepare(`SELECT from_email FROM mailboxes WHERE key = 'main'`).first<{ from_email: string }>())!.from_email);
    expect((await getMeeting(env.DB, s.meeting.id))!.followupSentAt).not.toBeNull();
    expect((await listActivity(env.DB, s.client.businessId)).some((a) => /follow-up sent/i.test(a.detail ?? ""))).toBe(true);
  });

  it("goes to the lead's point of contact when the meeting has no booking", async () => {
    const mail = await readyToSend();
    const s = await seed({ booking: false });
    expect(await approve(env as Env, s.approval.id)).toEqual({ ok: true });
    expect(mail.sent.map((m) => m.to)).toEqual(["pat@ace.test"]);
  });

  it("approving twice sends once", async () => {
    const mail = await readyToSend();
    const s = await seed();
    expect(await approve(env as Env, s.approval.id)).toEqual({ ok: true });
    expect(await approve(env as Env, s.approval.id)).toMatchObject({ ok: false, status: 409 });
    // Even if the handler is run again for the same meeting (a second approval, a retry), the mail does not repeat.
    const second = await createApproval(env.DB, { kind: "meeting.followup", title: "Follow-up", preview: "p", payload: { meetingId: s.meeting.id }, record_type: "meeting", record_id: s.meeting.id, drafted_by: "job" });
    expect(await approve(env as Env, second.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });

  it("a test client's follow-up goes to the owner only", async () => {
    const mail = await readyToSend();
    const s = await seed({ test: true });
    expect(await approve(env as Env, s.approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toBe("[Test] Recap of today");
    expect(mail.sent.some((m) => m.to === "bea@ace.test" || m.to === "pat@ace.test")).toBe(false);
  });

  it("a test client with no contact email of the owner's own fails with the plain sentence, and sends nothing", async () => {
    const mail = await readyToSend();
    await env.DB.prepare(`UPDATE settings SET contact_email = ''`).run();
    const s = await seed({ test: true });
    expect(await approve(env as Env, s.approval.id)).toEqual({ ok: false, error: "Add your contact email in Settings first: the test goes to it.", status: 502 });
    expect(mail.sent).toEqual([]);
  });

  it("a missing main mailbox fails with the plain sentence, leaves the approval pending and the meeting unsent", async () => {
    const mail = await readyToSend({ mailbox: false });
    const s = await seed();
    const r = await approve(env as Env, s.approval.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    if (!r.ok) expect(r.error).toMatch(/^The main mailbox cannot send: /);
    expect(mail.sent).toEqual([]);
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(s.approval.id).first<{ status: string }>())!.status).toBe("pending");
    expect((await getMeeting(env.DB, s.meeting.id))!.followupSentAt).toBeNull();
  });

  it("a missing recipient fails with a plain sentence", async () => {
    const mail = await readyToSend();
    const s = await seed({ booking: false });
    await env.DB.prepare(`DELETE FROM people WHERE business_id = ?`).bind(s.client.businessId).run();
    const r = await approve(env as Env, s.approval.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    if (!r.ok) expect(r.error).toMatch(/no contact email/);
    expect(mail.sent).toEqual([]);
  });

  it("a mail that fails to go leaves the approval pending, and a later approval sends it once", async () => {
    const mail = await readyToSend();
    mail.failures.push(new Error("smtp down"));
    const s = await seed();
    expect(await approve(env as Env, s.approval.id)).toMatchObject({ ok: false });
    expect(mail.sent).toEqual([]);
    expect((await getMeeting(env.DB, s.meeting.id))!.followupSentAt).toBeNull();
    expect(await approve(env as Env, s.approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });

  it("a meeting with no summary, or one that is gone, sends nothing", async () => {
    const mail = await readyToSend();
    const s = await seed({ summary: null });
    const r = await approve(env as Env, s.approval.id);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/no summary/);
    await env.DB.prepare(`DELETE FROM meetings WHERE id = ?`).bind(s.meeting.id).run();
    expect(await approve(env as Env, s.approval.id)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(mail.sent).toEqual([]);
  });
});
