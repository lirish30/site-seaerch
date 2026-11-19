import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import worker from "../src/worker/index";
import { setBookingDeps } from "../src/worker/booking/deps";
import { createVisitorBooking, eventIdFor } from "../src/worker/booking/create";
import { listActivity } from "../src/worker/db/activity";
import { bookingFor, getBooking, insertBookingIfFree } from "../src/worker/db/bookings";
import { createDeal, moveDeal, openDealFor } from "../src/worker/db/deals";
import { setMailDeps } from "../src/worker/mail/deps";
import { NOW, SLOT, SLOT_2, bookingOn, fakeGoogle, form, googleEnv, resetBookingTables, seedLead } from "./fixtures/booking";

const e = googleEnv();
let google = fakeGoogle();
let cookie = "";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const api = (method: string, path: string, body?: unknown, auth = true) => worker.fetch(new Request(`https://x${path}`, {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" },
}), e, ctx);

beforeAll(async () => {
  const r = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), e, ctx);
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await resetBookingTables();
  google = fakeGoogle();
  setBookingDeps({ fetch: google.f });
  setMailDeps({ smtp: async () => {}, now: () => NOW });
  await bookingOn();
});
afterEach(() => { setBookingDeps(null); setMailDeps(null); });

/** A lead that booked its discovery call through the guest page: the booking, its deal (at booked) and the calendar event. */
async function booked(start = SLOT) {
  const { b, token } = await seedLead();
  const r = await createVisitorBooking(e, token, form({ start }), NOW);
  if (!r.ok) throw new Error(r.error);
  return { b, token, booking: r.booking, deal: (await openDealFor(env.DB, b.id))! };
}
/** A confirmed recommendation meeting for a lead, as Logan's follow-up makes one. */
async function meeting(businessId: string, dealId: string | null, start = SLOT_2) {
  const m = await insertBookingIfFree(env.DB, { businessId, dealId, kind: "recommendation", startAt: start, endAt: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
    contactName: "Pat Jones", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "logan" });
  return m!;
}
const kinds = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind).map((a) => a.detail);
/** The "deal still at booked" lines on a lead's timeline (other notes, such as an unsent confirmation, are not what these tests are about). */
const stillBooked = async (businessId: string) => (await kinds(businessId, "note")).filter((d) => d?.includes("deal still at booked"));

describe("POST /api/bookings/:id/cancel", () => {
  it("needs a session, and an unknown booking is a 404", async () => {
    const { booking } = await booked();
    expect((await api("POST", `/api/bookings/${booking.id}/cancel`, {}, false)).status).toBe(401);
    expect((await api("POST", `/api/bookings/${booking.id}/held`, {}, false)).status).toBe(401);
    expect((await api("POST", "/api/bookings/nope/cancel", {})).status).toBe(404);
    expect((await api("POST", `/api/bookings/${booking.id}/cancel`, { noShow: "yes" })).status).toBe(400);
    expect((await api("POST", `/api/bookings/${booking.id}/cancel`, { nope: 1 })).status).toBe(400);
    expect((await getBooking(env.DB, booking.id))!.status).toBe("confirmed");
  });

  it("cancels a confirmed call: the event is deleted, the slot is freed, the timeline says so, and the deal stays at booked", async () => {
    const { b, booking, deal } = await booked();
    const res = await api("POST", `/api/bookings/${booking.id}/cancel`, {});
    expect([res.status, await res.json()]).toEqual([200, { id: booking.id, status: "cancelled" }]);
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining(`/events/${booking.calendarEventId}`)]);
    expect((await getBooking(env.DB, booking.id))).toMatchObject({ status: "cancelled" });
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    expect(await kinds(b.id, "booking_cancelled")).toEqual([expect.stringMatching(/^Discovery call cancelled \(was /)]);
    expect(await stillBooked(b.id)).toEqual(["Call cancelled, deal still at booked"]);
    expect((await openDealFor(env.DB, b.id))).toMatchObject({ id: deal.id, stage: "booked" });
    // The slot and the lead's one-discovery-call index are free: the guest page books again.
    const again = await createVisitorBooking(e, (await seedTokenFor(b.id)), form({ start: SLOT_2 }), NOW);
    expect(again.ok).toBe(true);
  });

  it("is idempotent: a second cancel is a 200, deletes nothing again and logs nothing again", async () => {
    const { b, booking } = await booked();
    await api("POST", `/api/bookings/${booking.id}/cancel`, {});
    const before = (await listActivity(env.DB, b.id)).length;
    const res = await api("POST", `/api/bookings/${booking.id}/cancel`, {});
    expect([res.status, await res.json()]).toEqual([200, { id: booking.id, status: "cancelled" }]);
    expect(google.deleted()).toHaveLength(1);
    expect((await listActivity(env.DB, b.id)).length).toBe(before);
  });

  it("noShow marks the call a no-show, frees the slot, and a later cancel changes nothing", async () => {
    const { b, booking } = await booked();
    const res = await api("POST", `/api/bookings/${booking.id}/cancel`, { noShow: true });
    expect([res.status, await res.json()]).toEqual([200, { id: booking.id, status: "no_show" }]);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    expect(await kinds(b.id, "booking_cancelled")).toEqual([expect.stringMatching(/^Discovery call marked as a no-show/)]);
    expect(await stillBooked(b.id)).toEqual(["Call missed, deal still at booked"]);
    const again = await api("POST", `/api/bookings/${booking.id}/cancel`, {});
    expect([again.status, await again.json()]).toEqual([200, { id: booking.id, status: "no_show" }]);
    expect((await getBooking(env.DB, booking.id))!.status).toBe("no_show");
    expect(google.deleted()).toHaveLength(1);
  });

  it("a held call cannot be cancelled (409)", async () => {
    const { booking } = await booked();
    await env.DB.prepare(`UPDATE bookings SET status = 'held' WHERE id = ?`).bind(booking.id).run();
    expect((await api("POST", `/api/bookings/${booking.id}/cancel`, {})).status).toBe(409);
    expect((await api("POST", `/api/bookings/${booking.id}/cancel`, { noShow: true })).status).toBe(409);
    expect((await getBooking(env.DB, booking.id))!.status).toBe("held");
    expect(google.deleted()).toHaveLength(0);
  });

  it("deletes the event under the booking's own id when no event id was recorded", async () => {
    const { b } = await seedLead();
    const m = (await insertBookingIfFree(env.DB, { businessId: b.id, dealId: null, kind: "discovery", startAt: SLOT, endAt: "2026-11-24T18:20:00.000Z", contactName: "Pat", contactEmail: "pat@acme.test",
      contactPhone: null, answers: null, source: "visitor" }))!;
    expect(m.calendarEventId).toBeNull();
    expect((await api("POST", `/api/bookings/${m.id}/cancel`, {})).status).toBe(200);
    expect(google.deleted().map((c) => c.url)).toEqual([expect.stringContaining(`/events/${eventIdFor(m.id)}`)]);
    expect((await getBooking(env.DB, m.id))!.status).toBe("cancelled");
  });

  it("still ends the booking when Google refuses the delete (best effort)", async () => {
    const { b, booking } = await booked();
    google = fakeGoogle({ deleteFails: true });
    setBookingDeps({ fetch: google.f });
    expect((await api("POST", `/api/bookings/${booking.id}/cancel`, {})).status).toBe(200);
    expect((await getBooking(env.DB, booking.id))!.status).toBe("cancelled");
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
  });

  it("a deal past booked gets no 'still at booked' line, and a cancelled recommendation meeting leaves the deal where it is", async () => {
    const { b, booking, deal } = await booked();
    await moveDeal(env.DB, deal.id, "discovery_done");
    await api("POST", `/api/bookings/${booking.id}/cancel`, { noShow: true });
    expect(await stillBooked(b.id)).toEqual([]);
    const m = await meeting(b.id, deal.id);
    await moveDeal(env.DB, deal.id, "recommendation_booked");
    expect((await api("POST", `/api/bookings/${m.id}/cancel`, {})).status).toBe(200);
    expect(await kinds(b.id, "booking_cancelled")).toContainEqual(expect.stringMatching(/^Recommendation meeting cancelled/));
    expect(await stillBooked(b.id)).toEqual([]);
    expect((await openDealFor(env.DB, b.id))!.stage).toBe("recommendation_booked");
  });

  it("no_show and cancelled both leave the partial unique index (it only covers confirmed discovery calls)", async () => {
    const idx = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name = 'uq_bookings_discovery'`).first<{ sql: string }>();
    expect(idx!.sql).toMatch(/WHERE kind = 'discovery' AND status = 'confirmed'/);
    const { b } = await seedLead();
    const make = async (start: string) => (await insertBookingIfFree(env.DB, { businessId: b.id, dealId: null, kind: "discovery", startAt: start, endAt: new Date(Date.parse(start) + 20 * 60_000).toISOString(),
      contactName: "Pat", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "visitor" }))!;
    const one = await make(SLOT);
    expect(await make(SLOT_2)).toBeNull(); // a second confirmed discovery call is refused
    await api("POST", `/api/bookings/${one.id}/cancel`, { noShow: true });
    const two = await make(SLOT_2);
    expect(two).not.toBeNull();
    await api("POST", `/api/bookings/${two.id}/cancel`, {});
    expect(await make("2026-11-26T18:00:00.000Z")).not.toBeNull();
  });
});

describe("POST /api/bookings/:id/held", () => {
  it("marks a recommendation meeting held, and says the same again", async () => {
    const { b, deal } = await booked();
    const m = await meeting(b.id, deal.id);
    expect((await api("POST", "/api/bookings/nope/held", {})).status).toBe(404);
    const res = await api("POST", `/api/bookings/${m.id}/held`, {});
    expect([res.status, await res.json()]).toEqual([200, { id: m.id, status: "held" }]);
    expect((await api("POST", `/api/bookings/${m.id}/held`, {})).status).toBe(200);
    expect((await getBooking(env.DB, m.id))!.status).toBe("held");
    expect((await api("POST", `/api/bookings/${m.id}/cancel`, {})).status).toBe(409); // it happened
  });

  it("refuses a discovery call (that is Call done on its deal) and a meeting that was cancelled", async () => {
    const { b, booking, deal } = await booked();
    const res = await api("POST", `/api/bookings/${booking.id}/held`, {});
    expect(res.status).toBe(409);
    expect((await getBooking(env.DB, booking.id))!.status).toBe("confirmed");
    const m = await meeting(b.id, deal.id);
    await api("POST", `/api/bookings/${m.id}/cancel`, {});
    expect((await api("POST", `/api/bookings/${m.id}/held`, {})).status).toBe(409);
  });
});

describe("the owner's lists", () => {
  it("GET /api/bookings never returns the guest's cancel token, and shows a call that started and was never marked", async () => {
    const { b, booking } = await booked();
    const past = (await insertBookingIfFree(env.DB, { businessId: (await seedLead("Old Co")).b.id, dealId: null, kind: "discovery", startAt: "2026-01-05T18:00:00.000Z", endAt: "2026-01-05T18:20:00.000Z",
      contactName: "Old", contactEmail: "old@acme.test", contactPhone: null, answers: null, source: "visitor" }))!;
    const res = await api("GET", "/api/bookings");
    const text = await res.text();
    expect(text).not.toContain("cancelToken");
    expect(text).not.toContain(booking.cancelToken);
    const rows = JSON.parse(text) as { id: string; kind: string; dealId: string | null }[];
    expect(rows.map((r) => r.id)).toEqual([past.id, booking.id]); // the one that started comes first: it needs an outcome
    expect(rows.find((r) => r.id === booking.id)).toMatchObject({ kind: "discovery", dealId: expect.any(String) });
    expect(await (await api("GET", `/api/bookings?lead=${b.id}`)).text()).not.toContain("cancelToken");
    // Marked a no-show, it leaves the list.
    await api("POST", `/api/bookings/${past.id}/cancel`, { noShow: true });
    expect((await (await api("GET", "/api/bookings")).json<{ id: string }[]>()).map((r) => r.id)).toEqual([booking.id]);
  });

  it("GET /api/today/calls carries the kind and the deal, and includes a call that started without an outcome", async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const lead = await seedLead("Soon Co");
    const d = await createDeal(env.DB, { businessId: lead.b.id, source: "booking" });
    const soon = (await insertBookingIfFree(env.DB, { businessId: lead.b.id, dealId: d.id, kind: "discovery", startAt: at(2 * 3_600_000), endAt: at(2 * 3_600_000 + 20 * 60_000),
      contactName: "Pat", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "visitor" }))!;
    const old = (await insertBookingIfFree(env.DB, { businessId: (await seedLead("Old Co")).b.id, dealId: null, kind: "recommendation", startAt: "2026-01-05T18:00:00.000Z", endAt: "2026-01-05T18:30:00.000Z",
      contactName: "Old", contactEmail: "old@acme.test", contactPhone: null, answers: null, source: "logan" }))!;
    const { calls } = await (await api("GET", "/api/today/calls")).json<{ calls: { id: string; kind: string; dealId: string | null }[] }>();
    expect(calls.map((c) => c.id)).toEqual([old.id, soon.id]); // the one that started comes first
    expect(calls[0]).toMatchObject({ kind: "recommendation", dealId: null });
    expect(calls[1]).toMatchObject({ kind: "discovery", dealId: d.id });
    expect(JSON.stringify(calls)).not.toContain("cancelToken");
  });
});

/** The report link of a lead (the booking page is addressed by it). */
async function seedTokenFor(businessId: string): Promise<string> {
  return (await env.DB.prepare(`SELECT token FROM audit_reports WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`).bind(businessId).first<{ token: string }>())!.token;
}
