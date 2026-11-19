import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import worker from "../src/worker/index";
import { setBookingDeps } from "../src/worker/booking/deps";
import { insertBookingIfFree } from "../src/worker/db/bookings";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { revokeReports } from "../src/worker/db/reports";
import { saveSettings } from "../src/worker/db/settings";
import { SLOT, WEEKDAY_WINDOWS, bookingOn, connectGoogle, fakeGoogle, form, googleEnv, resetBookingTables, seedLead, setBookingConfig } from "./fixtures/booking";

let google = fakeGoogle();
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
/** The Worker with a Google OAuth client configured (the test env has none), and no cookie: this is what a prospect's browser sends. */
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x${path}`, init), googleEnv(), ctx);
const get = (token: string) => call(`/api/public/report/${token}/book`);
const post = (token: string, body: unknown, path = "book") => call(`/api/public/report/${token}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(async () => {
  await resetBookingTables();
  google = fakeGoogle();
  setBookingDeps({ fetch: google.f });
  await bookingOn();
});
afterEach(() => setBookingDeps(null));

describe("GET /report/:token/book", () => {
  it("returns the booking page payload: slots, the form's options, and nothing else", async () => {
    await saveSettings(env.DB, { booking_url: "https://cal.example.com/me" });
    const { token } = await seedLead();
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await res.json<any>();
    expect(Object.keys(body).sort()).toEqual(["budgetOptions", "enabled", "existing", "fallbackUrl", "slots", "timelineOptions", "tz"]);
    expect(body).toMatchObject({ enabled: true, fallbackUrl: "https://cal.example.com/me", tz: "America/Los_Angeles", existing: null,
      timelineOptions: ["This month", "In 1–3 months", "Just exploring"] });
    expect(body.budgetOptions).toEqual([{ id: "797-1999", label: "$797–$1,999" }, { id: "2000-4999", label: "$2,000–$4,999" }, { id: "5000-plus", label: "$5,000+" }]);
    expect(body.slots.length).toBeGreaterThan(10);
    expect([...body.slots].sort()).toEqual(body.slots);
    for (const s of body.slots) expect(s).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(google.calls.filter((c) => c.url.endsWith("/freeBusy"))).toHaveLength(1); // fresh free/busy for this request
  });

  it("a slot that is busy on the calendar is not offered", async () => {
    const { token } = await seedLead();
    const all = (await (await get(token)).json<any>()).slots as string[];
    const taken = all[3];
    google = fakeGoogle({ busy: [{ start: taken, end: new Date(Date.parse(taken) + 20 * 60_000).toISOString() }] });
    setBookingDeps({ fetch: google.f });
    const slots = (await (await get(token)).json<any>()).slots as string[];
    expect(slots).not.toContain(taken);
    expect(slots.length).toBeLessThan(all.length);
  });

  it("is switched off, with no slots and no call to Google, without windows or without Google", async () => {
    await saveSettings(env.DB, { booking_url: "https://cal.example.com/me" });
    const { token } = await seedLead();
    await setBookingConfig({ windows: [] });
    expect(await (await get(token)).json<any>()).toMatchObject({ enabled: false, slots: [], fallbackUrl: "https://cal.example.com/me" });
    await setBookingConfig({ windows: WEEKDAY_WINDOWS });
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect(await (await get(token)).json<any>()).toMatchObject({ enabled: false, slots: [] });
    expect(google.calls).toHaveLength(0);
  });

  it("is a 503 with the fallback when free/busy fails: never offered as free", async () => {
    await saveSettings(env.DB, { booking_url: "https://cal.example.com/me" });
    google = fakeGoogle({ freeBusyErrors: true });
    setBookingDeps({ fetch: google.f });
    const { token } = await seedLead();
    const res = await get(token);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not available", fallbackUrl: "https://cal.example.com/me" });
  });

  it("the page payload never includes another lead's data", async () => {
    const [a, other] = [await seedLead("Ace Plumbing"), await seedLead("Zed Heating")];
    const booked = (await insertBookingIfFree(env.DB, { businessId: other.b.id, dealId: null, kind: "discovery", startAt: SLOT, endAt: "2026-11-24T18:20:00.000Z",
      contactName: "Zed Person", contactEmail: "zed@heating.test", contactPhone: "555-0199", answers: { topic: "SECRET-TOPIC", budgetId: "797-1999", timeline: "This month", decisionMaker: "me" }, source: "visitor" }))!;
    const text = await (await get(a.token)).text();
    for (const s of ["Zed", "zed@heating.test", "555-0199", "SECRET-TOPIC", booked.cancelToken, booked.id, other.b.id, other.token]) expect(text).not.toContain(s);
    expect(JSON.parse(text).existing).toBeNull();
    // The lead that has booked sees its own start and kind, and still no names, emails, answers or tokens.
    const own = await (await get(other.token)).text();
    expect(JSON.parse(own).existing).toEqual({ start: SLOT, kind: "discovery" });
    for (const s of ["Zed Person", "zed@heating.test", "555-0199", "SECRET-TOPIC", booked.cancelToken, booked.id]) expect(own).not.toContain(s);
  });
});

describe("POST /report/:token/book", () => {
  it("books the first offered slot and answers with the times, the Meet link and the cancel token, nothing typed", async () => {
    const { b, token } = await seedLead();
    const slot = (await (await get(token)).json<any>()).slots[0] as string;
    const res = await post(token, form({ start: slot, name: "Pat <b>Jones</b>", topic: "TYPED-TOPIC" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body)).toEqual(["booking"]);
    expect(Object.keys(body.booking).sort()).toEqual(["cancelToken", "end", "meetUrl", "start"]);
    expect(body.booking).toMatchObject({ start: slot, meetUrl: "https://meet.google.com/abc-defg-h1" });
    expect(body.booking.cancelToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const s of ["TYPED-TOPIC", "Pat", "pat@acme.test", "208-555-0100", b.id]) expect(text).not.toContain(s);
    // The page now shows it as the lead's existing booking, and a second try is refused.
    expect((await (await get(token)).json<any>()).existing).toEqual({ start: slot, kind: "discovery" });
    expect((await post(token, form({ start: slot }))).status).toBe(409);
  });

  it("the cancel link works once with the right token and is a harmless { ok: false } with the wrong one", async () => {
    const { token } = await seedLead();
    const slot = (await (await get(token)).json<any>()).slots[0] as string;
    const { booking } = await (await post(token, form({ start: slot }))).json<any>();
    const wrong = await post(token, { cancelToken: "x".repeat(43) }, "book/cancel");
    expect([wrong.status, await wrong.json()]).toEqual([200, { ok: false }]);
    expect((await (await get(token)).json<any>()).existing).not.toBeNull();
    const right = await post(token, { cancelToken: booking.cancelToken }, "book/cancel");
    expect([right.status, await right.json()]).toEqual([200, { ok: true }]);
    expect((await post(token, { cancelToken: booking.cancelToken }, "book/cancel")).status).toBe(200);
    expect(google.deleted()).toHaveLength(1);
    expect((await (await get(token)).json<any>()).existing).toBeNull();
    expect((await post(token, { nope: 1 }, "book/cancel")).status).toBe(400);
  });

  it("the cancel link still works through the route after the report link has expired", async () => {
    const { token } = await seedLead();
    const slot = (await (await get(token)).json<any>()).slots[0] as string;
    const { booking } = await (await post(token, form({ start: slot }))).json<any>();
    await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token = ?`).bind("2020-01-01T00:00:00.000Z", token).run();
    expect((await get(token)).status).toBe(404); // the page is gone ...
    const res = await post(token, { cancelToken: booking.cancelToken }, "book/cancel"); // ... the cancel is not
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(google.deleted()).toHaveLength(1);
  });

  it("rejects a bad body with a 400 that does not echo what was typed", async () => {
    const { token } = await seedLead();
    for (const body of ["{not json", "", "[]", JSON.stringify(form({ name: "" })), JSON.stringify(form({ email: "ECHO-ME" })), JSON.stringify({ ...form(), extra: "x" })]) {
      const res = await post(token, body);
      expect(res.status, body).toBe(400);
      expect(await res.text()).not.toContain("ECHO-ME");
    }
    expect(google.created()).toHaveLength(0);
  });

  it("an over-sized body is a 413", async () => {
    const { token } = await seedLead();
    const big = JSON.stringify(form({ topic: "x".repeat(9000) }));
    expect(big.length).toBeGreaterThan(8 * 1024);
    expect((await post(token, big)).status).toBe(413);
    expect((await call(`/api/public/report/${token}/book`, { method: "POST", headers: { "content-length": String(big.length) }, body: big })).status).toBe(413);
    expect((await post(token, "x".repeat(9000), "book/cancel")).status).toBe(413);
    // Just under the cap still reads (and then fails validation on its own terms, not as a 413).
    const under = JSON.stringify({ ...form(), topic: "x".repeat(400), pad: "y".repeat(7000) });
    expect(under.length).toBeLessThan(8 * 1024);
    expect((await post(token, under)).status).toBe(400);
    expect(await (await get(token)).json()).toMatchObject({ enabled: true });
  });

  it("an unknown, revoked or expired token and a do-not-contact or won lead all get the same 404 body", async () => {
    const make = async (name: string) => seedLead(name);
    const revoked = await make("Revoked Co"); await revokeReports(env.DB, revoked.b.id);
    const dnc = await make("Dnc Co"); await addDoNotContact(env.DB, { kind: "email", value: "pat@acme.test", reason: "opt_out" });
    const won = await make("Won Co"); await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(won.b.id).run();
    const expired = await make("Expired Co"); await env.DB.prepare(`UPDATE audit_reports SET expires_at = ? WHERE token = ?`).bind("2020-01-01T00:00:00.000Z", expired.token).run();
    const tokens = ["U".repeat(43), revoked.token, expired.token, won.token, dnc.token];
    const posted: string[] = [];
    for (const t of tokens) {
      const res = await post(t, form());
      expect(res.status, t).toBe(404);
      posted.push(await res.text());
    }
    expect(new Set(posted)).toEqual(new Set([JSON.stringify({ error: "not found" })]));
    // The page itself: the same for a token that is gone or a lead that may not be contacted. (The do-not-contact entry here is by email, which
    // only the POST knows, so the GET check is on the won lead and the dead tokens.)
    const pages: string[] = [];
    for (const t of ["U".repeat(43), revoked.token, expired.token, won.token]) { const res = await get(t); expect(res.status, t).toBe(404); pages.push(await res.text()); }
    expect(new Set(pages)).toEqual(new Set([JSON.stringify({ error: "not found" })]));
    expect(google.created()).toHaveLength(0);
  });

  it("GET and POST for a malformed token never touch the database", async () => {
    const orig = env.DB.prepare.bind(env.DB);
    let queries = 0;
    (env.DB as any).prepare = (q: string) => { queries++; return orig(q); };
    try {
      for (const t of ["a".repeat(65), "a".repeat(44), "A".repeat(42), "bad.token", "bad%20token", "%E2%9C%93"]) {
        expect((await get(t)).status, t).toBe(404);
        expect((await post(t, form())).status, t).toBe(404);
        expect((await post(t, { cancelToken: "x".repeat(43) }, "book/cancel")).status, t).toBe(404);
      }
      expect(queries).toBe(0);
    } finally { (env.DB as any).prepare = orig; }
    expect(google.calls).toHaveLength(0);
  });

  it("is unauthenticated for its own three requests only", async () => {
    const t = "T".repeat(43);
    expect((await SELF.fetch(`https://x/api/public/report/${t}/book`)).status).toBe(404); // reaches the route (and finds no such link)
    expect((await SELF.fetch(`https://x/api/public/report/${t}/book`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await SELF.fetch(`https://x/api/public/report/${t}/book/cancel`, { method: "POST", body: "{}" })).status).toBe(400);
    // Anything else under it needs a session.
    expect((await SELF.fetch(`https://x/api/public/report/${t}/book/cancel`)).status).toBe(401);
    expect((await SELF.fetch(`https://x/api/public/report/${t}/book/other`)).status).toBe(401);
    expect((await SELF.fetch(`https://x/api/public/report/${t}/book/cancel/more`, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("GET /api/bookings (the owner's list)", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });

  it("needs a session", async () => {
    expect((await SELF.fetch("https://x/api/bookings")).status).toBe(401);
  });

  it("lists a lead's upcoming call with the answers as typed and the budget as the guest saw it", async () => {
    const [x, y] = [await seedLead("X Co"), await seedLead("Y Co")];
    const slot = (await (await get(x.token)).json<any>()).slots[0] as string;
    expect((await post(x.token, form({ start: slot, topic: "<script>alert(1)</script>" }))).status).toBe(201);
    const mine = await (await SELF.fetch(`https://x/api/bookings?lead=${x.b.id}`, { headers: { cookie } })).json<any[]>();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ businessId: x.b.id, businessName: "X Co", startAt: slot, contactEmail: "pat@acme.test", budgetLabel: "$797–$1,999", answers: { topic: "<script>alert(1)</script>" } });
    expect(await (await SELF.fetch(`https://x/api/bookings?lead=${y.b.id}`, { headers: { cookie } })).json()).toEqual([]);
    expect((await (await SELF.fetch("https://x/api/bookings", { headers: { cookie } })).json<any[]>()).length).toBeGreaterThanOrEqual(1);
  });
});
