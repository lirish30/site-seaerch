import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { signSession } from "../src/worker/auth";
import { deleteBusiness } from "../src/worker/db/businesses";
import { setVideoStatus } from "../src/worker/db/videoAudits";
import { createReport, revokeReports } from "../src/worker/db/reports";
import { saveSettings } from "../src/worker/db/settings";
import { recordEvent, watchedFor, watchedLeads } from "../src/worker/video/views";
import { renderedVideo } from "./fixtures/video";

let cookie = "";
const api = (path: string) => SELF.fetch(`https://x${path}`, { headers: { cookie } });
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => { await saveSettings(env.DB, { booking_url: "", ai_voice_note: 1 }); });

type Ev = { session: string; type: string; pct?: unknown };
// The beacon: no cookie, any body.
const beacon = (token: string, body: unknown) =>
  SELF.fetch(`https://x/api/public/report/${token}/events`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
const send = (token: string, e: Ev) => beacon(token, e);

const published = async (o: { name?: string } = {}) => { const t = await renderedVideo(o); await setVideoStatus(env.DB, t.v.id, "published"); return t; };
const sessions = async (token: string) => (await env.DB.prepare(`SELECT * FROM video_sessions WHERE token = ? ORDER BY first_at, session`).bind(token).all<any>()).results;
const watchLog = async (businessId: string) =>
  (await env.DB.prepare(`SELECT detail FROM activity WHERE business_id = ? AND kind = 'video_watch' ORDER BY rowid`).bind(businessId).all<{ detail: string }>()).results.map((r) => r.detail);
const sid = (i: number) => `session-${String(i).padStart(4, "0")}`;
const DAY = 86_400_000;

describe("recording watch events", () => {
  it("fetching the page or the video records nothing", async () => {
    const { token, b } = await published();
    expect((await SELF.fetch(`https://x/api/public/report/${token}`)).status).toBe(200);
    expect((await SELF.fetch(`https://x/api/public/report/${token}/media/video.mp4`)).status).toBe(200);
    expect((await SELF.fetch(`https://x/api/public/report/${token}/media/video.mp4`, { headers: { range: "bytes=0-9" } })).status).toBe(206);
    expect(await sessions(token)).toEqual([]);
    expect(await watchLog(b.id)).toEqual([]);
  });

  it("open then play then 50 logs two activity entries once each", async () => {
    const { token, b } = await published();
    const s = sid(1);
    for (const e of [{ type: "open" }, { type: "play" }, { type: "progress", pct: 25 }]) expect((await send(token, { session: s, ...e })).status).toBe(204);
    expect(await watchLog(b.id)).toEqual(["Watched the video audit"]);
    for (const e of [{ type: "progress", pct: 50 }, { type: "progress", pct: 50 }, { type: "progress", pct: 75 }, { type: "play" }]) await send(token, { session: s, ...e });
    expect(await watchLog(b.id)).toEqual(["Watched the video audit", "Watched 50% of the video"]);
    const [row] = await sessions(token);
    expect(row).toMatchObject({ session: s, opened: 1, plays: 2, max_pct: 75 });
    // A second viewer crossing the same marks adds nothing: each is logged once per link.
    for (const e of [{ type: "open" }, { type: "play" }, { type: "progress", pct: 50 }]) await send(token, { session: sid(2), ...e });
    expect(await watchLog(b.id)).toHaveLength(2);
  });

  it("90 percent and the end log one entry between them, and the end counts as 100", async () => {
    const { token, b } = await published();
    await send(token, { session: sid(1), type: "play" });
    await send(token, { session: sid(1), type: "progress", pct: 90 });
    await send(token, { session: sid(1), type: "end" });
    await send(token, { session: sid(2), type: "end" });
    expect(await watchLog(b.id)).toEqual(["Watched the video audit", "Watched 50% of the video", "Watched 90% of the video"]);
    expect((await sessions(token)).map((r) => r.max_pct)).toEqual([100, 100]);
  });

  it("an end with no earlier progress still logs the 50 and the 90", async () => {
    const { token, b } = await published();
    await send(token, { session: sid(1), type: "end" });
    expect(await watchLog(b.id)).toEqual(["Watched 50% of the video", "Watched 90% of the video"]);
  });

  it("two beacons at once do not log twice", async () => {
    const { token, b } = await published();
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => send(token, { session: sid(i), type: i % 2 ? "play" : "end" })));
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => send(token, { session: sid(i), type: "progress", pct: 95 })));
    const log = await watchLog(b.id);
    expect(log.filter((d) => d === "Watched the video audit")).toHaveLength(1);
    expect(log.filter((d) => d === "Watched 50% of the video")).toHaveLength(1);
    expect(log.filter((d) => d === "Watched 90% of the video")).toHaveLength(1);
  });

  it("max_pct never goes down", async () => {
    const { token } = await published();
    const s = sid(1);
    for (const pct of [50, 25, 90, 75, 0]) await send(token, { session: s, type: "progress", pct });
    expect((await sessions(token))[0].max_pct).toBe(90);
    await send(token, { session: s, type: "open" });
    await send(token, { session: s, type: "play" });
    expect((await sessions(token))[0].max_pct).toBe(90);
  });

  it("the 51st session in a day is ignored", async () => {
    const { token } = await published();
    const now = new Date();
    for (let i = 0; i < 50; i++) await recordEvent(env, token, { session: sid(i), type: "open" }, now);
    await recordEvent(env, token, { session: sid(50), type: "open" }, now);
    expect(await sessions(token)).toHaveLength(50);
    expect((await sessions(token)).some((r) => r.session === sid(50))).toBe(false);
    // A session that already exists is always accepted, even at the cap.
    await recordEvent(env, token, { session: sid(7), type: "progress", pct: 60 }, now);
    expect((await sessions(token)).find((r) => r.session === sid(7))!.max_pct).toBe(60);
    // The cap counts the last 24 hours: a day later a new session fits again.
    await recordEvent(env, token, { session: sid(51), type: "open" }, new Date(now.getTime() + DAY + 1000));
    expect(await sessions(token)).toHaveLength(51);
  });

  it("the cap is per link", async () => {
    const a = await published(), c = await published();
    const now = new Date();
    for (let i = 0; i < 50; i++) await recordEvent(env, a.token, { session: sid(i), type: "open" }, now);
    await recordEvent(env, c.token, { session: sid(0), type: "open" }, now);
    expect(await sessions(c.token)).toHaveLength(1);
  });

  it("unknown token returns 204 and stores nothing", async () => {
    const before = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM video_sessions`).first<{ n: number }>())!.n;
    for (const t of ["A".repeat(43), "short", "abcDEF123_-".padEnd(43, "x")]) {
      const r = await send(t, { session: sid(1), type: "play" });
      expect(r.status).toBe(204);
      expect(await r.text()).toBe("");
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM video_sessions`).first<{ n: number }>())!.n).toBe(before);
  });

  it("unpublished video returns 204 and stores nothing", async () => {
    const { token, v, b } = await renderedVideo();
    expect((await send(token, { session: sid(1), type: "play" })).status).toBe(204);
    expect(await sessions(token)).toEqual([]);
    await setVideoStatus(env.DB, v.id, "published");
    await send(token, { session: sid(1), type: "play" });
    expect(await sessions(token)).toHaveLength(1);
    await setVideoStatus(env.DB, v.id, "cancelled");
    await send(token, { session: sid(2), type: "play" });
    expect(await sessions(token)).toHaveLength(1);
    expect(await watchLog(b.id)).toEqual(["Watched the video audit"]);
  });

  it("revoked and expired links store nothing", async () => {
    const { token, b, audit, v } = await published();
    await revokeReports(env.DB, b.id);
    await send(token, { session: sid(1), type: "play" });
    const old = await createReport(env.DB, b.id, audit.id, new Date(Date.now() - 40 * DAY));
    await send(old.token, { session: sid(1), type: "play" });
    expect(await sessions(token)).toEqual([]);
    expect(await sessions(old.token)).toEqual([]);
    expect(v.status).toBe("rendered");
  });

  it("pct of 140 is ignored", async () => {
    const { token } = await published();
    const s = sid(1);
    await send(token, { session: s, type: "progress", pct: 40 });
    for (const pct of [140, 101, -1, -50, Number.NaN, "90", null, {}]) await recordEvent(env, token, { session: s, type: "progress", pct: pct as number }, new Date());
    await send(token, { session: s, type: "progress", pct: 140 });
    await beacon(token, `{"session":"${s}","type":"progress","pct":99999999999999999999}`);
    expect((await sessions(token))[0].max_pct).toBe(40);
    // An event with an out-of-range pct is dropped whole: it does not even open a session.
    await send(token, { session: sid(2), type: "progress", pct: 140 });
    expect(await sessions(token)).toHaveLength(1);
  });

  it("bad bodies are 204 and store nothing", async () => {
    const { token } = await published();
    const bodies: unknown[] = ["", "not json", "[]", "null", "42", {}, { session: sid(1) }, { type: "play" }, { session: sid(1), type: "boom" },
      { session: "", type: "play" }, { session: "has space", type: "play" }, { session: "x".repeat(65), type: "play" }, { session: 5, type: "play" },
      { session: sid(1), type: "progress" }, { session: sid(1), type: "progress", pct: 12.5 }, { session: sid(1), type: "play", extra: 1 },
      { session: sid(1), type: "play", pad: "x".repeat(300) }];
    for (const b of bodies) { const r = await beacon(token, b as string); expect(r.status).toBe(204); expect(await r.text()).toBe(""); }
    expect(await sessions(token)).toEqual([]);
  });

  it("a body of at most 200 bytes is read, a larger one is not", async () => {
    const { token } = await published();
    const base = { session: sid(1), type: "open" };
    const pad = (n: number) => JSON.stringify({ ...base }).replace("}", `${" ".repeat(n)}}`);
    const fits = pad(200 - JSON.stringify(base).length);
    expect(new TextEncoder().encode(fits).length).toBe(200);
    await beacon(token, fits);
    expect(await sessions(token)).toHaveLength(1);
    await beacon(token, pad(200 - JSON.stringify(base).length + 1).replace(sid(1), sid(2)));
    expect(await sessions(token)).toHaveLength(1);
  });

  it("a logged-in owner's views are not recorded", async () => {
    const { token, b } = await published();
    const ownerBeacon = (e: Ev) => SELF.fetch(`https://x/api/public/report/${token}/events`, { method: "POST", body: JSON.stringify(e), headers: { cookie, "content-type": "application/json" } });
    for (const e of [{ type: "open" }, { type: "play" }, { type: "progress", pct: 90 }, { type: "end" }]) {
      const r = await ownerBeacon({ session: sid(1), ...e });
      expect(r.status).toBe(204);
      expect(await r.text()).toBe("");
    }
    expect(await sessions(token)).toEqual([]);
    expect(await watchLog(b.id)).toEqual([]);
    // The same link seen by a prospect (no cookie) still counts.
    await send(token, { session: sid(2), type: "play" });
    expect(await watchLog(b.id)).toEqual(["Watched the video audit"]);
  });

  it("an invalid or expired session cookie does not block recording", async () => {
    const { token } = await published();
    const expired = await signSession(env.SESSION_SECRET, Date.now() - 1000);
    const forged = `${Date.now() + 86_400_000}.${"A".repeat(43)}`;
    let i = 0;
    for (const c of [`session=${expired}`, `session=${forged}`, "session=garbage", "session="]) {
      await SELF.fetch(`https://x/api/public/report/${token}/events`, { method: "POST", body: JSON.stringify({ session: sid(++i), type: "open" }), headers: { cookie: c, "content-type": "application/json" } });
    }
    expect(await sessions(token)).toHaveLength(4);
  });

  it("deleting a lead removes its view sessions and marks", async () => {
    const t = await published();
    const other = await published();
    for (const x of [t, other]) await send(x.token, { session: sid(1), type: "end" });
    const count = async (table: string, token: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE token = ?`).bind(token).first<{ n: number }>())!.n;
    expect(await count("video_sessions", t.token)).toBe(1);
    expect(await count("video_view_marks", t.token)).toBe(2);
    await deleteBusiness(env.DB, t.b.id);
    expect(await count("video_sessions", t.token)).toBe(0);
    expect(await count("video_view_marks", t.token)).toBe(0);
    expect(await count("video_sessions", other.token)).toBe(1);
    expect(await count("video_view_marks", other.token)).toBe(2);
  });

  it("the beacon route answers 204 with no body and is never cached or indexed", async () => {
    const { token } = await published();
    const r = await send(token, { session: sid(1), type: "open" });
    expect(r.status).toBe(204);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await SELF.fetch(`https://x/api/public/report/${token}/events`)).status).toBe(401); // only POST is public
  });
});

describe("watched leads", () => {
  const watch = (token: string, session: string, pct: number, now: Date) => recordEvent(env, token, { session, type: "progress", pct }, now);
  const status = (id: string, s: string) => env.DB.prepare(`UPDATE businesses SET lead_status = ? WHERE id = ?`).bind(s, id).run();

  it("watchedLeads excludes replied leads and sessions under 50", async () => {
    const now = new Date();
    const half = await published({ name: "Half Watched" }), low = await published({ name: "Barely Watched" });
    const replied = await published({ name: "Replied Lead" }), won = await published({ name: "Won Lead" });
    const lost = await published({ name: "Lost Lead" }), skip = await published({ name: "Skip Lead" }), archived = await published({ name: "Archived Lead" });
    for (const [t, p] of [[half, 50], [low, 49], [replied, 100], [won, 100], [lost, 100], [skip, 100], [archived, 100]] as const) await watch(t.token, sid(1), p, now);
    await status(replied.b.id, "replied"); await status(won.b.id, "won"); await status(lost.b.id, "lost"); await status(skip.b.id, "skip");
    await env.DB.prepare(`UPDATE businesses SET archived_at = ? WHERE id = ?`).bind(now.toISOString(), archived.b.id).run();
    const rows = await watchedLeads(env.DB, now);
    expect(rows.find((r) => r.businessId === low.b.id)).toBeUndefined();
    for (const t of [replied, won, lost, skip, archived]) expect(rows.find((r) => r.businessId === t.b.id)).toBeUndefined();
    expect(rows.find((r) => r.businessId === half.b.id)).toEqual({ businessId: half.b.id, name: "Half Watched", maxPct: 50, lastAt: now.toISOString() });
    // Contacted and reviewed leads still count.
    await status(half.b.id, "contacted");
    expect((await watchedLeads(env.DB, now)).some((r) => r.businessId === half.b.id)).toBe(true);
  });

  it("only the last 7 days count, newest first, one row per lead with its deepest watch", async () => {
    const base = new Date();
    const a = await published({ name: "A" }), b = await published({ name: "B" }), old = await published({ name: "Old" });
    await watch(old.token, sid(1), 80, new Date(base.getTime() - 7 * DAY - 1000));
    await watch(a.token, sid(1), 60, new Date(base.getTime() - 3 * 3_600_000));
    await watch(a.token, sid(2), 90, new Date(base.getTime() - 2 * DAY));
    await watch(b.token, sid(1), 50, new Date(base.getTime() - 3_600_000));
    const rows = (await watchedLeads(env.DB, base)).filter((r) => [a.b.id, b.b.id, old.b.id].includes(r.businessId));
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
    expect(rows[1]).toMatchObject({ maxPct: 90, lastAt: new Date(base.getTime() - 3 * 3_600_000).toISOString() });
  });

  it("returns at most 10 leads", async () => {
    const now = new Date(Date.now() + 10 * DAY); // later than anything the other tests wrote
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) { const t = await published({ name: `Bulk ${i}` }); tokens.push(t.token); await watch(t.token, sid(1), 70, new Date(now.getTime() - i * 60_000)); }
    try {
      const rows = await watchedLeads(env.DB, now);
      expect(rows).toHaveLength(10);
      expect(rows[0].name).toBe("Bulk 0");
      expect(rows[9].name).toBe("Bulk 9");
    } finally { for (const t of tokens) await env.DB.prepare(`DELETE FROM video_sessions WHERE token = ?`).bind(t).run(); }
  });

  it("watchedFor is a lead's deepest watch, nothing before any progress", async () => {
    const t = await published();
    expect(await watchedFor(env.DB, t.b.id)).toBeNull();
    await recordEvent(env, t.token, { session: sid(1), type: "play" }, new Date());
    expect(await watchedFor(env.DB, t.b.id)).toBeNull();
    await watch(t.token, sid(1), 30, new Date(Date.now() - 1000));
    await watch(t.token, sid(2), 20, new Date());
    expect(await watchedFor(env.DB, t.b.id)).toMatchObject({ maxPct: 30 });
  });

  it("GET /api/video-audits/watched needs the login and returns the list", async () => {
    const t = await published({ name: "Route Watched" });
    await watch(t.token, sid(1), 55, new Date());
    expect((await SELF.fetch("https://x/api/video-audits/watched")).status).toBe(401);
    const r = await api("/api/video-audits/watched");
    expect(r.status).toBe(200);
    const body = await r.json<{ watched: { businessId: string; name: string; maxPct: number }[] }>();
    expect(body.watched.find((w) => w.businessId === t.b.id)).toMatchObject({ name: "Route Watched", maxPct: 55 });
    expect(body.watched.length).toBeLessThanOrEqual(10);
  });

  it("the lead's video panel data carries the Watched line", async () => {
    const t = await published();
    expect((await (await api(`/api/leads/${t.b.id}/video`)).json<any>()).watched).toBeNull();
    await watch(t.token, sid(1), 75, new Date());
    expect((await (await api(`/api/leads/${t.b.id}/video`)).json<any>()).watched).toMatchObject({ maxPct: 75 });
  });
});
