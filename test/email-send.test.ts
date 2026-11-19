import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { setMailDeps } from "../src/worker/mail/deps";
import type { OutboundMessage } from "../src/worker/mail/types";
import { createApproval } from "../src/worker/db/approvals";
import { approve } from "../src/worker/approvals/decide";
import { buildEmailSendApproval, type EmailSendPayload } from "../src/worker/approvals/emailSend";
import { dailyLimit, sentInLast24h } from "../src/worker/mail/limits";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { getBusiness, upsertBusiness } from "../src/worker/db/businesses";
import { listActivity } from "../src/worker/db/activity";
import { setAfterSendForTests } from "../src/worker/mail/send";

const NOW = new Date("2026-11-20T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const ADDRESS = "12 Main St, Boise ID 83702";
const OPT_OUT = "Reply stop and I will never write again.";
const CONFIG = {
  enabled: 1 as const, smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "hello@outreach.test", from_email: "hello@outreach.test", from_name: "Logan at Siteline",
};

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

let smtpCalls: OutboundMessage[] = [];
let smtpFailures: Error[] = [];
let now = NOW;
let businessId = "";

beforeEach(async () => {
  smtpCalls = []; smtpFailures = []; now = NOW;
  setMailDeps({
    smtp: async (_mb, _pw, msg) => { const f = smtpFailures.shift(); if (f) throw f; smtpCalls.push(msg); },
    now: () => now,
  });
  await env.DB.batch([env.DB.prepare(`DELETE FROM messages`), env.DB.prepare(`DELETE FROM approvals`), env.DB.prepare(`DELETE FROM enrollments`)]);
  await saveMailbox(env.DB, "outreach", { ...CONFIG, warmup_started_at: daysAgo(40) });
  await saveMailbox(env.DB, "main", { ...CONFIG, warmup_started_at: null, from_email: "logan@main.test", username: "logan@main.test" });
  await saveSettings(env.DB, { physical_address: ADDRESS, opt_out_line: OPT_OUT, signature: "Logan", signature_json: "" });
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  businessId = (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Acme Plumbing", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id)).id;
});
afterEach(() => { setMailDeps(null); setAfterSendForTests(null); });

const payload = (over: Partial<EmailSendPayload> = {}): EmailSendPayload => ({
  mailbox: "outreach", businessId, to: "dana@acme.test", subject: "Quick note about your site",
  body: "Hi Dana, I took a look at your site and had two ideas.", includeFooter: true, ...over,
});
async function mk(over: Partial<EmailSendPayload> = {}) {
  const settings = (await env.DB.prepare(`SELECT * FROM settings WHERE id = 1`).first())! as never;
  const spec = buildEmailSendApproval({ ...payload(over), title: "Email Dana", drafted_by: "logan" }, settings);
  return createApproval(env.DB, spec);
}
const approval = (id: string) => env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null }>();
const messages = async () => (await env.DB.prepare(`SELECT * FROM messages ORDER BY created_at`).all<Record<string, unknown>>()).results;

describe("email.send", () => {
  it("approve sends once and logs the message", async () => {
    const a = await mk();
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
    expect(smtpCalls[0]).toMatchObject({ to: "dana@acme.test", subject: "Quick note about your site", from: { email: "hello@outreach.test", name: "Logan at Siteline" } });
    expect(smtpCalls[0].messageId).toMatch(/^<[^@>]+@outreach\.test>$/);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "out", mailbox_key: "outreach", business_id: businessId, approval_id: a.id, status: "sent",
      counterpart: "dana@acme.test", subject: "Quick note about your site", message_id: smtpCalls[0].messageId, sent_at: NOW.toISOString(),
    });
    expect(rows[0].text).toContain("two ideas");
    const lead = (await getBusiness(env.DB, businessId))!;
    expect(lead.lead_status).toBe("contacted");
    expect(lead.contacted_at).toBeTruthy();
    expect(await listActivity(env.DB, businessId)).toContainEqual(expect.objectContaining({ kind: "note", detail: "Email sent: Quick note about your site" }));
    expect(await approval(a.id)).toMatchObject({ status: "approved" });
  });

  it("retry after sent is a no-op", async () => {
    const a = await mk();
    expect(await approve(env, a.id)).toEqual({ ok: true });
    await env.DB.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ?`).bind(a.id).run();
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
    expect(await messages()).toHaveLength(1);
  });

  it("stuck sending row refuses to resend", async () => {
    const a = await mk();
    await env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, approval_id, counterpart, subject, text, status, created_at)
      VALUES ('stuck', 'out', 'outreach', ?, ?, 'dana@acme.test', 's', 't', 'sending', ?)`).bind(businessId, a.id, NOW.toISOString()).run();
    const r = await approve(env, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toContain("may already have been sent");
    expect(smtpCalls).toHaveLength(0);
    expect(await approval(a.id)).toMatchObject({ status: "pending" });
    expect((await messages())[0]).toMatchObject({ id: "stuck", status: "sending" });
  });

  it("smtp failure leaves approval pending and allows retry", async () => {
    const a = await mk();
    smtpFailures = [new Error("451 try again later")];
    expect(await approve(env, a.id)).toMatchObject({ ok: false, status: 502, error: "451 try again later" });
    expect(await approval(a.id)).toMatchObject({ status: "pending", error: "451 try again later" });
    const failed = await messages();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: "failed", sent_at: null });
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("new");
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", message_id: smtpCalls[0].messageId });
    expect(rows[0].message_id).toBe(failed[0].message_id);
  });

  it("dailyLimit by warm-up age", () => {
    const at = (days: number | null) => dailyLimit({ warmup_started_at: days === null ? null : daysAgo(days) }, NOW);
    expect(at(null)).toBe(0);
    expect(at(0)).toBe(0);
    expect(at(29)).toBe(0);
    expect(at(30)).toBe(5);
    expect(at(44)).toBe(5);
    expect(at(45)).toBe(10);
    expect(at(59)).toBe(10);
    expect(at(60)).toBe(20);
    expect(at(400)).toBe(20);
  });

  it("sentInLast24h counts sent and in-flight business messages in the window", async () => {
    const ins = (id: string, o: { business?: string | null; status?: string; sent?: string | null; created?: string; direction?: string; mailbox?: string }) =>
      env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, counterpart, status, created_at, sent_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(id, o.direction ?? "out", o.mailbox ?? "outreach", o.business === undefined ? businessId : o.business, "x@y.test", o.status ?? "sent",
          o.created ?? NOW.toISOString(), o.sent === undefined ? NOW.toISOString() : o.sent).run();
    await ins("a", {});
    await ins("b", { sent: daysAgo(0.9) });
    await ins("inflight", { status: "sending", sent: null });
    await ins("old", { sent: daysAgo(1.1) });
    await ins("old-inflight", { status: "sending", sent: null, created: daysAgo(1.1) });
    await ins("test", { business: null });
    await ins("failed", { status: "failed", sent: null });
    await ins("inbound", { direction: "in", status: "received" });
    await ins("main", { mailbox: "main" });
    expect(await sentInLast24h(env.DB, "outreach", NOW)).toBe(3);
  });

  it("warm-up blocks outreach before day 30", async () => {
    await saveMailbox(env.DB, "outreach", { warmup_started_at: daysAgo(10) });
    const a = await mk();
    const r = await approve(env, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toBe(`warm-up: cold sends unlock on ${daysAgo(-20).slice(0, 10)}`);
    expect(smtpCalls).toHaveLength(0);
    expect(await messages()).toHaveLength(0);
    expect(await approval(a.id)).toMatchObject({ status: "pending" });
    await saveMailbox(env.DB, "outreach", { warmup_started_at: null });
    expect(await approve(env, a.id)).toMatchObject({ ok: false });
    expect(smtpCalls).toHaveLength(0);
  });

  it("daily limit reached after N sends", async () => {
    for (let i = 0; i < 5; i++) expect(await approve(env, (await mk()).id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(5);
    const sixth = await mk();
    expect(await approve(env, sixth.id)).toMatchObject({ ok: false, status: 502, error: "daily limit reached (5)" });
    expect(smtpCalls).toHaveLength(5);
    now = new Date(NOW.getTime() + 25 * 3_600_000); // the window rolls on
    expect(await approve(env, sixth.id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(6);
  });

  describe("an answer to a message the lead sent is not cold mail", () => {
    const INBOUND = "<their-reply-1@lead.test>";
    const inbound = async (over: { business?: string; counterpart?: string; messageId?: string; kind?: string | null } = {}) => {
      await env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, message_id, counterpart, subject, text, status, kind, created_at)
        VALUES (?, 'in', 'outreach', ?, ?, ?, 'Re: hello', 'Yes please', 'received', ?, ?)`)
        .bind(crypto.randomUUID(), over.business ?? businessId, over.messageId ?? INBOUND, over.counterpart ?? "dana@acme.test", over.kind === undefined ? "reply" : over.kind, NOW.toISOString()).run();
    };

    it("sends during warm-up day 5", async () => {
      await saveMailbox(env.DB, "outreach", { warmup_started_at: daysAgo(4) });
      await inbound();
      expect(await approve(env, (await mk({ inReplyTo: INBOUND })).id)).toEqual({ ok: true });
      expect(smtpCalls).toHaveLength(1);
      expect(smtpCalls[0].inReplyTo).toBe(INBOUND);
      expect(smtpCalls[0].text).toContain(ADDRESS); // the footer is still there
    });

    it("sends after the daily cap is reached, and matches the recipient case-insensitively and the id with or without brackets", async () => {
      for (let i = 0; i < 5; i++) expect(await approve(env, (await mk()).id)).toEqual({ ok: true });
      expect(await approve(env, (await mk()).id)).toMatchObject({ ok: false, error: "daily limit reached (5)" });
      await inbound({ messageId: "their-reply-1@lead.test", counterpart: "Dana@Acme.test" });
      expect(await approve(env, (await mk({ inReplyTo: INBOUND })).id)).toEqual({ ok: true });
      expect(smtpCalls).toHaveLength(6);
    });

    it("a made-up inReplyTo is refused by the warm-up lock and by the daily cap", async () => {
      await saveMailbox(env.DB, "outreach", { warmup_started_at: daysAgo(4) });
      await inbound();
      const r = await approve(env, (await mk({ inReplyTo: "<made-up@x.test>" })).id);
      expect(r).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toContain("warm-up");
      expect(smtpCalls).toHaveLength(0);
      await saveMailbox(env.DB, "outreach", { warmup_started_at: daysAgo(40) });
      for (let i = 0; i < 5; i++) expect(await approve(env, (await mk()).id)).toEqual({ ok: true });
      expect(await approve(env, (await mk({ inReplyTo: "<made-up@x.test>" })).id)).toMatchObject({ ok: false, error: "daily limit reached (5)" });
    });

    it("an inbound message of another business, another recipient or an outbound row does not count", async () => {
      await saveMailbox(env.DB, "outreach", { warmup_started_at: daysAgo(4) });
      const other = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Other Plumbing", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null },
        (await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 })).id);
      await inbound({ business: other.id });
      const a = await approve(env, (await mk({ inReplyTo: INBOUND })).id);
      expect(a).toMatchObject({ ok: false });
      expect((a as { error: string }).error).toContain("warm-up");
      await env.DB.prepare(`DELETE FROM messages`).run();
      await inbound({ counterpart: "someone-else@acme.test" });
      expect(await approve(env, (await mk({ inReplyTo: INBOUND })).id)).toMatchObject({ ok: false });
      await env.DB.prepare(`DELETE FROM messages`).run();
      await env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, message_id, counterpart, subject, text, status, created_at)
        VALUES (?, 'out', 'outreach', ?, ?, 'dana@acme.test', 's', 't', 'sent', ?)`).bind(crypto.randomUUID(), businessId, INBOUND, NOW.toISOString()).run();
      expect(await approve(env, (await mk({ inReplyTo: INBOUND })).id)).toMatchObject({ ok: false });
      expect(smtpCalls).toHaveLength(0);
    });

    it("only an inbound message of kind reply counts: an auto reply, a bounce or a stop does not", async () => {
      for (const kind of ["auto_reply", "bounce_hard", "bounce_soft", "stop", null]) {
        await env.DB.prepare(`DELETE FROM messages`).run();
        await saveMailbox(env.DB, "outreach", { warmup_started_at: daysAgo(4) });
        await inbound({ kind });
        const r = await approve(env, (await mk({ inReplyTo: INBOUND })).id);
        expect(r, String(kind)).toMatchObject({ ok: false });
        expect((r as { error: string }).error, String(kind)).toContain("warm-up");
      }
      expect(smtpCalls).toHaveLength(0);
    });

    it("the other checks still apply: a listed recipient is refused", async () => {
      await saveMailbox(env.DB, "outreach", { warmup_started_at: daysAgo(4) });
      await inbound();
      await saveSettings(env.DB, { physical_address: "" });
      expect(await approve(env, (await mk({ inReplyTo: INBOUND })).id)).toMatchObject({ ok: false, error: "add your mailing address in Settings before sending cold email" });
    });
  });

  it("the main mailbox is not warm-up limited", async () => {
    const a = await mk({ mailbox: "main" });
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls[0].from.email).toBe("logan@main.test");
  });

  it("a disabled mailbox or missing password secret blocks the send", async () => {
    await saveMailbox(env.DB, "outreach", { enabled: 0 });
    const a = await mk();
    expect(await approve(env, a.id)).toMatchObject({ ok: false, error: "mailbox outreach is not enabled" });
    await saveMailbox(env.DB, "outreach", { enabled: 1 });
    const saved = env.MAILBOX_OUTREACH_PASSWORD;
    (env as { MAILBOX_OUTREACH_PASSWORD?: string }).MAILBOX_OUTREACH_PASSWORD = "";
    try {
      expect(await approve(env, a.id)).toMatchObject({ ok: false, error: "password secret is not set" });
    } finally { (env as { MAILBOX_OUTREACH_PASSWORD?: string }).MAILBOX_OUTREACH_PASSWORD = saved; }
    expect(smtpCalls).toHaveLength(0);
  });

  it("test send is exempt from warm-up", async () => {
    await saveMailbox(env.DB, "outreach", { warmup_started_at: null });
    const r = await SELF.fetch("https://x/api/mailboxes/outreach/test-send", { method: "POST", headers: { cookie } });
    expect(await r.json()).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
    expect(smtpCalls[0].to).toBe("hello@outreach.test");
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ business_id: null, approval_id: null, status: "sent", direction: "out" });
    expect(await sentInLast24h(env.DB, "outreach", NOW)).toBe(0);
  });

  it("workers.dev link blocks send", async () => {
    const a = await mk({ body: "See https://acme-demo.someone.workers.dev/preview for the mock-up." });
    const r = await approve(env, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toContain("workers.dev");
    expect(smtpCalls).toHaveLength(0);
    const main = await mk({ mailbox: "main", body: "See https://acme-demo.someone.workers.dev/preview" });
    expect(await approve(env, main.id)).toMatchObject({ ok: false });
    expect(smtpCalls).toHaveLength(0);
  });

  it("a body link to the main brand domain blocks cold send", async () => {
    for (const url of ["https://sitelineweb.com/x", "https://clients.sitelineweb.com/report/abc", "http://WWW.SitelineWeb.com/"]) {
      const r = await approve(env, (await mk({ body: `Take a look: ${url}` })).id);
      expect(r).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toContain(url);
      expect((r as { error: string }).error).toContain("main brand domain");
      expect((r as { error: string }).error).toContain("outreach domain");
    }
    expect(smtpCalls).toHaveLength(0);
    // the main mailbox is not a cold mailbox: it may link the brand domain
    expect(await approve(env, (await mk({ mailbox: "main", body: "See https://sitelineweb.com/x" })).id)).toEqual({ ok: true });
  });

  it("a trailing dot on a URL host does not slip past the brand block or the outreach-host rule", async () => {
    for (const url of ["https://sitelineweb.com./x", "https://clients.sitelineweb.com./report/abc"]) {
      const r = await approve(env, (await mk({ body: `Take a look: ${url}` })).id);
      expect(r).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toContain("main brand domain");
    }
    // the outreach host itself with a trailing dot is still the outreach host
    expect(await approve(env, (await mk({ body: "Take a look: https://go.hellositeline.test./r/abc" })).id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
  });

  it("an OUTREACH_LINK_BASE that does not parse blocks cold sends instead of disabling the rule", async () => {
    const e = env as { OUTREACH_LINK_BASE?: string };
    const saved = e.OUTREACH_LINK_BASE;
    e.OUTREACH_LINK_BASE = "go.hellositeline.test/not a url";
    try {
      const r = await approve(env, (await mk({ body: "Plain note with no links." })).id);
      expect(r).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toContain("OUTREACH_LINK_BASE");
      expect((r as { error: string }).error).toContain("not a valid URL");
      expect(smtpCalls).toHaveLength(0);
      // the main mailbox is not a cold mailbox and is unaffected
      expect(await approve(env, (await mk({ mailbox: "main", body: "Plain note." })).id)).toEqual({ ok: true });
    } finally { e.OUTREACH_LINK_BASE = saved; }
  });

  it("an http OUTREACH_LINK_BASE is treated as misconfigured and blocks cold sends", async () => {
    const e = env as { OUTREACH_LINK_BASE?: string };
    const saved = e.OUTREACH_LINK_BASE;
    e.OUTREACH_LINK_BASE = "http://go.hellositeline.test";
    try {
      const r = await approve(env, (await mk({ body: "Plain note with no links." })).id);
      expect(r).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toContain("OUTREACH_LINK_BASE (http://go.hellositeline.test) is not a valid URL");
      expect(smtpCalls).toHaveLength(0);
    } finally { e.OUTREACH_LINK_BASE = saved; }
  });

  it("a public page link must be on the outreach host", async () => {
    const good = await mk({ body: "Take a look: https://go.hellositeline.test/r/abc." });
    expect(await approve(env, good.id)).toEqual({ ok: true });
    const bad = await mk({ body: "Take a look: https://other.example/r/abc" });
    const r = await approve(env, bad.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toContain("https://other.example/r/abc");
    expect((r as { error: string }).error).toContain("https://go.hellositeline.test/r/abc");
    const proposal = await approve(env, (await mk({ body: "Here: https://other.example/p/xyz" })).id);
    expect(proposal).toMatchObject({ ok: false });
    expect(smtpCalls).toHaveLength(1);
    // other paths on third-party hosts are fine
    expect(await approve(env, (await mk({ body: "My work: https://other.example/portfolio" })).id)).toEqual({ ok: true });
  });

  describe("a video email's hero image", () => {
    const hero = { src: "https://go.hellositeline.test/api/public/report/tok/media/preview.gif", href: "https://go.hellositeline.test/r/tok", alt: "Video audit for Acme Plumbing" };

    it("sends the gif and the watch line when the hero is on the outreach host", async () => {
      expect(await approve(env, (await mk({ heroImage: hero })).id)).toEqual({ ok: true });
      expect(smtpCalls[0].text).toContain("Watch it here: https://go.hellositeline.test/r/tok");
      expect(smtpCalls[0].html).toContain(`<img src="${hero.src}"`);
    });

    it("an OUTREACH_LINK_BASE changed after approval blocks the send with a clear reason", async () => {
      const a = await mk({ heroImage: hero });
      const e = env as { OUTREACH_LINK_BASE?: string };
      const saved = e.OUTREACH_LINK_BASE;
      try {
        e.OUTREACH_LINK_BASE = "https://go2.hellositeline.test";
        const r = await approve(env, a.id);
        expect(r).toMatchObject({ ok: false, status: 502 });
        const msg = (r as { error: string }).error;
        expect(msg).toContain("video link");
        expect(msg).toContain(hero.href);
        expect(msg).toContain("go2.hellositeline.test");
        expect(smtpCalls).toHaveLength(0);
        e.OUTREACH_LINK_BASE = undefined; // no base at all cannot vouch for the hero either
        const unset = await approve(env, a.id);
        expect(unset).toMatchObject({ ok: false });
        expect((unset as { error: string }).error).toContain("OUTREACH_LINK_BASE");
        expect(smtpCalls).toHaveLength(0);
        e.OUTREACH_LINK_BASE = saved; // put back, the same approval goes out
        expect(await approve(env, a.id)).toEqual({ ok: true });
        expect(smtpCalls).toHaveLength(1);
      } finally { e.OUTREACH_LINK_BASE = saved; }
    });
  });

  it("a signature with a personal website and a CDN logo still sends", async () => {
    await saveSettings(env.DB, { signature_json: JSON.stringify({
      name: "Logan Irish", website: "https://loganirish.com", links: [{ label: "Work", url: "https://loganirish.com/work" }],
      image_url: "https://cdn.example.net/logo.png", image_link: "https://loganirish.com",
    }) });
    expect(await approve(env, (await mk()).id)).toEqual({ ok: true });
    expect(smtpCalls[0].html).toContain("cdn.example.net/logo.png");
    expect(smtpCalls[0].text).toContain("loganirish.com");
  });

  it("with OUTREACH_LINK_BASE unset only workers.dev and the brand domain are blocked", async () => {
    const e = env as { OUTREACH_LINK_BASE?: string };
    const saved = e.OUTREACH_LINK_BASE;
    e.OUTREACH_LINK_BASE = undefined;
    try {
      expect(await approve(env, (await mk({ body: "See https://loganirish.com/work" })).id)).toEqual({ ok: true });
      expect(await approve(env, (await mk({ body: "See https://other.example/r/abc" })).id)).toEqual({ ok: true });
      expect(await approve(env, (await mk({ body: "See https://sitelineweb.com/x" })).id)).toMatchObject({ ok: false });
      expect(await approve(env, (await mk({ body: "See https://a.someone.workers.dev/x" })).id)).toMatchObject({ ok: false });
    } finally { e.OUTREACH_LINK_BASE = saved; }
    expect(smtpCalls).toHaveLength(2);
  });

  it("outreach send always carries address and opt-out", async () => {
    const a = await mk({ includeFooter: false });
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls[0].text).toContain(ADDRESS);
    expect(smtpCalls[0].text).toContain(OPT_OUT);
    expect(smtpCalls[0].html).toContain(ADDRESS);
    expect(smtpCalls[0].html).toContain(OPT_OUT);
  });

  it("main mailbox honours includeFooter", async () => {
    const a = await mk({ mailbox: "main", includeFooter: false });
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls[0].text).not.toContain(ADDRESS);
  });

  it("missing mailing address blocks cold send", async () => {
    await saveSettings(env.DB, { physical_address: "  " });
    const a = await mk();
    expect(await approve(env, a.id)).toMatchObject({ ok: false, status: 502, error: "add your mailing address in Settings before sending cold email" });
    expect(smtpCalls).toHaveLength(0);
  });

  it("missing opt-out line blocks cold send", async () => {
    await saveSettings(env.DB, { opt_out_line: "" });
    const a = await mk();
    expect(await approve(env, a.id)).toMatchObject({ ok: false, error: "add an opt-out line in Settings before sending cold email" });
    expect(smtpCalls).toHaveLength(0);
  });

  it("preview shows recipient and subject", async () => {
    const a = await mk();
    expect(a.kind).toBe("email.send");
    expect(a.record_type).toBe("lead");
    expect(a.record_id).toBe(businessId);
    expect(a.preview.startsWith("From: outreach mailbox (no address set yet)\nTo: dana@acme.test\nSubject: Quick note about your site\n\nHi Dana")).toBe(true);
    expect(buildEmailSendApproval({ ...payload(), title: "t", drafted_by: "logan" }, (await env.DB.prepare(`SELECT * FROM settings WHERE id = 1`).first())! as never, "hello@go.example.test").preview.startsWith("From: hello@go.example.test\nTo: dana@acme.test\n")).toBe(true);
    expect(a.preview).toContain(ADDRESS);
    expect(a.preview.length).toBeLessThanOrEqual("From: outreach mailbox (no address set yet)\nTo: dana@acme.test\nSubject: Quick note about your site\n\n".length + 400);
    expect(a.payload).toMatchObject({ mailbox: "outreach", to: "dana@acme.test", body: payload().body });
    const e = await mk({ enrollmentId: "enr1", stepIndex: 2 });
    expect(e.record_type).toBe("enrollment");
    expect(e.record_id).toBe("enr1");
  });

  it("edited payload is recomposed", async () => {
    const a = await mk();
    expect(await approve(env, a.id, { ...payload(), subject: "Edited subject", body: "Edited body text." })).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
    expect(smtpCalls[0].subject).toBe("Edited subject");
    expect(smtpCalls[0].text).toContain("Edited body text.");
    expect(smtpCalls[0].text).not.toContain("two ideas");
    expect(smtpCalls[0].text).toContain(ADDRESS);
  });

  it("a replied lead keeps its status and follow-up steps do not re-mark contacted", async () => {
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'replied' WHERE id = ?`).bind(businessId).run();
    expect(await approve(env, (await mk()).id)).toEqual({ ok: true });
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("replied");
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'new' WHERE id = ?`).bind(businessId).run();
    await env.DB.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, next_due_at, started_at, last_sent_step)
      VALUES ('e', ?, 'c', 'outreach', 'dana@acme.test', 'active', 1, NULL, ?, 0)`).bind(businessId, NOW.toISOString()).run();
    expect(await approve(env, (await mk({ enrollmentId: "e", stepIndex: 1 })).id)).toEqual({ ok: true });
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("new");
    expect((await messages())[1]).toMatchObject({ enrollment_id: "e", step_index: 1 });
  });

  it("rejects an invalid payload and a header-injecting subject", async () => {
    const a = await mk();
    expect(await approve(env, a.id, { ...payload(), to: "not-an-email" })).toMatchObject({ ok: false, status: 422 });
    expect(await approve(env, a.id, { ...payload(), subject: "Hi\r\nBcc: x@y.test" })).toMatchObject({ ok: false, status: 422 });
    expect(smtpCalls).toHaveLength(0);
  });

  it("the smtp error stored on the approval never contains the password", async () => {
    const pw = env.MAILBOX_OUTREACH_PASSWORD!;
    const a = await mk();
    smtpFailures = [new Error(`535 auth failed for ${pw} (${encodeURIComponent(pw)}) ${btoa(`\0hello@outreach.test\0${pw}`)}`)];
    const r = await approve(env, a.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    const stored = (await approval(a.id))!.error!;
    expect(stored).toContain("535 auth failed");
    expect(stored).not.toContain(pw);
    expect((r as { error: string }).error).not.toContain(pw);
    expect(JSON.stringify(await messages())).not.toContain(pw);
  });

  it("a retry of a sent message repeats afterSend instead of the checks and the send", async () => {
    for (let i = 0; i < 4; i++) expect(await approve(env, (await mk()).id)).toEqual({ ok: true });
    const fifth = await mk();
    let calls = 0;
    setAfterSendForTests(async () => { if (++calls === 1) throw new Error("advance failed"); });
    expect(await approve(env, fifth.id)).toMatchObject({ ok: false, status: 502, error: "advance failed" });
    expect(await approval(fifth.id)).toMatchObject({ status: "pending", error: "advance failed" });
    expect(smtpCalls).toHaveLength(5);
    // now at the cap and with the mailing address gone: the retry must still succeed without sending
    await saveSettings(env.DB, { physical_address: "" });
    expect(await approve(env, fifth.id)).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(smtpCalls).toHaveLength(5);
    expect(await messages()).toHaveLength(5);
  });

  it("a real send without an approval id is refused", async () => {
    const { sendEmail } = await import("../src/worker/mail/send");
    await expect(sendEmail(env, payload(), { approvalId: null })).rejects.toThrow("approvalId");
    expect(smtpCalls).toHaveLength(0);
  });
});
