import { z } from "zod";
import type { Env } from "../env";
import { checkConflict } from "../conflict";
import { logActivity } from "../db/activity";
import {
  bookingFor, cancelBooking, getBooking, getBookingByCancelToken, insertBookingIfFree, setBookingDeal, setBookingEvent, type Booking,
} from "../db/bookings";
import { getBusiness } from "../db/businesses";
import { createDeal } from "../db/deals";
import { liveReportTarget, reportBusinessId } from "../db/reports";
import { getSettings } from "../db/settings";
import { calendarToken, createEvent, deleteEvent, freeBusy } from "../google/calendar";
import { stopOutreach } from "../sequence/stop";
import { queueCallPrep } from "./callPrep";
import { sendConfirmation } from "./mail";
import { parseConfig, DURATION_MIN, type BookingConfig } from "./config";
import { getBookingFetch } from "./deps";
import { computeSlots, isOffered } from "./slots";

const DAY = 86_400_000;

/**
 * What the booking form sends. Every string is trimmed and length-capped; HTML is not stripped (the text is kept as typed) and is escaped everywhere
 * it is output. `start` is checked against the offered slots later, so here it is only a short string.
 */
export const BookingFormSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(254).pipe(z.email()),
  phone: z.string().trim().max(30).optional(),
  topic: z.string().trim().min(1).max(500),
  budgetId: z.string().trim().min(1).max(40),
  timeline: z.string().trim().min(1).max(60),
  decisionMaker: z.enum(["me", "me_and_other"]),
  start: z.string().trim().min(1).max(40),
}).strict();
export type BookingForm = z.infer<typeof BookingFormSchema>;

/** Why a booking did not happen. 404 is the one answer for a link that is gone and for a lead that may not be contacted: it never says which. */
export interface BookingFailure { ok: false; status: 404 | 409 | 422 | 503; error: string; /** The old booking link, on a 503, so the page can send the person there. */ fallbackUrl?: string }
const NOT_FOUND: BookingFailure = { ok: false, status: 404, error: "not found" };

/** The settings' own booking link (the Plan 3 one), shown only when it is https. */
const fallbackOf = (booking_url: string) => (booking_url.startsWith("https://") ? booking_url : "");

/** The booking page's data. `existing` is the lead's confirmed call, if any: only its start and kind, never who booked it or what they answered. */
export interface BookingPage {
  enabled: boolean; fallbackUrl: string; slots: string[]; tz: string;
  budgetOptions: { id: string; label: string }[]; timelineOptions: string[];
  existing: { start: string; kind: Booking["kind"] } | null;
}

/** A calendar token when booking can run (windows set, Google connected with both calendar scopes), else null. A refresh that fails reads as "not available". */
export async function calendarFor(env: Env, cfg: BookingConfig): Promise<string | null> {
  if (!cfg.windows.length) return null;
  try { return await calendarToken(env, getBookingFetch()); }
  catch (e) { console.error("booking: could not get a calendar token", e instanceof Error ? e.message : "unknown error"); return null; }
}

/** Free/busy from now to one day past the horizon, so the last day's slots are checked too. Throws when Google fails: that is never "free". */
export const busyFor = (token: string, cfg: BookingConfig, now: Date) => freeBusy(getBookingFetch(), token, now, new Date(now.getTime() + (cfg.horizonDays + 1) * DAY));

/** The live lead for a report link that may be contacted, or null: unknown, revoked, expired, do-not-contact, suppressed and won all read the same. */
async function bookableLead(env: Env, token: string, now: Date, email = "") {
  const target = await liveReportTarget(env.DB, token, now);
  if (!target) return null;
  const business = await getBusiness(env.DB, target.businessId);
  if (!business) return null;
  if ((await checkConflict(env.DB, { email, businessId: business.id })).blocked) return null;
  return business;
}

export async function bookingPage(env: Env, token: string, now: Date): Promise<{ ok: true; page: BookingPage } | BookingFailure> {
  const business = await bookableLead(env, token, now);
  if (!business) return NOT_FOUND;
  const settings = await getSettings(env.DB);
  const cfg = parseConfig(settings.booking_config), fallbackUrl = fallbackOf(settings.booking_url);
  const existing = await bookingFor(env.DB, business.id, "discovery");
  const calToken = await calendarFor(env, cfg);
  let slots: string[] = [];
  if (calToken && !existing) {
    try { slots = computeSlots(cfg, "discovery", await busyFor(calToken, cfg, now), now); }
    catch (e) {
      console.error("booking: free/busy failed", e instanceof Error ? e.message : "unknown error");
      return { ok: false, status: 503, error: "not available", fallbackUrl };
    }
  }
  return { ok: true, page: {
    enabled: !!calToken, fallbackUrl, slots, tz: cfg.timezone,
    budgetOptions: cfg.budgetOptions.map((o) => ({ id: o.id, label: o.label })), timelineOptions: cfg.timelineOptions,
    existing: existing ? { start: existing.startAt, kind: existing.kind } : null,
  } };
}

/** Text for a Google Calendar description, which renders HTML: one line, angle brackets and ampersands escaped. */
export const forDescription = (s: string, max = 600) => s.replace(/\s+/g, " ").trim().slice(0, max).replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
/** Text for an event title, which is plain: one line, no angle brackets. */
export const forTitle = (s: string) => s.replace(/\s+/g, " ").replace(/[<>]/g, "").trim().slice(0, 120);

/** The calendar event's id for a booking: its uuid without dashes (lowercase hex is valid for Google, 5 to 1024 characters of a-v and 0-9). Deterministic, so the id is known even when the create call never answered. */
export const eventIdFor = (bookingId: string) => bookingId.replace(/-/g, "");

export const when = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    .format(new Date(iso)).replace(/[  ]/g, " ");

/**
 * Books the lead's discovery call. The order is the point: nothing is written until the lead, the calendar and the time all check out; the booking row
 * is the anchor (a second request for the time finds it), so Google is asked once and never blindly retried. Once the event exists, any failure undoes
 * both halves (the event is deleted, the row is cancelled), so a confirmed booking always has its event and an event always has its row.
 */
export async function createVisitorBooking(env: Env, token: string, form: BookingForm, now: Date): Promise<{ ok: true; booking: Booking } | BookingFailure> {
  const business = await bookableLead(env, token, now, form.email);
  if (!business) return NOT_FOUND;
  const settings = await getSettings(env.DB);
  const cfg = parseConfig(settings.booking_config), fallbackUrl = fallbackOf(settings.booking_url);
  const unavailable = (error = "booking is not available right now, please reply to the email"): BookingFailure => ({ ok: false, status: 503, error, fallbackUrl });

  const calToken = await calendarFor(env, cfg);
  if (!calToken) return unavailable();

  const budget = cfg.budgetOptions.find((o) => o.id === form.budgetId);
  if (!budget || !cfg.timelineOptions.includes(form.timeline)) return { ok: false, status: 422, error: "choose one of the options offered" };
  if (await bookingFor(env.DB, business.id, "discovery")) return { ok: false, status: 409, error: "a call is already booked" };

  let busy;
  try { busy = await busyFor(calToken, cfg, now); }
  catch (e) { console.error("booking: free/busy failed", e instanceof Error ? e.message : "unknown error"); return unavailable(); }
  if (!isOffered(cfg, "discovery", busy, now, form.start)) return { ok: false, status: 409, error: "that time was just taken" };

  const startAt = new Date(form.start).toISOString();
  const endAt = new Date(Date.parse(startAt) + DURATION_MIN.discovery * 60_000).toISOString();
  const booking = await insertBookingIfFree(env.DB, {
    businessId: business.id, dealId: null, kind: "discovery", startAt, endAt, contactName: form.name, contactEmail: form.email, contactPhone: form.phone || null,
    answers: { topic: form.topic, budgetId: form.budgetId, timeline: form.timeline, decisionMaker: form.decisionMaker }, source: "visitor",
  });
  if (!booking) return { ok: false, status: 409, error: "that time was just taken" };

  const f = getBookingFetch();
  let event;
  try {
    // Asked once. `requestId` only stops a second Meet link; it would not stop a second event, so there is no retry here.
    event = await createEvent(f, calToken, {
      id: eventIdFor(booking.id),
      summary: `Discovery call: ${forTitle(business.name)}`,
      description: [
        "Booked from the report page.", `Name: ${forDescription(form.name, 100)}`, `Email: ${forDescription(form.email, 254)}`, form.phone ? `Phone: ${forDescription(form.phone, 30)}` : "",
        `Topic: ${forDescription(form.topic, 500)}`, `Budget: ${forDescription(budget.label, 60)}`, `Timeline: ${forDescription(form.timeline, 60)}`,
        `Decision maker: ${form.decisionMaker === "me" ? "just them" : "them and someone else"}`,
      ].filter(Boolean).join("\n"),
      start: startAt, end: endAt, attendeeEmail: form.email, requestId: booking.id,
    });
  } catch (e) {
    console.error("booking: could not create the calendar event", e instanceof Error ? e.message : "unknown error");
    // A timeout or a dropped connection can still leave the event made, and its id is ours, so take it down. Nothing there is fine (404 and 410 count as done).
    await deleteEvent(f, calToken, eventIdFor(booking.id)).catch((err) => console.error("booking: could not clear a possible event", err instanceof Error ? err.message : "unknown error"));
    await cancelBooking(env.DB, booking.id, now).catch((err) => console.error("booking: could not release the slot", err instanceof Error ? err.message : "unknown error"));
    return unavailable("could not book that time, please try again");
  }

  try {
    await setBookingEvent(env.DB, booking.id, event.eventId, event.meetUrl);
    const deal = await createDeal(env.DB, { businessId: business.id, source: "booking" });
    await setBookingDeal(env.DB, booking.id, deal.id);
    await stopOutreach(env.DB, { businessId: business.id, reason: "booked" });
    // No name, email or answer in this line: it is read on the lead's timeline and in Home.
    await logActivity(env.DB, business.id, "booked", `Discovery call booked for ${when(startAt, cfg.timezone)}`);
  } catch (e) {
    console.error("booking: the hand-off failed, undoing the booking", e instanceof Error ? e.message : "unknown error");
    await deleteEvent(f, calToken, event.eventId).catch((err) => console.error("booking: could not delete the event", err instanceof Error ? err.message : "unknown error"));
    await cancelBooking(env.DB, booking.id, now).catch((err) => console.error("booking: could not release the slot", err instanceof Error ? err.message : "unknown error"));
    return unavailable("could not book that time, please try again");
  }

  const done = (await getBooking(env.DB, booking.id))!;
  // The deal exists and is linked: ask for the call prep (Task 8 fills this in). A failure here is not the guest's problem.
  try { await queueCallPrep(env, done.dealId!); }
  catch (e) { console.error("booking: could not queue the call prep", e instanceof Error ? e.message : "unknown error"); }
  // The confirmation (a fixed template from the main mailbox). It never throws: if it cannot go out the booking stands and the lead's timeline says so.
  await sendConfirmation(env, done, token);
  return { ok: true, booking: done };
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Cancels the call a guest's cancel link names. The event is deleted first, so a cancel Google refuses leaves the booking confirmed and can be tried
 * again; then the row is cancelled. A second cancel is `ok: true` and does nothing. A wrong report token or cancel token is `ok: false` and does nothing,
 * and the answer is the same for an unknown report and a wrong cancel token.
 * Cancelling only lets a slot go, so it does not wait for the report link to be live (it may have expired or been revoked since the guest booked) and it
 * does not run the conflict gate (a do-not-contact guest can still release their slot). The cancel token is still scoped to the report's own lead.
 * A call that has started cannot be cancelled. It moves nothing else: the deal and the lead stay where they were.
 */
export async function cancelByToken(env: Env, token: string, cancelToken: string, now: Date): Promise<{ ok: boolean }> {
  if (!TOKEN.test(token) || !TOKEN.test(cancelToken)) return { ok: false };
  const businessId = await reportBusinessId(env.DB, token);
  if (!businessId) return { ok: false };
  const booking = await getBookingByCancelToken(env.DB, businessId, cancelToken);
  if (!booking) return { ok: false };
  if (booking.status === "cancelled") return { ok: true };
  if (booking.status !== "confirmed" || booking.startAt <= now.toISOString()) return { ok: false };
  if (booking.calendarEventId) {
    try {
      const calToken = await calendarToken(env, getBookingFetch());
      if (!calToken) return { ok: false };
      await deleteEvent(getBookingFetch(), calToken, booking.calendarEventId);
    } catch (e) {
      console.error("booking: could not delete the event for a cancel", e instanceof Error ? e.message : "unknown error");
      return { ok: false };
    }
  }
  if (await cancelBooking(env.DB, booking.id, now)) {
    const settings = await getSettings(env.DB);
    await logActivity(env.DB, booking.businessId, "booking_cancelled", `${booking.kind === "discovery" ? "Discovery call" : "Recommendation meeting"} cancelled (was ${when(booking.startAt, parseConfig(settings.booking_config).timezone)})`);
  }
  return { ok: true };
}
