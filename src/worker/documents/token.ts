const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The secret in a client's proposal link: 32 random bytes, base64url (43 characters). Same format as a report token (`db/reports.ts`, which does not export its own). */
export const newClientToken = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));
