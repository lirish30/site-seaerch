import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import * as callPrep from "../src/worker/booking/callPrep";
import { BookingFormSchema, cancelByToken, createVisitorBooking } from "../src/worker/booking/create";
import { setBookingDeps } from "../src/worker/booking/deps";
import { bookingFor, getBookingByCancelToken } from "../src/worker/db/bookings";
import { listActivity } from "../src/worker/db/activity";
import { getBusiness } from "../src/worker/db/businesses";
import { openDealFor } from "../src/worker/db/deals";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { createApproval } from "../src/worker/db/approvals";
import { revokeReports } from "../src/worker/db/reports";
import { saveSettings } from "../src/worker/db/settings";
import { suppressLead } from "../src/worker/db/suppression";
import { setMailDeps } from "../src/worker/mail/deps";
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
    expect(google.created()[0].body).toMatchObject({ start: { dateTime: SLOT }, end: { dateTime: "2026-11-24T18:20:00.000Z" }, attendees: [{ email: "pat@acme.test" }] });
    expect(google.created()[0].body.conferenceData.createRequest.requestId).toBe(out.booking.id);
    // The booking row.
    expect(out.booking).toMatchObject({ businessId: b.id, kind: "discovery", status: "confirmed", startAt: SLOT, endAt: "2026-11-24T18:20:00.000Z", contactName: "Pat Jones",
      contactEmail: "pat@acme.test", contactPhone: "208-555-0100", calendarEventId: "ev1", meetUrl: "https://meet.google.com/abc-defg-h1", source: "visitor",
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
    // The confirmation email is Task 7's job: nothing is sent here.
    expect(smtp).toBe(0);
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
    expect((await rows()).map((r) => r.status)).toEqual(["cancelled"]);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    expect(await openDealFor(env.DB, b.id)).toBeNull();
    expect(queueCallPrep).not.toHaveBeenCalled();
    // The slot is free again for the next try.
    google = fakeGoogle();
    setBookingDeps({ fetch: google.f });
    expect((await book(token)).ok).toBe(true);
  });

  it("a failure after the event exists deletes the event and cancels the row", async () => {
    const { b, token } = await seedLead();
    const orig = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (q: string) => { if (/INSERT INTO deals/i.test(q)) throw new Error("db down"); return orig(q); };
    let out;
    try { out = await book(token); } finally { (env.DB as any).prepare = orig; }
    expect(out).toMatchObject({ ok: false, status: 503 });
    expect(google.created()).toHaveLength(1);
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining("/events/ev1")]);
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
    expect(await cancelByToken(e, token, out.booking.cancelToken, later)).toEqual({ ok: true });
    expect(await cancelByToken(e, token, out.booking.cancelToken, new Date(later.getTime() + 60_000))).toEqual({ ok: true });
    expect(google.deleted()).toHaveLength(1);
    expect(google.deleted()[0].url).toContain("/events/ev1");
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
