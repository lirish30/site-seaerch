import type { BookingKind } from "../booking/config";
import { isDuplicateKey } from "./services";

export type BookingStatus = "confirmed" | "cancelled" | "held" | "no_show";

/** What the person typed on the booking form. Stored as typed (it is escaped wherever it is shown). */
export interface BookingAnswers { topic: string; budgetId: string; timeline: string; decisionMaker: "me" | "me_and_other" }

export interface Booking {
  id: string; businessId: string; dealId: string | null; kind: BookingKind; status: BookingStatus; startAt: string; endAt: string;
  contactName: string; contactEmail: string; contactPhone: string | null; answers: BookingAnswers | null;
  calendarEventId: string | null; meetUrl: string | null; cancelToken: string; source: "visitor" | "logan"; createdAt: string; cancelledAt: string | null;
}

interface Row {
  id: string; business_id: string; deal_id: string | null; kind: BookingKind; status: BookingStatus; start_at: string; end_at: string;
  contact_name: string; contact_email: string; contact_phone: string | null; answers: string | null;
  calendar_event_id: string | null; meet_url: string | null; cancel_token: string; source: "visitor" | "logan"; created_at: string; cancelled_at: string | null;
}

/** The answers column read back; a missing or damaged value is `null`, never a thrown error. */
function readAnswers(s: string | null): BookingAnswers | null {
  if (s === null) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && typeof v.topic === "string" ? (v as BookingAnswers) : null;
  } catch { return null; }
}

const toBooking = (r: Row): Booking => ({
  id: r.id, businessId: r.business_id, dealId: r.deal_id, kind: r.kind, status: r.status, startAt: r.start_at, endAt: r.end_at,
  contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone, answers: readAnswers(r.answers),
  calendarEventId: r.calendar_event_id, meetUrl: r.meet_url, cancelToken: r.cancel_token, source: r.source, createdAt: r.created_at, cancelledAt: r.cancelled_at,
});

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const newCancelToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const iso = (s: string) => new Date(s).toISOString();

export async function getBooking(db: D1Database, id: string): Promise<Booking | null> {
  const r = await db.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first<Row>();
  return r ? toBooking(r) : null;
}

/**
 * Takes [startAt, endAt) unless a confirmed booking already overlaps it, in ONE statement, so two people picking the same time cannot both get it.
 * Null when the time is taken, or when the lead already holds a confirmed discovery call (the partial unique index refuses a second).
 * Two intervals overlap when each starts before the other ends, so back to back is fine.
 */
export async function insertBookingIfFree(
  db: D1Database, b: Omit<Booking, "id" | "status" | "createdAt" | "cancelledAt" | "cancelToken" | "calendarEventId" | "meetUrl"> & { /** Tests only: the creation time to record; the clock when left out. */ createdAt?: string },
): Promise<Booking | null> {
  const id = crypto.randomUUID(), start = iso(b.startAt), end = iso(b.endAt);
  try {
    const res = await db.prepare(
      `INSERT INTO bookings (id, business_id, deal_id, kind, status, start_at, end_at, contact_name, contact_email, contact_phone, answers, cancel_token, source, created_at)
       SELECT ?,?,?,?, 'confirmed', ?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE status = 'confirmed' AND start_at < ? AND end_at > ?)`,
    ).bind(id, b.businessId, b.dealId, b.kind, start, end, b.contactName, b.contactEmail, b.contactPhone, b.answers ? JSON.stringify(b.answers) : null,
      newCancelToken(), b.source, b.createdAt ? iso(b.createdAt) : new Date().toISOString(), end, start).run();
    if ((res.meta.changes ?? 0) !== 1) return null;
  } catch (e) {
    if (isDuplicateKey(e)) return null; // one confirmed discovery call per lead
    throw e;
  }
  return (await getBooking(db, id))!;
}

export async function setBookingEvent(db: D1Database, id: string, eventId: string, meetUrl: string | null): Promise<void> {
  await db.prepare(`UPDATE bookings SET calendar_event_id = ?, meet_url = ? WHERE id = ?`).bind(eventId, meetUrl, id).run();
}

export async function setBookingDeal(db: D1Database, id: string, dealId: string): Promise<void> {
  await db.prepare(`UPDATE bookings SET deal_id = ? WHERE id = ?`).bind(dealId, id).run();
}

/** Cancels a confirmed booking, which frees its slot. True only for the call that did it; a booking that is not confirmed is left alone. */
export async function cancelBooking(db: D1Database, id: string, at: Date): Promise<boolean> {
  const res = await db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'confirmed'`).bind(at.toISOString(), id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** The booking the guest's cancel link names. Needs the lead the report link belongs to as well, so one lead's token never reaches another's booking. */
export async function getBookingByCancelToken(db: D1Database, businessId: string, cancelToken: string): Promise<Booking | null> {
  const r = await db.prepare(`SELECT * FROM bookings WHERE business_id = ? AND cancel_token = ?`).bind(businessId, cancelToken).first<Row>();
  return r ? toBooking(r) : null;
}

/** Confirmed bookings that start in [from, to), soonest first, with the lead's name. */
export async function upcomingBookings(db: D1Database, from: Date, to: Date): Promise<(Booking & { businessName: string })[]> {
  const rows = (await db.prepare(
    `SELECT k.*, b.name AS business_name FROM bookings k JOIN businesses b ON b.id = k.business_id
     WHERE k.status = 'confirmed' AND k.start_at >= ? AND k.start_at < ? ORDER BY k.start_at, k.id`,
  ).bind(from.toISOString(), to.toISOString()).all<Row & { business_name: string }>()).results;
  return rows.map((r) => ({ ...toBooking(r), businessName: r.business_name }));
}

/** The lead's confirmed booking of this kind, if it has one. */
export async function bookingFor(db: D1Database, businessId: string, kind: BookingKind): Promise<Booking | null> {
  const r = await db.prepare(`SELECT * FROM bookings WHERE business_id = ? AND kind = ? AND status = 'confirmed' ORDER BY start_at LIMIT 1`).bind(businessId, kind).first<Row>();
  return r ? toBooking(r) : null;
}

/**
 * The lead's most recent booking of this kind in any state, a cancelled one last: the call may already be held, and its contact is still who to write to.
 * Null when the lead never booked one.
 */
export async function lastBookingFor(db: D1Database, businessId: string, kind: BookingKind): Promise<Booking | null> {
  const r = await db.prepare(`SELECT * FROM bookings WHERE business_id = ? AND kind = ? ORDER BY status = 'cancelled', start_at DESC LIMIT 1`).bind(businessId, kind).first<Row>();
  return r ? toBooking(r) : null;
}

/** Marks a confirmed booking as held (the call happened). True only for the call that did it. */
export async function markBookingHeld(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`UPDATE bookings SET status = 'held' WHERE id = ? AND status = 'confirmed'`).bind(id).run();
  return (res.meta.changes ?? 0) === 1;
}

/** How many bookings of any status (cancelled ones too) the lead has made since `since`: the guest page's cap on book, cancel, book loops. */
export async function bookingsSince(db: D1Database, businessId: string, since: Date): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE business_id = ? AND created_at >= ?`).bind(businessId, since.toISOString()).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Whether the lead has a booking of this kind whose call already happened. The guest page never makes a second one. */
export async function hasHeldBooking(db: D1Database, businessId: string, kind: BookingKind): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM bookings WHERE business_id = ? AND kind = ? AND status = 'held' LIMIT 1`).bind(businessId, kind).first());
}

/** Sets a confirmed booking to a state that ends it (cancelled, or the guest did not come). True only for the call that did it; anything not confirmed is left alone. */
export async function endBooking(db: D1Database, id: string, status: "cancelled" | "no_show", at: Date): Promise<boolean> {
  const res = await db.prepare(`UPDATE bookings SET status = ?, cancelled_at = ? WHERE id = ? AND status = 'confirmed'`).bind(status, at.toISOString(), id).run();
  return (res.meta.changes ?? 0) === 1;
}
