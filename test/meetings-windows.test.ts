import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertBookingIfFree, setBookingEvent, endBooking } from "../src/worker/db/bookings";
import { createSite } from "../src/worker/db/sites";
import { saveGoogleAuth } from "../src/worker/db/google";
import { listEvents } from "../src/worker/google/calendar";
import { encryptSecret } from "../src/worker/google/crypto";
import { buildAttendeeIndex, FREE_MAIL_DOMAINS, meetingWindows, resolveAttendees } from "../src/worker/meetings/windows";
import { seedClient } from "./fixtures/clients";

const NOW = new Date("2026-12-01T20:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();
const SCOPE = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
const E = { ...env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };

interface Call { url: string; method: string }
/** A fake Google: the token endpoint answers a token, the events endpoint answers `events` (or the response `onEvents` gives). */
function google(events: unknown[], onEvents?: () => Response) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
    return onEvents ? onEvents() : Response.json({ items: events });
  };
  return { f, calls };
}

const ev = (id: string, attendees: string[], over: Record<string, unknown> = {}) => ({
  id, status: "confirmed", summary: `Event ${id}`, start: { dateTime: hoursAgo(3) }, end: { dateTime: hoursAgo(2) },
  attendees: attendees.map((email) => ({ email })), ...over,
});

async function connectGoogle(scope: string | null = SCOPE) {
  await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), scope);
}

/** A client whose point of contact has this email (the fixture's own is shared by every client, so it is replaced), and optionally a site on `domain`. */
async function client(email: string, domain?: string, o: { test?: boolean } = {}) {
  const s = await seedClient({ site: false, test: o.test });
  await env.DB.prepare(`UPDATE people SET email = ? WHERE id = ?`).bind(email, s.person.id).run();
  if (domain) await createSite(env.DB, { businessId: s.businessId, url: `https://${domain}`, test: o.test ?? false });
  return s;
}

const book = (businessId: string, startAt: string, over: Partial<Parameters<typeof insertBookingIfFree>[1]> = {}) =>
  insertBookingIfFree(env.DB, {
    businessId, dealId: null, kind: "discovery", startAt, endAt: plus(startAt, 20), contactName: "Pat Jones", contactEmail: "contact@form.test",
    contactPhone: null, answers: null, source: "visitor", ...over,
  });

// Storage carries over between the tests of a file, so what the attendee index reads (emails, site domains, bookings) is cleared before each one.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM google_auth`), env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`UPDATE people SET email = NULL`), env.DB.prepare(`UPDATE sites SET archived_at = '2026-01-01T00:00:00.000Z' WHERE archived_at IS NULL`),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("listEvents", () => {
  it("asks for single events in the window and keeps timed, live events with their other attendees, lower-cased", async () => {
    const { f, calls } = google([
      ev("a", ["Pat@Ace.test", "me@x.test"], { attendees: [{ email: "Pat@Ace.test" }, { email: "ME@x.test", self: true }, { email: "room@res.test", resource: true }] }),
      ev("cancelled", ["x@y.test"], { status: "cancelled" }),
      ev("allday", ["x@y.test"], { start: { date: "2026-12-01" }, end: { date: "2026-12-02" } }),
      ev("solo", [], { attendees: undefined }),
    ]);
    const out = await listEvents(f, "tok", new Date("2026-11-28T20:00:00.000Z"), NOW);
    expect(out.map((e) => e.id)).toEqual(["a", "solo"]);
    expect(out[0].attendees).toEqual(["pat@ace.test", "room@res.test"]);
    expect(out[1].attendees).toEqual([]);
    expect(out[0]).toMatchObject({ summary: "Event a", startAt: hoursAgo(3), endAt: hoursAgo(2) });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(u.searchParams.get("singleEvents")).toBe("true");
    expect(u.searchParams.get("timeMin")).toBe("2026-11-28T20:00:00.000Z");
    expect(u.searchParams.get("timeMax")).toBe(NOW.toISOString());
  });

  it("throws when Google refuses", async () => {
    const { f } = google([], () => Response.json({ error: { message: "nope" } }, { status: 403 }));
    await expect(listEvents(f, "tok", new Date(0), new Date(1))).rejects.toThrow(/403/);
  });
});

describe("resolveAttendees", () => {
  const index = {
    emails: new Map([["pat@ace.test", "A"], ["jo@b.test", "B"]]),
    domains: new Map<string, string | null>([["acmeplumbing.com", "A"], ["shared.com", null], ["gmail.com", "A"]]),
  };

  it("matches a known email, then a site domain, and never a free-mail domain or an ambiguous one", () => {
    expect(resolveAttendees(["pat@ace.test"], index)).toBe("A");
    expect(resolveAttendees(["jane@acmeplumbing.com"], index)).toBe("A");
    expect(resolveAttendees(["JANE@AcmePlumbing.com"], index)).toBe("A");
    expect(resolveAttendees(["jane@gmail.com"], index)).toBeNull();
    expect(resolveAttendees(["jane@shared.com"], index)).toBeNull();
    expect(resolveAttendees(["nobody@else.test"], index)).toBeNull();
    expect(resolveAttendees([], index)).toBeNull();
  });

  it("is null when two different businesses match, and fine when the same one matches twice", () => {
    expect(resolveAttendees(["pat@ace.test", "jo@b.test"], index)).toBeNull();
    expect(resolveAttendees(["pat@ace.test", "jane@acmeplumbing.com"], index)).toBe("A");
    expect(resolveAttendees(["pat@ace.test", "stranger@else.test"], index)).toBe("A");
  });

  it("lists the common free-mail domains", () => {
    for (const d of ["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]) expect(FREE_MAIL_DOMAINS).toContain(d);
  });
});

describe("buildAttendeeIndex", () => {
  it("indexes people and booking contact emails and site domains for real clients, and nothing of a test client", async () => {
    const a = await client("Owner@Acme.test", "acmeplumbing.com");
    await book(a.businessId, hoursAgo(5), { contactEmail: "Form@Contact.test" });
    const t = await client("rehearsal@t.test", "rehearsal.com", { test: true });
    const index = await buildAttendeeIndex(env.DB);
    expect(index.emails.get("owner@acme.test")).toBe(a.businessId);
    expect(index.emails.get("form@contact.test")).toBe(a.businessId);
    expect(index.domains.get("acmeplumbing.com")).toBe(a.businessId);
    expect(index.emails.has("rehearsal@t.test")).toBe(false);
    expect(index.domains.has("rehearsal.com")).toBe(false);
    expect(t.businessId).not.toBe(a.businessId);
  });

  it("maps a domain claimed by two businesses to null, and keeps free-mail domains out", async () => {
    await client("a@a.test", "shared-site.com");
    await client("b@b.test", "shared-site.com");
    await client("c@c.test", "gmail.com");
    const index = await buildAttendeeIndex(env.DB);
    expect(index.domains.get("shared-site.com")).toBeNull();
    expect(index.domains.has("gmail.com")).toBe(false);
  });
});

describe("meetingWindows: bookings", () => {
  it("gives a confirmed booking from 2 hours ago one window keyed by the booking", async () => {
    const a = await client("owner@acme.test");
    const b = (await book(a.businessId, hoursAgo(2)))!;
    const out = await meetingWindows(E, NOW);
    expect(out).toEqual([{ key: `booking:${b.id}`, businessId: a.businessId, startAt: b.startAt, endAt: b.endAt, bookingId: b.id, source: "booking" }]);
  });

  it("includes a held booking, and leaves out cancelled, no-show, future and older-than-the-lookback bookings", async () => {
    const a = await client("owner@acme.test");
    const b = await client("owner@b.test");
    const c = await client("owner@c.test");
    const d = await client("owner@d.test");
    const e = await client("owner@e.test");
    const held = (await book(a.businessId, hoursAgo(1)))!;
    await env.DB.prepare(`UPDATE bookings SET status = 'held' WHERE id = ?`).bind(held.id).run();
    const cancelled = (await book(b.businessId, hoursAgo(6)))!;
    await endBooking(env.DB, cancelled.id, "cancelled", NOW);
    const noShow = (await book(c.businessId, hoursAgo(7)))!;
    await endBooking(env.DB, noShow.id, "no_show", NOW);
    await book(d.businessId, plus(NOW.toISOString(), 30)); // not started yet
    await book(e.businessId, hoursAgo(80)); // older than 72 hours
    expect((await meetingWindows(E, NOW)).map((w) => w.key)).toEqual([`booking:${held.id}`]);
    expect((await meetingWindows(E, NOW, { lookbackHours: 100 })).map((w) => w.businessId)).toEqual([e.businessId, a.businessId]);
  });

  it("gives a test client's booking no window", async () => {
    const t = await client("rehearsal@t.test", undefined, { test: true });
    await book(t.businessId, hoursAgo(2));
    expect(await meetingWindows(E, NOW)).toEqual([]);
  });
});

describe("meetingWindows: calendar events", () => {
  beforeEach(() => connectGoogle());

  it("resolves an event whose attendee email is a person's email", async () => {
    const a = await client("owner@acme.test");
    const { f } = google([ev("e1", ["Owner@acme.test", "me@x.test"])]);
    expect(await meetingWindows(E, NOW, { f })).toEqual([
      { key: "event:e1", businessId: a.businessId, startAt: hoursAgo(3), endAt: hoursAgo(2), bookingId: null, source: "calendar" },
    ]);
  });

  it("resolves jane@acmeplumbing.com through the site's domain, but never jane@gmail.com through a domain", async () => {
    const a = await client("owner@acme.test", "acmeplumbing.com");
    await client("someone@gmail.test", "gmail.com"); // a free-mail "site" must never claim a domain
    const { f } = google([ev("e1", ["jane@acmeplumbing.com"]), ev("e2", ["jane@gmail.com"])]);
    expect((await meetingWindows(E, NOW, { f })).map((w) => [w.key, w.businessId])).toEqual([["event:e1", a.businessId]]);
  });

  it("gives no window to an event with attendees from two clients, or with none known", async () => {
    await client("owner@acme.test");
    await client("owner@b.test");
    const { f } = google([ev("two", ["owner@acme.test", "owner@b.test"]), ev("none", ["stranger@else.test"]), ev("empty", [])]);
    expect(await meetingWindows(E, NOW, { f })).toEqual([]);
  });

  it("gives a test client's event no window", async () => {
    await client("rehearsal@t.test", undefined, { test: true });
    const { f } = google([ev("e1", ["rehearsal@t.test"])]);
    expect(await meetingWindows(E, NOW, { f })).toEqual([]);
  });

  it("leaves out events that have not started or started before the lookback", async () => {
    await client("owner@acme.test");
    const { f } = google([
      ev("future", ["owner@acme.test"], { start: { dateTime: plus(NOW.toISOString(), 30) }, end: { dateTime: plus(NOW.toISOString(), 60) } }),
      ev("old", ["owner@acme.test"], { start: { dateTime: hoursAgo(90) }, end: { dateTime: hoursAgo(89) } }),
      ev("ok", ["owner@acme.test"]),
    ]);
    expect((await meetingWindows(E, NOW, { f })).map((w) => w.key)).toEqual(["event:ok"]);
  });

  it("does not repeat a booking as an event when the booking carries that event's id", async () => {
    const a = await client("owner@acme.test");
    const b = (await book(a.businessId, hoursAgo(3)))!;
    await setBookingEvent(env.DB, b.id, "e1", null);
    const { f } = google([ev("e1", ["owner@acme.test"]), ev("e2", ["owner@acme.test"], { start: { dateTime: hoursAgo(1) }, end: { dateTime: hoursAgo(0.5) } })]);
    expect((await meetingWindows(E, NOW, { f })).map((w) => w.key)).toEqual([`booking:${b.id}`, "event:e2"]);
  });
});

describe("meetingWindows: Google unavailable", () => {
  it("returns the booking windows and logs one line when Google is not connected", async () => {
    const a = await client("owner@acme.test");
    const b = (await book(a.businessId, hoursAgo(2)))!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { f, calls } = google([]);
    expect((await meetingWindows(E, NOW, { f })).map((w) => w.key)).toEqual([`booking:${b.id}`]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("returns the booking windows and logs one line, without the address, when the stored consent has no calendar scope", async () => {
    await connectGoogle("openid email https://www.googleapis.com/auth/drive.file");
    const a = await client("owner@acme.test");
    const b = (await book(a.businessId, hoursAgo(2)))!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await meetingWindows(E, NOW, { f: google([]).f })).map((w) => w.key)).toEqual([`booking:${b.id}`]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("@");
  });

  it("returns the booking windows and logs one line when Google answers an error", async () => {
    await connectGoogle();
    const a = await client("owner@acme.test");
    const b = (await book(a.businessId, hoursAgo(2)))!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { f } = google([], () => Response.json({ error: { message: "backend down" } }, { status: 500 }));
    expect((await meetingWindows(E, NOW, { f })).map((w) => w.key)).toEqual([`booking:${b.id}`]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
