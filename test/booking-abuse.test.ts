import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../src/worker/index";
import { setBookingDeps } from "../src/worker/booking/deps";
import { BookingFormSchema, MAX_BOOKINGS_PER_DAY, createVisitorBooking } from "../src/worker/booking/create";
import { bookingFor, cancelBooking, insertBookingIfFree } from "../src/worker/db/bookings";
import { setMailDeps } from "../src/worker/mail/deps";
import { NOW, SLOT, SLOT_2, bookingOn, fakeGoogle, form, googleEnv, resetBookingTables, seedLead } from "./fixtures/booking";

const e = googleEnv();
let google = fakeGoogle();
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const HOUR = 3_600_000;

beforeEach(async () => {
  await resetBookingTables();
  google = fakeGoogle();
  setBookingDeps({ fetch: google.f });
  setMailDeps({ smtp: async () => {}, now: () => NOW });
  await bookingOn();
});
afterEach(() => { setBookingDeps(null); setMailDeps(null); });

/** Real rows: `n` discovery bookings for the lead, each made at `madeAt` and then cancelled (so the next can be made), at distinct times. */
async function history(businessId: string, n: number, madeAt: Date) {
  for (let i = 0; i < n; i++) {
    const start = new Date(Date.parse("2026-12-01T18:00:00.000Z") + i * 86_400_000).toISOString();
    const row = (await insertBookingIfFree(env.DB, { businessId, dealId: null, kind: "discovery", startAt: start, endAt: new Date(Date.parse(start) + 20 * 60_000).toISOString(),
      contactName: "Pat", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "visitor", createdAt: madeAt.toISOString() }))!;
    expect(row).not.toBeNull();
    await cancelBooking(env.DB, row.id, madeAt);
  }
}

describe("the per-lead cap on guest bookings", () => {
  it("refuses with a 429 when the lead already has three bookings of any status made in the last 24 hours", async () => {
    expect(MAX_BOOKINGS_PER_DAY).toBe(3);
    const { b, token } = await seedLead();
    await history(b.id, 3, new Date(NOW.getTime() - 2 * HOUR));
    const r = await createVisitorBooking(e, token, form(), NOW);
    expect(r).toEqual({ ok: false, status: 429, error: "too many attempts, reply to the email", });
    expect(google.created()).toHaveLength(0); // refused before any calendar work
    expect(google.calls).toHaveLength(0);
    expect(await bookingFor(env.DB, b.id, "discovery")).toBeNull();
  });

  it("counts every status: a confirmed, a held and a no-show booking count like a cancelled one", async () => {
    const { b, token } = await seedLead();
    await history(b.id, 2, new Date(NOW.getTime() - HOUR));
    const third = (await insertBookingIfFree(env.DB, { businessId: b.id, dealId: null, kind: "recommendation", startAt: "2026-12-10T18:00:00.000Z", endAt: "2026-12-10T18:30:00.000Z",
      contactName: "Pat", contactEmail: "pat@acme.test", contactPhone: null, answers: null, source: "logan", createdAt: new Date(NOW.getTime() - HOUR).toISOString() }))!;
    await env.DB.prepare(`UPDATE bookings SET status = 'held' WHERE id = ?`).bind(third.id).run();
    expect(await createVisitorBooking(e, token, form(), NOW)).toMatchObject({ ok: false, status: 429 });
  });

  it("two bookings in the day are fine, and so are three that were made more than 24 hours ago", async () => {
    const a = await seedLead("Ace Plumbing");
    await history(a.b.id, 2, new Date(NOW.getTime() - HOUR));
    expect((await createVisitorBooking(e, a.token, form(), NOW)).ok).toBe(true);
    const old = await seedLead("Old Habits Co");
    await history(old.b.id, 3, new Date(NOW.getTime() - 25 * HOUR));
    expect((await createVisitorBooking(e, old.token, form({ email: "old@acme.test", start: SLOT_2 }), NOW)).ok).toBe(true);
  });

  it("another lead's bookings never count", async () => {
    const [x, y] = [await seedLead("X Co"), await seedLead("Y Co")];
    await history(x.b.id, 3, new Date(NOW.getTime() - HOUR));
    expect((await createVisitorBooking(e, y.token, form({ email: "y@acme.test" }), NOW)).ok).toBe(true);
  });

  it("through the public route it is a 429 with the same generic copy", async () => {
    const { b, token } = await seedLead();
    await history(b.id, 3, new Date(Date.now() - HOUR));
    const res = await worker.fetch(new Request(`https://x/api/public/report/${token}/book`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form()) }), e, ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "too many attempts, reply to the email" });
  });
});

describe("the name on the booking form", () => {
  const good = { name: "Pat", email: "pat@acme.test", topic: "Site", budgetId: "a", timeline: "b", decisionMaker: "me", start: SLOT };
  const parse = (name: string) => BookingFormSchema.safeParse({ ...good, name });

  it("rejects an address, a link, an email or a colon", () => {
    for (const bad of ["http://evil.example/x", "https://evil.example", "ftp://x", "see www.evil.example", "WWW.evil.example", "pat@evil.example", "@pat", "Pat: click here", "javascript:alert(1)", "mailto:a@b.co", "a://b"]) {
      expect(parse(bad).success, bad).toBe(false);
    }
  });

  it("keeps an ordinary name, with its apostrophes, hyphens, dots and accents", () => {
    for (const ok of ["Pat Jones", "Mary-Jane O'Neil", "Dr. José Núñez", "李 雷", "Pat & Sam"]) expect(parse(ok).success, ok).toBe(true);
  });

  it("strips control characters and collapses whitespace", () => {
    expect(BookingFormSchema.parse({ ...good, name: "  Pat\u0000\u0007 \n\t Jones" }).name).toBe("Pat Jones");
    expect(BookingFormSchema.parse({ ...good, name: "Pat\u0085Jones\u2028Smith" }).name).toBe("Pat Jones Smith");
    expect(parse("\u0000\u0001\u0002").success).toBe(false); // nothing left is an empty name
  });

  it("is a 422 through the route naming only the field, and never echoes what was typed", async () => {
    const { token } = await seedLead();
    for (const name of ["http://evil.example/ECHO-ME", "ECHO-ME@evil.example", "www.ECHO-ME.example", "ECHO-ME: now"]) {
      const res = await worker.fetch(new Request(`https://x/api/public/report/${token}/book`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form({ name })) }), e, ctx);
      expect(res.status, name).toBe(422);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "invalid body", fields: ["name"] });
      expect(text).not.toContain("ECHO-ME");
    }
    expect(google.calls).toHaveLength(0);
  });

  it("an empty name stays a 400 (the shape is wrong, not the content)", async () => {
    const { token } = await seedLead();
    const res = await worker.fetch(new Request(`https://x/api/public/report/${token}/book`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form({ name: "" })) }), e, ctx);
    expect(res.status).toBe(400);
  });
});

describe("the BOOKING_LIMITER", () => {
  const limiter = (success: boolean) => {
    const keys: string[] = [];
    return { keys, binding: { limit: async (o: { key: string }) => { keys.push(o.key); return { success }; } } as unknown as RateLimit };
  };
  const call = (token: string, path: string, init: RequestInit = {}, binding?: RateLimit) =>
    worker.fetch(new Request(`https://x/api/public/report/${token}${path}`, init), { ...e, BOOKING_LIMITER: binding } as typeof e, ctx);
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(body) });

  it("answers 429 { error: 'too many requests' } and nothing else on every booking route when the limiter says no", async () => {
    const { token } = await seedLead();
    const l = limiter(false);
    for (const [path, init] of [["/book", { headers: { "cf-connecting-ip": "203.0.113.9" } }], ["/book", json(form())], ["/book/cancel", json({ cancelToken: "x".repeat(43) })]] as [string, RequestInit][]) {
      const res = await call(token, path, init, l.binding);
      expect(res.status, path).toBe(429);
      expect(await res.text()).toBe(JSON.stringify({ error: "too many requests" }));
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(google.calls).toHaveLength(0); // nothing behind the limiter ran
    expect(l.keys).toEqual([`${token}:203.0.113.9`, `${token}:203.0.113.9`, `${token}:203.0.113.9`]); // the link and the client IP
  });

  it("lets the request through when the limiter says yes, and when there is no binding (local and test runs)", async () => {
    const { token } = await seedLead();
    const ok = limiter(true);
    expect((await call(token, "/book", { headers: { "cf-connecting-ip": "203.0.113.9" } }, ok.binding)).status).toBe(200);
    expect(ok.keys).toHaveLength(1);
    expect((await call(token, "/book")).status).toBe(200);
  });

  it("keys on the link and the IP, so another link or another address is counted apart", async () => {
    const [a, b] = [await seedLead("A Co"), await seedLead("B Co")];
    const l = limiter(true);
    await call(a.token, "/book", { headers: { "cf-connecting-ip": "1.1.1.1" } }, l.binding);
    await call(a.token, "/book", { headers: { "cf-connecting-ip": "2.2.2.2" } }, l.binding);
    await call(b.token, "/book", { headers: { "cf-connecting-ip": "1.1.1.1" } }, l.binding);
    await call(a.token, "/book", {}, l.binding);
    expect(l.keys).toEqual([`${a.token}:1.1.1.1`, `${a.token}:2.2.2.2`, `${b.token}:1.1.1.1`, `${a.token}:unknown`]);
  });

  it("does not limit the report page itself or the watch beacon, and does not count a malformed link", async () => {
    const { token } = await seedLead();
    const l = limiter(false);
    expect((await call(token, "", {}, l.binding)).status).toBe(200);
    expect((await call(token, "/events", { method: "POST", body: "{}" }, l.binding)).status).toBe(204);
    expect((await call("bad", "/book", {}, l.binding)).status).toBe(404);
    expect(l.keys).toEqual([]);
  });
});

describe("a discovery call that was already held is not booked a second time from the guest page", () => {
  async function heldLead() {
    const lead = await seedLead();
    const r = await createVisitorBooking(e, lead.token, form(), NOW);
    if (!r.ok) throw new Error(r.error);
    await env.DB.prepare(`UPDATE bookings SET status = 'held' WHERE id = ?`).bind(r.booking.id).run();
    google = fakeGoogle();
    setBookingDeps({ fetch: google.f });
    return { ...lead, held: r.booking };
  }
  const page = (token: string) => worker.fetch(new Request(`https://x/api/public/report/${token}/book`), e, ctx);

  it("the page offers no times and shows no existing call", async () => {
    const { token } = await heldLead();
    const body = await (await page(token)).json<any>();
    expect(body).toMatchObject({ enabled: true, slots: [], existing: null });
    expect(google.calls.filter((c) => c.url.endsWith("/freeBusy"))).toHaveLength(0);
  });

  it("a booking is a 409 and creates nothing: no event, no row, no second call prep", async () => {
    const { b, token } = await heldLead();
    const before = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE business_id = ?`).bind(b.id).first<{ n: number }>())!.n;
    const tasksBefore = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks WHERE kind = 'call.prep'`).first<{ n: number }>())!.n;
    const r = await createVisitorBooking(e, token, form({ start: SLOT_2 }), NOW);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(google.created()).toHaveLength(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE business_id = ?`).bind(b.id).first<{ n: number }>())!.n).toBe(before);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM claude_tasks WHERE kind = 'call.prep'`).first<{ n: number }>())!.n).toBe(tasksBefore);
  });

  it("a no-show can book again (the call never happened)", async () => {
    const { b, token, held } = await heldLead();
    await env.DB.prepare(`UPDATE bookings SET status = 'no_show' WHERE id = ?`).bind(held.id).run();
    expect((await createVisitorBooking(e, token, form({ start: SLOT_2 }), NOW)).ok).toBe(true);
    expect((await bookingFor(env.DB, b.id, "discovery"))!.startAt).toBe(SLOT_2);
  });
});
