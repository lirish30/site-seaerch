import { Hono } from "hono";
import { z } from "zod";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Env } from "../env";
import { loginThrottled, startSession } from "../auth";
import { challengeFromClientData, consumeChallenge, createChallenge, fromBase64Url, relyingParty, toBase64Url } from "../passkeys";

/** The two WebAuthn checks, injectable so tests can stub them. Defaults to @simplewebauthn/server. */
export interface PasskeyVerifier {
  registration: typeof verifyRegistrationResponse;
  authentication: typeof verifyAuthenticationResponse;
}
export const defaultVerifier: PasskeyVerifier = { registration: verifyRegistrationResponse, authentication: verifyAuthenticationResponse };

// A stable opaque handle for the single owner, so a second registration on the same device replaces rather than duplicates.
const USER_ID = new TextEncoder().encode("agency-os-owner");

const b64 = z.string().min(1).max(32768).regex(/^[A-Za-z0-9_-]+$/, "base64url");
const credential = { id: b64, rawId: b64, type: z.literal("public-key"), authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional() };
const RegisterBody = z.object({
  nickname: z.string().trim().max(60).optional(),
  response: z.object({ ...credential, response: z.object({ clientDataJSON: b64, attestationObject: b64, transports: z.array(z.string().max(32)).max(10).optional() }) }),
});
const LoginBody = z.object({
  response: z.object({ ...credential, response: z.object({ clientDataJSON: b64, authenticatorData: b64, signature: b64, userHandle: z.string().max(1024).optional() }) }),
});

const fieldErrors = (e: z.ZodError) => e.issues.map((i) => i.path.join(".") || "body");
const invalid = (e: z.ZodError) => ({ error: "invalid request", fields: fieldErrors(e) });
const parseJson = (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => undefined);
const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e)) || /UNIQUE constraint failed/i.test(String((e as Error)?.cause ?? ""));

interface Row { id: string; credential_id: string; public_key: string; counter: number; transports: string | null }

function parseTransports(s: string | null) {
  try { const v: unknown = s ? JSON.parse(s) : undefined; return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as never[]) : undefined; }
  catch { return undefined; }
}

export function createPasskeyRoutes(verify: PasskeyVerifier = defaultVerifier) {
  const routes = new Hono<{ Bindings: Env }>();

  // ---- Login (public: requireAuth lets exactly these two through) ----
  routes.post("/login/options", async (c) => {
    if (await loginThrottled(c)) return c.json({ error: "too many attempts" }, 429);
    const { rpID } = relyingParty(c);
    const challenge = await createChallenge(c.env.DB, "login", new Date());
    // No allowCredentials: the browser offers the discoverable passkey, and credential ids are never listed to an anonymous caller.
    return c.json(await generateAuthenticationOptions({ rpID, challenge: fromBase64Url(challenge), userVerification: "required" }));
  });

  routes.post("/login/verify", async (c) => {
    if (await loginThrottled(c)) return c.json({ error: "too many attempts" }, 429);
    const parsed = LoginBody.safeParse(await parseJson(c));
    if (!parsed.success) return c.json(invalid(parsed.error), 400);
    const response = parsed.data.response as unknown as AuthenticationResponseJSON;
    const now = new Date();
    const fail = () => c.json({ error: "passkey sign-in failed" }, 401);

    const challenge = challengeFromClientData(response.response.clientDataJSON);
    if (!challenge || !(await consumeChallenge(c.env.DB, challenge, "login", now))) return fail();
    const row = await c.env.DB.prepare("SELECT id, credential_id, public_key, counter, transports FROM passkeys WHERE credential_id = ?")
      .bind(response.id).first<Row>();
    if (!row) return fail();

    const { rpID, origin } = relyingParty(c);
    let newCounter: number;
    try {
      const result = await verify.authentication({
        response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: row.credential_id, publicKey: fromBase64Url(row.public_key), counter: row.counter, transports: parseTransports(row.transports) },
      });
      if (!result.verified) return fail();
      newCounter = result.authenticationInfo.newCounter;
    } catch { return fail(); }

    // A counter that did not move forward means a cloned authenticator or a replay. Authenticators that never count report 0 throughout.
    if ((newCounter !== 0 || row.counter !== 0) && newCounter <= row.counter) return fail();
    // Compare-and-set so two concurrent sign-ins cannot both pass the same counter.
    const upd = await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?")
      .bind(newCounter, now.toISOString(), row.id, row.counter).run();
    if (upd.meta.changes !== 1) return fail();

    await startSession(c);
    return c.json({ ok: true });
  });

  // ---- Everything below needs a session (requireAuth) ----
  routes.post("/register/options", async (c) => {
    const { rpID } = relyingParty(c);
    const existing = await c.env.DB.prepare("SELECT credential_id, transports FROM passkeys").all<{ credential_id: string; transports: string | null }>();
    const challenge = await createChallenge(c.env.DB, "register", new Date());
    return c.json(await generateRegistrationOptions({
      rpName: "Agency OS", rpID, userName: "owner", userDisplayName: "Owner", userID: USER_ID,
      challenge: fromBase64Url(challenge), attestationType: "none",
      excludeCredentials: existing.results.map((r) => ({ id: r.credential_id, transports: parseTransports(r.transports) })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    }));
  });

  routes.post("/register/verify", async (c) => {
    const parsed = RegisterBody.safeParse(await parseJson(c));
    if (!parsed.success) return c.json(invalid(parsed.error), 400);
    const response = parsed.data.response as unknown as RegistrationResponseJSON;
    const now = new Date();
    const challenge = challengeFromClientData(response.response.clientDataJSON);
    if (!challenge || !(await consumeChallenge(c.env.DB, challenge, "register", now))) return c.json({ error: "challenge expired or already used" }, 400);

    const { rpID, origin } = relyingParty(c);
    let info;
    try {
      const result = await verify.registration({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!result.verified) return c.json({ error: "passkey could not be verified" }, 400);
      info = result.registrationInfo;
    } catch { return c.json({ error: "passkey could not be verified" }, 400); }

    const id = crypto.randomUUID();
    try {
      await c.env.DB.prepare("INSERT INTO passkeys (id, credential_id, public_key, counter, transports, nickname, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, info.credential.id, toBase64Url(info.credential.publicKey), info.credential.counter,
          info.credential.transports ? JSON.stringify(info.credential.transports) : null, parsed.data.nickname || null, now.toISOString()).run();
    } catch (e) {
      if (isUnique(e)) return c.json({ error: "this passkey is already registered" }, 409);
      throw e;
    }
    return c.json({ ok: true, id }, 201);
  });

  routes.get("/", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT id, nickname, transports, created_at, last_used_at FROM passkeys ORDER BY created_at").all();
    return c.json(results);
  });

  routes.delete("/:id", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ?").bind(c.req.param("id")).run();
    return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  return routes;
}

export const passkeyRoutes = createPasskeyRoutes();
