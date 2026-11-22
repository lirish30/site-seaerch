import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "../src/worker/auth";

describe("session tokens", () => {
  it("verifies own token, rejects tampered or expired", async () => {
    const t = await signSession("s", 2000);
    expect(await verifySession("s", t, 1000)).toBe(true);
    expect(await verifySession("s", t, 3000)).toBe(false);
    expect(await verifySession("other", t, 1000)).toBe(false);
    expect(await verifySession("s", t.replace(/^\d+/, "9999"), 1000)).toBe(false);
  });
});

describe("auth routes", () => {
  it("blocks /api/me without cookie", async () => {
    expect((await SELF.fetch("https://x/api/me")).status).toBe(401);
  });

  it("wrong password 401, right password sets cookie that unlocks /api/me", async () => {
    const bad = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    const ok = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    const me = await SELF.fetch("https://x/api/me", { headers: { cookie: cookie.split(";")[0] } });
    expect(me.status).toBe(200);
  });

  it.each([
    ["null JSON", "null"],
    ["array JSON", "[]"],
    ["number password", JSON.stringify({ password: 12345 })],
    ["object password", JSON.stringify({ password: { toString: "test-pass" } })],
    ["array password", JSON.stringify({ password: ["test-pass"] })],
    ["malformed JSON", "{"],
  ])("%s body → 401, not 500", async (_n, body) => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body, headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0.1" } });
    expect(r.status).toBe(401);
  });

  it("throttles repeated login attempts per client IP with 429", async () => {
    const attempt = (ip: string) => SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }),
      headers: { "content-type": "application/json", "cf-connecting-ip": ip } });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt("203.0.113.9")).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    const limited = await attempt("203.0.113.9");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "too many attempts" });
    expect((await attempt("203.0.113.10")).status).toBe(401);
  });

  it("health stays public", async () => {
    expect((await SELF.fetch("https://x/api/health")).status).toBe(200);
  });

  it.each(["/api/leads", "/api/settings", "/api/searches", "/api/publicx", "/api/public/", "/api/public", "/api/public/other/x",
    "/api/public/report", "/api/public/report/", "/api/public/report/abc/def", "/api/public/report/%2e%2e/leads",
    `/api/public/report/${"A".repeat(43)}/x`, `/api/public/report/${"A".repeat(43)}/media`,
    `/api/public/report/${"A".repeat(43)}/media/video.mp4/x`, "/api/public/report//media/video.mp4",
    `/api/public/report/${"A".repeat(43)}/events`, `/api/public/report/${"A".repeat(43)}/events/`])("%s stays protected without a cookie", async (p) => {
    expect((await SELF.fetch(`https://x${p}`)).status).toBe(401);
  });

  it("an encoded-slash token segment reaches the public route and is just a malformed token (404)", async () => {
    const r = await SELF.fetch("https://x/api/public/report/..%2fleads");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });

  it("public report route needs no cookie (404 for an unknown token, not 401)", async () => {
    const r = await SELF.fetch(`https://x/api/public/report/${"abcDEF123_-".padEnd(43, "x")}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });

  describe("a client's Local SEO report (GET /api/public/l/<token>)", () => {
    const T = "abcDEF123_-".padEnd(43, "x");
    it("needs no cookie to read: an unknown token is a 404, not a 401", async () => {
      const r = await SELF.fetch(`https://x/api/public/l/${T}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
    });
    it.each(["/api/public/l", "/api/public/l/", `/api/public/l/${"A".repeat(43)}/`, `/api/public/l/${"A".repeat(43)}/x`, "/api/public/l//x", "/api/public/lx/abc", "/api/public/L/abc", "/api/public/l/a/b/c"])("GET %s stays protected without a cookie", async (p) => {
      expect((await SELF.fetch(`https://x${p}`)).status).toBe(401);
    });
    it.each(["POST", "PUT", "DELETE", "PATCH"])("%s on it stays protected", async (m) => {
      expect((await SELF.fetch(`https://x/api/public/l/${T}`, { method: m, body: "{}" })).status).toBe(401);
    });
  });

  describe("a client's strategy memo (GET /api/public/y/<token>)", () => {
    const T = "abcDEF123_-".padEnd(43, "x");
    it("needs no cookie to read: an unknown token is a 404, not a 401", async () => {
      const r = await SELF.fetch(`https://x/api/public/y/${T}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
    });
    it.each(["/api/public/y", "/api/public/y/", `/api/public/y/${"A".repeat(43)}/`, `/api/public/y/${"A".repeat(43)}/x`, "/api/public/y//x", "/api/public/yx/abc", "/api/public/Y/abc", "/api/public/y/a/b/c"])("GET %s stays protected without a cookie", async (p) => {
      expect((await SELF.fetch(`https://x${p}`)).status).toBe(401);
    });
    it.each(["POST", "PUT", "DELETE", "PATCH"])("%s on it stays protected", async (m) => {
      expect((await SELF.fetch(`https://x/api/public/y/${T}`, { method: m, body: "{}" })).status).toBe(401);
    });
  });

  describe.each([["Care", "m"], ["Local SEO", "l"]])("a client's %s report video (GET /api/public/<m or l>/<token>/video.mp4)", (name, letter) => {
    const T = "abcDEF123_-".padEnd(43, "x");
    it(`needs no cookie to read the ${name} report's video: an unknown token is a 404, not a 401`, async () => {
      const r = await SELF.fetch(`https://x/api/public/${letter}/${T}/video.mp4`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
    });
    it.each([
      (l: string) => `/api/public/${l}/${"A".repeat(43)}/video.mp4/`,
      (l: string) => `/api/public/${l}/${"A".repeat(43)}/video.mp4/x`,
      (l: string) => `/api/public/${l}/${"A".repeat(43)}/video.mp4x`,
      (l: string) => `/api/public/${l}/${"A".repeat(43)}/Video.mp4`,
      (l: string) => `/api/public/${l}/${"A".repeat(43)}/video`,
      (l: string) => `/api/public/${l}/${"A".repeat(43)}/poster.jpg`,
      (l: string) => `/api/public/${l}//video.mp4`,
      (l: string) => `/api/public/${l}/a/b/video.mp4`,
      (l: string) => `/api/public/${l}x/${"A".repeat(43)}/video.mp4`,
      (l: string) => `/api/public/${l.toUpperCase()}/${"A".repeat(43)}/video.mp4`,
    ])("GET %s stays protected without a cookie", async (path) => {
      expect((await SELF.fetch(`https://x${path(letter)}`)).status).toBe(401);
    });
    it.each(["POST", "PUT", "DELETE", "PATCH"])("%s on it stays protected", async (m) => {
      expect((await SELF.fetch(`https://x/api/public/${letter}/${T}/video.mp4`, { method: m, body: "{}" })).status).toBe(401);
    });
  });

  it("the three video files need no cookie (404 for an unknown token, not 401)", async () => {
    for (const n of ["video.mp4", "poster.jpg", "preview.gif"]) expect((await SELF.fetch(`https://x/api/public/report/${"abcDEF123_-".padEnd(43, "x")}/media/${n}`)).status).toBe(404);
  });

  describe("the watch beacon (POST <token>/events)", () => {
    const T = "abcDEF123_-".padEnd(43, "x");
    const send = (path: string, method = "POST") => SELF.fetch(`https://x/api/public/report/${path}`, { method, body: ["GET", "HEAD", "OPTIONS"].includes(method) ? undefined : "{}" });

    it("needs no cookie: an unknown token still gets 204, not 401", async () => {
      const r = await send(`${T}/events`);
      expect(r.status).toBe(204);
      expect(await r.text()).toBe("");
    });

    it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])("%s on it stays protected", async (m) => {
      expect((await send(`${T}/events`, m)).status).toBe(401);
    });

    it.each([`${T}/events/`, `${T}/events/x`, `${T}/events/media/video.mp4`, `${T}/event`, `${T}/eventsx`, `${T}/Events`, `${T}/x/events`,
      `${T}/media/video.mp4/events`, `${T}/events/..`, `${T}/events/../x`, `${T}//events`, `${T}/events%2fx`, "events/", "events/x"])("POST %s stays protected", async (p) => {
      expect((await send(p)).status).toBe(401);
    });

    it("a single segment is just a malformed token for the public router, never the beacon", async () => {
      for (const p of ["events", "..%2fleads", `${T}%2fevents`]) expect((await send(p)).status).toBe(404);
    });

    it("an empty token segment stays protected", async () => {
      expect((await SELF.fetch("https://x/api/public/report//events", { method: "POST", body: "{}" })).status).toBe(401);
    });

    it("an encoded slash inside the token segment is one segment: the beacon, which stores nothing for it", async () => {
      expect((await send("..%2fleads/events")).status).toBe(204);
      expect((await send("%2e%2e/events")).status).toBe(401); // the URL parser makes this /api/public/events, which is not a report route
    });

    it("opens nothing else: the other API paths still need the login", async () => {
      for (const p of ["/api/leads", "/api/video-audits/watched", "/api/public/events", `/api/public/report/${T}/events/x`]) {
        expect((await SELF.fetch(`https://x${p}`, { method: "POST", body: "{}" })).status).toBe(401);
      }
    });
  });
});
