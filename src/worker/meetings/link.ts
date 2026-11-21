import type { Env } from "../env";
import { lastBookingFor } from "../db/bookings";
import type { Deal } from "../db/deals";
import { meetingForBooking, type Meeting } from "../db/meetings";
import { readTranscriptText } from "./summary";

/** The meeting recorded for the deal's discovery call (found through the lead's discovery booking), or `null` when the call was never recorded or matched. The cheap lookup: it does not read the transcript. */
export async function matchedMeetingFor(db: D1Database, deal: Pick<Deal, "businessId">): Promise<Meeting | null> {
  const booking = await lastBookingFor(db, deal.businessId, "discovery");
  return booking ? meetingForBooking(db, booking.id) : null;
}

/**
 * The matched meeting, only when its transcript can be read and has something in it. The one test for "a recording a recap can be written from": the
 * request route, the deal page's `hasRecording` and the recap task all use it, so a button that works never queues a task that is stale on arrival.
 */
export async function recordingFor(env: Env, deal: Pick<Deal, "businessId">): Promise<Meeting | null> {
  const meeting = await matchedMeetingFor(env.DB, deal);
  return meeting && (await readTranscriptText(env, meeting)) !== "" ? meeting : null;
}
