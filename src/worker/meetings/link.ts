import { lastBookingFor } from "../db/bookings";
import type { Deal } from "../db/deals";
import { meetingForBooking, type Meeting } from "../db/meetings";

/** The meeting recorded for the deal's discovery call (found through the lead's discovery booking), or `null` when the call was never recorded or matched. */
export async function matchedMeetingFor(db: D1Database, deal: Pick<Deal, "businessId">): Promise<Meeting | null> {
  const booking = await lastBookingFor(db, deal.businessId, "discovery");
  return booking ? meetingForBooking(db, booking.id) : null;
}
