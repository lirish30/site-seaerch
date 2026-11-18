import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../src/worker/google/crypto";
import { signState, verifyState, authUrl, SCOPES } from "../src/worker/google/oauth";
import { uploadFile, ensureFolder } from "../src/worker/google/api";

describe("google crypto + oauth state", () => {
  it("encrypts and decrypts with the session secret; other secrets fail", async () => {
    const sealed = await encryptSecret("s1", "refresh-token-123");
    expect(sealed).not.toContain("refresh-token");
    expect(await decryptSecret("s1", sealed)).toBe("refresh-token-123");
    await expect(decryptSecret("s2", sealed)).rejects.toThrow();
  });

  it("state must match the nonce cookie, be unexpired and untampered", async () => {
    const st = await signState("sec", "n1", 1000);
    expect(await verifyState("sec", st, "n1", 2000)).toBe(true);
    expect(await verifyState("sec", st, "other", 2000)).toBe(false);
    expect(await verifyState("sec", st, undefined, 2000)).toBe(false);
    expect(await verifyState("sec", st, "n1", 1000 + 11 * 60 * 1000)).toBe(false);
    expect(await verifyState("other", st, "n1", 2000)).toBe(false);
    expect(await verifyState("sec", st.replace(/.$/, "0"), "n1", 2000)).toBe(st.endsWith("0"));
  });

  it("auth URL asks for offline access with drive.file only (no Gmail scope of any kind)", () => {
    const u = new URL(authUrl({ clientId: "cid", clientSecret: "x", redirectUri: "https://app/api/google/callback" }, "st"));
    expect(u.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(SCOPES).toEqual(["openid", "email", "https://www.googleapis.com/auth/drive.file"]);
    expect(SCOPES.join(" ")).not.toContain("gmail");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/api/google/callback");
  });
});

describe("drive", () => {
  it("uploads multipart with metadata then content; recreates a trashed folder", async () => {
    let body = "";
    const up = await uploadFile(async (_u, i) => { body = new TextDecoder().decode(i!.body as Uint8Array); return Response.json({ id: "f", webViewLink: "https://docs/x" }); },
      "t", { name: "Doc", parents: ["p"], mimeType: "application/vnd.google-apps.document" }, { type: "text/html", bytes: "<h1>Hi</h1>" });
    expect(up.webViewLink).toBe("https://docs/x");
    expect(body.indexOf('"mimeType":"application/vnd.google-apps.document"')).toBeLessThan(body.indexOf("<h1>Hi</h1>"));
    const seen: string[] = [];
    const id = await ensureFolder(async (u, i) => { seen.push(`${i?.method ?? "GET"} ${u}`);
      return i?.method === "POST" ? Response.json({ id: "new" }) : Response.json({ id: "old", trashed: true }); }, "t", "old", "Reports");
    expect(id).toBe("new");
    expect(seen[1]).toMatch(/^POST /);
  });
});
