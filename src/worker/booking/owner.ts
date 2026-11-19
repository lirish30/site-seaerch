import type { Env } from "../env";
import { logActivity } from "../db/activity";
import { endBooking, getBooking, markBookingHeld, type Booking } from "../db/bookings";
import { getDeal } from "../db/deals";
import { getSettings } from "../db/settings";
import { calendarToken, deleteEvent } from "../google/calendar";
import { parseConfig } from "./config";
import { eventIdFor, when } from "./create";
import { getBookingFetch } from "./deps";

/** What an owner-side change answers with: the booking's new state (never its cancel token, which is the guest's secret), or why not. */
export type OwnerResult = { ok: true; booking: { id: string; status: Booking["status"] } } | { ok: false; status: 404 | 409; error: string };

const fail = (status: 404 | 409, error: string): OwnerResult => ({ ok: false, status, error });
const stateOf = (b: Booking): OwnerResult => ({ ok: true, booking: { id: b.id, status: b.status } });
const NAME = { discovery: "Discovery call", recommendation: "Recommendation meeting" } as const;

/**
 * Logan cancels a confirmed booking, or marks that the guest did not come (`noShow`). The calendar event is deleted first, best effort (a calendar that
 * cannot be reached must not trap Logan with a call that is never happening: the failure is logged and the row is still ended). Either way the row stops
 * being `confirmed`, which frees its slot and the lead's one-discovery-call index. A booking that is already cancelled or a no-show answers the same and
 * does nothing again; a held one (the call happened) is a 409. It moves no deal: a discovery call whose deal is still at `booked` just gets a line on
 * the lead's timeline saying so.
 */
export async function cancelBookingByOwner(env: Env, id: string, o: { noShow?: boolean }, now: Date): Promise<OwnerResult> {
  const booking = await getBooking(env.DB, id);
  if (!booking) return fail(404, "not found");
  if (booking.status === "held") return fail(409, "that call already happened");
  if (booking.status !== "confirmed") return stateOf(booking);

  try {
    const token = await calendarToken(env, getBookingFetch());
    if (token) await deleteEvent(getBookingFetch(), token, booking.calendarEventId ?? eventIdFor(booking.id));
  } catch (e) {
    console.error("booking: could not delete the event for an owner cancel", e instanceof Error ? e.message : "unknown error");
  }
  const status = o.noShow ? "no_show" : "cancelled";
  if (!(await endBooking(env.DB, booking.id, status, now))) return stateOf((await getBooking(env.DB, id)) ?? booking); // another request got there first

  const tz = parseConfig((await getSettings(env.DB)).booking_config).timezone;
  const name = NAME[booking.kind];
  await logActivity(env.DB, booking.businessId, "booking_cancelled", `${name} ${o.noShow ? "marked as a no-show" : "cancelled"} (was ${when(booking.startAt, tz)})`);
  const deal = booking.kind === "discovery" && booking.dealId ? await getDeal(env.DB, booking.dealId) : null;
  if (deal?.stage === "booked") await logActivity(env.DB, booking.businessId, "note", `${o.noShow ? "Call missed" : "Call cancelled"}, deal still at booked`);
  return { ok: true, booking: { id: booking.id, status } };
}

/**
 * Logan marks a recommendation meeting as held (it happened). A discovery call is marked done from its deal (`call-done`, which also moves the deal and
 * stamps the notes), so it is refused here. A held meeting answers the same again; a cancelled one or a no-show is a 409.
 */
export async function markMeetingHeld(env: Env, id: string): Promise<OwnerResult> {
  const booking = await getBooking(env.DB, id);
  if (!booking) return fail(404, "not found");
  if (booking.kind !== "recommendation") return fail(409, "mark a discovery call done from its deal");
  if (booking.status === "held") return stateOf(booking);
  if (booking.status !== "confirmed") return fail(409, "that meeting was cancelled");
  if (!(await markBookingHeld(env.DB, booking.id))) return stateOf((await getBooking(env.DB, id)) ?? booking);
  return { ok: true, booking: { id: booking.id, status: "held" } };
}
