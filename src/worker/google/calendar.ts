import type { Env } from "../env";
import { getGoogleAuth } from "../db/google";
import { googleAccess, GoogleNotConnected } from "./access";
import { google } from "./api";
import { hasCalendarScope, type Fetch } from "./oauth";

const BASE = "https://www.googleapis.com/calendar/v3";
/** A busy stretch, in epoch milliseconds. */
export interface Interval { start: number; end: number }

/** Busy times on the primary calendar between `from` and `to`. */
export async function freeBusy(f: Fetch, token: string, from: Date, to: Date): Promise<Interval[]> {
  const r = await google<{ calendars?: { primary?: { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] } } }>(f, token, `${BASE}/freeBusy`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
  });
  // A 200 can still carry per-calendar errors (notFound, internalError) and no busy list. Treating that as "free" would offer slots over real events.
  const errors = r.calendars?.primary?.errors ?? [];
  if (errors.length) throw new Error(`Google freeBusy failed: ${errors.map((e) => e.reason ?? "unknown").join(", ")}`);
  return (r.calendars?.primary?.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

/** Creates the event with a Google Meet link. sendUpdates=none: the app sends the confirmation mail, not Google. A retry with the same requestId does not make a second Meet. */
export async function createEvent(f: Fetch, token: string,
  e: { summary: string; description: string; start: string; end: string; attendeeEmail: string; requestId: string }): Promise<{ eventId: string; meetUrl: string | null }> {
  const r = await google<{ id: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } }>(f, token, `${BASE}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      summary: e.summary, description: e.description,
      start: { dateTime: e.start }, end: { dateTime: e.end },
      attendees: [{ email: e.attendeeEmail }],
      conferenceData: { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    }),
  });
  return { eventId: r.id, meetUrl: r.hangoutLink ?? r.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null };
}

/** Deletes the event without notifying the guest. Already gone (404 or 410) counts as success. */
export async function deleteEvent(f: Fetch, token: string, eventId: string): Promise<void> {
  const res = await f(`${BASE}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (res.ok || res.status === 404 || res.status === 410) return;
  const json = await res.json<any>().catch(() => ({}));
  throw new Error(`Google API ${res.status}: ${json.error?.message ?? "request failed"}`);
}

/** An access token for calendar calls, or null when Google isn't connected or the stored consent predates the calendar scopes. */
export async function calendarToken(env: Env, f: Fetch = fetch): Promise<string | null> {
  const row = await getGoogleAuth(env.DB);
  if (!row || !hasCalendarScope(row.scope)) return null;
  try {
    // The redirect URI is only used by the consent flow, so the origin doesn't matter for a refresh.
    return (await googleAccess(env, "", f)).token;
  } catch (e) {
    if (e instanceof GoogleNotConnected) return null;
    throw e;
  }
}
