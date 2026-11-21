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

/** One timed, live event on the primary calendar. `attendees` are the other people's emails (yours left out), lower-cased. */
export interface CalendarEvent { id: string; summary: string; startAt: string; endAt: string; attendees: string[] }

interface GoogleEvent {
  id: string; status?: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean }[];
}

/** Pages read before giving up: 250 events a page, far more than three days of one person's calendar. */
const EVENT_PAGES = 4;

/** Events on the primary calendar that overlap [from, to], repeats expanded. Cancelled and all-day events are left out, and so is the calendar owner as an attendee. */
export async function listEvents(f: Fetch, token: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < EVENT_PAGES; page++) {
    const q = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: "250", timeMin: from.toISOString(), timeMax: to.toISOString(), ...(pageToken && { pageToken }) });
    const r = await google<{ items?: GoogleEvent[]; nextPageToken?: string }>(f, token, `${BASE}/calendars/primary/events?${q}`);
    for (const e of r.items ?? []) {
      const start = e.start?.dateTime, end = e.end?.dateTime;
      if (e.status === "cancelled" || !start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) continue; // an all-day event has a date, not a dateTime
      out.push({
        id: e.id, summary: e.summary ?? "", startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
        attendees: (e.attendees ?? []).filter((a) => a.email && !a.self).map((a) => a.email!.trim().toLowerCase()),
      });
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * Creates the event with a Google Meet link. sendUpdates=none: the app sends the confirmation mail, not Google. A retry with the same requestId does not make a second Meet.
 * With `id` (the caller's own, 5 to 1024 characters of a-v and 0-9) the event is made under that id, so a caller that never heard the answer still knows what to delete.
 * Google answers 409 when that id already exists; that counts as created only if a plain GET of the id returns a live event, and is a failure otherwise.
 */
export async function createEvent(f: Fetch, token: string,
  e: { summary: string; description: string; start: string; end: string; attendeeEmail: string; requestId: string; id?: string }): Promise<{ eventId: string; meetUrl: string | null }> {
  type Made = { id: string; status?: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } };
  const out = (r: Made) => ({ eventId: r.id, meetUrl: r.hangoutLink ?? r.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null });
  try {
    return out(await google<Made>(f, token, `${BASE}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(e.id && { id: e.id }),
        summary: e.summary, description: e.description,
        start: { dateTime: e.start }, end: { dateTime: e.end },
        attendees: [{ email: e.attendeeEmail }],
        conferenceData: { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
      }),
    }));
  } catch (err) {
    if (!e.id || !/^Google API 409\b/.test((err as Error).message)) throw err;
    const existing = await google<Made>(f, token, `${BASE}/calendars/primary/events/${encodeURIComponent(e.id)}`);
    if (existing.id !== e.id || existing.status === "cancelled") throw err; // a deleted event still answers a GET: it is not a booking
    return out(existing);
  }
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
