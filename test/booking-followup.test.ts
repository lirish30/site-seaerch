import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import worker from "../src/worker/index";
import { setBookingDeps } from "../src/worker/booking/deps";
import { cancelByToken, createVisitorBooking } from "../src/worker/booking/create";
import { bookRecommendation, suggestFollowups } from "../src/worker/booking/followup";
import { computeSlots } from "../src/worker/booking/slots";
import { parseConfig } from "../src/worker/booking/config";
import { listActivity } from "../src/worker/db/activity";
import { bookingFor, insertBookingIfFree } from "../src/worker/db/bookings";
import { getSettings } from "../src/worker/db/settings";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { replaceContacts } from "../src/worker/db/contacts";
import { getDeal, moveDeal, openDealFor } from "../src/worker/db/deals";
import { setMailDeps } from "../src/worker/mail/deps";
import type { OutboundMessage } from "../src/worker/mail/types";
import { groupByDay } from "../src/client/bookingView";
import { NOW, SLOT, SLOT_2, bookingOn, connectGoogle, fakeGoogle, form, googleEnv, resetBookingTables, seedLead, setBookingConfig, WEEKDAY_WINDOWS } from "./fixtures/booking";
import { NOTES, seedRecapDeal } from "./fixtures/deal";

const e = googleEnv();
let google = fakeGoogle();
let out: OutboundMessage[] = [];
const MAIN = { enabled: 1 as const, smtp_host: "smtp.main.test", smtp_port: 465, imap_host: "imap.main.test", imap_port: 993, username: "logan@main.test", from_email: "logan@main.test", from_name: "Logan" };

beforeEach(async () => {
  await resetBookingTables();
  await env.DB.batch(["claude_tasks", "contacts", "messages"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  google = fakeGoogle();
  setBookingDeps({ fetch: google.f });
  out = [];
  setMailDeps({ smtp: async (_mb, _pw, m) => { out.push(m); }, now: () => NOW });
  await saveMailbox(env.DB, "main", MAIN);
  await bookingOn();
});
afterEach(async () => { setBookingDeps(null); setMailDeps(null); await saveMailbox(env.DB, "main", { enabled: 0, smtp_host: "", from_email: "" }); });

/** A lead that booked its discovery call from the report page (so it has the deal, the booking and the Meet link), as the visitor path makes them. */
async function bookedLead() {
  const { b, token } = await seedLead();
  const r = await createVisitorBooking(e, token, form(), NOW);
  if (!r.ok) throw new Error(`setup booking failed: ${r.error}`);
  // The discovery confirmation and event are not what these tests are about: count from here (the calendar still shows the discovery call as busy).
  out = [];
  google = fakeGoogle({ busy: [...google.busy] });
  setBookingDeps({ fetch: google.f });
  return { b, token, deal: (await openDealFor(env.DB, b.id))!, discovery: r.booking };
}

describe("suggestFollowups", () => {
  it("suggestFollowups returns two slots on different days", async () => {
    const slots = await suggestFollowups(e, NOW);
    expect(slots).toHaveLength(2);
    const cfg = parseConfig((await getSettings(env.DB)).booking_config);
    expect(groupByDay(slots, cfg.timezone)).toHaveLength(2);
    // They are real recommendation-meeting starts (30 minutes), from a fresh look at the calendar.
    for (const s of slots) expect(computeSlots(cfg, "recommendation", [], NOW)).toContain(s);
    expect(google.calls.filter((c) => c.url.endsWith("/freeBusy"))).toHaveLength(1);
  });

  it("does not offer a time that is busy on the calendar", async () => {
    const first = (await suggestFollowups(e, NOW))[0];
    google = fakeGoogle({ busy: [{ start: first, end: new Date(Date.parse(first) + 30 * 60_000).toISOString() }] });
    setBookingDeps({ fetch: google.f });
    expect(await suggestFollowups(e, NOW)).not.toContain(first);
  });

  it("is empty when there are no windows or Google is not connected, and throws when Google cannot be asked (never 'free')", async () => {
    await setBookingConfig({ windows: [] });
    expect(await suggestFollowups(e, NOW)).toEqual([]);
    await setBookingConfig({ windows: WEEKDAY_WINDOWS });
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect(await suggestFollowups(e, NOW)).toEqual([]);
    await connectGoogle();
    google = fakeGoogle({ freeBusyFails: true });
    setBookingDeps({ fetch: google.f });
    await expect(suggestFollowups(e, NOW)).rejects.toThrow();
  });
});

describe("bookRecommendation", () => {
  it("bookRecommendation moves the deal and creates a meet link", async () => {
    const { b, deal, discovery } = await bookedLead();
    const r = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.booking).toMatchObject({
      kind: "recommendation", status: "confirmed", startAt: SLOT_2, endAt: "2026-11-25T18:30:00.000Z", source: "logan", businessId: b.id, dealId: deal.id,
      contactEmail: "pat@acme.test", contactName: "Pat Jones",
    });
    expect(r.booking.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    // The event is made under the booking's own id, with the guest as the attendee.
    const [made] = google.created();
    expect(made.body).toMatchObject({ id: r.booking.id.replace(/-/g, ""), attendees: [{ email: "pat@acme.test" }] });
    expect(made.body.summary).toMatch(/Recommendation/);
    expect(made.url).toContain("sendUpdates=none");
    expect(r.booking.calendarEventId).toBe(r.booking.id.replace(/-/g, ""));
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked");
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "followup_booked")).toHaveLength(1);
    // The discovery call is untouched, and the confirmation went from the main mailbox to the typed address.
    expect((await bookingFor(env.DB, b.id, "discovery"))!.id).toBe(discovery.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: "pat@acme.test", from: { email: "logan@main.test" } });
    expect(out[0].text).toContain(r.booking.meetUrl!);
    expect(out[0].text).toContain("30 minutes");
  });

  it("uses the discovery booking's email even after the call is marked held", async () => {
    const { b, deal, discovery } = await bookedLead();
    await env.DB.prepare(`UPDATE bookings SET status = 'held' WHERE id = ?`).bind(discovery.id).run();
    await moveDeal(env.DB, deal.id, "discovery_done");
    const r = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    expect(r).toMatchObject({ ok: true, booking: { contactEmail: "pat@acme.test", businessId: b.id } });
  });

  it("booking a taken follow-up slot is a 409", async () => {
    const { b, deal } = await bookedLead();
    // Busy on the calendar: not offered.
    google = fakeGoogle({ busy: [{ start: SLOT_2, end: "2026-11-25T18:30:00.000Z" }] });
    setBookingDeps({ fetch: google.f });
    expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toEqual({ ok: false, status: 409, error: expect.stringMatching(/taken|not available/) });
    // Free on the calendar but another confirmed booking holds it: the atomic insert refuses, and Google is never asked to make an event.
    google = fakeGoogle();
    setBookingDeps({ fetch: google.f });
    const other = await seedLead("Birch Bakery");
    await insertBookingIfFree(env.DB, { businessId: other.b.id, dealId: null, kind: "discovery", startAt: SLOT_2, endAt: "2026-11-25T18:20:00.000Z", contactName: "Sam", contactEmail: "sam@birch.test", contactPhone: null, answers: null, source: "visitor" });
    expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toEqual({ ok: false, status: 409, error: expect.any(String) });
    expect(google.created()).toHaveLength(0);
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("booked");
    expect(await bookingFor(env.DB, b.id, "recommendation")).toBeNull();
    // A start that was never on offer (a time off the grid) is refused the same way.
    expect((await bookRecommendation(e, deal.id, "2026-11-25T18:07:00.000Z", NOW)).ok).toBe(false);
    expect((await bookRecommendation(e, deal.id, "not a date", NOW)).ok).toBe(false);
  });

  it("a skipCall deal can book a recommendation meeting", async () => {
    const { b, deal } = await seedRecapDeal({ skipCall: true, notes: null });
    expect(deal.stage).toBe("discovery_done");
    await replaceContacts(env.DB, b.id, [{ type: "email", value: "owner@ace.test", source_url: "https://ace.com/contact", person_name: "Pat Jones", role: "Owner", confidence: 0.9 }]);
    const r = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.booking).toMatchObject({ kind: "recommendation", contactEmail: "owner@ace.test", contactName: "Pat Jones", source: "logan" });
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked");
    expect(google.created()[0].body.attendees).toEqual([{ email: "owner@ace.test" }]);
  });

  it("a deal with no address to send to is a 422 and touches nothing", async () => {
    const { b, deal } = await seedRecapDeal({ skipCall: true, notes: null });
    expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toEqual({ ok: false, status: 422, error: expect.stringMatching(/email/i) });
    expect(google.created()).toHaveLength(0);
    expect(await bookingFor(env.DB, b.id, "recommendation")).toBeNull();
    await replaceContacts(env.DB, b.id, [{ type: "email", value: "not an address", source_url: null, person_name: null, role: null, confidence: 0.5 }]);
    expect((await bookRecommendation(e, deal.id, SLOT_2, NOW)).ok).toBe(false);
  });

  it("refuses a won or lost deal, an unknown deal, and a second meeting while one is booked", async () => {
    const { deal } = await bookedLead();
    expect((await bookRecommendation(e, "nope", SLOT_2, NOW)).ok).toBe(false);
    const first = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    expect(first.ok).toBe(true);
    const again = await bookRecommendation(e, deal.id, "2026-11-26T18:00:00.000Z", NOW);
    expect(again).toEqual({ ok: false, status: 409, error: expect.stringMatching(/already/) });
    expect(google.created()).toHaveLength(1);
    await moveDeal(env.DB, deal.id, "lost", { lostReason: "chose someone else" });
    expect(await bookRecommendation(e, deal.id, "2026-11-26T18:00:00.000Z", NOW)).toEqual({ ok: false, status: 409, error: expect.stringMatching(/closed/) });
  });

  it("refuses a deal already past the recommendation meeting (it cannot move back)", async () => {
    const { deal } = await bookedLead();
    await moveDeal(env.DB, deal.id, "recommended");
    expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toEqual({ ok: false, status: 409, error: expect.any(String) });
    expect(google.created()).toHaveLength(0);
  });

  it("is a 503 without a calendar, and when Google cannot be asked", async () => {
    const { deal } = await bookedLead();
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toMatchObject({ ok: false, status: 503 });
    await connectGoogle();
    google = fakeGoogle({ freeBusyFails: true });
    setBookingDeps({ fetch: google.f });
    expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toMatchObject({ ok: false, status: 503 });
  });

  it("when Google fails to make the event the row is cancelled, the possible event is deleted and the deal stays put", async () => {
    const { b, deal } = await bookedLead();
    for (const mode of [{ createFails: true }, { createThrows: true }]) {
      google = fakeGoogle(mode);
      setBookingDeps({ fetch: google.f });
      expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toMatchObject({ ok: false, status: 503 });
      expect(google.deleted()).toHaveLength(1);
      expect(await bookingFor(env.DB, b.id, "recommendation")).toBeNull();
      const row = (await env.DB.prepare(`SELECT status FROM bookings WHERE kind = 'recommendation'`).first<{ status: string }>())!;
      expect(row.status).toBe("cancelled");
      await env.DB.prepare(`DELETE FROM bookings WHERE kind = 'recommendation'`).run();
    }
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("booked");
    expect(out).toHaveLength(0);
  });

  it("the guest's cancel link frees the meeting and the timeline says it was the recommendation meeting", async () => {
    const { b, token, deal } = await bookedLead();
    const r = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(out[0].text).toContain(`https://go.hellositeline.test/r/${token}/book?cancel=${r.booking.cancelToken}`);
    expect(await cancelByToken(e, token, r.booking.cancelToken, NOW)).toEqual({ ok: true, kind: "recommendation" });
    expect(await bookingFor(env.DB, b.id, "recommendation")).toBeNull();
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "booking_cancelled").map((a) => a.detail)).toEqual([expect.stringMatching(/^Recommendation meeting cancelled/)]);
  });

  it("after the guest cancels the meeting, Logan can book it again: the deal stays at recommendation_booked with exactly one confirmed meeting", async () => {
    const { b, token, deal } = await bookedLead();
    const first = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    if (!first.ok) throw new Error(first.error);
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked");
    // While the meeting stands, a second one is refused.
    expect(await bookRecommendation(e, deal.id, "2026-11-26T18:00:00.000Z", NOW)).toMatchObject({ ok: false, status: 409 });
    expect(await cancelByToken(e, token, first.booking.cancelToken, NOW)).toEqual({ ok: true, kind: "recommendation" });
    expect(await bookingFor(env.DB, b.id, "recommendation")).toBeNull();
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked"); // the cancel moves nothing
    const again = await bookRecommendation(e, deal.id, "2026-11-26T18:00:00.000Z", NOW);
    if (!again.ok) throw new Error(again.error);
    expect(again.booking).toMatchObject({ kind: "recommendation", status: "confirmed", startAt: "2026-11-26T18:00:00.000Z" });
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked");
    const rows = (await env.DB.prepare(`SELECT status FROM bookings WHERE business_id = ? AND kind = 'recommendation' ORDER BY created_at, id`).bind(b.id).all<{ status: string }>()).results.map((r) => r.status).sort();
    expect(rows).toEqual(["cancelled", "confirmed"]);
    expect((await listActivity(env.DB, b.id)).filter((a) => a.kind === "followup_booked")).toHaveLength(2);
    // A deal that is past this step (recommended) still cannot book one.
    await moveDeal(env.DB, deal.id, "recommended");
    expect(await bookRecommendation(e, deal.id, SLOT_2, NOW)).toMatchObject({ ok: false, status: 409 });
  });

  it("a deal at recommendation_booked that has no meeting books one without moving the stage twice", async () => {
    const { deal } = await bookedLead();
    await moveDeal(env.DB, deal.id, "recommendation_booked"); // e.g. the meeting row is gone
    const r = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    expect(r.ok).toBe(true);
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked");
  });

  it("a confirmation that cannot go out never undoes the booking", async () => {
    const { b, deal } = await bookedLead();
    setMailDeps({ smtp: async () => { throw new Error("smtp down"); }, now: () => NOW });
    const r = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    expect(r.ok).toBe(true);
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked");
    expect((await listActivity(env.DB, b.id)).some((a) => a.detail === "confirmation not sent: smtp down")).toBe(true);
  });
});

describe("the follow-up routes", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const api = (method: string, path: string, body?: unknown, auth = true) => worker.fetch(new Request(`https://x${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" },
  }), e, ctx);

  it("require sign-in", async () => {
    expect((await api("GET", "/api/deals/x/followup-slots", undefined, false)).status).toBe(401);
    expect((await api("POST", "/api/deals/x/book-recommendation", { start: SLOT_2 }, false)).status).toBe(401);
  });

  it("GET followup-slots gives two times and the zone to show them in", async () => {
    const { deal } = await bookedLead();
    const res = await api("GET", `/api/deals/${deal.id}/followup-slots`);
    expect(res.status).toBe(200);
    const body = await res.json<{ slots: string[]; tz: string }>();
    expect(body.tz).toBe("America/Los_Angeles");
    expect(body.slots).toHaveLength(2);
    expect((await api("GET", "/api/deals/nope/followup-slots")).status).toBe(404);
  });

  it("GET followup-slots is a 503 when Google cannot be asked, and a 409 for a closed deal", async () => {
    const { deal } = await bookedLead();
    google = fakeGoogle({ freeBusyFails: true });
    setBookingDeps({ fetch: google.f });
    expect((await api("GET", `/api/deals/${deal.id}/followup-slots`)).status).toBe(503);
    await moveDeal(env.DB, deal.id, "lost", { lostReason: "x" });
    expect((await api("GET", `/api/deals/${deal.id}/followup-slots`)).status).toBe(409);
  });

  it("the guest's cancel through the public route says which kind of booking was cancelled, and a wrong token says nothing about it", async () => {
    const { token, deal } = await bookedLead();
    const r = await bookRecommendation(e, deal.id, SLOT_2, NOW);
    if (!r.ok) throw new Error(r.error);
    const cancel = (cancelToken: string) => api("POST", `/api/public/report/${token}/book/cancel`, { cancelToken }, false);
    const wrong = await cancel("x".repeat(43));
    expect([wrong.status, await wrong.text()]).toEqual([200, JSON.stringify({ ok: false })]);
    const right = await cancel(r.booking.cancelToken);
    expect([right.status, await right.json()]).toEqual([200, { ok: true, kind: "recommendation" }]);
    expect(await (await cancel(r.booking.cancelToken)).json()).toEqual({ ok: true, kind: "recommendation" }); // the same again
  });

  it("POST book-recommendation books it and moves the deal; a taken time is a 409; a bad body is a 400", async () => {
    const { deal } = await bookedLead();
    expect((await api("POST", `/api/deals/${deal.id}/book-recommendation`, { start: 5 })).status).toBe(400);
    expect((await api("POST", `/api/deals/${deal.id}/book-recommendation`, { start: SLOT_2, extra: 1 })).status).toBe(400);
    expect((await api("POST", "/api/deals/nope/book-recommendation", { start: SLOT_2 })).status).toBe(404);
    const res = await api("POST", `/api/deals/${deal.id}/book-recommendation`, { start: SLOT_2 });
    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body.booking).toMatchObject({ kind: "recommendation", start: SLOT_2 });
    expect(JSON.stringify(body)).not.toContain("cancelToken"); // the guest's secret stays out of the owner's screen
    expect((await getDeal(env.DB, deal.id))!.stage).toBe("recommendation_booked");
    const second = await seedLead("Birch Bakery");
    const r2 = await createVisitorBooking(e, second.token, form({ email: "sam@birch.test", start: "2026-11-26T18:00:00.000Z" }), NOW);
    expect(r2.ok).toBe(true);
    const d2 = (await openDealFor(env.DB, second.b.id))!;
    const taken = await api("POST", `/api/deals/${d2.id}/book-recommendation`, { start: SLOT_2 });
    expect(taken.status).toBe(409);
    expect((await taken.json<any>()).error).toBeTruthy();
  });
});

// Keep the fixtures import honest: NOTES is what the recap tests share.
void NOTES;
