import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setMailDeps } from "../src/worker/mail/deps";
import type { OutboundMessage } from "../src/worker/mail/types";
import { createApproval, type Approval } from "../src/worker/db/approvals";
import { approve, reject } from "../src/worker/approvals/decide";
import { buildEmailSendApproval } from "../src/worker/approvals/emailSend";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { getBusiness, upsertBusiness } from "../src/worker/db/businesses";
import { replaceContacts } from "../src/worker/db/contacts";
import { insertDraft } from "../src/worker/db/drafts";
import { insertAudit } from "../src/worker/db/audits";
import { listActivity } from "../src/worker/db/activity";
import { addDoNotContact, listDoNotContact } from "../src/worker/db/doNotContact";
import { listSuppressions } from "../src/worker/db/suppression";
import { createCampaign, saveStep, listSteps } from "../src/worker/db/campaigns";
import { setAfterSendForTests } from "../src/worker/mail/send";
import { addBusinessDays } from "../src/worker/sequence/dates";
import { RULE_PHRASES, VETTED_RULE_PHRASES, advanceAfterSend, problemOne, scanDueSteps, startSequence } from "../src/worker/sequence/engine";
import { DEFAULT_STEPS } from "../src/worker/db/campaigns";
import { renderTemplate } from "../src/worker/sequence/template";
import { stopOutreach } from "../src/worker/sequence/stop";
import type { Enrollment } from "../src/worker/sequence/types";
import type { Finding } from "../src/worker/types";

// Wednesday. Offsets from it: business day 5 = Wed 25 Nov, calendar day 7 = Wed 25 Nov, business day 12 = Fri 4 Dec.
const NOW = new Date("2026-11-18T10:00:00.000Z");
const at = (iso: string) => new Date(iso);
const CONFIG = {
  enabled: 1 as const, smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "hello@outreach.test", from_email: "hello@outreach.test", from_name: "Logan at Siteline",
};
const FINDING: Finding = {
  code: "ai_cro_0", category: "cro", severity: "critical", points: 0, source: "ai", recommendation: "Add one clear button.",
  evidence: "Weak call to action. Visitors cannot tell what to do next.",
};

let smtpCalls: OutboundMessage[] = [];
let clock = NOW;
let businessId = "", campaignId = "", contactId = "";

const enrollmentRows = async () => (await env.DB.prepare(`SELECT * FROM enrollments ORDER BY started_at, id`).all<Enrollment>()).results;
const enrollment = async (id: string) => (await env.DB.prepare(`SELECT * FROM enrollments WHERE id = ?`).bind(id).first<Enrollment>())!;
const approvalRows = async () => (await env.DB.prepare(`SELECT * FROM approvals ORDER BY created_at, id`).all<Approval & { payload: string }>()).results
  .map((r) => ({ ...r, payload: JSON.parse(r.payload as unknown as string) as Record<string, any> }));
const messageRows = async () => (await env.DB.prepare(`SELECT * FROM messages ORDER BY created_at, id`).all<Record<string, any>>()).results;

async function seedLead(name: string, o: { website?: string; email?: string | null; person?: string | null; audit?: Finding[] | null; draft?: boolean } = {}) {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const id = (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: o.website ?? "https://acme.test", mapsUrl: null, rating: null, reviewCount: null }, s.id)).id;
  let cid: string | null = null;
  if (o.email !== null) {
    const list = await replaceContacts(env.DB, id, [
      { type: "email", value: o.email ?? "dana@acme.test", source_url: "https://acme.test/contact", person_name: o.person === undefined ? "Dana Smith" : o.person, role: "Owner", confidence: 0.9 },
      { type: "email", value: "info@acme.test", source_url: "https://acme.test", person_name: null, role: null, confidence: 0.5 },
    ]);
    cid = list.find((c) => c.value === (o.email ?? "dana@acme.test"))!.id;
  }
  const audit = o.audit === null ? null : await insertAudit(env.DB, {
    business_id: id, site_status: "ok", partial: false, pagespeed_mobile: 40, lcp_ms: 3000, cls: 0.1, mobile_friendly: true, https: true, has_title: true,
    has_meta_description: true, has_contact_form: true, copyright_year: 2024, latest_content_date: null, broken_link_count: 0, platform: "wix", seo_score: 70,
    accessibility_score: 70, score: 50, offer: "new_site", findings: o.audit ?? [FINDING], raw_r2_key: null, mail_warning: null, health_score: 50, niche: "plumber",
    category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {},
  });
  if (o.draft !== false) {
    await insertDraft(env.DB, { business_id: id, audit_id: audit?.id ?? null, to_contact_id: cid, recipient_reason: "owner", subject: "Quick video about Acme Plumbing's website",
      body: "Hi Dana,\n\nI made a short video about your site.", offer: "new_site", steering_note: null });
  }
  return { id, contactId: cid };
}

beforeEach(async () => {
  smtpCalls = []; clock = NOW;
  setMailDeps({ smtp: async (_mb, _pw, msg) => { smtpCalls.push(msg); }, now: () => clock });
  await env.DB.batch([
    ...["enrollments", "approvals", "messages", "campaigns", "do_not_contact", "suppressions", "activity", "audit_reports", "audits", "drafts", "contacts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  ]);
  await saveMailbox(env.DB, "outreach", { ...CONFIG, warmup_started_at: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  await saveSettings(env.DB, { physical_address: "12 Main St, Boise ID 83702", opt_out_line: "Reply stop.", signature: "Logan", signature_json: "" });
  const lead = await seedLead("Acme Plumbing");
  businessId = lead.id; contactId = lead.contactId!;
  campaignId = (await createCampaign(env.DB, { name: "Boise plumbers", niche: "plumber", region: "Treasure Valley, ID", towns: ["Boise, ID"] })).id;
});
afterEach(() => { setMailDeps(null); setAfterSendForTests(null); });

/** Starts the sequence and approves step 0, which sends it and advances the enrollment. */
async function startAndSendStep0() {
  const r = await startSequence(env, { businessId, campaignId });
  if (!r.ok) throw new Error(`start failed: ${r.error}`);
  expect(await approve(env, r.approvalId)).toEqual({ ok: true });
  return r;
}

/** An enrollment row with no mail history, for tests of one scan decision. */
async function seedEnrollment(o: Partial<Enrollment> & { id?: string } = {}): Promise<string> {
  const id = o.id ?? crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, next_due_at, started_at, last_sent_at, last_error, stopped_reason, last_sent_step)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, o.business_id ?? businessId, o.campaign_id ?? campaignId, o.mailbox_key ?? "outreach", o.to_email ?? "dana@acme.test", o.status ?? "active",
    o.next_step_index ?? 1, o.next_due_at === undefined ? NOW.toISOString() : o.next_due_at, o.started_at ?? NOW.toISOString(), o.last_sent_at ?? null, o.last_error ?? null,
    o.stopped_reason ?? null, o.last_sent_step === undefined ? 0 : o.last_sent_step).run();
  return id;
}

/** A pending step approval built by hand, the way a leftover or MCP-made one would exist. */
async function stepApproval(enrollmentId: string, stepIndex: number, over: Record<string, unknown> = {}) {
  const settings = (await env.DB.prepare(`SELECT * FROM settings WHERE id = 1`).first())! as never;
  return createApproval(env.DB, buildEmailSendApproval({
    mailbox: "outreach", businessId, to: "dana@acme.test", subject: "Re: Quick video", body: "Hi Dana, just checking in.", includeFooter: true,
    enrollmentId, stepIndex, title: `Step ${stepIndex}`, drafted_by: "job", ...over,
  } as never, settings));
}

describe("addBusinessDays", () => {
  it("addBusinessDays skips weekends", () => {
    expect(addBusinessDays(at("2026-11-20T10:00:00Z"), 1).toISOString()).toBe("2026-11-23T10:00:00.000Z"); // Friday + 1 = Monday
    expect(addBusinessDays(at("2026-11-18T10:00:00Z"), 5).toISOString()).toBe("2026-11-25T10:00:00.000Z"); // Wednesday + 5 = next Wednesday
    expect(addBusinessDays(at("2026-11-21T09:30:00Z"), 1).toISOString()).toBe("2026-11-23T09:30:00.000Z"); // Saturday + 1 = Monday
    expect(addBusinessDays(at("2026-11-18T10:00:00Z"), 12).toISOString()).toBe("2026-12-04T10:00:00.000Z");
    expect(addBusinessDays(at("2026-11-22T10:00:00Z"), 0).toISOString()).toBe("2026-11-22T10:00:00.000Z");
    expect(() => addBusinessDays(NOW, -1)).toThrow();
  });
});

describe("startSequence", () => {
  it("start creates enrollment and step 0 approval for the draft recipient", async () => {
    // the draft's contact is a person; pickRecipient would also choose it, so point the draft at the generic inbox to prove the draft wins
    const generic = (await env.DB.prepare(`SELECT id FROM contacts WHERE value = 'info@acme.test'`).first<{ id: string }>())!.id;
    await env.DB.prepare(`UPDATE drafts SET to_contact_id = ?, include_footer = 0`).bind(generic).run();
    const r = await startSequence(env, { businessId, campaignId });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const rows = await enrollmentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: r.enrollmentId, business_id: businessId, campaign_id: campaignId, mailbox_key: "outreach", to_email: "info@acme.test", status: "active",
      next_step_index: 1, next_due_at: null, started_at: NOW.toISOString(), last_sent_at: null, last_sent_step: null, last_error: null, stopped_reason: null,
    });
    const approvals = await approvalRows();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: r.approvalId, kind: "email.send", status: "pending", drafted_by: "logan", record_type: "enrollment", record_id: r.enrollmentId });
    expect(approvals[0].payload).toMatchObject({
      mailbox: "outreach", businessId, to: "info@acme.test", subject: "Quick video about Acme Plumbing's website", enrollmentId: r.enrollmentId, stepIndex: 0, includeFooter: false,
    });
    expect(approvals[0].payload.body).toContain("short video");
    expect(approvals[0].payload.inReplyTo).toBeUndefined();
  });

  it("start falls back to the best email contact when the draft names none", async () => {
    await env.DB.prepare(`UPDATE drafts SET to_contact_id = NULL`).run();
    const r = await startSequence(env, { businessId, campaignId });
    expect(r.ok).toBe(true);
    expect((await enrollmentRows())[0].to_email).toBe("dana@acme.test");
  });

  it("start without a draft is 400", async () => {
    await env.DB.prepare(`DELETE FROM drafts`).run();
    const r = await startSequence(env, { businessId, campaignId });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(await enrollmentRows()).toHaveLength(0);
    expect(await approvalRows()).toHaveLength(0);
  });

  it("start without an email address is 400, an unknown lead or campaign 404", async () => {
    const noMail = await seedLead("No Mail Co", { website: "https://nomail.test", email: null });
    expect(await startSequence(env, { businessId: noMail.id, campaignId })).toEqual({ ok: false, error: "no email address", status: 400 });
    expect(await startSequence(env, { businessId: "nope", campaignId })).toMatchObject({ ok: false, status: 404 });
    expect(await startSequence(env, { businessId, campaignId: "nope" })).toMatchObject({ ok: false, status: 404 });
    expect(await enrollmentRows()).toHaveLength(0);
  });

  it("start on a conflict is 422 and creates nothing", async () => {
    await addDoNotContact(env.DB, { kind: "email", value: "dana@acme.test", reason: "opt_out" });
    await env.DB.prepare(`UPDATE drafts SET to_contact_id = ?`).bind(contactId).run();
    const r = await startSequence(env, { businessId, campaignId });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect((r as { error: string }).error).toContain("do-not-contact");
    expect(await enrollmentRows()).toHaveLength(0);
    expect(await approvalRows()).toHaveLength(0);
  });

  it("second start is 409", async () => {
    expect((await startSequence(env, { businessId, campaignId })).ok).toBe(true);
    const again = await startSequence(env, { businessId, campaignId });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(await enrollmentRows()).toHaveLength(1);
    expect(await approvalRows()).toHaveLength(1);
  });

  it("a draft that is not a valid email is 422 and creates nothing", async () => {
    await env.DB.prepare(`UPDATE drafts SET subject = 'Hi\nBcc: x@y.test'`).run(); // fails the email.send payload schema
    const r = await startSequence(env, { businessId, campaignId });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(await enrollmentRows()).toHaveLength(0);
    expect(await approvalRows()).toHaveLength(0);
  });

  it("an approval that cannot be stored removes the enrollment again", async () => {
    await env.DB.prepare(`CREATE TRIGGER fail_approval BEFORE INSERT ON approvals BEGIN SELECT RAISE(ABORT, 'approvals are down'); END`).run();
    try {
      await expect(startSequence(env, { businessId, campaignId })).rejects.toThrow("approvals are down");
    } finally { await env.DB.prepare(`DROP TRIGGER fail_approval`).run(); }
    expect(await enrollmentRows()).toHaveLength(0);
    expect((await startSequence(env, { businessId, campaignId })).ok).toBe(true); // the lead is not stuck as enrolled
  });
});

describe("after send and the due-step scan", () => {
  it("sending step 0 records it and schedules step 1 no earlier than business day 5", async () => {
    const r = await startAndSendStep0();
    const e = await enrollment(r.enrollmentId);
    expect(e).toMatchObject({ status: "active", last_sent_step: 0, last_sent_at: NOW.toISOString(), next_step_index: 1, next_due_at: "2026-11-25T10:00:00.000Z" });
  });

  it("scan creates the step 1 approval only when due", async () => {
    const r = await startAndSendStep0();
    const before = await scanDueSteps(env, at("2026-11-24T10:00:00Z"));
    expect(before).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
    expect(await approvalRows()).toHaveLength(1); // only the step 0 approval
    const due = await scanDueSteps(env, at("2026-11-25T10:00:00Z"));
    expect(due).toEqual({ approvalsCreated: 1, calls: 0, skipped: 0 });
    const approvals = await approvalRows();
    expect(approvals).toHaveLength(2);
    const a = approvals[1];
    expect(a).toMatchObject({ kind: "email.send", status: "pending", drafted_by: "job", record_type: "enrollment", record_id: r.enrollmentId });
    const token = (await env.DB.prepare(`SELECT token FROM audit_reports WHERE business_id = ?`).bind(businessId).first<{ token: string }>())!.token;
    const sent0 = (await messageRows())[0];
    expect(a.payload).toMatchObject({
      mailbox: "outreach", businessId, to: "dana@acme.test", enrollmentId: r.enrollmentId, stepIndex: 1, includeFooter: true,
      subject: "Re: Quick video about Acme Plumbing's website", inReplyTo: sent0.message_id,
    });
    expect(a.payload.body).toMatch(/^Hi Dana,/);
    expect(a.payload.body).toContain(`https://go.hellositeline.test/r/${token}`);
    expect(a.payload.body).not.toMatch(/[{}]/);
    expect((await enrollment(r.enrollmentId)).last_error).toBeNull();
  });

  it("the greeting falls back to '<Business> team' when no contact name is known", async () => {
    await env.DB.prepare(`UPDATE contacts SET person_name = NULL`).run();
    await startAndSendStep0();
    await scanDueSteps(env, at("2026-11-25T10:00:00Z"));
    expect((await approvalRows())[1].payload.body).toMatch(/^Hi Acme Plumbing team,/);
  });

  it("scan twice does not duplicate", async () => {
    await startAndSendStep0();
    const t = at("2026-11-25T10:00:00Z");
    expect((await scanDueSteps(env, t)).approvalsCreated).toBe(1);
    expect(await scanDueSteps(env, t)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
    expect(await approvalRows()).toHaveLength(2);
  });

  it("two scans running at once create one approval", async () => {
    await startAndSendStep0();
    const t = at("2026-11-25T10:00:00Z");
    const [a, b] = await Promise.all([scanDueSteps(env, t), scanDueSteps(env, t)]);
    expect(a.approvalsCreated + b.approvalsCreated).toBe(1);
    expect(await approvalRows()).toHaveLength(2);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_reports`).first<{ n: number }>()).toEqual({ n: 1 }); // the link token is reused, not minted twice
  });

  it("an approval being sent right now also blocks a duplicate for the same step", async () => {
    const id = await seedEnrollment({ next_step_index: 1 });
    const a = await stepApproval(id, 1);
    await env.DB.prepare(`UPDATE approvals SET status = 'approved' WHERE id = ?`).bind(a.id).run(); // claimed by approve(), send in flight
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
    expect(await approvalRows()).toHaveLength(1);
  });

  it("an enrollment whose step 0 has not been sent is never scanned", async () => {
    await seedEnrollment({ next_step_index: 1, next_due_at: null, last_sent_step: null });
    await seedEnrollment({ business_id: "other", next_step_index: 1, next_due_at: "2020-01-01T00:00:00Z", last_sent_step: null });
    expect(await scanDueSteps(env, at("2027-01-01T00:00:00Z"))).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
    expect(await approvalRows()).toHaveLength(0);
  });

  it("only active enrollments are scanned", async () => {
    for (const status of ["nurture", "replied", "stopped", "bounced", "completed"] as const) await seedEnrollment({ status, business_id: `b-${status}` });
    expect(await scanDueSteps(env, at("2027-01-01T00:00:00Z"))).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
  });

  it("call step sets follow_up_at and advances without an approval", async () => {
    const id = await seedEnrollment({ next_step_index: 2, last_sent_step: 1, last_sent_at: "2026-11-25T10:00:00.000Z", next_due_at: "2026-11-25T10:00:00.000Z" });
    const t = at("2026-11-25T10:00:00Z");
    expect(await scanDueSteps(env, t)).toEqual({ approvalsCreated: 0, calls: 1, skipped: 0 });
    expect(await approvalRows()).toHaveLength(0);
    expect((await getBusiness(env.DB, businessId))!.follow_up_at).toBe("2026-11-25");
    const e = await enrollment(id);
    // Email 3 is business day 12 (4 Dec); the call at 25 Nov + 3 business days is 30 Nov, so the step offset wins
    expect(e).toMatchObject({ status: "active", next_step_index: 3, next_due_at: "2026-12-04T10:00:00.000Z" });
    expect((await listActivity(env.DB, businessId)).map((a) => a.detail)).toContainEqual(expect.stringContaining("Call due"));
    expect((await scanDueSteps(env, t)).calls).toBe(0); // not due again
  });

  it("one scan handles at most 40 enrollments, oldest due first, and the next scan takes the rest", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      const lead = await seedLead(`Bulk ${i}`, { website: `https://bulk${i}.test`, email: `owner${i}@bulk${i}.test` });
      // enrollment 0 has been due the longest
      ids.push(await seedEnrollment({ business_id: lead.id, to_email: `owner${i}@bulk${i}.test`, next_due_at: new Date(NOW.getTime() - (60 - i) * 60_000).toISOString() }));
    }
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 40, calls: 0, skipped: 0 });
    const open = new Set((await approvalRows()).map((a) => a.record_id));
    expect(open.size).toBe(40);
    expect(ids.slice(0, 40).every((id) => open.has(id))).toBe(true);
    expect(ids.slice(40).some((id) => open.has(id))).toBe(false);
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 5, calls: 0, skipped: 0 });
    expect(new Set((await approvalRows()).map((a) => a.record_id)).size).toBe(45);
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
  });

  it("unfilled merge field skips the step and records last_error", async () => {
    await saveStep(env.DB, campaignId, { idx: 1, kind: "email", offset_days: 5, offset_kind: "business", subject: "Re: {Business}", variants: ["Hi {Name}, see {link} about {nope}."] });
    const id = await seedEnrollment();
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 1 });
    expect((await enrollment(id)).last_error).toContain("nope");
    expect(await approvalRows()).toHaveLength(0);
    expect((await enrollment(id)).next_step_index).toBe(1); // still waiting: fix the template and the next scan picks it up
  });

  it("OUTREACH_LINK_BASE unset or unusable skips the step and never emits another host", async () => {
    const e = env as { OUTREACH_LINK_BASE?: string };
    const saved = e.OUTREACH_LINK_BASE;
    const id = await seedEnrollment();
    try {
      for (const bad of [undefined, "", "go.example.test/not a url", "http://go.example.test", "https://acme-demo.someone.workers.dev"]) {
        e.OUTREACH_LINK_BASE = bad;
        expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 1 });
        expect((await enrollment(id)).last_error).toContain("OUTREACH_LINK_BASE is not set");
        if (bad === undefined || bad === "") expect((await enrollment(id)).last_error).toBe("OUTREACH_LINK_BASE is not set");
      }
      expect((await enrollment(id)).last_error).toContain("workers.dev");
      expect(await approvalRows()).toHaveLength(0);
      e.OUTREACH_LINK_BASE = "https://go.hellositeline.test/"; // a trailing slash does not double up
      expect((await scanDueSteps(env, NOW)).approvalsCreated).toBe(1);
      expect((await approvalRows())[0].payload.body).toMatch(/https:\/\/go\.hellositeline\.test\/r\/[\w-]+/);
      expect((await enrollment(id)).last_error).toBeNull();
    } finally { e.OUTREACH_LINK_BASE = saved; }
  });

  it("a lead with no audit cannot be given a link", async () => {
    await env.DB.prepare(`DELETE FROM audits`).run();
    const id = await seedEnrollment();
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 1 });
    expect((await enrollment(id)).last_error).toContain("audit");
  });

  it("a conflict that appears after the start sets last_error and creates no approval", async () => {
    const id = await seedEnrollment();
    await addDoNotContact(env.DB, { kind: "domain", value: "acme.test", reason: "client" });
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 1 });
    expect((await enrollment(id)).last_error).toContain("do-not-contact");
    expect(await approvalRows()).toHaveLength(0);
  });

  it("late approval keeps a 3 business day gap before the next step", async () => {
    const r = await startAndSendStep0();
    await scanDueSteps(env, at("2026-11-25T10:00:00Z"));
    const step1 = (await approvalRows())[1];
    clock = at("2026-12-04T10:00:00Z"); // Friday: Logan approves nine days late
    expect(await approve(env, step1.id)).toEqual({ ok: true });
    const e = await enrollment(r.enrollmentId);
    // the call is day 7 (25 Nov), long past; sent Fri 4 Dec + 3 business days = Wed 9 Dec
    expect(e).toMatchObject({ last_sent_step: 1, last_sent_at: "2026-12-04T10:00:00.000Z", next_step_index: 2, next_due_at: "2026-12-09T10:00:00.000Z" });
    expect(smtpCalls[1].inReplyTo).toBe(smtpCalls[0].messageId);
  });

  it("completed after the last email step", async () => {
    const id = await seedEnrollment({ next_step_index: 3, last_sent_step: 2, next_due_at: "2026-12-04T10:00:00.000Z" });
    const t = at("2026-12-04T10:00:00Z");
    expect(await scanDueSteps(env, t)).toEqual({ approvalsCreated: 1, calls: 0, skipped: 0 });
    const a = (await approvalRows())[0];
    expect(a.payload).toMatchObject({ stepIndex: 3 });
    expect(a.payload.body).toContain("If the weak call to action ever"); // the top finding's title, as a noun phrase after "the"
    clock = t;
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(await enrollment(id)).toMatchObject({ status: "completed", next_due_at: null, last_sent_step: 3, last_sent_at: t.toISOString() });
    // the 90-day check-in is the nurture flow's, not part of this sequence
    expect(await scanDueSteps(env, at("2027-06-01T00:00:00Z"))).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
  });

  it("Email 3 falls back to 'website' when the lead has no usable finding", async () => {
    await env.DB.prepare(`DELETE FROM audits`).run();
    await insertAudit(env.DB, {
      business_id: businessId, site_status: "ok", partial: false, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null, https: null, has_title: null,
      has_meta_description: null, has_contact_form: null, copyright_year: null, latest_content_date: null, broken_link_count: null, platform: null, seo_score: null,
      accessibility_score: null, score: 0, offer: "new_site", findings: [], raw_r2_key: null, mail_warning: null, health_score: null, niche: null, category_scores: {},
      ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {},
    });
    await seedEnrollment({ next_step_index: 3, last_sent_step: 2 });
    expect((await scanDueSteps(env, NOW)).approvalsCreated).toBe(1);
    expect((await approvalRows())[0].payload.body).toContain("If the website ever");
  });

  it("a rejected step is skipped, not proposed again", async () => {
    const id = await seedEnrollment({ next_step_index: 1, last_sent_step: 0 });
    const a = await stepApproval(id, 1);
    expect(await reject(env.DB, a.id, "not this one")).toBe(true);
    const t = at("2026-11-25T10:00:00Z");
    expect(await scanDueSteps(env, t)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
    expect(await approvalRows()).toHaveLength(1); // still just the rejected one
    const e = await enrollment(id);
    // next is the call (day 7 = 25 Nov); nothing was sent, so the gap counts from now: 25 Nov + 3 business days
    expect(e).toMatchObject({ status: "active", next_step_index: 2, last_sent_step: 0, next_due_at: "2026-11-30T10:00:00.000Z" });
    expect((await listActivity(env.DB, businessId)).map((x) => x.detail)).toContainEqual(expect.stringContaining("skipped"));
    expect(await scanDueSteps(env, t)).toEqual({ approvalsCreated: 0, calls: 0, skipped: 0 });
    expect((await enrollment(id)).next_step_index).toBe(2);
  });

  it("rejecting the step 0 approval stops the enrollment on the next scan without suppressing the lead", async () => {
    const r = await startSequence(env, { businessId, campaignId });
    if (!r.ok) throw new Error(r.error);
    expect(await reject(env.DB, r.approvalId)).toBe(true);
    expect((await enrollment(r.enrollmentId)).status).toBe("active"); // nothing happens until the scan looks
    await scanDueSteps(env, NOW);
    expect(await enrollment(r.enrollmentId)).toMatchObject({ status: "stopped", stopped_reason: "step 0 rejected", next_due_at: null });
    expect(await listSuppressions(env.DB)).toHaveLength(0);
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("new");
    expect((await startSequence(env, { businessId, campaignId })).ok).toBe(true); // free to start again
  });

  it("one enrollment's failure does not stop the others", async () => {
    await saveStep(env.DB, campaignId, { idx: 1, kind: "email", offset_days: 5, offset_kind: "business", subject: "Re: {Business}", variants: ["Hi {Name}, {nope}"] });
    const good = await seedLead("Good Co", { website: "https://good.test", email: "pat@good.test", person: "Pat Lee" });
    await seedEnrollment({ next_due_at: "2026-11-01T00:00:00Z" });
    await saveStep(env.DB, campaignId, { idx: 3, kind: "email", offset_days: 12, offset_kind: "business", subject: "Last note for {Business}", variants: ["Hi {Name}, {link}, the {problem_one}."] });
    await seedEnrollment({ business_id: good.id, to_email: "pat@good.test", next_step_index: 3, last_sent_step: 2, next_due_at: "2026-11-02T00:00:00Z" });
    expect(await scanDueSteps(env, NOW)).toEqual({ approvalsCreated: 1, calls: 0, skipped: 1 });
  });
});

describe("advanceAfterSend", () => {
  it("is idempotent: a second call changes nothing", async () => {
    const id = await seedEnrollment({ next_step_index: 1, next_due_at: null, last_sent_step: null });
    await advanceAfterSend(env.DB, id, 0, NOW);
    const first = await enrollment(id);
    expect(first).toMatchObject({ last_sent_step: 0, last_sent_at: NOW.toISOString(), next_step_index: 1, next_due_at: "2026-11-25T10:00:00.000Z" });
    await advanceAfterSend(env.DB, id, 0, at("2026-12-01T10:00:00Z"));
    expect(await enrollment(id)).toEqual(first);
    await advanceAfterSend(env.DB, id, 1, at("2026-11-25T10:00:00Z"));
    const second = await enrollment(id);
    expect(second).toMatchObject({ last_sent_step: 1, next_step_index: 2 });
    await advanceAfterSend(env.DB, id, 0, at("2026-12-09T10:00:00Z")); // an older step arriving late never moves it back
    expect(await enrollment(id)).toEqual(second);
  });

  it("repeating the approval after a failed advance sends nothing again and advances once", async () => {
    const r = await startSequence(env, { businessId, campaignId });
    if (!r.ok) throw new Error(r.error);
    let calls = 0;
    setAfterSendForTests(async () => { if (++calls === 1) throw new Error("advance failed"); });
    expect(await approve(env, r.approvalId)).toMatchObject({ ok: false, status: 502, error: "advance failed" });
    expect((await enrollment(r.enrollmentId)).last_sent_step).toBeNull();
    setAfterSendForTests(null); // the real hook this time
    expect(await approve(env, r.approvalId)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
    expect(await enrollment(r.enrollmentId)).toMatchObject({ last_sent_step: 0, next_step_index: 1, next_due_at: "2026-11-25T10:00:00.000Z" });
  });

  it("a send that lands after the sequence was stopped records the step but does not revive it", async () => {
    const id = await seedEnrollment({ status: "replied", stopped_reason: "replied", next_due_at: null, next_step_index: 1, last_sent_step: null });
    await advanceAfterSend(env.DB, id, 0, NOW);
    expect(await enrollment(id)).toMatchObject({ status: "replied", last_sent_step: 0, next_due_at: null, next_step_index: 1 });
  });

  it("an enrollment that no longer exists is ignored", async () => {
    await expect(advanceAfterSend(env.DB, "gone", 0, NOW)).resolves.toBeUndefined();
  });
});

describe("stopOutreach", () => {
  async function liveWithPending() {
    const r = await startSequence(env, { businessId, campaignId });
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  it("stopOutreach opt_out suppresses lead, adds do_not_contact and rejects pending approvals", async () => {
    const r = await liveWithPending();
    const out = await stopOutreach(env.DB, { businessId, reason: "opt_out", email: "dana@acme.test" });
    expect(out).toEqual({ rejectedApprovals: 1 });
    expect(await enrollment(r.enrollmentId)).toMatchObject({ status: "stopped", stopped_reason: "opt_out", next_due_at: null });
    const approval = (await approvalRows())[0];
    expect(approval).toMatchObject({ status: "rejected", decision_note: "sequence stopped: opt_out" });
    expect((await listSuppressions(env.DB)).map((s) => [s.kind, s.value, s.reason])).toContainEqual(["domain", "acme.test", "opt_out"]);
    expect((await listDoNotContact(env.DB)).map((d) => [d.kind, d.value, d.reason])).toEqual([["email", "dana@acme.test", "opt_out"]]);
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("lost");
    expect((await listActivity(env.DB, businessId)).map((a) => a.detail)).toContainEqual(expect.stringContaining("opt_out"));
    // doing it again is harmless
    expect(await stopOutreach(env.DB, { businessId, reason: "opt_out", email: "dana@acme.test" })).toEqual({ rejectedApprovals: 0 });
    expect(await listDoNotContact(env.DB)).toHaveLength(1);
  });

  it("opt_out without an email uses the enrollment's recipient", async () => {
    await liveWithPending();
    await stopOutreach(env.DB, { businessId, reason: "opt_out" });
    expect((await listDoNotContact(env.DB)).map((d) => d.value)).toEqual(["dana@acme.test"]);
  });

  it("replied sets the enrollment and the lead to replied", async () => {
    const r = await liveWithPending();
    expect(await stopOutreach(env.DB, { businessId, reason: "replied" })).toEqual({ rejectedApprovals: 1 });
    expect(await enrollment(r.enrollmentId)).toMatchObject({ status: "replied", stopped_reason: "replied", next_due_at: null });
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("replied");
    expect(await listSuppressions(env.DB)).toHaveLength(0);
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
  });

  it("bounced sets the enrollment to bounced and lists the address", async () => {
    const r = await liveWithPending();
    await stopOutreach(env.DB, { businessId, reason: "bounced", email: "dana@acme.test" });
    expect(await enrollment(r.enrollmentId)).toMatchObject({ status: "bounced", stopped_reason: "bounced" });
    expect((await listDoNotContact(env.DB)).map((d) => [d.kind, d.value, d.reason])).toEqual([["email", "dana@acme.test", "bounced"]]);
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("new");
  });

  it("manual only stops", async () => {
    const r = await liveWithPending();
    await stopOutreach(env.DB, { businessId, reason: "manual" });
    expect(await enrollment(r.enrollmentId)).toMatchObject({ status: "stopped", stopped_reason: "manual" });
    expect(await listSuppressions(env.DB)).toHaveLength(0);
    expect(await listDoNotContact(env.DB)).toHaveLength(0);
    // the lead can be enrolled again
    expect((await startSequence(env, { businessId, campaignId })).ok).toBe(true);
  });

  it("a won client keeps its status when a stop arrives", async () => {
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(businessId).run();
    await stopOutreach(env.DB, { businessId, reason: "replied" });
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("won");
  });

  it("works for a lead that was never enrolled", async () => {
    expect(await stopOutreach(env.DB, { businessId, reason: "replied" })).toEqual({ rejectedApprovals: 0 });
    expect((await getBusiness(env.DB, businessId))!.lead_status).toBe("replied");
  });

  it("only the stopped lead's approvals are rejected", async () => {
    await liveWithPending();
    const other = await seedLead("Other Co", { website: "https://other.test", email: "sam@other.test" });
    const o = await startSequence(env, { businessId: other.id, campaignId });
    expect(o.ok).toBe(true);
    expect(await stopOutreach(env.DB, { businessId, reason: "manual" })).toEqual({ rejectedApprovals: 1 });
    expect((await approvalRows()).map((a) => a.status).sort()).toEqual(["pending", "rejected"]);
  });

  it("stop beats approval: an approval created before a reply cannot be approved after it", async () => {
    const r = await liveWithPending();
    await stopOutreach(env.DB, { businessId, reason: "replied" });
    expect(await approve(env, r.approvalId)).toMatchObject({ ok: false, status: 409 });
    expect(smtpCalls).toHaveLength(0);
  });

  it("stopped enrollment blocks send", async () => {
    const r = await startAndSendStep0();
    await scanDueSteps(env, at("2026-11-25T10:00:00Z")); // step 1 approval now pending
    await stopOutreach(env.DB, { businessId, reason: "manual" });
    // a leftover approval for the stopped enrollment (created directly, as an MCP or a race could)
    const leftover = await stepApproval(r.enrollmentId, 1);
    const res = await approve(env, leftover.id);
    expect(res).toMatchObject({ ok: false, status: 502 });
    expect((res as { error: string }).error).toBe("sequence stopped: stopped");
    expect(smtpCalls).toHaveLength(1); // only Email 1
    expect(await messageRows()).toHaveLength(1);
    expect((await approvalRows()).find((a) => a.id === leftover.id)).toMatchObject({ status: "pending" });
  });

  describe("a stop rejects every pending email.send for the lead", () => {
    const leadApproval = async (forBusiness = businessId) => {
      const settings = (await env.DB.prepare(`SELECT * FROM settings WHERE id = 1`).first())! as never;
      // what an MCP proposal looks like: record_type 'lead', no enrollmentId
      return createApproval(env.DB, { ...buildEmailSendApproval({ mailbox: "outreach", businessId: forBusiness, to: "dana@acme.test", subject: "Quick note", body: "Hi Dana, a note.", includeFooter: true, title: "Cold email", drafted_by: "mcp" }, settings) });
    };

    for (const reason of ["replied", "manual"] as const) {
      it(`a ${reason} stop rejects an approval made outside any enrollment, and approving it afterwards is 409`, async () => {
        const a = await leadApproval();
        expect(a.record_type).toBe("lead");
        expect(await stopOutreach(env.DB, { businessId, reason })).toEqual({ rejectedApprovals: 1 });
        expect((await approvalRows())[0]).toMatchObject({ id: a.id, status: "rejected", decision_note: `sequence stopped: ${reason}` });
        expect(await approve(env, a.id)).toMatchObject({ ok: false, status: 409 });
        expect(smtpCalls).toHaveLength(0);
      });
    }

    it("opt_out and bounced reject it too", async () => {
      for (const reason of ["opt_out", "bounced"] as const) {
        await leadApproval();
        expect(await stopOutreach(env.DB, { businessId, reason, email: "dana@acme.test" })).toEqual({ rejectedApprovals: 1 });
      }
    });

    it("another lead's pending email.send is untouched", async () => {
      const other = await seedLead("Other Co", { website: "https://other.test", email: "sam@other.test" });
      const mine = await leadApproval(), theirs = await leadApproval(other.id);
      expect(await stopOutreach(env.DB, { businessId, reason: "replied" })).toEqual({ rejectedApprovals: 1 });
      const rows = await approvalRows();
      expect(rows.find((r) => r.id === mine.id)!.status).toBe("rejected");
      expect(rows.find((r) => r.id === theirs.id)!.status).toBe("pending");
    });

    it("an approval matching both the enrollment and the lead is rejected and counted once", async () => {
      const r = await startSequence(env, { businessId, campaignId });
      if (!r.ok) throw new Error(r.error);
      await leadApproval();
      expect(await stopOutreach(env.DB, { businessId, reason: "manual" })).toEqual({ rejectedApprovals: 2 });
      expect((await approvalRows()).map((a) => a.status)).toEqual(["rejected", "rejected"]);
    });

    it("the approval the scan created ends rejected after the stop and approves to 409", async () => {
      await startAndSendStep0();
      expect((await scanDueSteps(env, at("2026-11-25T10:00:00Z"))).approvalsCreated).toBe(1);
      const created = (await approvalRows())[1];
      expect(created).toMatchObject({ status: "pending", drafted_by: "job", record_type: "enrollment" });
      expect(await stopOutreach(env.DB, { businessId, reason: "replied" })).toEqual({ rejectedApprovals: 1 });
      expect((await approvalRows()).find((a) => a.id === created.id)).toMatchObject({ status: "rejected", decision_note: "sequence stopped: replied" });
      expect(await approve(env, created.id)).toMatchObject({ ok: false, status: 409 });
      expect(smtpCalls).toHaveLength(1); // only Email 1
    });
  });

  it("an email approval for an enrollment that does not exist is refused", async () => {
    const a = await stepApproval("ghost", 1);
    const res = await approve(env, a.id);
    expect(res).toMatchObject({ ok: false, status: 502 });
    expect((res as { error: string }).error).toContain("sequence stopped");
    expect(smtpCalls).toHaveLength(0);
  });

  it("a retry of a message that was already sent is unaffected by the sequence being stopped", async () => {
    const r = await startAndSendStep0();
    await stopOutreach(env.DB, { businessId, reason: "manual" });
    await env.DB.prepare(`UPDATE approvals SET status = 'pending', decided_at = NULL WHERE id = ?`).bind(r.approvalId).run();
    expect(await approve(env, r.approvalId)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
  });
});

describe("problemOne", () => {
  const f = (over: Partial<Finding>): Finding => ({ ...FINDING, ...over });

  it("takes the title of the top finding and lower-cases it", () => {
    expect(problemOne([f({ severity: "nice", evidence: "Dated footer. Old." }), f({ severity: "important", evidence: "Cluttered homepage. Too much." }), FINDING])).toBe("weak call to action");
  });

  it("breaks a severity tie on points", () => {
    expect(problemOne([f({ code: "slow_mobile", severity: "important", points: 5, evidence: "Mobile speed 38/100" }), f({ code: "no_cta", severity: "important", points: 9, evidence: "No clear call to action on the homepage" })]))
      .toBe("call to action");
  });

  it("names rule findings by what they are about, not by their sentence", () => {
    expect(problemOne([f({ code: "slow_mobile", source: "rule", severity: "critical", evidence: "Mobile speed 38/100" })])).toBe("mobile speed");
  });

  it("keeps an acronym as written", () => {
    expect(problemOne([f({ evidence: "SEO title tags. Titles are blank." })])).toBe("SEO title tags");
  });

  it("falls back to 'website' for no finding, a verb, a colon or a long sentence", () => {
    expect(problemOne([])).toBe("website");
    expect(problemOne([f({ evidence: "Add a booking button. Customers cannot book." })])).toBe("website");
    expect(problemOne([f({ evidence: "No contact form. Visitors cannot reach you." })])).toBe("website");
    expect(problemOne([f({ evidence: "Mobile: text is tiny. Hard to read." })])).toBe("website");
    expect(problemOne([f({ evidence: `${"Very long title ".repeat(6)}. Evidence.` })])).toBe("website");
    expect(problemOne([f({ code: "no_website", source: "rule", evidence: "They have no website" })])).toBe("website");
  });
});

describe("problem_one wording", () => {
  const ai = (evidence: string): Finding => ({ ...FINDING, evidence });

  it("every rule phrase is a vetted singular phrase, and the table uses exactly the vetted list", () => {
    const used = [...new Set(Object.values(RULE_PHRASES))].sort();
    expect(used).toEqual([...VETTED_RULE_PHRASES].sort());
    for (const p of used) expect(p).not.toMatch(/s$/);
  });

  it("every phrase reads correctly in both seeded Email 3 variants", () => {
    const variants = DEFAULT_STEPS[3].variants;
    expect(variants).toHaveLength(2);
    for (const phrase of VETTED_RULE_PHRASES) {
      for (const v of variants) {
        const body = renderTemplate(v, { Business: "Acme", Name: "Dana", link: "https://go.example.test/r/x", problem_one: phrase });
        expect(body).toMatch(new RegExp(`If the ${phrase} ever (becomes a priority|moves up your list)`));
      }
    }
  });

  it("every rule code gives its singular phrase", () => {
    for (const [code, phrase] of Object.entries(RULE_PHRASES)) {
      expect(problemOne([{ ...FINDING, code: code as Finding["code"], source: "rule" }])).toBe(phrase);
    }
  });

  it("keeps the casing of a proper noun or acronym, lower-cases an ordinary title", () => {
    expect(problemOne([ai("WordPress theme outdated. Old.")])).toBe("WordPress theme outdated");
    expect(problemOne([ai("Google Business Profile gaps. Missing hours.")])).toBe("Google Business Profile gaps");
    expect(problemOne([ai("Facebook page link. Nothing.")])).toBe("Facebook page link");
    expect(problemOne([ai("Weak call to action. Nothing to click.")])).toBe("weak call to action");
  });

  it("only plain-word titles pass; everything else falls back to 'website'", () => {
    for (const bad of ["visit evil.com for deals", "Click <b>here</b>", "Email me@evil.test now", "See https://evil.test/x", "Top 10 homepage fixes", "Mobile: text is tiny", "Cheap deals!", "Weak call to action, again", `${"Long title ".repeat(6)}`]) {
      expect(problemOne([ai(`${bad}. Evidence.`)])).toBe("website");
      expect(problemOne([ai(bad)])).toBe("website");
    }
    expect(problemOne([ai("Cluttered homepage layout. Too much.")])).toBe("cluttered homepage layout");
    expect(problemOne([ai("Hours & directions buried. Hard to find.")])).toBe("hours & directions buried");
  });

  it("a sentence-like title (a verb anywhere, or more than four words) falls back to 'website'", () => {
    expect(problemOne([ai("Homepage lacks a clear call to action. Nothing to click.")])).toBe("website");
    expect(problemOne([ai("Missing click-to-call button. Hard to call.")])).toBe("website");
    expect(problemOne([ai("Google Business Profile is incomplete. Missing hours.")])).toBe("website");
    expect(problemOne([ai("WordPress theme looks dated. Old.")])).toBe("website");
    expect(problemOne([ai("Facebook page not linked. Nothing.")])).toBe("website");
    expect(problemOne([ai("SEO basics missing. Titles are blank.")])).toBe("website");
    expect(problemOne([ai("Slow cluttered homepage layout today. Too much.")])).toBe("website"); // five words
    expect(problemOne([ai("Weak call to action. Nothing to click.")])).toBe("weak call to action"); // four words, no verb
  });
});

describe("steps stay editable", () => {
  it("the scan reads the campaign's current steps", async () => {
    await saveStep(env.DB, campaignId, { idx: 1, kind: "email", offset_days: 5, offset_kind: "business", subject: "Edited {Business}", variants: ["Edited body for {Name}: {link}"] });
    expect((await listSteps(env.DB, campaignId))[1].subject).toBe("Edited {Business}");
    await seedEnrollment();
    await scanDueSteps(env, NOW);
    const a = (await approvalRows())[0];
    expect(a.payload.subject).toBe("Edited Acme Plumbing");
    expect(a.payload.body).toContain("Edited body for Dana");
  });
});
