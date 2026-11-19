import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { freeBusy, createEvent, deleteEvent, calendarToken } from "../src/worker/google/calendar";
import { SCOPES, authUrl, hasCalendarScope } from "../src/worker/google/oauth";
import { encryptSecret } from "../src/worker/google/crypto";
import { saveGoogleAuth } from "../src/worker/db/google";

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
function fake(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const c: Call = { url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
    calls.push(c);
    return respond(c);
  };
  return { f, calls };
}

describe("freeBusy", () => {
  it("posts the window and returns intervals as epoch ms", async () => {
    const { f, calls } = fake(() => Response.json({ calendars: { primary: { busy: [{ start: "2026-12-01T17:00:00Z", end: "2026-12-01T18:00:00Z" }] } } }));
    const out = await freeBusy(f, "tok", new Date("2026-12-01T00:00:00Z"), new Date("2026-12-08T00:00:00Z"));
    expect(out).toEqual([{ start: Date.parse("2026-12-01T17:00:00Z"), end: Date.parse("2026-12-01T18:00:00Z") }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body).toEqual({ timeMin: "2026-12-01T00:00:00.000Z", timeMax: "2026-12-08T00:00:00.000Z", items: [{ id: "primary" }] });
  });

  it("throws when Google answers 200 with calendar errors, rather than reading it as free", async () => {
    const { f } = fake(() => Response.json({ calendars: { primary: { errors: [{ domain: "global", reason: "notFound" }] } } }));
    await expect(freeBusy(f, "t", new Date(0), new Date(1))).rejects.toThrow(/notFound/);
    const { f: g } = fake(() => Response.json({ calendars: { primary: { busy: [], errors: [] } } }));
    expect(await freeBusy(g, "t", new Date(0), new Date(1))).toEqual([]);
  });

  it("returns no intervals when the calendar has none, and throws when Google refuses", async () => {
    expect(await freeBusy(fake(() => Response.json({ calendars: { primary: {} } })).f, "t", new Date(0), new Date(1))).toEqual([]);
    await expect(freeBusy(fake(() => Response.json({ error: { message: "nope" } }, { status: 403 })).f, "t", new Date(0), new Date(1))).rejects.toThrow(/403/);
  });
});

const EVENT = { summary: "Discovery call", description: "20 minutes", start: "2026-12-01T17:00:00.000Z", end: "2026-12-01T17:20:00.000Z", attendeeEmail: "pat@acme.test", requestId: "req-1" };

describe("createEvent", () => {
  it("asks for a Meet link and returns its url", async () => {
    const { f, calls } = fake(() => Response.json({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" }));
    expect(await createEvent(f, "tok", EVENT)).toEqual({ eventId: "ev1", meetUrl: "https://meet.google.com/abc-defg-hij" });
    expect(calls[0].body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: "hangoutsMeet" });
    expect(calls[0].body).toMatchObject({ summary: "Discovery call", description: "20 minutes", start: { dateTime: EVENT.start }, end: { dateTime: EVENT.end }, attendees: [{ email: "pat@acme.test" }] });
  });

  it("returns a null meetUrl when Google gave no link", async () => {
    const { f } = fake(() => Response.json({ id: "ev2" }));
    expect(await createEvent(f, "tok", EVENT)).toEqual({ eventId: "ev2", meetUrl: null });
  });

  it("falls back to the video entry point when there is no hangoutLink", async () => {
    const { f } = fake(() => Response.json({ id: "ev3", conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://meet.google.com/zzz-yyyy-xxx" }] } }));
    expect(await createEvent(f, "tok", EVENT)).toEqual({ eventId: "ev3", meetUrl: "https://meet.google.com/zzz-yyyy-xxx" });
  });

  it("sends the requestId and no attendee updates", async () => {
    const { f, calls } = fake(() => Response.json({ id: "ev1" }));
    await createEvent(f, "tok", EVENT);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(u.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(u.searchParams.get("sendUpdates")).toBe("none");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body.conferenceData.createRequest.requestId).toBe("req-1");
  });

  it("throws when Google refuses", async () => {
    await expect(createEvent(fake(() => Response.json({ error: { message: "bad" } }, { status: 400 })).f, "t", EVENT)).rejects.toThrow(/400/);
  });
});

describe("deleteEvent", () => {
  it("deletes the event without notifying anyone", async () => {
    const { f, calls } = fake(() => new Response(null, { status: 204 }));
    await deleteEvent(f, "tok", "ev 1");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/ev%201?sendUpdates=none");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("treats 404 and 410 as success", async () => {
    for (const status of [404, 410]) await expect(deleteEvent(fake(() => new Response("{}", { status })).f, "t", "ev1")).resolves.toBeUndefined();
  });

  it("throws on 500", async () => {
    await expect(deleteEvent(fake(() => new Response("{}", { status: 500 })).f, "t", "ev1")).rejects.toThrow(/500/);
  });
});

describe("createEvent with an id", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  it("sends the id in the insert body, and leaves it out when none is given", async () => {
    const { f, calls } = fake(() => Response.json({ id: ID, hangoutLink: "https://meet.google.com/abc" }));
    expect(await createEvent(f, "tok", { ...EVENT, id: ID })).toEqual({ eventId: ID, meetUrl: "https://meet.google.com/abc" });
    expect(calls[0].body.id).toBe(ID);
    await createEvent(f, "tok", EVENT);
    expect("id" in calls[1].body).toBe(false);
  });

  it("a 409 is the event already made when a plain GET of the id returns it", async () => {
    const { f, calls } = fake((c) => c.method === "POST"
      ? Response.json({ error: { message: "The requested identifier already exists." } }, { status: 409 })
      : Response.json({ id: ID, status: "confirmed", hangoutLink: "https://meet.google.com/zzz" }));
    expect(await createEvent(f, "tok", { ...EVENT, id: ID })).toEqual({ eventId: ID, meetUrl: "https://meet.google.com/zzz" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(calls[1].url).toBe(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${ID}`);
  });

  it("a 409 is a failure when the GET finds nothing, a cancelled event, or another id", async () => {
    const conflict = () => Response.json({ error: { message: "The requested identifier already exists." } }, { status: 409 });
    const never = fake((c) => (c.method === "POST" ? conflict() : Response.json({ error: { message: "Not Found" } }, { status: 404 })));
    await expect(createEvent(never.f, "tok", { ...EVENT, id: ID })).rejects.toThrow(/409|404/);
    const gone = fake((c) => (c.method === "POST" ? conflict() : Response.json({ id: ID, status: "cancelled" })));
    await expect(createEvent(gone.f, "tok", { ...EVENT, id: ID })).rejects.toThrow(/409/);
    const other = fake((c) => (c.method === "POST" ? conflict() : Response.json({ id: "someotherid", status: "confirmed" })));
    await expect(createEvent(other.f, "tok", { ...EVENT, id: ID })).rejects.toThrow(/409/);
  });

  it("a 409 with no id given, and any other error, is thrown without a GET", async () => {
    const a = fake(() => Response.json({ error: { message: "dup" } }, { status: 409 }));
    await expect(createEvent(a.f, "tok", EVENT)).rejects.toThrow(/409/);
    const b = fake(() => Response.json({ error: { message: "down" } }, { status: 500 }));
    await expect(createEvent(b.f, "tok", { ...EVENT, id: ID })).rejects.toThrow(/500/);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});

describe("calendarToken", () => {
  const e = { ...env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };
  beforeEach(async () => { await env.DB.prepare(`DELETE FROM google_auth`).run(); });

  it("is null when Google is not connected, and never calls Google", async () => {
    const { f, calls } = fake(() => Response.json({}));
    expect(await calendarToken(e, f)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("is null when the stored scope has no calendar (or is NULL from before this scope existed)", async () => {
    const { f, calls } = fake(() => Response.json({ access_token: "x" }));
    const enc = await encryptSecret(env.SESSION_SECRET, "refresh-1");
    await saveGoogleAuth(env.DB, "me@x.test", enc, "openid email https://www.googleapis.com/auth/drive.file");
    expect(await calendarToken(e, f)).toBeNull();
    await saveGoogleAuth(env.DB, "me@x.test", enc, null);
    expect(await calendarToken(e, f)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refreshes the stored token when the scope includes calendar", async () => {
    const { f, calls } = fake(() => Response.json({ access_token: "access-9", expires_in: 3600 }));
    await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"),
      "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy");
    expect(await calendarToken(e, f)).toBe("access-9");
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(String(calls[0].body)).toContain("refresh_token=refresh-1");
  });
});

describe("scopes", () => {
  it("authUrl requests the calendar scopes", () => {
    const u = new URL(authUrl({ clientId: "cid", clientSecret: "x", redirectUri: "https://app/api/google/callback" }, "st"));
    const asked = u.searchParams.get("scope")!.split(" ");
    expect(asked).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(asked).toContain("https://www.googleapis.com/auth/calendar.freebusy");
    expect(asked).toContain("https://www.googleapis.com/auth/drive.file");
    expect(SCOPES.join(" ")).not.toContain("gmail");
    expect(u.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("hasCalendarScope needs both calendar scopes: either one alone is not enough", () => {
    const events = "https://www.googleapis.com/auth/calendar.events";
    const busy = "https://www.googleapis.com/auth/calendar.freebusy";
    expect(hasCalendarScope(null)).toBe(false);
    expect(hasCalendarScope("openid email")).toBe(false);
    expect(hasCalendarScope(`openid ${events}`)).toBe(false);
    expect(hasCalendarScope(busy)).toBe(false);
    expect(hasCalendarScope(`openid email ${events} ${busy}`)).toBe(true);
    expect(hasCalendarScope(`${busy}\n${events}`)).toBe(true);
  });
});
