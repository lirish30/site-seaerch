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

  it("health stays public", async () => {
    expect((await SELF.fetch("https://x/api/health")).status).toBe(200);
  });
});
