import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { setMailDeps } from "../src/worker/mail/deps";
import type { Mailbox, OutboundMessage } from "../src/worker/mail/types";

let cookie = "";
const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

const CONFIG = {
  smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "hello@outreach.test", from_email: "hello@outreach.test", from_name: "Logan at Siteline",
};

let sent: { mb: Mailbox; password: string; msg: OutboundMessage }[] = [];
let smtpError: Error | null = null;
let probeCalls = 0, imapCalls = 0;
const dohReply = (spf: boolean) => (url: string) => {
  const type = new URL(url).searchParams.get("type");
  const Answer = type === "TXT" && spf ? [{ type: 16, data: '"v=spf1 include:mail.test ~all"' }] : [];
  return Promise.resolve(new Response(JSON.stringify({ Status: 0, Answer }), { status: 200 }));
};

beforeEach(async () => {
  sent = []; smtpError = null; probeCalls = 0; imapCalls = 0;
  await env.DB.prepare(`UPDATE mailboxes SET enabled = 0, smtp_host = '', smtp_port = 465, imap_host = '', imap_port = 993, username = '',
    from_email = '', from_name = '', warmup_started_at = NULL, imap_uid_validity = NULL, imap_last_uid = NULL, last_sync_at = NULL, last_sync_error = NULL`).run();
  setMailDeps({
    smtp: async (mb, password, msg) => { if (smtpError) throw smtpError; sent.push({ mb, password, msg }); },
    imap: async () => { imapCalls++; return { uidValidity: 1, uidNext: 1, messages: [], highestUid: 0, skipped: [] }; },
    imapProbe: async () => { probeCalls++; return { uidValidity: 1 }; },
    fetch: dohReply(true),
    now: () => new Date("2026-11-20T10:00:00Z"),
  });
});
afterEach(() => setMailDeps(null));

describe("mailboxes", () => {
  it("GET never leaks the password", async () => {
    const r = await call("GET", "/api/mailboxes");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain("pw-out");
    expect(text).not.toContain("pw-main");
    const j = JSON.parse(text) as { mailboxes: { key: string; passwordSet: boolean }[] };
    expect(j.mailboxes.map((m) => m.key).sort()).toEqual(["main", "outreach"]);
    expect(j.mailboxes.find((m) => m.key === "outreach")!.passwordSet).toBe(true);
  });

  it("PUT saves settings and ignores a password field", async () => {
    const r = await call("PUT", "/api/mailboxes/outreach", { ...CONFIG, enabled: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ key: "outreach", enabled: 1, smtp_host: "smtp.mail.test", passwordSet: true });
    const bad = await call("PUT", "/api/mailboxes/outreach", { password: "nope" });
    expect(bad.status).toBe(400);
    const row = await env.DB.prepare(`SELECT * FROM mailboxes WHERE key = 'outreach'`).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain("nope");
  });

  it("PUT rejects a bad port", async () => {
    const r = await call("PUT", "/api/mailboxes/outreach", { ...CONFIG, smtp_port: 70000 });
    expect(r.status).toBe(400);
    const j = await r.json<{ fields: Record<string, string[]> }>();
    expect(j.fields.smtp_port).toBeTruthy();
  });

  it("PUT rejects a bad from_email and an unknown mailbox", async () => {
    expect((await call("PUT", "/api/mailboxes/outreach", { from_email: "not-an-email" })).status).toBe(400);
    expect((await call("PUT", "/api/mailboxes/other", CONFIG)).status).toBe(404);
  });

  it("test-send uses the smtp dep with the mailbox from address and own address", async () => {
    await call("PUT", "/api/mailboxes/outreach", CONFIG);
    const r = await call("POST", "/api/mailboxes/outreach/test-send");
    expect(await r.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].password).toBe("pw-out");
    expect(sent[0].mb.smtp_host).toBe("smtp.mail.test");
    expect(sent[0].msg.from).toEqual({ email: "hello@outreach.test", name: "Logan at Siteline" });
    expect(sent[0].msg.to).toBe("hello@outreach.test");
    expect(sent[0].msg.messageId).toMatch(/^<[^@>]+@outreach\.test>$/);
  });

  it("test-send on an unconfigured mailbox is a 400 and sends nothing", async () => {
    const r = await call("POST", "/api/mailboxes/outreach/test-send");
    expect(r.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("test reports smtp failure text", async () => {
    await call("PUT", "/api/mailboxes/outreach", CONFIG);
    smtpError = new Error("535 auth failed");
    const j = await (await call("POST", "/api/mailboxes/outreach/test")).json<{ smtp: { ok: boolean; error?: string }; imap: { ok: boolean }; spf: boolean | null }>();
    expect(j.smtp.ok).toBe(false);
    expect(j.smtp.error).toContain("535 auth failed");
    expect(j.imap.ok).toBe(true);
    expect(j.spf).toBe(true);
    expect(probeCalls).toBe(1);
    expect(imapCalls).toBe(0); // a connection test never downloads a message
  });

  it("test reports imap failure and a missing SPF record", async () => {
    await call("PUT", "/api/mailboxes/outreach", CONFIG);
    setMailDeps({ smtp: async () => {}, imapProbe: async () => { throw new Error("LOGIN failed"); }, fetch: dohReply(false) });
    const j = await (await call("POST", "/api/mailboxes/outreach/test")).json<{ smtp: { ok: boolean }; imap: { ok: boolean; error?: string }; spf: boolean | null }>();
    expect(j.smtp.ok).toBe(true);
    expect(j.imap).toEqual({ ok: false, error: "LOGIN failed" });
    expect(j.spf).toBe(false);
  });

  it("start-warmup twice gives 409", async () => {
    const first = await call("POST", "/api/mailboxes/outreach/start-warmup");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ warmup_started_at: "2026-11-20T10:00:00.000Z" });
    expect((await call("POST", "/api/mailboxes/outreach/start-warmup")).status).toBe(409);
  });
});
