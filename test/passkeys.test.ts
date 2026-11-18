import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/worker/env";
import { requireAuth } from "../src/worker/auth";
import { createChallenge, consumeChallenge } from "../src/worker/passkeys";
import { createPasskeyRoutes, type PasskeyVerifier } from "../src/worker/routes/passkeys";

// The login limiter keys on client IP (10 per minute), so each request gets its own.
let n = 0;
const fresh = () => ({ "content-type": "application/json", "cf-connecting-ip": `10.7.0.${++n}` });
const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const clientData = (challenge: string, type: string) => b64(JSON.stringify({ type, challenge, origin: "https://x" }));

async function passwordCookie() {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: fresh() });
  return r.headers.get("set-cookie")!.split(";")[0]!;
}

function appWith(verify: PasskeyVerifier) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/api/*", requireAuth);
  app.route("/api/passkey", createPasskeyRoutes(verify));
  return (path: string, init?: RequestInit) => app.request(`https://x${path}`, init, env);
}

const noVerify: PasskeyVerifier = {
  registration: async () => { throw new Error("unexpected"); },
  authentication: async () => { throw new Error("unexpected"); },
};

async function seedPasskey(counter: number) {
  await env.DB.prepare("INSERT INTO passkeys (id, credential_id, public_key, counter, created_at) VALUES ('p1','cred-1','pk',?, '2026-01-01T00:00:00Z')").bind(counter).run();
}
const counterOf = async () => (await env.DB.prepare("SELECT counter, last_used_at FROM passkeys WHERE id='p1'").first<{ counter: number; last_used_at: string | null }>())!;

const loginBody = (challenge: string, id = "cred-1") => JSON.stringify({
  response: { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: clientData(challenge, "webauthn.get"), authenticatorData: "AA", signature: "AA" } },
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM passkeys");
  await env.DB.exec("DELETE FROM auth_challenges");
});

describe("passkey challenges", () => {
  it("expired or reused challenge is rejected", async () => {
    const t0 = new Date("2026-06-01T12:00:00Z");
    const c = await createChallenge(env.DB, "login", t0);
    expect(await consumeChallenge(env.DB, c, "login", t0)).toBe(true);
    expect(await consumeChallenge(env.DB, c, "login", t0)).toBe(false);

    const c2 = await createChallenge(env.DB, "login", t0);
    expect(await consumeChallenge(env.DB, c2, "login", new Date(t0.getTime() + 6 * 60_000))).toBe(false);

    const c3 = await createChallenge(env.DB, "login", t0);
    expect(await consumeChallenge(env.DB, c3, "register", t0)).toBe(false);
    expect(await consumeChallenge(env.DB, c3, "login", new Date(t0.getTime() + 4 * 60_000))).toBe(false); // wrong-purpose attempt burned it
  });
});

describe("passkey routes", () => {
  it("login options are public and store a challenge", async () => {
    const r = await SELF.fetch("https://x/api/passkey/login/options", { method: "POST", headers: fresh(), body: "{}" });
    expect(r.status).toBe(200);
    const o = (await r.json()) as { challenge: string; rpId: string };
    expect(o.rpId).toBe("x");
    const row = await env.DB.prepare("SELECT purpose FROM auth_challenges WHERE challenge=?").bind(o.challenge).first<{ purpose: string }>();
    expect(row?.purpose).toBe("login");
  });

  it("register options need a session", async () => {
    for (const [m, p] of [["POST", "/register/options"], ["POST", "/register/verify"], ["GET", ""], ["DELETE", "/p1"]] as const) {
      const r = await SELF.fetch(`https://x/api/passkey${p}`, { method: m, headers: fresh(), body: m === "POST" ? "{}" : undefined });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    const cookie = await passwordCookie();
    const ok = await SELF.fetch("https://x/api/passkey/register/options", { method: "POST", headers: { ...fresh(), cookie }, body: "{}" });
    expect(ok.status).toBe(200);
    const o = (await ok.json()) as { challenge: string };
    expect((await env.DB.prepare("SELECT purpose FROM auth_challenges WHERE challenge=?").bind(o.challenge).first<{ purpose: string }>())?.purpose).toBe("register");
  });

  it("login verify with stubbed verifier sets session cookie and bumps counter", async () => {
    await seedPasskey(5);
    const call = appWith({ ...noVerify, authentication: async () => ({ verified: true, authenticationInfo: { newCounter: 6 } }) as never });
    const challenge = await createChallenge(env.DB, "login", new Date());
    const r = await call("/api/passkey/login/verify", { method: "POST", headers: fresh(), body: loginBody(challenge) });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const me = await SELF.fetch("https://x/api/me", { headers: { cookie: cookie.split(";")[0]! } });
    expect(me.status).toBe(200);
    const row = await counterOf();
    expect(row.counter).toBe(6);
    expect(row.last_used_at).not.toBeNull();
    // the challenge is single use: replaying the same request fails
    const again = await call("/api/passkey/login/verify", { method: "POST", headers: fresh(), body: loginBody(challenge) });
    expect(again.status).toBe(401);
  });

  it("counter regression rejected", async () => {
    await seedPasskey(5);
    const call = appWith({ ...noVerify, authentication: async () => ({ verified: true, authenticationInfo: { newCounter: 5 } }) as never });
    const challenge = await createChallenge(env.DB, "login", new Date());
    const r = await call("/api/passkey/login/verify", { method: "POST", headers: fresh(), body: loginBody(challenge) });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await counterOf()).counter).toBe(5);
  });

  it("rejects unknown credentials, unverified results and unknown challenges", async () => {
    await seedPasskey(0);
    const call = appWith({ ...noVerify, authentication: async () => ({ verified: false }) as never });
    const ch = await createChallenge(env.DB, "login", new Date());
    expect((await call("/api/passkey/login/verify", { method: "POST", headers: fresh(), body: loginBody(ch, "nope") })).status).toBe(401);
    const ch2 = await createChallenge(env.DB, "login", new Date());
    expect((await call("/api/passkey/login/verify", { method: "POST", headers: fresh(), body: loginBody(ch2) })).status).toBe(401);
    expect((await call("/api/passkey/login/verify", { method: "POST", headers: fresh(), body: loginBody("never-issued") })).status).toBe(401);
    expect((await call("/api/passkey/login/verify", { method: "POST", headers: fresh(), body: "{" })).status).toBe(400);
  });

  it("registers a passkey (stubbed verifier), lists it without key material, and deletes it", async () => {
    const call = appWith({
      ...noVerify,
      registration: async () => ({ verified: true, registrationInfo: { credential: { id: "cred-new", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] } } }) as never,
    });
    const cookie = await passwordCookie();
    const challenge = await createChallenge(env.DB, "register", new Date());
    const body = JSON.stringify({
      nickname: "MacBook",
      response: { id: "cred-new", rawId: "cred-new", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: clientData(challenge, "webauthn.create"), attestationObject: "AA" } },
    });
    const r = await call("/api/passkey/register/verify", { method: "POST", headers: { ...fresh(), cookie }, body });
    expect(r.status).toBe(201);
    // single use + duplicate credential
    expect((await call("/api/passkey/register/verify", { method: "POST", headers: { ...fresh(), cookie }, body })).status).toBe(400);
    const list = (await (await call("/api/passkey", { headers: { cookie } })).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ nickname: "MacBook" });
    expect(JSON.stringify(list)).not.toContain("public_key");
    expect((await call(`/api/passkey/${list[0]!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect((await call(`/api/passkey/${list[0]!.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(404);
  });

  it("password login still works", async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: fresh() });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/session=/);
  });
});
