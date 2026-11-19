import { env } from "cloudflare:test";
import { insertTestAudit } from "./video";
import { seedBusiness } from "./cro";
import { ensureReport } from "../../src/worker/db/reports";
import { saveGoogleAuth } from "../../src/worker/db/google";
import { saveSettings } from "../../src/worker/db/settings";
import { encryptSecret } from "../../src/worker/google/crypto";
import type { Fetch } from "../../src/worker/google/oauth";
import type { BookingForm } from "../../src/worker/booking/create";

/** Wednesday 10:00 in Los Angeles. */
export const NOW = new Date("2026-11-18T18:00:00.000Z");
/** Tuesday 24 Nov, 10:00 Los Angeles: on the 20-minute grid of a 09:00-17:00 window. */
export const SLOT = "2026-11-24T18:00:00.000Z";
/** Wednesday 25 Nov, 10:00 Los Angeles. */
export const SLOT_2 = "2026-11-25T18:00:00.000Z";

export const WEEKDAY_WINDOWS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" }));
export const CAL_SCOPE = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";

/** The Worker env with a Google OAuth client, so a refresh reaches the fake fetch instead of failing as "not connected". */
export const googleEnv = () => ({ ...env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" });

export async function connectGoogle(scope: string | null = CAL_SCOPE) {
  await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), scope);
}
export const setBookingConfig = (cfg: Record<string, unknown>) => saveSettings(env.DB, { booking_config: JSON.stringify(cfg) });

export interface Call { url: string; method: string; body: any }
/**
 * A stand-in for Google: token refresh, free/busy, event create and event delete. `busy` is what free/busy reports; created events are
 * added to it afterwards, as the real calendar would.
 */
export function fakeGoogle(o: { busy?: { start: string; end: string }[]; createFails?: boolean; freeBusyFails?: boolean; freeBusyErrors?: boolean; deleteFails?: boolean } = {}) {
  const calls: Call[] = [];
  const busy = [...(o.busy ?? [])];
  let n = 0;
  const f: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (() => { try { return JSON.parse(init.body as string); } catch { return init.body; } })() : init?.body;
    calls.push({ url, method, body });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-1", expires_in: 3600 });
    if (url.endsWith("/freeBusy")) {
      if (o.freeBusyFails) return Response.json({ error: { message: "boom" } }, { status: 500 });
      if (o.freeBusyErrors) return Response.json({ calendars: { primary: { errors: [{ reason: "notFound" }] } } });
      return Response.json({ calendars: { primary: { busy } } });
    }
    if (method === "POST" && url.includes("/calendars/primary/events")) {
      if (o.createFails) return Response.json({ error: { message: "calendar down" } }, { status: 500 });
      busy.push({ start: body.start.dateTime, end: body.end.dateTime });
      return Response.json({ id: `ev${++n}`, hangoutLink: `https://meet.google.com/abc-defg-h${n}` });
    }
    if (method === "DELETE" && url.includes("/calendars/primary/events/")) {
      if (o.deleteFails) return Response.json({ error: { message: "nope" } }, { status: 500 });
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { message: `unexpected ${method} ${url}` } }, { status: 500 });
  };
  const created = () => calls.filter((c) => c.method === "POST" && c.url.includes("/calendars/primary/events"));
  const deleted = () => calls.filter((c) => c.method === "DELETE");
  return { f, calls, busy, created, deleted };
}

/** A lead with an audit and a live report link made at `now`. */
export async function seedLead(name = "Ace Plumbing", now = NOW) {
  const b = await seedBusiness({ name });
  const audit = await insertTestAudit(b.id);
  const report = await ensureReport(env.DB, b.id, audit.id, now);
  return { b, token: report.token };
}

export const form = (over: Partial<BookingForm> = {}): BookingForm => ({
  name: "Pat Jones", email: "pat@acme.test", phone: "208-555-0100", topic: "A new website", budgetId: "797-1999", timeline: "This month",
  decisionMaker: "me", start: SLOT, ...over,
});

/** Windows set, Google connected with both calendar scopes: booking is on. */
export async function bookingOn() {
  await setBookingConfig({ windows: WEEKDAY_WINDOWS });
  await connectGoogle();
}

export async function resetBookingTables() {
  await env.DB.batch(["bookings", "deals", "activity", "enrollments", "approvals", "do_not_contact", "suppressions", "google_auth", "audit_reports"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await saveSettings(env.DB, { booking_config: "{}", booking_url: "" });
}
