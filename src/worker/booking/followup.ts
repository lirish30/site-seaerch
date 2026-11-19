import { z } from "zod";
import type { Env } from "../env";
import { logActivity } from "../db/activity";
import { bookingFor, cancelBooking, getBooking, insertBookingIfFree, lastBookingFor, setBookingEvent, type Booking } from "../db/bookings";
import { businessDomain, getBusiness } from "../db/businesses";
import { listContacts } from "../db/contacts";
import { canMove, getDeal, moveDeal } from "../db/deals";
import { liveTokenFor } from "../db/reports";
import { getSettings } from "../db/settings";
import { createEvent, deleteEvent } from "../google/calendar";
import { pickRecipient } from "../recipient";
import { busyFor, calendarFor, eventIdFor, forDescription, forTitle, when } from "./create";
import { DURATION_MIN, parseConfig } from "./config";
import { getBookingFetch } from "./deps";
import { sendConfirmation } from "./mail";
import { computeSlots, isOffered, suggestTwo } from "./slots";

/** Two recommendation-meeting starts to offer on the call: the earliest, and the earliest on another day. Empty when booking is off (no windows, Google not connected). Throws when Google cannot be asked: that is never "free". */
export async function suggestFollowups(env: Env, now: Date): Promise<string[]> {
  const cfg = parseConfig((await getSettings(env.DB)).booking_config);
  const calToken = await calendarFor(env, cfg);
  if (!calToken) return [];
  return suggestTwo(computeSlots(cfg, "recommendation", await busyFor(calToken, cfg, now), now), cfg.timezone);
}

type Failure = { ok: false; status: 409 | 422 | 503; error: string };
const fail = (status: Failure["status"], error: string): Failure => ({ ok: false, status, error });
const emailOk = (s: string) => z.email().safeParse(s).success;

/** Who the invite goes to: the person who booked the discovery call (even once it is held), else the lead's best email on file. */
async function inviteTo(env: Env, businessId: string, businessName: string, siteDomain: string | null) {
  const discovery = await lastBookingFor(env.DB, businessId, "discovery");
  if (discovery && emailOk(discovery.contactEmail)) return { name: discovery.contactName, email: discovery.contactEmail, phone: discovery.contactPhone };
  const best = pickRecipient(await listContacts(env.DB, businessId), siteDomain).emailContact;
  return best && emailOk(best.value) ? { name: best.person_name || businessName, email: best.value, phone: null } : null;
}

/**
 * Books the recommendation meeting for a lead, as Logan (not the guest). Same order as the visitor path, so a failure never leaves half a booking: the
 * calendar must be connected, the start must be offered by a fresh free/busy read, and the time is taken atomically before Google is asked once for the
 * event (under the booking's own id). Any failure after that deletes the event, best effort, and cancels the row. The deal moves to
 * `recommendation_booked`; the confirmation (and, by the booking's own start, the reminders) go out afterwards and never undo the booking.
 * It does not run the conflict gate: this is Logan acting for a lead that already booked or was approved. A won or lost deal is refused.
 */
export async function bookRecommendation(env: Env, dealId: string, startIso: string, now: Date): Promise<{ ok: true; booking: Booking } | Failure> {
  const deal = await getDeal(env.DB, dealId);
  if (!deal) return fail(422, "the deal no longer exists");
  if (deal.stage === "won" || deal.stage === "lost") return fail(409, "the deal is closed");
  if (await bookingFor(env.DB, deal.businessId, "recommendation")) return fail(409, "a recommendation meeting is already booked");
  // A deal already at `recommendation_booked` with no confirmed meeting is the guest having cancelled theirs: it can be booked again, and the stage stays.
  const rebook = deal.stage === "recommendation_booked";
  if (!rebook && !canMove(deal.stage, "recommendation_booked")) return fail(409, `the deal is already past this step (it is ${deal.stage.replace(/_/g, " ")})`);
  const business = await getBusiness(env.DB, deal.businessId);
  if (!business) return fail(422, "the lead no longer exists");
  const guest = await inviteTo(env, business.id, business.name, businessDomain(business));
  if (!guest) return fail(422, "there is no email address to send the invite to: add one to the lead first");

  const cfg = parseConfig((await getSettings(env.DB)).booking_config);
  const calToken = await calendarFor(env, cfg);
  if (!calToken) return fail(503, "booking is not available: connect Google and set your availability in Settings");
  let busy;
  try { busy = await busyFor(calToken, cfg, now); }
  catch (e) { console.error("followup: free/busy failed", e instanceof Error ? e.message : "unknown error"); return fail(503, "could not read your calendar, please try again"); }
  if (!isOffered(cfg, "recommendation", busy, now, startIso)) return fail(409, "that time is not available");

  const startAt = new Date(startIso).toISOString();
  const endAt = new Date(Date.parse(startAt) + DURATION_MIN.recommendation * 60_000).toISOString();
  const booking = await insertBookingIfFree(env.DB, {
    businessId: business.id, dealId: deal.id, kind: "recommendation", startAt, endAt, contactName: guest.name, contactEmail: guest.email, contactPhone: guest.phone,
    answers: null, source: "logan",
  });
  if (!booking) return fail(409, "that time was just taken");

  const f = getBookingFetch();
  const undo = async (eventId: string) => {
    await deleteEvent(f, calToken, eventId).catch((err) => console.error("followup: could not clear a possible event", err instanceof Error ? err.message : "unknown error"));
    await cancelBooking(env.DB, booking.id, now).catch((err) => console.error("followup: could not release the slot", err instanceof Error ? err.message : "unknown error"));
  };
  let event;
  try {
    // Asked once, as on the visitor path: the id is ours, so a call that never answered can still be cleaned up.
    event = await createEvent(f, calToken, {
      id: eventIdFor(booking.id),
      summary: `Recommendation meeting: ${forTitle(business.name)}`,
      description: ["Booked by Logan after the discovery call.", `Name: ${forDescription(guest.name, 100)}`, `Email: ${forDescription(guest.email, 254)}`].join("\n"),
      start: startAt, end: endAt, attendeeEmail: guest.email, requestId: booking.id,
    });
  } catch (e) {
    console.error("followup: could not create the calendar event", e instanceof Error ? e.message : "unknown error");
    await undo(eventIdFor(booking.id));
    return fail(503, "could not book that time, please try again");
  }

  try {
    await setBookingEvent(env.DB, booking.id, event.eventId, event.meetUrl);
    if (!rebook) await moveDeal(env.DB, deal.id, "recommendation_booked");
  } catch (e) {
    console.error("followup: the hand-off failed, undoing the booking", e instanceof Error ? e.message : "unknown error");
    await undo(event.eventId);
    return fail(503, "could not book that time, please try again");
  }
  await logActivity(env.DB, business.id, "followup_booked", `Recommendation meeting booked for ${when(startAt, cfg.timezone)}`)
    .catch((err) => console.error("followup: could not log the booking", err instanceof Error ? err.message : "unknown error"));

  const done = (await getBooking(env.DB, booking.id))!;
  await sendConfirmation(env, done, await liveTokenFor(env.DB, business.id, now));
  return { ok: true, booking: done };
}
