import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDER_OFFSETS, REMINDER_WINDOW_MIN, dueReminders, sendDueReminders } from "../src/worker/booking/reminders";
import { insertBookingIfFree, setBookingEvent, type Booking } from "../src/worker/db/bookings";
import { listActivity } from "../src/worker/db/activity";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { setMailDeps } from "../src/worker/mail/deps";
import type { OutboundMessage } from "../src/worker/mail/types";
import { resetBookingTables, seedLead } from "./fixtures/booking";

const MIN = 60_000;
const START = new Date("2026-11-24T18:00:00.000Z");
const at = (offsetMin: number, start = START) => new Date(start.getTime() - offsetMin * MIN);
const iso = (d: Date) => d.toISOString();

const fake = (over: Partial<Booking> = {}): Booking => ({
  id: "b1", businessId: "biz", dealId: null, kind: "discovery", status: "confirmed", startAt: iso(START), endAt: iso(at(-20)),
  contactName: "Pat Jones", contactEmail: "pat@acme.test", contactPhone: null, answers: null, calendarEventId: null, meetUrl: null,
  cancelToken: "c".repeat(43), source: "visitor", createdAt: "2026-11-18T18:00:00.000Z", cancelledAt: null, ...over,
});

describe("dueReminders", () => {
  it("a 24h reminder is due inside its window and not before", () => {
    const b = [fake()];
    expect(dueReminders(b, [], at(1441))).toEqual([]);
    expect(dueReminders(b, [], at(1440))).toEqual([{ bookingId: "b1", offsetMin: 1440 }]);
    expect(dueReminders(b, [], at(1426))).toEqual([{ bookingId: "b1", offsetMin: 1440 }]);
    expect(dueReminders(b, [], at(1425))).toEqual([]); // the window is 15 minutes: a missed one is never sent late
    expect(dueReminders(b, [], at(60))).toEqual([{ bookingId: "b1", offsetMin: 60 }]);
    expect(dueReminders(b, [], at(46))).toEqual([{ bookingId: "b1", offsetMin: 60 }]);
    expect(dueReminders(b, [], at(45))).toEqual([]);
  });

  it("10m reminder window is 5 minutes", () => {
    expect(REMINDER_OFFSETS).toEqual([1440, 60, 10]);
    expect(REMINDER_WINDOW_MIN).toEqual({ 1440: 15, 60: 15, 10: 5 });
    const b = [fake()];
    expect(dueReminders(b, [], at(11))).toEqual([]);
    expect(dueReminders(b, [], at(10))).toEqual([{ bookingId: "b1", offsetMin: 10 }]);
    expect(dueReminders(b, [], at(6))).toEqual([{ bookingId: "b1", offsetMin: 10 }]);
    expect(dueReminders(b, [], at(5))).toEqual([]);
    expect(dueReminders(b, [], at(0))).toEqual([]); // never "starts in 10 minutes" once it has started
  });

  it("a booking made 30 minutes before the call gets only the 10-minute reminder", () => {
    // Every 5-minute tick from the moment it was made to the start, with what was already sent carried forward.
    const sent: { bookingId: string; offsetMin: number }[] = [];
    for (let m = 30; m >= 0; m -= 5) for (const d of dueReminders([fake({ createdAt: iso(at(30)) })], sent, at(m))) sent.push(d);
    expect(sent).toEqual([{ bookingId: "b1", offsetMin: 10 }]);
  });

  it("a booking made 55 minutes out gets no 60-minute reminder but does get the 10-minute one", () => {
    const b = [fake({ createdAt: iso(at(55)) })];
    expect(dueReminders(b, [], at(55))).toEqual([]); // inside the 60-minute window, but it did not exist when that window opened
    expect(dueReminders(b, [], at(50))).toEqual([]);
    expect(dueReminders(b, [], at(10))).toEqual([{ bookingId: "b1", offsetMin: 10 }]);
  });

  it("a booking made 7 minutes out gets no reminders at all", () => {
    const b = [fake({ createdAt: iso(at(7)) })];
    for (let m = 1500; m >= 0; m--) expect(dueReminders(b, [], at(m))).toEqual([]);
  });

  it("a booking made 25 hours out gets all three over a full-day sweep", () => {
    const b = [fake({ createdAt: iso(at(25 * 60)) })];
    const sent: { bookingId: string; offsetMin: number }[] = [];
    for (let m = 1500; m >= 0; m -= 5) for (const d of dueReminders(b, sent, at(m))) sent.push(d);
    expect(sent.map((d) => d.offsetMin)).toEqual([1440, 60, 10]);
  });

  it("a booking made exactly when a window opens still gets that reminder", () => {
    expect(dueReminders([fake({ createdAt: iso(at(60)) })], [], at(60))).toEqual([{ bookingId: "b1", offsetMin: 60 }]);
  });

  it("a sent reminder is not due again, and the others still are", () => {
    expect(dueReminders([fake()], [{ bookingId: "b1", offsetMin: 60 }], at(60))).toEqual([]);
    expect(dueReminders([fake()], [{ bookingId: "b1", offsetMin: 1440 }], at(60))).toEqual([{ bookingId: "b1", offsetMin: 60 }]);
    expect(dueReminders([fake()], [{ bookingId: "other", offsetMin: 60 }], at(60))).toEqual([{ bookingId: "b1", offsetMin: 60 }]);
  });

  it("a cancelled booking gets no reminder", () => {
    expect(dueReminders([fake({ status: "cancelled" })], [], at(60))).toEqual([]);
  });

  it("held and no_show bookings get none", () => {
    for (const status of ["held", "no_show"] as const) expect(dueReminders([fake({ status })], [], at(10))).toEqual([]);
  });
});

const MAIN = { enabled: 1 as const, smtp_host: "smtp.main.test", smtp_port: 465, imap_host: "imap.main.test", imap_port: 993, username: "logan@main.test", from_email: "logan@main.test", from_name: "Logan" };
let sent: OutboundMessage[] = [];
let failures: Error[] = [];
let n = 0;

/** A confirmed booking starting at START, with a Meet link, for a fresh lead. */
async function seedBooking(start = START) {
  const { b } = await seedLead(`Lead ${++n}`);
  const row = (await insertBookingIfFree(env.DB, {
    businessId: b.id, dealId: null, kind: "discovery", startAt: iso(start), endAt: iso(new Date(start.getTime() + 20 * MIN)),
    contactName: "Pat Jones", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "visitor",
    createdAt: iso(new Date(start.getTime() - 3 * 86_400_000)), // booked well ahead; the real clock must not decide whether a reminder is due
  }))!;
  await setBookingEvent(env.DB, row.id, row.id.replace(/-/g, ""), "https://meet.google.com/abc-defg-hij");
  return { b, booking: row };
}
const claims = async () => (await env.DB.prepare(`SELECT booking_id, offset_min FROM booking_reminders ORDER BY offset_min`).all<{ booking_id: string; offset_min: number }>()).results;

beforeEach(async () => {
  await resetBookingTables();
  await env.DB.prepare(`DELETE FROM messages`).run();
  sent = []; failures = [];
  setMailDeps({ smtp: async (_mb, _pw, msg) => { const f = failures.shift(); if (f) throw f; sent.push(msg); } });
  await saveMailbox(env.DB, "main", MAIN);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { setMailDeps(null); vi.restoreAllMocks(); });

describe("sendDueReminders", () => {
  it("sends the due reminder from the main mailbox to the address typed, with no cold-mail footer", async () => {
    const { booking } = await seedBooking();
    expect(await sendDueReminders(env, at(60))).toEqual({ sent: 1, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "pat@acme.test", subject: "Your call is in 1 hour", from: { email: "logan@main.test" } });
    expect(sent[0].text).toContain("https://meet.google.com/abc-defg-hij");
    expect(sent[0].text).not.toContain("1 Main St"); // the opt-out footer is for cold mail
    expect(await claims()).toEqual([{ booking_id: booking.id, offset_min: 60 }]);
  });

  it("a reminder is not sent twice when the cron runs twice", async () => {
    await seedBooking();
    expect(await sendDueReminders(env, at(60))).toEqual({ sent: 1, skipped: 0 });
    expect(await sendDueReminders(env, at(58))).toEqual({ sent: 0, skipped: 0 });
    // Two ticks at once: only the one whose claim landed sends.
    await seedBooking(new Date(START.getTime() + 2 * 60 * MIN));
    const both = await Promise.all([sendDueReminders(env, at(60, new Date(START.getTime() + 2 * 60 * MIN))), sendDueReminders(env, at(60, new Date(START.getTime() + 2 * 60 * MIN)))]);
    expect(both.reduce((s, r) => s + r.sent, 0)).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("a failed send is retried on the next tick inside the window", async () => {
    const { booking } = await seedBooking();
    failures.push(new Error("smtp down"));
    const first = await sendDueReminders(env, at(60));
    expect(first.sent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await claims()).toEqual([]); // the claim was given back
    expect(await sendDueReminders(env, at(55))).toEqual({ sent: 1, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(await claims()).toEqual([{ booking_id: booking.id, offset_min: 60 }]);
    // Past the window, nothing is sent late.
    await env.DB.prepare(`DELETE FROM booking_reminders`).run();
    expect(await sendDueReminders(env, at(40))).toEqual({ sent: 0, skipped: 0 });
  });

  it("a booking made after the 60-minute window opened gets no 60-minute reminder, and no mail goes out for it", async () => {
    const { b } = await seedLead("Late Co");
    await insertBookingIfFree(env.DB, { businessId: b.id, dealId: null, kind: "discovery", startAt: iso(START), endAt: iso(at(-20)), contactName: "Pat", contactEmail: "pat@acme.test", contactPhone: null,
      answers: null, source: "visitor", createdAt: iso(at(55)) });
    expect(await sendDueReminders(env, at(55))).toEqual({ sent: 0, skipped: 0 });
    expect(await sendDueReminders(env, at(10))).toEqual({ sent: 1, skipped: 0 });
    expect(sent.map((s) => s.subject)).toEqual(["Your call is in 10 minutes"]);
  });

  it("a cancelled booking gets no reminder", async () => {
    const { booking } = await seedBooking();
    await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(booking.id).run();
    expect(await sendDueReminders(env, at(60))).toEqual({ sent: 0, skipped: 0 });
    expect(sent).toHaveLength(0);
  });

  it("held and no_show bookings get none", async () => {
    for (const status of ["held", "no_show"]) {
      const { booking } = await seedBooking(new Date(START.getTime() + (status === "held" ? 0 : 60) * MIN));
      await env.DB.prepare(`UPDATE bookings SET status = ? WHERE id = ?`).bind(status, booking.id).run();
    }
    expect(await sendDueReminders(env, at(10))).toEqual({ sent: 0, skipped: 0 });
    expect(await sendDueReminders(env, at(10, new Date(START.getTime() + 60 * MIN)))).toEqual({ sent: 0, skipped: 0 });
    expect(sent).toHaveLength(0);
  });

  it("a reminder for a lead now on do-not-contact is skipped", async () => {
    const { b } = await seedBooking();
    await addDoNotContact(env.DB, { kind: "email", value: "pat@acme.test", reason: "opt_out", note: "" });
    expect(await sendDueReminders(env, at(60))).toEqual({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
    // Logged once: the claim stays, so the next tick does not log it again.
    expect(await sendDueReminders(env, at(55))).toEqual({ sent: 0, skipped: 0 });
    const lines = (await listActivity(env.DB, b.id)).filter((a) => a.detail?.startsWith("reminder not sent"));
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain("do-not-contact");
  });

  it("a mailbox that is not configured, or switched off, sends nothing and does not throw", async () => {
    const { booking } = await seedBooking();
    await saveMailbox(env.DB, "main", { smtp_host: "" });
    expect(await sendDueReminders(env, at(60))).toEqual({ sent: 0, skipped: 1 });
    await saveMailbox(env.DB, "main", { ...MAIN, enabled: 0 });
    expect(await sendDueReminders(env, at(58))).toEqual({ sent: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
    expect(await claims()).toEqual([]); // nothing was claimed, so switching it on in time still sends
    await saveMailbox(env.DB, "main", MAIN);
    expect(await sendDueReminders(env, at(55))).toEqual({ sent: 1, skipped: 0 });
    expect(await claims()).toEqual([{ booking_id: booking.id, offset_min: 60 }]);
  });

  it("each of the three reminders goes once over a whole day of ticks", async () => {
    await seedBooking();
    for (let m = 1500; m >= 0; m -= 5) await sendDueReminders(env, at(m));
    expect(sent.map((s) => s.subject)).toEqual(["Your call is in 24 hours", "Your call is in 1 hour", "Your call is in 10 minutes"]);
  });
});
