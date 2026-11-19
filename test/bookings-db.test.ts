import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { bookingFor, cancelBooking, getBookingByCancelToken, insertBookingIfFree, setBookingEvent, upcomingBookings, type Booking } from "../src/worker/db/bookings";
import { deleteBusiness } from "../src/worker/db/businesses";
import { seedBusiness } from "./fixtures/cro";
import { resetBookingTables } from "./fixtures/booking";

const at = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00.000Z`).toISOString();
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

type Input = Parameters<typeof insertBookingIfFree>[1];
const input = (businessId: string, startAt: string, over: Partial<Input> & { minutes?: number } = {}): Input => ({
  businessId, dealId: null, kind: "discovery", startAt, endAt: plus(startAt, over.minutes ?? 20),
  contactName: "Pat Jones", contactEmail: "pat@acme.test", contactPhone: null,
  answers: { topic: "A new website", budgetId: "797-1999", timeline: "This month", decisionMaker: "me" }, source: "visitor", ...over,
});

beforeEach(resetBookingTables);

describe("insertBookingIfFree", () => {
  it("stores a confirmed booking with a 43-character cancel token and reads it back", async () => {
    const b = await seedBusiness();
    const made = (await insertBookingIfFree(env.DB, input(b.id, at("17:00"))))!;
    expect(made).toMatchObject({ businessId: b.id, kind: "discovery", status: "confirmed", startAt: at("17:00"), endAt: at("17:20"), contactName: "Pat Jones",
      contactEmail: "pat@acme.test", contactPhone: null, calendarEventId: null, meetUrl: null, cancelledAt: null, source: "visitor", dealId: null,
      answers: { topic: "A new website", budgetId: "797-1999", timeline: "This month", decisionMaker: "me" } });
    expect(made.cancelToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.id).toBeTruthy();
    expect((await insertBookingIfFree(env.DB, input((await seedBusiness()).id, at("18:00"))))!.cancelToken).not.toBe(made.cancelToken);
  });

  it("second booking on the same slot is refused", async () => {
    const [x, y] = [await seedBusiness({ name: "X Co" }), await seedBusiness({ name: "Y Co" })];
    expect(await insertBookingIfFree(env.DB, input(x.id, at("17:00")))).not.toBeNull();
    expect(await insertBookingIfFree(env.DB, input(y.id, at("17:00")))).toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings`).first<{ n: number }>())!.n).toBe(1);
  });

  it("a 30-minute booking overlapping a confirmed 20-minute one is refused", async () => {
    const [x, y] = [await seedBusiness({ name: "X Co" }), await seedBusiness({ name: "Y Co" })];
    expect(await insertBookingIfFree(env.DB, input(x.id, at("17:00")))).not.toBeNull(); // 17:00-17:20
    expect(await insertBookingIfFree(env.DB, input(y.id, at("17:10"), { kind: "recommendation", minutes: 30 }))).toBeNull(); // starts inside it
    expect(await insertBookingIfFree(env.DB, input(y.id, at("16:50"), { kind: "recommendation", minutes: 30 }))).toBeNull(); // ends inside it
    expect(await insertBookingIfFree(env.DB, input(y.id, at("16:40"), { kind: "recommendation", minutes: 60 }))).toBeNull(); // wraps it
    // Back to back is fine: an interval ends where the next begins.
    expect(await insertBookingIfFree(env.DB, input(y.id, at("17:20"), { kind: "recommendation", minutes: 30 }))).not.toBeNull();
  });

  it("a cancelled booking frees its slot", async () => {
    const [x, y] = [await seedBusiness({ name: "X Co" }), await seedBusiness({ name: "Y Co" })];
    const first = (await insertBookingIfFree(env.DB, input(x.id, at("17:00"))))!;
    expect(await cancelBooking(env.DB, first.id, new Date("2026-11-30T00:00:00Z"))).toBe(true);
    expect(await insertBookingIfFree(env.DB, input(y.id, at("17:00")))).not.toBeNull();
    expect(await cancelBooking(env.DB, first.id, new Date("2026-11-30T01:00:00Z"))).toBe(false); // already cancelled: nothing changes
    const row = (await env.DB.prepare(`SELECT status, cancelled_at FROM bookings WHERE id = ?`).bind(first.id).first<any>())!;
    expect(row).toEqual({ status: "cancelled", cancelled_at: "2026-11-30T00:00:00.000Z" });
  });

  it("a lead can hold only one confirmed discovery booking", async () => {
    const b = await seedBusiness();
    const first = (await insertBookingIfFree(env.DB, input(b.id, at("17:00"))))!;
    expect(await insertBookingIfFree(env.DB, input(b.id, at("19:00")))).toBeNull();
    // A different kind of call for the same lead is allowed, and so is a new discovery once the first is cancelled.
    expect(await insertBookingIfFree(env.DB, input(b.id, at("20:00"), { kind: "recommendation", minutes: 30 }))).not.toBeNull();
    await cancelBooking(env.DB, first.id, new Date());
    expect(await insertBookingIfFree(env.DB, input(b.id, at("19:00")))).not.toBeNull();
  });
});

describe("reading bookings", () => {
  it("setBookingEvent records the event and the Meet link", async () => {
    const b = await seedBusiness();
    const made = (await insertBookingIfFree(env.DB, input(b.id, at("17:00"))))!;
    await setBookingEvent(env.DB, made.id, "ev1", "https://meet.google.com/abc");
    expect(await bookingFor(env.DB, b.id, "discovery")).toMatchObject({ id: made.id, calendarEventId: "ev1", meetUrl: "https://meet.google.com/abc" });
    await setBookingEvent(env.DB, made.id, "ev2", null);
    expect(await bookingFor(env.DB, b.id, "discovery")).toMatchObject({ calendarEventId: "ev2", meetUrl: null });
  });

  it("bookingFor is the confirmed booking of that kind, or null", async () => {
    const b = await seedBusiness();
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
    const made = (await insertBookingIfFree(env.DB, input(b.id, at("17:00"))))!;
    expect((await bookingFor(env.DB, b.id, "discovery"))!.id).toBe(made.id);
    expect(await bookingFor(env.DB, b.id, "recommendation")).toBeNull();
    await cancelBooking(env.DB, made.id, new Date());
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
  });

  it("getBookingByCancelToken needs the right lead and the right token", async () => {
    const [x, y] = [await seedBusiness({ name: "X Co" }), await seedBusiness({ name: "Y Co" })];
    const made = (await insertBookingIfFree(env.DB, input(x.id, at("17:00"))))!;
    expect((await getBookingByCancelToken(env.DB, x.id, made.cancelToken))!.id).toBe(made.id);
    expect(await getBookingByCancelToken(env.DB, y.id, made.cancelToken)).toBeNull();
    expect(await getBookingByCancelToken(env.DB, x.id, "x".repeat(43))).toBeNull();
  });

  it("upcomingBookings lists confirmed bookings in the range, soonest first, with the lead's name", async () => {
    const [x, y, z] = [await seedBusiness({ name: "X Co" }), await seedBusiness({ name: "Y Co" }), await seedBusiness({ name: "Z Co" })];
    const later = (await insertBookingIfFree(env.DB, input(x.id, at("19:00"))))!;
    const sooner = (await insertBookingIfFree(env.DB, input(y.id, at("17:00"))))!;
    const gone = (await insertBookingIfFree(env.DB, input(z.id, at("18:00"))))!;
    await cancelBooking(env.DB, gone.id, new Date());
    const out: (Booking & { businessName: string })[] = await upcomingBookings(env.DB, new Date(at("16:00")), new Date(at("23:00")));
    expect(out.map((b) => [b.id, b.businessName])).toEqual([[sooner.id, "Y Co"], [later.id, "X Co"]]);
    expect(await upcomingBookings(env.DB, new Date(at("17:30")), new Date(at("18:30")))).toEqual([]); // 17:00 started earlier, 19:00 is later
  });

  it("deleting a lead deletes its bookings", async () => {
    const b = await seedBusiness();
    await insertBookingIfFree(env.DB, input(b.id, at("17:00")));
    await deleteBusiness(env.DB, b.id);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings`).first<{ n: number }>())!.n).toBe(0);
  });
});
