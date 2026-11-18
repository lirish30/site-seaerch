import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { addDoNotContact, listDoNotContact, removeDoNotContact } from "../src/worker/db/doNotContact";
import { checkConflict } from "../src/worker/conflict";
import { suppressLead } from "../src/worker/db/suppression";
import { createSearch } from "../src/worker/db/searches";
import { domainOf, upsertBusiness } from "../src/worker/db/businesses";
import { setMailDeps } from "../src/worker/mail/deps";
import type { OutboundMessage } from "../src/worker/mail/types";
import { createApproval } from "../src/worker/db/approvals";
import { approve } from "../src/worker/approvals/decide";
import { buildEmailSendApproval, type EmailSendPayload } from "../src/worker/approvals/emailSend";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { saveSettings } from "../src/worker/db/settings";
import { setAfterSendForTests } from "../src/worker/mail/send";

const NOW = new Date("2026-11-20T10:00:00Z");
const CONFIG = {
  enabled: 1 as const, smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "hello@outreach.test", from_email: "hello@outreach.test", from_name: "Logan at Siteline",
};

let cookie = "";
const api = (method: string, path: string, body?: unknown, withCookie = true) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(withCookie ? { cookie } : {}), "content-type": "application/json" } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

let smtpCalls: OutboundMessage[] = [];
let searchId = "";
beforeEach(async () => {
  smtpCalls = [];
  setMailDeps({ smtp: async (_mb, _pw, msg) => { smtpCalls.push(msg); }, now: () => NOW });
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM do_not_contact`), env.DB.prepare(`DELETE FROM suppressions`),
    env.DB.prepare(`DELETE FROM messages`), env.DB.prepare(`DELETE FROM approvals`),
  ]);
  await saveMailbox(env.DB, "outreach", { ...CONFIG, warmup_started_at: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  await saveSettings(env.DB, { physical_address: "12 Main St, Boise ID 83702", opt_out_line: "Reply stop.", signature: "Logan", signature_json: "" });
  searchId = (await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 })).id;
});
afterEach(() => { setMailDeps(null); setAfterSendForTests(null); });

const lead = async (name: string, websiteUrl: string | null = null) =>
  (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl, mapsUrl: null, rating: null, reviewCount: null }, searchId)).id;

describe("checkConflict", () => {
  it("nothing listed means nothing blocked", async () => {
    expect(await checkConflict(env.DB, { email: "dana@acme.test" })).toEqual({ blocked: false });
    expect(await checkConflict(env.DB, { email: "dana@acme.test", businessId: await lead("Acme Plumbing", "https://acme.test") })).toEqual({ blocked: false });
  });

  it("listed email blocks regardless of case", async () => {
    await addDoNotContact(env.DB, { kind: "email", value: "  Dana@Acme.Test ", reason: "opt_out" });
    const r = await checkConflict(env.DB, { email: "DANA@acme.TEST" });
    expect(r).toMatchObject({ blocked: true, source: "do_not_contact" });
    expect((r as { reason: string }).reason).toBe("dana@acme.test is on your do-not-contact list (opt_out)");
    expect(await checkConflict(env.DB, { email: "other@acme.test" })).toEqual({ blocked: false });
  });

  it("listed domain blocks subdomain and www", async () => {
    await addDoNotContact(env.DB, { kind: "domain", value: "https://www.Acme.com/", reason: "webfor" });
    const r = await checkConflict(env.DB, { email: "Sam@Mail.Acme.com" });
    expect(r).toMatchObject({ blocked: true, source: "do_not_contact" });
    expect((r as { reason: string }).reason).toBe("acme.com is on your do-not-contact list (webfor)");
    expect(await checkConflict(env.DB, { email: "sam@acme.com" })).toMatchObject({ blocked: true });
    // the lead's own site, even when the email is on a free mailbox host
    const id = await lead("Some Shop", "https://www.acme.com/contact");
    expect(await checkConflict(env.DB, { email: "shop@gmail.test", businessId: id })).toMatchObject({ blocked: true, source: "do_not_contact" });
    const sub = await lead("Other Shop", "https://shop.acme.com");
    expect(await checkConflict(env.DB, { email: "shop@gmail.test", businessId: sub })).toMatchObject({ blocked: true });
    // a trailing dot on the host does not slip through
    expect(await checkConflict(env.DB, { email: "x@mail.acme.com." })).toMatchObject({ blocked: true });
  });

  it("similar domain does not block", async () => {
    await addDoNotContact(env.DB, { kind: "domain", value: "acme.com", reason: "client" });
    expect(await checkConflict(env.DB, { email: "x@notacme.com" })).toEqual({ blocked: false });
    expect(await checkConflict(env.DB, { email: "x@acme.com.au" })).toEqual({ blocked: false });
    const id = await lead("Not Acme", "https://notacme.com");
    expect(await checkConflict(env.DB, { email: "x@notacme.com", businessId: id })).toEqual({ blocked: false });
  });

  it("listed name blocks normalized name", async () => {
    await addDoNotContact(env.DB, { kind: "name", value: "acme plumbing", reason: "competitor" });
    const id = await lead("Acme Plumbing, LLC");
    const r = await checkConflict(env.DB, { email: "x@free.test", businessId: id });
    expect(r).toMatchObject({ blocked: true, source: "do_not_contact" });
    expect((r as { reason: string }).reason).toContain("acme plumbing");
    expect((r as { reason: string }).reason).toContain("competitor");
    expect(await checkConflict(env.DB, { email: "x@free.test", businessId: await lead("Acme Plumbing Supply") })).toEqual({ blocked: false });
    // names only apply when the lead is known
    expect(await checkConflict(env.DB, { email: "x@free.test" })).toEqual({ blocked: false });
  });

  it("suppression list blocks", async () => {
    const id = await lead("Beta Roofing", "https://beta-roofing.test");
    await suppressLead(env.DB, { domain: "beta-roofing.test", place_id: null, website_url: null }, { reason: "competitor" });
    const r = await checkConflict(env.DB, { email: "x@free.test", businessId: id });
    expect(r).toMatchObject({ blocked: true, source: "suppression" });
    expect((r as { reason: string }).reason).toContain("beta-roofing.test");
  });

  it("won lead blocks with client source", async () => {
    const id = await lead("Gamma Dental", "https://gamma.test");
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(id).run();
    const r = await checkConflict(env.DB, { email: "x@free.test", businessId: id });
    expect(r).toMatchObject({ blocked: true, source: "client" });
    expect((r as { reason: string }).reason).toContain("Gamma Dental");
    expect(await checkConflict(env.DB, { email: "x@free.test" })).toEqual({ blocked: false });
  });
});

describe("do-not-contact store", () => {
  it("normalizes on write and lists newest first", async () => {
    const d = await addDoNotContact(env.DB, { kind: "domain", value: "WWW.Example.COM", reason: "client", note: " signed " });
    expect(d).toMatchObject({ kind: "domain", value: "example.com", reason: "client", note: "signed" });
    const n = await addDoNotContact(env.DB, { kind: "name", value: "The Acme Plumbing Co., Inc.", reason: "other" });
    expect(n.value).toBe("the acme plumbing");
    expect((await listDoNotContact(env.DB)).map((x) => x.id).sort()).toEqual([d.id, n.id].sort());
    expect(await removeDoNotContact(env.DB, d.id)).toBe(true);
    expect(await removeDoNotContact(env.DB, d.id)).toBe(false);
  });
});

describe("email.send gate", () => {
  const spec = async (businessId: string, to = "dana@acme.test") => {
    const settings = (await env.DB.prepare(`SELECT * FROM settings WHERE id = 1`).first())! as never;
    const p: EmailSendPayload = { mailbox: "outreach", businessId, to, subject: "Quick note", body: "Hi Dana, two ideas for your site.", includeFooter: true };
    return buildEmailSendApproval({ ...p, title: "Email Dana", drafted_by: "logan" }, settings);
  };
  const approval = (id: string) => env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null }>();

  it("email.send execute refuses a conflict and the approval stays pending with the reason", async () => {
    const id = await lead("Acme Plumbing", "https://acme.test");
    await addDoNotContact(env.DB, { kind: "domain", value: "acme.test", reason: "active_deal" });
    const a = await createApproval(env.DB, await spec(id));
    const r = await approve(env, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toBe("blocked: acme.test is on your do-not-contact list (active_deal) (do_not_contact)");
    expect(smtpCalls).toHaveLength(0);
    expect(await approval(a.id)).toMatchObject({ status: "pending", error: (r as { error: string }).error });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>()).toEqual({ n: 0 });
    // lifting the entry lets the same approval through
    await env.DB.prepare(`DELETE FROM do_not_contact`).run();
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
  });

  it("a retry of a sent approval is not stopped by a mailbox switched off or a new conflict", async () => {
    const id = await lead("Acme Plumbing", "https://acme.test");
    const a = await createApproval(env.DB, await spec(id));
    let calls = 0;
    setAfterSendForTests(async () => { if (++calls === 1) throw new Error("advance failed"); });
    expect(await approve(env, a.id)).toMatchObject({ ok: false, status: 502, error: "advance failed" });
    expect(smtpCalls).toHaveLength(1);
    await saveMailbox(env.DB, "outreach", { enabled: 0 });
    await addDoNotContact(env.DB, { kind: "email", value: "dana@acme.test", reason: "opt_out" });
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(smtpCalls).toHaveLength(1);
  });
});

describe("hosts that start with http", () => {
  it("httpbin.org can be listed as a do-not-contact domain, and an address at http.acme.com is blocked by acme.com", async () => {
    const d = await addDoNotContact(env.DB, { kind: "domain", value: "httpbin.org", reason: "other" });
    expect(d.value).toBe("httpbin.org");
    expect(await checkConflict(env.DB, { email: "x@httpbin.org" })).toMatchObject({ blocked: true, source: "do_not_contact" });
    await addDoNotContact(env.DB, { kind: "domain", value: "acme.com", reason: "client" });
    expect(await checkConflict(env.DB, { email: "x@http.acme.com" })).toMatchObject({ blocked: true, source: "do_not_contact" });
    const id = await lead("Httpd Shop", "http.acme.com");
    expect(await checkConflict(env.DB, { email: "shop@gmail.test", businessId: id })).toMatchObject({ blocked: true });
    expect(domainOf("https://httpbin.org/x")).toBe("httpbin.org");
    expect(domainOf("HTTP://Www.Acme.com")).toBe("acme.com");
  });
});

describe("free-mail domains", () => {
  it("cannot be listed as a domain, with a message that points to an Email entry", async () => {
    for (const host of ["gmail.com", "GMAIL.com", "https://www.yahoo.com/", "googlemail.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "comcast.net", "att.net", "verizon.net", "sbcglobal.net"]) {
      await expect(addDoNotContact(env.DB, { kind: "domain", value: host, reason: "other" })).rejects.toThrow("use an Email entry for a single address instead of blocking a whole free-mail provider");
    }
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
  });

  it("the route answers 400, and email and name entries are unaffected", async () => {
    const r = await api("POST", "/api/do-not-contact", { kind: "domain", value: "gmail.com", reason: "other" });
    expect(r.status).toBe(400);
    expect((await r.json<{ error: string }>()).error).toContain("Email entry");
    expect((await api("POST", "/api/do-not-contact", { kind: "email", value: "someone@gmail.com", reason: "opt_out" })).status).toBe(201);
    expect((await api("POST", "/api/do-not-contact", { kind: "name", value: "Gmail Repair", reason: "other" })).status).toBe(201);
    expect((await api("POST", "/api/do-not-contact", { kind: "domain", value: "gmail.company.test", reason: "other" })).status).toBe(201);
  });
});

describe("do-not-contact routes", () => {
  it("add and delete round trip", async () => {
    const empty = await api("GET", "/api/do-not-contact");
    expect(await empty.json()).toEqual([]);
    const created = await api("POST", "/api/do-not-contact", { kind: "domain", value: "Acme.com", reason: "client", note: "signed" });
    expect(created.status).toBe(201);
    const row = await created.json<{ id: string; kind: string; value: string; reason: string; note: string }>();
    expect(row).toMatchObject({ kind: "domain", value: "acme.com", reason: "client", note: "signed" });
    expect(await (await api("GET", "/api/do-not-contact")).json()).toEqual([expect.objectContaining({ id: row.id })]);
    expect((await api("DELETE", `/api/do-not-contact/${row.id}`)).status).toBe(200);
    expect(await (await api("GET", "/api/do-not-contact")).json()).toEqual([]);
    expect((await api("DELETE", `/api/do-not-contact/${row.id}`)).status).toBe(404);
  });

  it("rejects bad input", async () => {
    expect((await api("POST", "/api/do-not-contact", { kind: "domain", value: "acme.com", reason: "nope" })).status).toBe(400);
    expect((await api("POST", "/api/do-not-contact", { kind: "phone", value: "x", reason: "other" })).status).toBe(400);
    expect((await api("POST", "/api/do-not-contact", { kind: "email", value: "not-an-email", reason: "other" })).status).toBe(400);
    expect((await api("POST", "/api/do-not-contact", { kind: "name", value: "LLC", reason: "other" })).status).toBe(400);
  });

  it("duplicate gives 409", async () => {
    expect((await api("POST", "/api/do-not-contact", { kind: "email", value: "a@b.test", reason: "other" })).status).toBe(201);
    const dup = await api("POST", "/api/do-not-contact", { kind: "email", value: "A@B.test", reason: "bounced" });
    expect(dup.status).toBe(409);
  });

  it("401 without a cookie", async () => {
    expect((await api("GET", "/api/do-not-contact", undefined, false)).status).toBe(401);
    expect((await api("POST", "/api/do-not-contact", { kind: "email", value: "a@b.test", reason: "other" }, false)).status).toBe(401);
    expect((await api("DELETE", "/api/do-not-contact/x", undefined, false)).status).toBe(401);
  });
});
