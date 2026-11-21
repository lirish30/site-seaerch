import type { Env } from "../env";
import { testClientSql } from "../clients/record";
import { calendarToken, listEvents } from "../google/calendar";
import type { Fetch } from "../google/oauth";

/** A stretch of time the Mac helper matches a Meetily recording against, tied to one business. */
export interface MeetingWindow { key: string; businessId: string; startAt: string; endAt: string; bookingId: string | null; source: "booking" | "calendar" }

/** Mail providers anyone can have an address at: an address there says nothing about which business a person works for. */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "zoho.com", "mail.com", "comcast.net",
];

/** Known emails and site domains, each pointing at a business id. A domain two businesses both claim maps to `null` (it names nobody). */
export type AttendeeIndex = { emails: Map<string, string>; domains: Map<string, string | null> };

const domainOfEmail = (email: string): string => email.slice(email.lastIndexOf("@") + 1);

/** Folds one more (key, business) pair into the map; a key already claimed by a different business is `null`. */
function claim(m: Map<string, string | null>, key: string, businessId: string) {
  const had = m.get(key);
  m.set(key, had === undefined || had === businessId ? businessId : null);
}

/** Who each email and site domain belongs to, for every business that is not a rehearsal: people and booking contact emails, and live sites' domains. */
export async function buildAttendeeIndex(db: D1Database): Promise<AttendeeIndex> {
  const [people, bookings, sites] = await Promise.all([
    db.prepare(`SELECT p.email AS v, p.business_id AS id FROM people p JOIN businesses b ON b.id = p.business_id WHERE p.email IS NOT NULL AND NOT ${testClientSql("b")}`).all<{ v: string; id: string }>(),
    db.prepare(`SELECT k.contact_email AS v, k.business_id AS id FROM bookings k JOIN businesses b ON b.id = k.business_id WHERE NOT ${testClientSql("b")}`).all<{ v: string; id: string }>(),
    db.prepare(
      `SELECT s.domain AS v, s.business_id AS id FROM sites s JOIN businesses b ON b.id = s.business_id WHERE s.domain IS NOT NULL AND s.archived_at IS NULL AND NOT ${testClientSql("b")}`,
    ).all<{ v: string; id: string }>(),
  ]);
  // An email two businesses share (a family's one address) is dropped: matching it either way could file a meeting under the wrong client.
  const claimed = new Map<string, string | null>();
  for (const r of [...people.results, ...bookings.results]) {
    const email = r.v.trim().toLowerCase();
    if (email.includes("@")) claim(claimed, email, r.id);
  }
  const emails = new Map<string, string>();
  for (const [email, id] of claimed) if (id) emails.set(email, id);
  const domains = new Map<string, string | null>();
  for (const r of sites.results) {
    const d = r.v.trim().toLowerCase();
    if (d && !FREE_MAIL_DOMAINS.includes(d)) claim(domains, d, r.id);
  }
  return { emails, domains };
}

/** The one business the attendees point to: a known email first, else a site domain (never a free-mail one). Null when none match, or two different businesses do. */
export function resolveAttendees(emails: string[], index: AttendeeIndex): string | null {
  const found = new Set<string>();
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email.includes("@")) continue;
    const domain = domainOfEmail(email);
    const id = index.emails.get(email) ?? (FREE_MAIL_DOMAINS.includes(domain) ? null : index.domains.get(domain) ?? null);
    if (id) found.add(id);
  }
  return found.size === 1 ? [...found][0] : null;
}

const DEFAULT_LOOKBACK_HOURS = 72;

/**
 * The meetings a recording could belong to: confirmed or held bookings, plus calendar events whose attendees point to one business, that started in the last `lookbackHours` (72 by
 * default) and not after `now`. A booking that carries its calendar event's id is not repeated as an event. Without a usable Google connection the windows are the bookings alone
 * (one line is logged); rehearsal clients never get one. Oldest first.
 */
export async function meetingWindows(env: Env, now: Date, o: { lookbackHours?: number; f?: Fetch } = {}): Promise<MeetingWindow[]> {
  const from = new Date(now.getTime() - (o.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000);
  const { results: rows } = await env.DB.prepare(
    `SELECT k.id, k.business_id, k.start_at, k.end_at, k.status, k.calendar_event_id FROM bookings k JOIN businesses b ON b.id = k.business_id
     WHERE k.start_at >= ? AND k.start_at <= ? AND NOT ${testClientSql("b")}`,
  ).bind(from.toISOString(), now.toISOString()).all<{ id: string; business_id: string; start_at: string; end_at: string; status: string; calendar_event_id: string | null }>();
  const windows: MeetingWindow[] = rows.filter((r) => r.status === "confirmed" || r.status === "held")
    .map((r) => ({ key: `booking:${r.id}`, businessId: r.business_id, startAt: r.start_at, endAt: r.end_at, bookingId: r.id, source: "booking" as const }));
  // Any booking's event id counts, a cancelled one too: its event is gone from Google, and a no-show's is not a meeting that happened.
  const bookedEvents = new Set(rows.map((r) => r.calendar_event_id).filter((id): id is string => !!id));

  try {
    const token = await calendarToken(env, o.f);
    if (!token) {
      console.warn("meeting windows: Google Calendar is not connected for reading events; bookings only");
    } else {
      const events = await listEvents(o.f ?? fetch, token, from, now);
      const index = await buildAttendeeIndex(env.DB);
      for (const e of events) {
        if (bookedEvents.has(e.id) || e.startAt < from.toISOString() || e.startAt > now.toISOString()) continue;
        const businessId = resolveAttendees(e.attendees, index);
        if (businessId) windows.push({ key: `event:${e.id}`, businessId, startAt: e.startAt, endAt: e.endAt, bookingId: null, source: "calendar" });
      }
    }
  } catch (e) {
    console.warn(`meeting windows: calendar events unavailable (${(e as Error).message}); bookings only`);
  }
  return windows.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.key.localeCompare(b.key));
}
