import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import type { ImapFetch, ImapFetchResult } from "../src/worker/mail/types";
import { createApproval } from "../src/worker/db/approvals";
import { approve } from "../src/worker/approvals/decide";
import { buildEmailSendApproval } from "../src/worker/approvals/emailSend";
import { getMailbox, saveMailbox } from "../src/worker/db/mailboxes";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { getBusiness, updateLead, upsertBusiness } from "../src/worker/db/businesses";
import { listActivity } from "../src/worker/db/activity";
import { listDoNotContact } from "../src/worker/db/doNotContact";
import { listSuppressions } from "../src/worker/db/suppression";
import { createCampaign } from "../src/worker/db/campaigns";
import { syncAllMailboxes, syncMailbox } from "../src/worker/mail/sync";
import type { Enrollment } from "../src/worker/sequence/types";
import replyEml from "./fixtures/mail/reply.eml?raw";
import footerEml from "./fixtures/mail/reply-quoted-footer.eml?raw";
import stopEml from "./fixtures/mail/stop.eml?raw";
import bounceEml from "./fixtures/mail/bounce-dsn.eml?raw";
import oooEml from "./fixtures/mail/ooo.eml?raw";
import hugeEml from "./fixtures/mail/huge.eml?raw";

const NOW = new Date("2026-11-18T18:00:00.000Z");
const DAY = 86_400_000;
const CONFIG = {
  enabled: 1 as const, smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "hello@outreach.test", from_email: "hello@outreach.test", from_name: "Logan at Siteline",
};
// The In-Reply-To of each fixture: the Message-ID of the outbound row the lead is answering.
const OUT = {
  reply: "<6b1d2c7e-4a51-4c1e-9d0a-3f0c8d5e7a11@hellositeline.test>",
  footer: "<9e8f7a60-1b2c-4d3e-8f90-a1b2c3d4e5f6@hellositeline.test>",
  stop: "<c3d4e5f6-0a1b-4c2d-8e3f-4a5b6c7d8e9f@hellositeline.test>",
  ooo: "<d4e5f6a7-1b2c-4d3e-9f40-b1c2d3e4f5a6@hellositeline.test>",
  huge: "<e5f6a7b8-2c3d-4e4f-8a51-c2d3e4f5a6b7@hellositeline.test>",
};

const bytes = (s: string) => new TextEncoder().encode(s);
let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

/** A scripted IMAP server: windows of `window` UIDs, like the real client, so the sync's looping can be observed. */
const box = { uidValidity: 7, window: 25, mails: [] as { uid: number; raw: string; size?: number }[], uidNext: 1, calls: [] as (number | null)[], fail: null as Error | null, oversized: new Set<number>() };
const fakeImap: ImapFetch = async (_mb, _pw, since) => {
  box.calls.push(since);
  if (box.fail) throw box.fail;
  const base = { uidValidity: box.uidValidity, uidNext: box.uidNext };
  if (since === null) return { ...base, messages: [], highestUid: box.uidNext - 1, skipped: [] };
  const to = Math.min(since + box.window, box.uidNext - 1);
  const inWindow = box.mails.filter((m) => m.uid > since && m.uid <= to);
  const skipped = inWindow.filter((m) => box.oversized.has(m.uid)).map((m) => ({ uid: m.uid, size: 5_000_000 }));
  return {
    ...base, highestUid: Math.max(since, to), skipped,
    messages: inWindow.filter((m) => !box.oversized.has(m.uid)).map((m) => ({ uid: m.uid, raw: bytes(m.raw) })),
  } satisfies ImapFetchResult;
};
/** Puts mail on the server at the next UIDs. */
function deliver(...raws: string[]): number[] {
  return raws.map((raw) => { const uid = box.uidNext++; box.mails.push({ uid, raw }); return uid; });
}
/** Makes the first sync done: baseline at the current end of the mailbox. */
async function baseline() {
  await syncMailbox(env, "outreach");
  box.calls = [];
}

const eml = (o: { from: string; inReplyTo?: string; subject?: string; body: string; headers?: string }) =>
  `From: Someone <${o.from}>\r\nTo: Logan <hello@outreach.test>\r\nSubject: ${o.subject ?? "Re: hello"}\r\nMessage-ID: <${crypto.randomUUID()}@lead.test>\r\n` +
  `${o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}\r\nReferences: ${o.inReplyTo}\r\n` : ""}${o.headers ?? ""}Content-Type: text/plain; charset=UTF-8\r\n\r\n${o.body}\r\n`;

let campaignId = "";
let smtpCalls = 0;
let warnings: string[] = [];
let searchId = "";

/** A lead with a sequence and the outbound email it was sent (Message-ID `outbound`), the way the send path leaves them. */
async function seedLead(name: string, o: { to?: string; outbound?: string | null; status?: Enrollment["status"]; nextDueAt?: string | null; leadStatus?: "contacted" } = {}) {
  const id = (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: `https://${crypto.randomUUID()}.test`, mapsUrl: null, rating: null, reviewCount: null }, searchId)).id;
  await updateLead(env.DB, id, { leadStatus: o.leadStatus ?? "contacted" });
  const eid = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, next_due_at, started_at, last_sent_at, last_sent_step)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(eid, id, campaignId, "outreach", o.to ?? "dana@acme.test", o.status ?? "active", 1,
    o.nextDueAt === undefined ? new Date(NOW.getTime() + 3 * DAY).toISOString() : o.nextDueAt, new Date(NOW.getTime() - 2 * DAY).toISOString(), new Date(NOW.getTime() - 2 * DAY).toISOString(), 0).run();
  if (o.outbound !== null) {
    await env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, enrollment_id, step_index, message_id, counterpart, subject, text, status, created_at, sent_at)
      VALUES (?, 'out', 'outreach', ?, ?, 0, ?, ?, 'Quick video', 'Hi', 'sent', ?, ?)`)
      .bind(crypto.randomUUID(), id, eid, o.outbound, o.to ?? "dana@acme.test", new Date(NOW.getTime() - 2 * DAY).toISOString(), new Date(NOW.getTime() - 2 * DAY).toISOString()).run();
  }
  return { businessId: id, enrollmentId: eid };
}

const inbound = async () => (await env.DB.prepare(`SELECT * FROM messages WHERE direction = 'in' ORDER BY imap_uid`).all<Record<string, any>>()).results;
const enrollment = async (id: string) => (await env.DB.prepare(`SELECT * FROM enrollments WHERE id = ?`).bind(id).first<Enrollment>())!;
const kinds = async (id: string) => (await listActivity(env.DB, id)).map((a) => a.kind);
const mailbox = () => getMailbox(env.DB, "outreach");

beforeEach(async () => {
  box.uidValidity = 7; box.window = 25; box.mails = []; box.uidNext = 1; box.calls = []; box.fail = null; box.oversized = new Set();
  smtpCalls = 0; warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...a) => { warnings.push(a.map(String).join(" ")); });
  setMailDeps({ imap: fakeImap, smtp: async () => { smtpCalls++; }, now: () => NOW });
  await env.DB.batch(["enrollments", "approvals", "messages", "campaigns", "do_not_contact", "suppressions", "activity", "businesses"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await saveMailbox(env.DB, "outreach", { ...CONFIG, imap_uid_validity: null, imap_last_uid: null, last_sync_at: null, last_sync_error: null, warmup_started_at: new Date(NOW.getTime() - 40 * DAY).toISOString() });
  await saveMailbox(env.DB, "main", { ...CONFIG, enabled: 0, imap_uid_validity: null, imap_last_uid: null, last_sync_at: null, last_sync_error: null, from_email: "logan@main.test", username: "logan@main.test" });
  await saveSettings(env.DB, { physical_address: "12 Main St, Boise ID 83702", opt_out_line: "Reply stop.", signature: "Logan", signature_json: "" });
  searchId = (await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 })).id;
  campaignId = (await createCampaign(env.DB, { name: "Boise plumbers", niche: "plumber", region: "Treasure Valley, ID", towns: ["Boise, ID"] })).id;
});
afterEach(() => { setMailDeps(null); vi.restoreAllMocks(); });

describe("syncMailbox: baseline", () => {
  it("first sync saves the baseline and imports nothing", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    deliver(replyEml, replyEml.replace("CAK7r2b1e3F9", "other"), footerEml); // history already in the mailbox
    expect(await syncMailbox(env, "outreach")).toEqual({ fetched: 0, matched: 0, replies: 0, stopped: 0, bounced: 0 });
    expect(box.calls).toEqual([null]);
    expect(await mailbox()).toMatchObject({ imap_last_uid: 3, imap_uid_validity: 7, last_sync_at: NOW.toISOString(), last_sync_error: null });
    expect(await inbound()).toHaveLength(0);
    expect(await kinds(lead.businessId)).not.toContain("email_reply");
    expect((await enrollment(lead.enrollmentId)).status).toBe("active");
  });

  it("uidValidity change resets the baseline", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await saveMailbox(env.DB, "outreach", { imap_last_uid: 5, imap_uid_validity: 7 });
    box.uidValidity = 8; box.uidNext = 20;
    box.mails.push({ uid: 6, raw: replyEml });
    const r = await syncMailbox(env, "outreach");
    expect(r).toEqual({ fetched: 0, matched: 0, replies: 0, stopped: 0, bounced: 0 });
    expect(await mailbox()).toMatchObject({ imap_last_uid: 19, imap_uid_validity: 8, last_sync_error: "mailbox UID validity changed; baseline reset" });
    expect(await inbound()).toHaveLength(0);
    expect(warnings).toEqual(["mail sync outreach: mailbox UID validity changed; baseline reset"]);
    // the next run is an ordinary one from the new baseline
    box.uidNext = 21; box.mails.push({ uid: 20, raw: replyEml });
    expect((await syncMailbox(env, "outreach")).replies).toBe(1);
    expect((await mailbox()).last_sync_error).toBeNull();
  });
});

describe("syncMailbox: UID validity and stored UIDs", () => {
  it("a new-epoch mail that reuses a UID of an old processed row is still applied", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    // an old-epoch message with UID 20 was stored and processed long ago
    await env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, enrollment_id, counterpart, subject, text, status, kind, imap_uid, created_at, processed_at)
      VALUES ('old', 'in', 'outreach', ?, ?, 'pat@brightsmiles.example', 'old', 'old', 'received', 'auto_reply', 20, ?, ?)`)
      .bind(lead.businessId, lead.enrollmentId, new Date(NOW.getTime() - 9 * DAY).toISOString(), new Date(NOW.getTime() - 9 * DAY).toISOString()).run();
    await saveMailbox(env.DB, "outreach", { imap_last_uid: 30, imap_uid_validity: 7 });
    box.uidValidity = 8; box.uidNext = 20; // the new epoch is numbered below the old UIDs
    await syncMailbox(env, "outreach");
    expect((await mailbox()).imap_last_uid).toBe(19);
    box.uidNext = 21; box.mails.push({ uid: 20, raw: replyEml }); // the reply gets UID 20 again
    expect(await syncMailbox(env, "outreach")).toMatchObject({ fetched: 1, matched: 1, replies: 1 });
    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "replied" });
    const rows = (await env.DB.prepare(`SELECT id, imap_uid, kind FROM messages WHERE direction = 'in' ORDER BY created_at`).all<Record<string, any>>()).results;
    expect(rows).toEqual([{ id: "old", imap_uid: null, kind: "auto_reply" }, expect.objectContaining({ imap_uid: 20, kind: "reply" })]);
  });
});

describe("syncMailbox: replies", () => {
  it("reply matched by In-Reply-To stops the sequence and marks the lead replied", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    const [uid] = deliver(replyEml);
    expect(await syncMailbox(env, "outreach")).toEqual({ fetched: 1, matched: 1, replies: 1, stopped: 0, bounced: 0 });

    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "replied", stopped_reason: "replied", next_due_at: null });
    expect((await getBusiness(env.DB, lead.businessId))!.lead_status).toBe("replied");
    const rows = await inbound();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "in", mailbox_key: "outreach", business_id: lead.businessId, enrollment_id: lead.enrollmentId, counterpart: "pat@brightsmiles.example",
      kind: "reply", subject: "Re: Your site search, Bright Smiles Dental", status: "received", imap_uid: uid,
      message_id: "<CAK7r2b1e3F9@mail.brightsmiles.example>", in_reply_to: OUT.reply, processed_at: NOW.toISOString(),
    });
    expect(rows[0].text).toContain("Tuesday afternoon works");
    const acts = await listActivity(env.DB, lead.businessId);
    expect(acts.filter((a) => a.kind === "email_reply")).toHaveLength(1);
    expect(acts.find((a) => a.kind === "email_reply")!.detail).toContain("pat@brightsmiles.example");
    expect(await mailbox()).toMatchObject({ imap_last_uid: uid, last_sync_error: null });
  });

  it("reply rejects pending step approvals", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    const settings = (await env.DB.prepare(`SELECT * FROM settings WHERE id = 1`).first())! as never;
    const approval = await createApproval(env.DB, buildEmailSendApproval({
      mailbox: "outreach", businessId: lead.businessId, to: "pat@brightsmiles.example", subject: "Following up", body: "Hi Pat, just checking in.", includeFooter: true,
      enrollmentId: lead.enrollmentId, stepIndex: 1, title: "Step 1", drafted_by: "job",
    } as never, settings));
    await baseline();
    deliver(replyEml);
    await syncMailbox(env, "outreach");
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(approval.id).first<{ status: string }>())!.status).toBe("rejected");
    // stop beats approval: approving it now must not send anything
    expect((await approve(env, approval.id)).ok).toBe(false);
    expect(smtpCalls).toBe(0);
  });

  it("stop reply suppresses the lead and adds do_not_contact", async () => {
    const lead = await seedLead("Lakeview Vet", { to: "dana@lakeviewvet.example", outbound: OUT.stop });
    await baseline();
    deliver(stopEml);
    expect(await syncMailbox(env, "outreach")).toEqual({ fetched: 1, matched: 1, replies: 0, stopped: 1, bounced: 0 });
    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "stopped", stopped_reason: "opt_out" });
    expect((await getBusiness(env.DB, lead.businessId))!.lead_status).toBe("lost");
    expect((await listDoNotContact(env.DB)).map((d) => [d.kind, d.value, d.reason])).toEqual([["email", "dana@lakeviewvet.example", "opt_out"]]);
    expect(await listSuppressions(env.DB)).not.toHaveLength(0);
    expect((await inbound())[0]).toMatchObject({ kind: "stop", processed_at: NOW.toISOString() });
  });

  it("quoted footer reply is a reply, not a stop", async () => {
    const lead = await seedLead("Harbor Plumbing", { to: "sam@harborplumbing.example", outbound: OUT.footer });
    await baseline();
    deliver(footerEml);
    expect(await syncMailbox(env, "outreach")).toMatchObject({ replies: 1, stopped: 0 });
    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "replied" });
    expect((await getBusiness(env.DB, lead.businessId))!.lead_status).toBe("replied");
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
    expect((await inbound())[0].kind).toBe("reply");
  });

  it("a reply with no In-Reply-To matches by the sender address, case-insensitively, on any enrollment status newest first", async () => {
    const old = await seedLead("Old Co", { to: "Pat@BrightSmiles.example", outbound: null, status: "completed", nextDueAt: null });
    await baseline();
    deliver(eml({ from: "pat@brightsmiles.example", body: "Sure, let's talk." }));
    expect(await syncMailbox(env, "outreach")).toMatchObject({ matched: 1, replies: 1 });
    expect(await enrollment(old.enrollmentId)).toMatchObject({ status: "completed" }); // an ended sequence stays as it ended
    expect((await getBusiness(env.DB, old.businessId))!.lead_status).toBe("replied");
    expect((await inbound())[0]).toMatchObject({ business_id: old.businessId, enrollment_id: old.enrollmentId, in_reply_to: null });
  });

  it("a sender with several enrollments goes to the newest one", async () => {
    const a = await seedLead("First Co", { to: "pat@shared.example", outbound: null, status: "completed", nextDueAt: null });
    const b = await seedLead("Second Co", { to: "pat@shared.example", outbound: null });
    await env.DB.prepare(`UPDATE enrollments SET started_at = ? WHERE id = ?`).bind(new Date(NOW.getTime() - 30 * DAY).toISOString(), a.enrollmentId).run();
    await baseline();
    deliver(eml({ from: "pat@shared.example", body: "Yes please." }));
    await syncMailbox(env, "outreach");
    expect((await inbound())[0].business_id).toBe(b.businessId);
  });

  it("a reply to an ended sequence is still stored and classified", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply, status: "stopped", nextDueAt: null });
    await baseline();
    deliver(replyEml);
    expect(await syncMailbox(env, "outreach")).toMatchObject({ matched: 1, replies: 1 });
    expect((await inbound())[0]).toMatchObject({ kind: "reply", business_id: lead.businessId });
  });
});

describe("syncMailbox: bounces and automatic replies", () => {
  it("hard bounce marks bounced and lists the address", async () => {
    const lead = await seedLead("Old Plumber", { to: "owner@oldplumber.example", outbound: null });
    await baseline();
    deliver(bounceEml);
    expect(await syncMailbox(env, "outreach")).toEqual({ fetched: 1, matched: 1, replies: 0, stopped: 0, bounced: 1 });
    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "bounced", stopped_reason: "bounced" });
    expect((await listDoNotContact(env.DB)).map((d) => [d.value, d.reason])).toEqual([["owner@oldplumber.example", "bounced"]]);
    expect(await kinds(lead.businessId)).toContain("email_bounce");
    expect((await inbound())[0]).toMatchObject({ kind: "bounce_hard", business_id: lead.businessId, enrollment_id: lead.enrollmentId });
  });

  it("a hard bounce lists the address the DSN names, not the sender", async () => {
    const lead = await seedLead("Old Plumber", { to: "owner@oldplumber.example", outbound: OUT.reply });
    await baseline();
    deliver(bounceEml.replace("Auto-Submitted: auto-replied\n", `Auto-Submitted: auto-replied\nIn-Reply-To: ${OUT.reply}\n`));
    await syncMailbox(env, "outreach");
    expect((await listDoNotContact(env.DB)).map((d) => d.value)).toEqual(["owner@oldplumber.example"]);
    expect((await enrollment(lead.enrollmentId)).status).toBe("bounced");
  });

  it("a DSN naming an unusable recipient still bounces the sequence, listing the address it wrote to", async () => {
    const lead = await seedLead("Old Plumber", { to: "owner@oldplumber.example", outbound: OUT.reply });
    await baseline();
    deliver(bounceEml.replace("Auto-Submitted: auto-replied\n", `Auto-Submitted: auto-replied\nIn-Reply-To: ${OUT.reply}\n`).replace("Final-Recipient: rfc822; owner@oldplumber.example", "Final-Recipient: rfc822; garbage"));
    const eml = bounceEml.includes("Final-Recipient: rfc822; owner@oldplumber.example");
    expect(eml).toBe(true); // the fixture still has the line this test rewrites
    expect(await syncMailbox(env, "outreach")).toMatchObject({ bounced: 1 });
    expect((await enrollment(lead.enrollmentId)).status).toBe("bounced");
    expect((await listDoNotContact(env.DB)).map((d) => d.value)).toEqual(["owner@oldplumber.example"]);
    expect((await mailbox()).last_sync_error).toBeNull();
  });

  it("soft bounce changes nothing", async () => {
    const lead = await seedLead("Old Plumber", { to: "owner@oldplumber.example", outbound: null });
    await baseline();
    deliver(bounceEml.replace("Status: 5.1.1", "Status: 4.2.2"));
    expect(await syncMailbox(env, "outreach")).toEqual({ fetched: 1, matched: 1, replies: 0, stopped: 0, bounced: 0 });
    const e = await enrollment(lead.enrollmentId);
    expect(e).toMatchObject({ status: "active", next_due_at: new Date(NOW.getTime() + 3 * DAY).toISOString() });
    expect((await getBusiness(env.DB, lead.businessId))!.lead_status).toBe("contacted");
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
    expect(await kinds(lead.businessId)).toContain("email_bounce");
    expect((await inbound())[0].kind).toBe("bounce_soft");
  });

  it("out of office delays the next step by 7 days and keeps the lead status", async () => {
    const due = new Date(NOW.getTime() + 3 * DAY).toISOString();
    const lead = await seedLead("Summit Roofing", { to: "jules@summitroofing.example", outbound: OUT.ooo, nextDueAt: due });
    await baseline();
    deliver(oooEml);
    expect(await syncMailbox(env, "outreach")).toEqual({ fetched: 1, matched: 1, replies: 0, stopped: 0, bounced: 0 });
    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "active", next_due_at: new Date(NOW.getTime() + 10 * DAY).toISOString() });
    expect((await getBusiness(env.DB, lead.businessId))!.lead_status).toBe("contacted");
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
    expect((await inbound())[0]).toMatchObject({ kind: "auto_reply", processed_at: NOW.toISOString() });
    expect(await kinds(lead.businessId)).not.toContain("email_reply");
  });

  it("an out of office for a sequence that is not active, or has no due time, moves nothing", async () => {
    const stopped = await seedLead("Summit Roofing", { to: "jules@summitroofing.example", outbound: OUT.ooo, status: "stopped", nextDueAt: null });
    await baseline();
    deliver(oooEml);
    await syncMailbox(env, "outreach");
    expect(await enrollment(stopped.enrollmentId)).toMatchObject({ status: "stopped", next_due_at: null });
    expect((await inbound())[0].kind).toBe("auto_reply");
  });
});

describe("syncMailbox: hostile and odd mail", () => {
  it("unmatched mail is ignored and not stored", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    deliver(eml({ from: "stranger@nowhere.example", body: "Buy our SEO services" }), eml({ from: "x@y.example", body: "stop" }), "not an email at all \u0000\u0001");
    expect(await syncMailbox(env, "outreach")).toEqual({ fetched: 3, matched: 0, replies: 0, stopped: 0, bounced: 0 });
    expect(await inbound()).toHaveLength(0);
    expect((await mailbox()).imap_last_uid).toBe(3);
  });

  it("mail that names an unknown Message-ID and an unknown sender is ignored", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    deliver(eml({ from: "stranger@nowhere.example", inReplyTo: "<nothing@elsewhere.test>", body: "hello" }));
    expect((await syncMailbox(env, "outreach")).matched).toBe(0);
    expect(await inbound()).toHaveLength(0);
  });

  it("a message over 200 KB is parsed, stored truncated and matched", async () => {
    const lead = await seedLead("Big Thread", { to: "big@bigthread.example", outbound: OUT.huge });
    await baseline();
    deliver(hugeEml);
    expect(await syncMailbox(env, "outreach")).toMatchObject({ matched: 1, replies: 1 });
    const row = (await inbound())[0];
    expect(row.business_id).toBe(lead.businessId);
    expect(row.text.length).toBeLessThanOrEqual(20_000);
  });

  it("a long References list is matched on its last entries without error", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    const refs = Array.from({ length: 400 }, (_, i) => `<ancestor-${i}@lead.test>`).join(" ") + ` ${OUT.reply}`;
    deliver(eml({ from: "someone-else@lead.example", body: "Sounds good.", headers: `References: ${refs}\r\n` }));
    expect(await syncMailbox(env, "outreach")).toMatchObject({ matched: 1, replies: 1 });
    expect((await inbound())[0].business_id).toBe(lead.businessId);
  });
});

describe("syncMailbox: idempotence and recovery", () => {
  it("the same uid is not processed twice", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    const [uid] = deliver(replyEml);
    await syncMailbox(env, "outreach");
    // the server serves the same uid again (the cursor was lost); nothing is stored or applied a second time
    await saveMailbox(env.DB, "outreach", { imap_last_uid: uid - 1 });
    await env.DB.prepare(`UPDATE enrollments SET status = 'active', stopped_reason = NULL WHERE id = ?`).bind(lead.enrollmentId).run();
    const again = await syncMailbox(env, "outreach");
    expect(again).toMatchObject({ fetched: 1, matched: 0, replies: 0 });
    expect(await inbound()).toHaveLength(1);
    expect((await enrollment(lead.enrollmentId)).status).toBe("active"); // the effects were not applied again
    expect((await listActivity(env.DB, lead.businessId)).filter((a) => a.kind === "email_reply")).toHaveLength(1);
    expect((await mailbox()).imap_last_uid).toBe(uid);
  });

  it("a stored message whose effects never ran is finished on the next run", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    const [uid] = deliver(replyEml);
    // a crash between the insert and the effects
    await env.DB.prepare(`INSERT INTO messages (id, direction, mailbox_key, business_id, enrollment_id, message_id, in_reply_to, counterpart, subject, text, status, kind, imap_uid, created_at, processed_at)
      VALUES ('crashed', 'in', 'outreach', ?, ?, '<CAK7r2b1e3F9@mail.brightsmiles.example>', ?, 'pat@brightsmiles.example', 's', 't', 'received', 'reply', ?, ?, NULL)`)
      .bind(lead.businessId, lead.enrollmentId, OUT.reply, uid, NOW.toISOString()).run();
    expect(await syncMailbox(env, "outreach")).toMatchObject({ fetched: 1, matched: 1, replies: 1 });
    expect(await inbound()).toHaveLength(1);
    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "replied" });
    expect((await inbound())[0].processed_at).toBe(NOW.toISOString());
    expect((await listActivity(env.DB, lead.businessId)).filter((a) => a.kind === "email_reply")).toHaveLength(1);
  });

  it("a failure while applying a message records the error and does not advance the baseline", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    const before = (await mailbox()).imap_last_uid;
    deliver(replyEml);
    await env.DB.prepare(`CREATE TRIGGER no_inbound BEFORE INSERT ON messages WHEN NEW.direction = 'in' BEGIN SELECT RAISE(ABORT, 'messages are down'); END`).run();
    try {
      const r = await syncMailbox(env, "outreach");
      expect(r).toMatchObject({ matched: 0 });
      expect(await mailbox()).toMatchObject({ imap_last_uid: before });
      expect((await mailbox()).last_sync_error).toContain("messages are down");
    } finally {
      await env.DB.prepare(`DROP TRIGGER no_inbound`).run();
    }
    // the next run picks the message up again
    expect(await syncMailbox(env, "outreach")).toMatchObject({ replies: 1 });
  });

  it("imap error is recorded in last_sync_error and does not throw", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    await saveMailbox(env.DB, "outreach", { imap_last_uid: 4, last_sync_at: "2026-11-18T10:00:00.000Z" });
    box.fail = new Error("LOGIN failed for hello@outreach.test with pw-out");
    const r = await syncMailbox(env, "outreach");
    expect(r).toMatchObject({ fetched: 0, matched: 0 });
    const mb = await mailbox();
    expect(mb.last_sync_error).toContain("LOGIN failed");
    expect(mb.last_sync_error).not.toContain("pw-out");
    expect(mb).toMatchObject({ imap_last_uid: 4, last_sync_at: "2026-11-18T10:00:00.000Z" });
    box.fail = null; box.uidNext = 5;
    await syncMailbox(env, "outreach");
    expect((await mailbox()).last_sync_error).toBeNull();
  });
});

describe("syncMailbox: windows and oversized mail", () => {
  it("drains a backlog over up to 4 windows per run and persists after each", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    box.window = 2;
    deliver(...Array.from({ length: 10 }, (_, i) => eml({ from: `nobody${i}@x.example`, body: "hi" })));
    const first = await syncMailbox(env, "outreach");
    expect(first.fetched).toBe(8);
    expect(box.calls).toEqual([0, 2, 4, 6]);
    expect((await mailbox()).imap_last_uid).toBe(8);
    const second = await syncMailbox(env, "outreach");
    expect(second.fetched).toBe(2);
    expect(box.calls.slice(4)).toEqual([8]);
    expect((await mailbox()).imap_last_uid).toBe(10);
  });

  it("an oversized message is skipped with a warning, the baseline moves past it, and the run is a success", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    const uids = deliver(eml({ from: "nobody@x.example", body: "big" }), replyEml);
    box.oversized.add(uids[0]);
    const r = await syncMailbox(env, "outreach");
    expect(r).toMatchObject({ fetched: 1, replies: 1 });
    expect((await mailbox())).toMatchObject({ imap_last_uid: uids[1], last_sync_at: NOW.toISOString() });
    expect((await mailbox()).last_sync_error).toBe(`skipped 1 oversized message(s): uids ${uids[0]}`);
    expect((await enrollment(lead.enrollmentId)).status).toBe("replied");
    expect(warnings).toEqual([`mail sync outreach: skipped 1 oversized message(s): uids ${uids[0]}`]);
  });
});

describe("syncMailbox: a message that cannot be applied", () => {
  const POISON = `CREATE TRIGGER poison BEFORE INSERT ON messages WHEN NEW.subject LIKE '%POISON%' BEGIN SELECT RAISE(ABORT, 'poisoned'); END`;
  const fromLead = (from: string, subject: string) => eml({ from, subject, body: "hello there" });
  afterEach(async () => { await env.DB.prepare(`DROP TRIGGER IF EXISTS poison`).run(); });

  async function threeInAWindow() {
    const a = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    const b = await seedLead("Poison Co", { to: "poison@poison.example", outbound: null });
    const c = await seedLead("Lakeview Vet", { to: "dana@lakeviewvet.example", outbound: OUT.stop });
    await baseline();
    deliver(replyEml, fromLead("poison@poison.example", "POISON"), stopEml);
    await env.DB.prepare(POISON).run();
    return { a, b, c };
  }

  it("a poison message in the middle of a window does not stop the later messages, and the cursor holds", async () => {
    const { a, b, c } = await threeInAWindow();
    const r = await syncMailbox(env, "outreach");
    expect(r).toMatchObject({ fetched: 3, replies: 1, stopped: 1 });
    expect(r.error).toMatch(/^failed on uid 2: .*poisoned/);
    expect((await enrollment(a.enrollmentId)).status).toBe("replied");
    expect((await enrollment(c.enrollmentId)).status).toBe("stopped"); // the stop behind the bad message was applied
    expect((await enrollment(b.enrollmentId)).status).toBe("active");
    expect(await mailbox()).toMatchObject({ imap_last_uid: 0, imap_fail_count: 1, imap_fail_cursor: 0 });
    expect((await mailbox()).last_sync_error).toBe(r.error);
    // the next run re-reads the window; the two applied messages are skipped, not applied again
    const again = await syncMailbox(env, "outreach");
    expect(again).toMatchObject({ fetched: 3, replies: 0, stopped: 0 });
    expect(await mailbox()).toMatchObject({ imap_last_uid: 0, imap_fail_count: 2 });
    expect((await listActivity(env.DB, a.businessId)).filter((x) => x.kind === "email_reply")).toHaveLength(1);
  });

  it("after 5 failing runs the cursor moves past the window and the give-up is recorded", async () => {
    const { b } = await threeInAWindow();
    for (let i = 1; i <= 4; i++) {
      expect((await syncMailbox(env, "outreach")).error).toBeDefined();
      expect(await mailbox()).toMatchObject({ imap_last_uid: 0, imap_fail_count: i });
    }
    const fifth = await syncMailbox(env, "outreach");
    expect(fifth.error).toMatch(/^gave up on uid 2 after 5 attempts: .*poisoned/);
    expect(await mailbox()).toMatchObject({ imap_last_uid: 3, imap_fail_count: 0, imap_fail_cursor: null, last_sync_at: NOW.toISOString() });
    expect((await mailbox()).last_sync_error).toBe(fifth.error);
    expect(warnings.some((w) => w.includes("gave up on uid 2"))).toBe(true);
    expect((await enrollment(b.enrollmentId)).status).toBe("active"); // that one message was dropped, nothing else
    // and the mailbox is flowing again
    deliver(eml({ from: "nobody@x.example", body: "hi" }));
    expect((await syncMailbox(env, "outreach")).error).toBeUndefined();
    expect((await mailbox()).imap_last_uid).toBe(4);
  });

  it("the failure counter resets after a clean window", async () => {
    await threeInAWindow();
    await syncMailbox(env, "outreach"); await syncMailbox(env, "outreach");
    expect((await mailbox()).imap_fail_count).toBe(2);
    await env.DB.prepare(`DROP TRIGGER poison`).run();
    const ok = await syncMailbox(env, "outreach");
    expect(ok.error).toBeUndefined();
    expect(await mailbox()).toMatchObject({ imap_last_uid: 3, imap_fail_count: 0, imap_fail_cursor: null, last_sync_error: null });
    // a later failure starts counting from one again
    deliver(fromLead("poison@poison.example", "POISON again"));
    await env.DB.prepare(POISON).run();
    await syncMailbox(env, "outreach");
    expect(await mailbox()).toMatchObject({ imap_last_uid: 3, imap_fail_count: 1, imap_fail_cursor: 3 });
  });

  it("a different failing window starts the count over", async () => {
    await threeInAWindow();
    await syncMailbox(env, "outreach");
    await saveMailbox(env.DB, "outreach", { imap_last_uid: 1 }); // the cursor is somewhere else now
    await syncMailbox(env, "outreach");
    expect(await mailbox()).toMatchObject({ imap_fail_count: 1, imap_fail_cursor: 1 });
  });

  it("a 2 MB Subject is stored clamped and its effect applies", async () => {
    const lead = await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    deliver(eml({ from: "pat@brightsmiles.example", inReplyTo: OUT.reply, subject: "S".repeat(2_000_000), body: "Yes please." }));
    const r = await syncMailbox(env, "outreach");
    expect(r).toMatchObject({ matched: 1, replies: 1 });
    expect(r.error).toBeUndefined();
    expect((await enrollment(lead.enrollmentId)).status).toBe("replied");
    const row = (await inbound())[0];
    expect(row.subject).toHaveLength(998);
    expect((await listActivity(env.DB, lead.businessId)).find((x) => x.kind === "email_reply")!.detail!.length).toBeLessThan(400);
  });

  it("an oversized Message-ID, In-Reply-To and sender are clamped too", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    deliver(
      `From: pat@brightsmiles.example\r\nSubject: Re\r\nMessage-ID: <${"m".repeat(5000)}@x.test>\r\nIn-Reply-To: ${OUT.reply}\r\nReferences: ${OUT.reply} <${"r".repeat(5000)}@x.test>\r\n\r\nok\r\n`,
    );
    expect((await syncMailbox(env, "outreach")).replies).toBe(1);
    const row = (await inbound())[0];
    expect(row.message_id.length).toBeLessThanOrEqual(998);
    expect(row.in_reply_to.length).toBeLessThanOrEqual(998);
    expect(row.counterpart.length).toBeLessThanOrEqual(320);
  });

  it("a stop with no usable address still stops, and the unusable stored address is not listed", async () => {
    const lead = await seedLead("Lakeview Vet", { to: "not-an-email", outbound: OUT.stop });
    await baseline();
    deliver(`Subject: Re: hello\r\nMessage-ID: <nofrom@x.test>\r\nIn-Reply-To: ${OUT.stop}\r\n\r\nStop\r\n`);
    const r = await syncMailbox(env, "outreach");
    expect(r).toMatchObject({ stopped: 1 });
    expect(r.error).toBeUndefined();
    expect(await enrollment(lead.enrollmentId)).toMatchObject({ status: "stopped", stopped_reason: "opt_out" });
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
    expect((await inbound())[0].processed_at).toBe(NOW.toISOString());
  });
});

describe("syncMailbox: configuration", () => {
  it("throws a plain error when the mailbox is not configured", async () => {
    await saveMailbox(env.DB, "outreach", { imap_host: "" });
    await expect(syncMailbox(env, "outreach")).rejects.toThrow("mailbox is not configured");
    await expect(syncMailbox({ ...env, MAILBOX_OUTREACH_PASSWORD: undefined } as typeof env, "outreach")).rejects.toThrow();
    expect(box.calls).toEqual([]);
  });
});

describe("syncAllMailboxes", () => {
  it("syncs only enabled mailboxes with a password secret", async () => {
    await saveMailbox(env.DB, "main", { enabled: 1 });
    const seen: string[] = [];
    setMailDeps({ now: () => NOW, imap: async (mb, pw, since) => { seen.push(`${mb.key}:${pw}`); return fakeImap(mb, pw, since); } });
    await syncAllMailboxes(env);
    expect(seen).toEqual(["outreach:pw-out", "main:pw-main"]);
    seen.length = 0;
    await saveMailbox(env.DB, "outreach", { enabled: 0 });
    await syncAllMailboxes({ ...env, MAILBOX_MAIN_PASSWORD: undefined } as typeof env);
    expect(seen).toEqual([]);
  });

  it("one mailbox failing does not stop the other, and nothing throws", async () => {
    await saveMailbox(env.DB, "main", { enabled: 1 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    setMailDeps({ now: () => NOW, imap: async (mb, pw, since) => { if (mb.key === "outreach") throw new Error(`boom with ${pw}`); return fakeImap(mb, pw, since); } });
    await expect(syncAllMailboxes(env)).resolves.toBeUndefined();
    const out = await getMailbox(env.DB, "outreach");
    expect(out.last_sync_error).toContain("boom");
    expect(out.last_sync_error).not.toContain("pw-out");
    expect(await getMailbox(env.DB, "main")).toMatchObject({ last_sync_error: null, imap_last_uid: 0, last_sync_at: NOW.toISOString() });
  });

  it("a mailbox that is not configured gets last_sync_error instead of a throw", async () => {
    await saveMailbox(env.DB, "outreach", { imap_host: "" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(syncAllMailboxes(env)).resolves.toBeUndefined();
    expect((await mailbox()).last_sync_error).toBe("mailbox is not configured");
  });
});

describe("POST /api/mailboxes/:key/sync", () => {
  const post = (key: string) => SELF.fetch(`https://x/api/mailboxes/${key}/sync`, { method: "POST", headers: { cookie } });

  it("returns the summary", async () => {
    await seedLead("Bright Smiles", { to: "pat@brightsmiles.example", outbound: OUT.reply });
    await baseline();
    deliver(replyEml);
    const r = await post("outreach");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ fetched: 1, matched: 1, replies: 1, stopped: 0, bounced: 0 });
  });

  it("is a 400 with the reason when the mailbox is not configured", async () => {
    await saveMailbox(env.DB, "outreach", { imap_host: "" });
    const r = await post("outreach");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "mailbox is not configured" });
  });

  it("an unknown mailbox is 404 and a signed-out call is refused", async () => {
    expect((await post("nope")).status).toBe(404);
    expect((await SELF.fetch("https://x/api/mailboxes/outreach/sync", { method: "POST" })).status).toBe(401);
  });

  it("reports an IMAP failure in the body", async () => {
    box.fail = new Error("connection refused");
    const r = await post("outreach");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ fetched: 0, error: "connection refused" });
  });
});

it("the deps used by the tests are the injected ones", () => {
  expect(getMailDeps().imap).toBe(fakeImap);
});
