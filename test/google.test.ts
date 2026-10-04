import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../src/worker/google/crypto";
import { signState, verifyState, authUrl, SCOPES } from "../src/worker/google/oauth";
import { buildMime, createGmailDraft, uploadFile, ensureFolder } from "../src/worker/google/api";

const dec = (s: string) => Buffer.from(s.replace(/\r\n/g, ""), "base64").toString();

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

  it("auth URL asks for offline access with compose + drive.file only", () => {
    const u = new URL(authUrl({ clientId: "cid", clientSecret: "x", redirectUri: "https://app/api/google/callback" }, "st"));
    expect(u.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(SCOPES).not.toContain("https://www.googleapis.com/auth/gmail.send");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/api/google/callback");
  });
});

describe("gmail + drive", () => {
  it("builds a plain-text MIME message with an encoded subject", () => {
    const m = buildMime({ to: "ann@ace.com", subject: "Café idea", body: "Hi Ann,\nLine two" });
    expect(m).toContain("To: ann@ace.com");
    expect(m).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/);
    expect(dec(m.split("\r\n\r\n")[1])).toBe("Hi Ann,\nLine two");
  });

  it("adds the PDF as a base64 attachment and omits To when there's no recipient", () => {
    const m = buildMime({ to: null, subject: "S", body: "B", attachment: { name: "ace-website-audit.pdf", bytes: new Uint8Array([37, 80, 68, 70]) } });
    expect(m).not.toContain("To:");
    expect(m).toContain('Content-Type: multipart/mixed; boundary="');
    expect(m).toContain('filename="ace-website-audit.pdf"');
    expect(m).toContain(Buffer.from("%PDF").toString("base64"));
  });

  it("creates a draft (never sends) and returns a Gmail link", async () => {
    const calls: [string, RequestInit][] = [];
    const f = async (u: string, i?: RequestInit) => { calls.push([u, i!]); return Response.json({ id: "d1", message: { id: "m1" } }); };
    const r = await createGmailDraft(f, "tok", "Subject: x\r\n\r\nhi");
    expect(calls[0][0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(calls.some(([u]) => u.includes("/send"))).toBe(false);
    expect((calls[0][1].headers as any).authorization).toBe("Bearer tok");
    expect(Buffer.from(JSON.parse(calls[0][1].body as string).message.raw, "base64url").toString()).toBe("Subject: x\r\n\r\nhi");
    expect(r.url).toContain("compose=m1");
  });

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
