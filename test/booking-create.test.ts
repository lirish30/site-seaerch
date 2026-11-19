import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import * as callPrep from "../src/worker/booking/callPrep";
import { BookingFormSchema, cancelByToken, createVisitorBooking } from "../src/worker/booking/create";
import { setBookingDeps } from "../src/worker/booking/deps";
import { bookingFor, getBookingByCancelToken, insertBookingIfFree } from "../src/worker/db/bookings";
import { listActivity } from "../src/worker/db/activity";
import { getBusiness } from "../src/worker/db/businesses";
import { openDealFor } from "../src/worker/db/deals";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { createApproval } from "../src/worker/db/approvals";
import { revokeReports } from "../src/worker/db/reports";
import { saveSettings } from "../src/worker/db/settings";
import { suppressLead } from "../src/worker/db/suppression";
import { setMailDeps } from "../src/worker/mail/deps";
import { saveMailbox } from "../src/worker/db/mailboxes";
import type { OutboundMessage } from "../src/worker/mail/types";
import { stopOutreach } from "../src/worker/sequence/stop";
import "../src/worker/approvals/emailSend";
import { NOW, SLOT, SLOT_2, WEEKDAY_WINDOWS, bookingOn, connectGoogle, fakeGoogle, form, googleEnv, resetBookingTables, seedLead, setBookingConfig } from "./fixtures/booking";

const e = googleEnv();
let google = fakeGoogle();
let smtp = 0;
// The seam Task 8 fills: spied on, so each booking is seen to ask for call prep once.
const queueCallPrep = vi.spyOn(callPrep, "queueCallPrep");

beforeEach(async () => {
  await resetBookingTables();
  google = fakeGoogle();
  setBookingDeps({ fetch: google.f });
  smtp = 0;
  setMailDeps({ smtp: async () => { smtp++; }, now: () => NOW });
  queueCallPrep.mockClear();
  await bookingOn();
});
afterEach(() => { setBookingDeps(null); setMailDeps(null); });

const book = (token: string, over: Parameters<typeof form>[0] = {}, now = NOW) => createVisitorBooking(e, token, form(over), now);
const rows = async () => (await env.DB.prepare(`SELECT * FROM bookings ORDER BY created_at, id`).all<any>()).results;

async function seedEnrollment(businessId: string, approvals = 1) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, next_due_at, started_at, last_sent_step)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, businessId, "camp", "outreach", "pat@acme.test", "active", 1, NOW.toISOString(), NOW.toISOString(), 0).run();
  const ids: string[] = [];
  for (let i = 0; i < approvals; i++) {
    ids.push((await createApproval(env.DB, { kind: "email.send", title: "Step 1", preview: "Hi", payload: { businessId, stepIndex: 1, enrollmentId: id }, record_type: "enrollment", record_id: id, drafted_by: "job" })).id);
  }
  return { id, approvals: ids };
}

describe("createVisitorBooking", () => {
  it("a valid booking creates the event, the deal, stops the sequence and queues call.prep", async () => {
    const { b, token } = await seedLead();
    const enrollment = await seedEnrollment(b.id);
    const out = await book(token);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The calendar event: one, for the 20 minutes asked for, with the guest and a Meet request. No mail goes from Google.
    expect(google.created()).toHaveLength(1);
    expect(google.created()[0].url).toContain("sendUpdates=none");
    // The event is made under the booking's own id (its uuid without dashes), so it is known even if Google's answer never arrives.
    expect(google.created()[0].body.id).toBe(out.booking.id.replace(/-/g, ""));
    expect(google.created()[0].body.id).toMatch(/^[0-9a-v]{32}$/);
    expect(google.created()[0].body).toMatchObject({ start: { dateTime: SLOT }, end: { dateTime: "2026-11-24T18:20:00.000Z" }, attendees: [{ email: "pat@acme.test" }] });
    expect(google.created()[0].body.conferenceData.createRequest.requestId).toBe(out.booking.id);
    // The booking row.
    expect(out.booking).toMatchObject({ businessId: b.id, kind: "discovery", status: "confirmed", startAt: SLOT, endAt: "2026-11-24T18:20:00.000Z", contactName: "Pat Jones",
      contactEmail: "pat@acme.test", contactPhone: "208-555-0100", calendarEventId: out.booking.id.replace(/-/g, ""), meetUrl: "https://meet.google.com/abc-defg-h1", source: "visitor",
      answers: { topic: "A new website", budgetId: "797-1999", timeline: "This month", decisionMaker: "me" } });
    expect(out.booking.cancelToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await bookingFor(env.DB, b.id, "discovery"))!.id).toBe(out.booking.id);
    // The deal, linked.
    const deal = (await openDealFor(env.DB, b.id))!;
    expect(deal).toMatchObject({ stage: "booked", source: "booking" });
    expect(out.booking.dealId).toBe(deal.id);
    expect((await bookingFor(env.DB, b.id, "discovery"))!.dealId).toBe(deal.id);
    // The sequence stops: ended as replied (reason booked), its waiting approval rejected, the lead moved to replied.
    expect(await env.DB.prepare(`SELECT status, stopped_reason, next_due_at FROM enrollments WHERE id = ?`).bind(enrollment.id).first()).toEqual({ status: "replied", stopped_reason: "booked", next_due_at: null });
    expect(await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(enrollment.approvals[0]).first()).toEqual({ status: "rejected" });
    expect((await getBusiness(env.DB, b.id))!.lead_status).toBe("replied");
    // The activity line, and the seam Task 8 fills.
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "booked")).toHaveLength(1);
    expect(queueCallPrep).toHaveBeenCalledTimes(1);
    expect(queueCallPrep).toHaveBeenCalledWith(e, deal.id);
    // The main mailbox is not set up in this test, so no confirmation goes out and the timeline says why; the booking stands.
    expect(smtp).toBe(0);
    expect((await listActivity(env.DB, b.id)).filter((a) => a.detail?.startsWith("confirmation not sent:")).map((a) => a.detail)).toEqual(["confirmation not sent: mailbox is not configured"]);
  });

  it("slot busy on the calendar since page load is refused", async () => {
    google = fakeGoogle({ busy: [{ start: "2026-11-24T17:50:00.000Z", end: "2026-11-24T18:30:00.000Z" }] });
    setBookingDeps({ fetch: google.f });
    const { b, token } = await seedLead();
    expect(await book(token)).toMatchObject({ ok: false, status: 409, error: "that time was just taken" });
    expect(await rows()).toHaveLength(0);
    expect(google.created()).toHaveLength(0);
    expect(await openDealFor(env.DB, b.id)).toBeNull();
  });

  it("a time that was never offered is refused", async () => {
    const { token } = await seedLead();
    expect(await book(token, { start: "2026-11-24T18:07:00.000Z" })).toMatchObject({ ok: false, status: 409 }); // off the grid
    expect(await book(token, { start: "2026-11-22T18:00:00.000Z" })).toMatchObject({ ok: false, status: 409 }); // a Sunday
    expect(await book(token, { start: "not a date" })).toMatchObject({ ok: false, status: 409 });
    expect(google.created()).toHaveLength(0);
  });

  it("a free/busy failure is a 503, never read as free", async () => {
    google = fakeGoogle({ freeBusyErrors: true });
    setBookingDeps({ fetch: google.f });
    const { token } = await seedLead();
    expect(await book(token)).toMatchObject({ ok: false, status: 503 });
    expect(google.created()).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("the same slot twice is caught by the booking table even when the calendar looks free", async () => {
    const [x, y] = [await seedLead("X Co"), await seedLead("Y Co")];
    expect((await book(x.token)).ok).toBe(true);
    google.busy.length = 0; // a stale read: the event is not in free/busy yet
    expect(await book(y.token, { email: "other@y.test" })).toMatchObject({ ok: false, status: 409 });
    expect(google.created()).toHaveLength(1);
    expect((await rows()).filter((r) => r.status === "confirmed")).toHaveLength(1);
    expect(await openDealFor(env.DB, y.b.id)).toBeNull();
  });

  it("a lead that already has a call booked cannot book a second", async () => {
    const { token } = await seedLead();
    expect((await book(token)).ok).toBe(true);
    expect(await book(token, { start: SLOT_2 })).toMatchObject({ ok: false, status: 409 });
    expect(google.created()).toHaveLength(1);
  });

  it("calendar create failure leaves no confirmed row", async () => {
    google = fakeGoogle({ createFails: true });
    setBookingDeps({ fetch: google.f });
    const { b, token } = await seedLead();
    expect(await book(token)).toMatchObject({ ok: false, status: 503 });
    expect(google.created()).toHaveLength(1); // tried once, never blindly retried
    // The event may exist even though the call failed, so its id is cleared (the id is the one the create call was sent).
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining(`/events/${google.created()[0].body.id}`)]);
    expect((await rows()).map((r) => r.status)).toEqual(["cancelled"]);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    expect(await openDealFor(env.DB, b.id)).toBeNull();
    expect(queueCallPrep).not.toHaveBeenCalled();
    // The slot is free again for the next try.
    google = fakeGoogle();
    setBookingDeps({ fetch: google.f });
    expect((await book(token)).ok).toBe(true);
  });

  it("a createEvent that throws (a timeout) still clears the event it may have made, under the same id", async () => {
    google = fakeGoogle({ createThrows: true });
    setBookingDeps({ fetch: google.f });
    const { b, token } = await seedLead();
    expect(await book(token)).toMatchObject({ ok: false, status: 503 });
    expect(google.created()).toHaveLength(1);
    const id = google.created()[0].body.id;
    expect(id).toBe((await rows())[0].id.replace(/-/g, ""));
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining(`/events/${id}`)]);
    expect((await rows()).map((r) => r.status)).toEqual(["cancelled"]);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
  });

  it("a failure after the event exists deletes the event and cancels the row", async () => {
    const { b, token } = await seedLead();
    const orig = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (q: string) => { if (/INSERT INTO deals/i.test(q)) throw new Error("db down"); return orig(q); };
    let out;
    try { out = await book(token); } finally { (env.DB as any).prepare = orig; }
    expect(out).toMatchObject({ ok: false, status: 503 });
    expect(google.created()).toHaveLength(1);
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining(`/events/${(await rows())[0].id.replace(/-/g, "")}`)]);
    expect((await rows()).map((r) => r.status)).toEqual(["cancelled"]);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    expect(queueCallPrep).not.toHaveBeenCalled();
  });

  it("unknown budget id is a 422", async () => {
    const { token } = await seedLead();
    expect(await book(token, { budgetId: "10-million" })).toMatchObject({ ok: false, status: 422 });
    expect(await book(token, { timeline: "Yesterday" })).toMatchObject({ ok: false, status: 422 });
    expect(await rows()).toHaveLength(0);
    expect(google.created()).toHaveLength(0);
  });

  it("an unknown, revoked or expired token is a 404", async () => {
    const { b, token } = await seedLead();
    const unknown = await book("U".repeat(43));
    expect(unknown).toEqual({ ok: false, status: 404, error: "not found" });
    // expired: a link made a month and a bit ago
    const old = await seedLead("Old Co", new Date(NOW.getTime() - 40 * 86_400_000));
    expect(await book(old.token)).toEqual(unknown);
    await revokeReports(env.DB, b.id);
    expect(await book(token)).toEqual(unknown); // a revoked token cannot book
    expect(google.calls).toHaveLength(0);
  });

  it("do-not-contact lead gets the same 404 as an unknown token", async () => {
    const unknown = await book("U".repeat(43));
    const byEmail = await seedLead("Email Co");
    await addDoNotContact(env.DB, { kind: "email", value: "pat@acme.test", reason: "opt_out", note: "" });
    expect(await book(byEmail.token)).toEqual(unknown);
    await env.DB.prepare(`DELETE FROM do_not_contact`).run();
    const byName = await seedLead("Name Co");
    await addDoNotContact(env.DB, { kind: "name", value: "Name Co", reason: "client", note: "" });
    expect(await book(byName.token)).toEqual(unknown);
    const suppressed = await seedLead("Suppressed Co");
    await suppressLead(env.DB, (await getBusiness(env.DB, suppressed.b.id))!, { reason: "opt_out", note: "" });
    expect(await book(suppressed.token)).toEqual(unknown);
    expect(google.calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("a client (won) cannot book", async () => {
    const unknown = await book("U".repeat(43));
    const { b, token } = await seedLead("Client Co");
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(b.id).run();
    expect(await book(token)).toEqual(unknown);
    expect(await rows()).toHaveLength(0);
  });

  it("booking with an empty or windowless config is a 503 with the fallback url", async () => {
    await saveSettings(env.DB, { booking_url: "https://cal.example.com/me" });
    const { token } = await seedLead();
    for (const cfg of [{}, { windows: [] }]) {
      await setBookingConfig(cfg);
      expect(await book(token)).toMatchObject({ ok: false, status: 503, fallbackUrl: "https://cal.example.com/me" });
    }
    await env.DB.prepare(`UPDATE settings SET booking_config = '' WHERE id = 1`).run();
    expect(await book(token)).toMatchObject({ ok: false, status: 503 });
    // An http-only fallback is not shown.
    await saveSettings(env.DB, { booking_url: "http://cal.example.com/me" });
    expect(await book(token)).toMatchObject({ ok: false, status: 503, fallbackUrl: "" });
    expect(await rows()).toHaveLength(0);
    expect(google.created()).toHaveLength(0);
  });

  it("booking with Google disconnected, or without both calendar scopes, is a 503", async () => {
    const { token } = await seedLead();
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect(await book(token)).toMatchObject({ ok: false, status: 503 });
    await connectGoogle("openid email https://www.googleapis.com/auth/calendar.events");
    expect(await book(token)).toMatchObject({ ok: false, status: 503 });
    expect(google.calls).toHaveLength(0);
  });

  it("answers containing script tags are stored as typed and never rendered raw", async () => {
    const { b, token } = await seedLead();
    const evil = `<script>alert(1)</script> & <img src=x onerror=alert(2)>`;
    const out = await book(token, { name: `<b>${evil}</b>`, topic: evil, timeline: "This month" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Stored exactly as typed.
    const row = (await env.DB.prepare(`SELECT contact_name, answers FROM bookings WHERE id = ?`).bind(out.booking.id).first<any>())!;
    expect(row.contact_name).toBe(`<b>${evil}</b>`);
    expect(JSON.parse(row.answers).topic).toBe(evil);
    // Not in the activity line, and not as markup in the calendar event.
    const activity = (await listActivity(env.DB, b.id)).map((a) => a.detail ?? "").join("\n");
    expect(activity).not.toMatch(/<\s*(script|img|b)\b/i);
    expect(activity).not.toContain("alert(");
    const event = JSON.stringify(google.created()[0].body);
    expect(event).not.toMatch(/<\s*(script|img|b)\b/i);
    // Each way a prospect's text could reach a page goes through React, which escapes it.
    const src = import.meta.glob(["../src/client/pages/Book.tsx", "../src/client/pages/LeadDetail.tsx", "../src/client/components/UpcomingBooking.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(src).length).toBeGreaterThanOrEqual(3);
    for (const [name, text] of Object.entries(src)) expect(text, name).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("cancelByToken", () => {
  it("cancel with a wrong cancel token changes nothing", async () => {
    const { b, token } = await seedLead();
    const out = await book(token);
    if (!out.ok) throw new Error("booking failed");
    expect(await cancelByToken(e, token, "x".repeat(43), NOW)).toEqual({ ok: false });
    expect(await cancelByToken(e, "U".repeat(43), out.booking.cancelToken, NOW)).toEqual({ ok: false }); // right cancel token, wrong report token
    const other = await seedLead("Other Co");
    expect(await cancelByToken(e, other.token, out.booking.cancelToken, NOW)).toEqual({ ok: false }); // another lead's token
    expect((await bookingFor(env.DB, b.id, "discovery"))!.status).toBe("confirmed");
    expect(google.deleted()).toHaveLength(0);
  });

  it("cancel twice is fine and deletes the event once", async () => {
    const { b, token } = await seedLead();
    const out = await book(token);
    if (!out.ok) throw new Error("booking failed");
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await cancelByToken(e, token, out.booking.cancelToken, later)).toEqual({ ok: true, kind: "discovery" });
    expect(await cancelByToken(e, token, out.booking.cancelToken, new Date(later.getTime() + 60_000))).toEqual({ ok: true, kind: "discovery" });
    expect(google.deleted()).toHaveLength(1);
    expect(google.deleted()[0].url).toContain(`/events/${out.booking.id.replace(/-/g, "")}`);
    const after = (await getBookingByCancelToken(env.DB, b.id, out.booking.cancelToken))!;
    expect(after).toMatchObject({ status: "cancelled", cancelledAt: later.toISOString() });
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "booking_cancelled")).toHaveLength(1);
    // Cancelling moves nothing else: the deal stays where it was, the lead stays replied.
    expect(await openDealFor(env.DB, b.id)).toMatchObject({ stage: "booked" });
    expect((await getBusiness(env.DB, b.id))!.lead_status).toBe("replied");
    // The guest can book again after cancelling.
    expect((await book(token, { start: SLOT_2 })).ok).toBe(true);
  });

  /** A booked call and its report link, ready to cancel. */
  async function booked(name = "Ace Plumbing", start = SLOT) {
    const lead = await seedLead(name);
    const out = await book(lead.token, { start, email: `${name.replace(/\W/g, "").toLowerCase()}@acme.test` });
    if (!out.ok) throw new Error("booking failed");
    return { ...lead, booking: out.booking, eventId: out.booking.id.replace(/-/g, "") };
  }

  it("cancel works with an expired report token and the right cancel token, and deletes the event", async () => {
    const { b, token, booking, eventId } = await booked();
    await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token = ?`).bind("2020-01-01T00:00:00.000Z", token).run();
    expect(await cancelByToken(e, token, booking.cancelToken, NOW)).toEqual({ ok: true, kind: "discovery" });
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining(`/events/${eventId}`)]);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
  });

  it("cancel works with a revoked report token", async () => {
    const { b, token, booking } = await booked();
    await revokeReports(env.DB, b.id);
    expect(await cancelByToken(e, token, booking.cancelToken, NOW)).toEqual({ ok: true, kind: "discovery" });
    expect(google.deleted()).toHaveLength(1);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
  });

  it("cancel works for a do-not-contact lead: letting the slot go is always allowed", async () => {
    const { b, token, booking } = await booked();
    await addDoNotContact(env.DB, { kind: "email", value: "pat@acme.test", reason: "opt_out" });
    await addDoNotContact(env.DB, { kind: "name", value: "Ace Plumbing", reason: "other" });
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(b.id).run();
    expect(await cancelByToken(e, token, booking.cancelToken, NOW)).toEqual({ ok: true, kind: "discovery" });
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    expect(google.deleted()).toHaveLength(1);
  });

  it("an expired report token with a wrong or another lead's cancel token still changes nothing, and answers the same", async () => {
    const a = await booked("A Co"), other = await booked("B Co", SLOT_2);
    google.busy.length = 0;
    await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token IN (?, ?)`).bind("2020-01-01T00:00:00.000Z", a.token, other.token).run();
    const answers = [
      await cancelByToken(e, a.token, "x".repeat(43), NOW), // wrong cancel token
      await cancelByToken(e, a.token, other.booking.cancelToken, NOW), // another lead's cancel token
      await cancelByToken(e, "U".repeat(43), a.booking.cancelToken, NOW), // a report token that was never issued
      await cancelByToken(e, "short", a.booking.cancelToken, NOW), // not a token at all
      await cancelByToken(e, a.token, "short", NOW),
    ];
    for (const r of answers) expect(r).toEqual({ ok: false });
    expect(google.deleted()).toHaveLength(0);
    expect((await bookingFor(env.DB, a.b.id, "discovery"))!.status).toBe("confirmed");
    expect((await bookingFor(env.DB, other.b.id, "discovery"))!.status).toBe("confirmed");
  });

  it("a second cancel after the report has expired is ok and does not delete twice", async () => {
    const { token, booking } = await booked();
    await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token = ?`).bind("2020-01-01T00:00:00.000Z", token).run();
    expect(await cancelByToken(e, token, booking.cancelToken, NOW)).toEqual({ ok: true, kind: "discovery" });
    expect(await cancelByToken(e, token, booking.cancelToken, new Date(NOW.getTime() + 60_000))).toEqual({ ok: true, kind: "discovery" });
    expect(google.deleted()).toHaveLength(1);
  });

  it("a call that has started cannot be cancelled", async () => {
    const { b, token, booking } = await booked();
    const atStart = new Date(booking.startAt), after = new Date(Date.parse(booking.startAt) + 60_000);
    expect(await cancelByToken(e, token, booking.cancelToken, atStart)).toEqual({ ok: false });
    expect(await cancelByToken(e, token, booking.cancelToken, after)).toEqual({ ok: false });
    expect(google.deleted()).toHaveLength(0);
    expect((await bookingFor(env.DB, b.id, "discovery"))!.status).toBe("confirmed");
    // One minute before it starts is still fine.
    expect(await cancelByToken(e, token, booking.cancelToken, new Date(Date.parse(booking.startAt) - 60_000))).toEqual({ ok: true, kind: "discovery" });
    expect(google.deleted()).toHaveLength(1);
  });

  it("a booking whose event id was never recorded is still taken off the calendar, under the id made from its own", async () => {
    const { b, token } = await seedLead();
    const row = (await insertBookingIfFree(env.DB, { businessId: b.id, dealId: null, kind: "discovery", startAt: SLOT, endAt: "2026-11-24T18:20:00.000Z", contactName: "Pat", contactEmail: "pat@acme.test",
      contactPhone: null, answers: null, source: "visitor" }))!;
    expect(row.calendarEventId).toBeNull();
    expect(await cancelByToken(e, token, row.cancelToken, NOW)).toEqual({ ok: true, kind: "discovery" });
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining(`/events/${row.id.replace(/-/g, "")}`)]);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
  });

  it("a cancel the calendar refuses leaves the booking confirmed so it can be tried again", async () => {
    const { b, token } = await seedLead();
    const out = await book(token);
    if (!out.ok) throw new Error("booking failed");
    google = fakeGoogle({ deleteFails: true });
    setBookingDeps({ fetch: google.f });
    expect(await cancelByToken(e, token, out.booking.cancelToken, NOW)).toEqual({ ok: false });
    expect((await bookingFor(env.DB, b.id, "discovery"))!.status).toBe("confirmed");
  });
});

describe("the booked stop reason", () => {
  it("booked stop reason ends the enrollment as replied and rejects pending cold approvals", async () => {
    const { b } = await seedLead();
    const enrollment = await seedEnrollment(b.id, 2);
    expect(await stopOutreach(env.DB, { businessId: b.id, reason: "booked" })).toEqual({ rejectedApprovals: 2 });
    expect(await env.DB.prepare(`SELECT status, stopped_reason, next_due_at FROM enrollments WHERE id = ?`).bind(enrollment.id).first()).toEqual({ status: "replied", stopped_reason: "booked", next_due_at: null });
    const approvals = (await env.DB.prepare(`SELECT status, decision_note FROM approvals ORDER BY id`).all<any>()).results;
    expect(approvals).toHaveLength(2);
    for (const a of approvals) expect(a).toEqual({ status: "rejected", decision_note: "sequence stopped: booked" });
    expect((await getBusiness(env.DB, b.id))!.lead_status).toBe("replied");
    // Safe to repeat, and a client keeps its status.
    expect(await stopOutreach(env.DB, { businessId: b.id, reason: "booked" })).toEqual({ rejectedApprovals: 0 });
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(b.id).run();
    await stopOutreach(env.DB, { businessId: b.id, reason: "booked" });
    expect((await getBusiness(env.DB, b.id))!.lead_status).toBe("won");
  });
});

describe("BookingFormSchema", () => {
  const good = { name: "Pat", email: "pat@acme.test", topic: "Site", budgetId: "a", timeline: "b", decisionMaker: "me", start: SLOT };
  it("trims strings and makes the phone optional", () => {
    const r = BookingFormSchema.parse({ ...good, name: "  Pat  ", topic: " Site ", email: " pat@acme.test " });
    expect(r).toMatchObject({ name: "Pat", topic: "Site", email: "pat@acme.test" });
    expect(r.phone).toBeUndefined();
  });
  it("caps every length and rejects bad values", () => {
    const bad = (o: Record<string, unknown>) => BookingFormSchema.safeParse({ ...good, ...o }).success;
    expect(bad({})).toBe(true);
    expect(bad({ name: "" })).toBe(false);
    expect(bad({ name: "   " })).toBe(false);
    expect(bad({ name: "n".repeat(100) })).toBe(true);
    expect(bad({ name: "n".repeat(101) })).toBe(false);
    expect(bad({ email: "not an email" })).toBe(false);
    expect(bad({ email: `${"a".repeat(250)}@x.co` })).toBe(false);
    expect(bad({ phone: "1".repeat(30) })).toBe(true);
    expect(bad({ phone: "1".repeat(31) })).toBe(false);
    expect(bad({ topic: "" })).toBe(false);
    expect(bad({ topic: "t".repeat(500) })).toBe(true);
    expect(bad({ topic: "t".repeat(501) })).toBe(false);
    expect(bad({ decisionMaker: "nobody" })).toBe(false);
    expect(bad({ start: undefined })).toBe(false);
    expect(bad({ extra: "field" })).toBe(false);
  });
});

describe("the confirmation", () => {
  const MAIN = { enabled: 1 as const, smtp_host: "smtp.main.test", smtp_port: 465, imap_host: "imap.main.test", imap_port: 993, username: "logan@main.test", from_email: "logan@main.test", from_name: "Logan" };
  let out: OutboundMessage[] = [];
  let fail: Error | null = null;
  beforeEach(async () => {
    out = []; fail = null;
    setMailDeps({ smtp: async (_mb, _pw, m) => { if (fail) throw fail; out.push(m); }, now: () => NOW });
    await env.DB.prepare(`DELETE FROM messages`).run();
    await saveMailbox(env.DB, "main", MAIN);
  });
  afterEach(() => saveMailbox(env.DB, "main", { enabled: 0, smtp_host: "", from_email: "" }));
  const notSent = async (businessId: string) => (await listActivity(env.DB, businessId)).filter((a) => a.detail?.startsWith("confirmation not sent:")).map((a) => a.detail);

  it("goes from the main mailbox to the typed address with the Meet link and a cancel link on the outreach host", async () => {
    const { b, token } = await seedLead();
    const r = await book(token);
    if (!r.ok) throw new Error("booking failed");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: "pat@acme.test", from: { email: "logan@main.test" } });
    expect(out[0].subject).toBe("Your call is booked for Tue, Nov 24 at 10:00 AM PST");
    expect(out[0].text).toContain("https://meet.google.com/abc-defg-h1");
    expect(out[0].text).toContain(`https://go.hellositeline.test/r/${token}/book?cancel=${r.booking.cancelToken}`);
    expect(out[0].text).not.toContain("1 Main St"); // no cold-mail footer
    expect(await notSent(b.id)).toEqual([]);
  });

  it("a mail server failure never undoes the booking", async () => {
    const { b, token } = await seedLead();
    fail = new Error("smtp down");
    const r = await book(token);
    expect(r.ok).toBe(true);
    expect(await rows()).toHaveLength(1);
    expect(google.deleted()).toHaveLength(0);
    expect(await notSent(b.id)).toEqual(["confirmation not sent: smtp down"]);
  });

  it("a main mailbox that is switched off sends nothing and says so", async () => {
    await saveMailbox(env.DB, "main", { enabled: 0 });
    const { b, token } = await seedLead();
    expect((await book(token)).ok).toBe(true);
    expect(out).toHaveLength(0);
    expect(await notSent(b.id)).toEqual(["confirmation not sent: mailbox main is not enabled"]);
  });
});
