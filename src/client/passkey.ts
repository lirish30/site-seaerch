import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api, ApiError } from "./api";

export type CeremonyResult = { ok: true } | { ok: false; message: string };

/** Turn a failed browser prompt into a short sentence. Cancelling the Touch ID sheet is the common case. */
function promptFailure(err: unknown): CeremonyResult {
  const name = err instanceof Error ? err.name : "";
  const code = err instanceof WebAuthnError ? err.code : "";
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") return { ok: false, message: "Cancelled. Try again when you're ready." };
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") return { ok: false, message: "This device already has a passkey here." };
  return { ok: false, message: "This browser could not use a passkey." };
}

const serverFailure = (e: unknown, fallback: string): CeremonyResult =>
  ({ ok: false, message: e instanceof ApiError && e.status === 429 ? "Too many attempts. Wait a minute and try again." : fallback });

export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential;

/** Sign in with a saved passkey. On success the session cookie is already set. */
export async function signInWithPasskey(): Promise<CeremonyResult> {
  let optionsJSON: PublicKeyCredentialRequestOptionsJSON;
  try { optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>("/passkey/login/options"); }
  catch (e) { return serverFailure(e, "Couldn't start passkey sign-in. Use your password."); }
  let response;
  try { response = await startAuthentication({ optionsJSON }); } catch (e) { return promptFailure(e); }
  try { await api.post("/passkey/login/verify", { response }); return { ok: true }; }
  catch (e) { return serverFailure(e, "That passkey wasn't accepted. Use your password."); }
}

/** Register a passkey on this device (signed in). */
export async function registerPasskey(nickname?: string): Promise<CeremonyResult> {
  let optionsJSON: PublicKeyCredentialCreationOptionsJSON;
  try { optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>("/passkey/register/options"); }
  catch (e) { return serverFailure(e, "Couldn't start passkey setup. Try again."); }
  let response;
  try { response = await startRegistration({ optionsJSON }); } catch (e) { return promptFailure(e); }
  try { await api.post("/passkey/register/verify", { response, ...(nickname ? { nickname } : {}) }); return { ok: true }; }
  catch (e) { return serverFailure(e, e instanceof ApiError && e.status === 409 ? "This passkey is already registered." : "The passkey couldn't be saved. Try again."); }
}
