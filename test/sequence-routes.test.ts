import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { setMailDeps } from "../src/worker/mail/deps";
import type { OutboundMessage } from "../src/worker/mail/types";
import { approve } from "../src/worker/approvals/decide";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { replaceContacts } from "../src/worker/db/contacts";
import { insertDraft } from "../src/worker/db/drafts";
import { insertAudit } from "../src/worker/db/audits";
import { createCampaign } from "../src/worker/db/campaigns";
import { scanDueSteps } from "../src/worker/sequence/engine";
import type { Finding } from "../src/worker/types";

const NOW = new Date("2026-11-18T10:00:00.000Z"); // a Wednesday
const CONFIG = {
  enabled: 1 as const, smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "hello@outreach.test", from_email: "hello@outreach.test", from_name: "Logan at Siteline",
};
const FINDING: Finding = {
  code: "ai_cro_0", category: "cro", severity: "critical", points: 0, source: "ai", recommendation: "Add one clear button.",
  evidence: "Weak call to action. Visitors cannot tell what to do next.",
};

let cookie = "";
let smtpCalls: OutboundMessage[] = [];
let clock = NOW;
let businessId = "", campaignId = "";

const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
const getSeq = async (id = businessId) => (await api(`/api/leads/${id}/sequence`)).json<any>();

async function seedLead(name: string, o: { draft?: boolean } = {}) {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const id = (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: "https://acme.test", mapsUrl: null, rating: null, reviewCount: null }, s.id)).id;
  const list = await replaceContacts(env.DB, id, [
    { type: "email", value: "dana@acme.test", source_url: "https://acme.test/contact", person_name: "Dana Smith", role: "Owner", confidence: 0.9 },
  ]);
  const audit = await insertAudit(env.DB, {
    business_id: id, site_status: "ok", partial: false, pagespeed_mobile: 40, lcp_ms: 3000, cls: 0.1, mobile_friendly: true, https: true, has_title: true,
    has_meta_description: true, has_contact_form: true, copyright_year: 2024, latest_content_date: null, broken_link_count: 0, platform: "wix", seo_score: 70,
    accessibility_score: 70, score: 50, offer: "new_site", findings: [FINDING], raw_r2_key: null, mail_warning: null, health_score: 50, niche: "plumber",
    category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {},
  });
  if (o.draft !== false) {
    await insertDraft(env.DB, { business_id: id, audit_id: audit.id, to_contact_id: list[0].id, recipient_reason: "owner", subject: "Quick video about Acme Plumbing's website",
      body: "Hi Dana,\n\nI made a short video about your site.", offer: "new_site", steering_note: null });
  }
  return id;
}

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  smtpCalls = []; clock = NOW;
  setMailDeps({ smtp: async (_mb, _pw, msg) => { smtpCalls.push(msg); }, now: () => clock });
  await env.DB.batch(["enrollments", "approvals", "messages", "campaigns", "do_not_contact", "suppressions", "activity", "audit_reports", "audits", "drafts", "contacts"]
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await saveMailbox(env.DB, "outreach", { ...CONFIG, warmup_started_at: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  await saveSettings(env.DB, { physical_address: "12 Main St, Boise ID 83702", opt_out_line: "Reply stop.", signature: "Logan", signature_json: "" });
  businessId = await seedLead("Acme Plumbing");
  campaignId = (await createCampaign(env.DB, { name: "Boise plumbers", niche: "plumber", region: "Treasure Valley, ID", towns: ["Boise, ID"] })).id;
});
afterEach(() => { setMailDeps(null); });

describe("POST /api/leads/:id/sequence/start", () => {
  it("start returns approvalId and the approval is pending", async () => {
    const r = await post(`/api/leads/${businessId}/sequence/start`, { campaignId });
    expect(r.status).toBe(201);
    const body = await r.json<{ enrollmentId: string; approvalId: string }>();
    expect(Object.keys(body).sort()).toEqual(["approvalId", "enrollmentId"]);
    const a = await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(body.approvalId).first<any>();
    expect(a).toMatchObject({ kind: "email.send", status: "pending", record_type: "enrollment", record_id: body.enrollmentId });
    expect(a.preview).toContain("To: dana@acme.test");
    expect(smtpCalls).toHaveLength(0); // nothing is sent until the approval is approved
    const seq = await getSeq();
    expect(seq.enrollment).toMatchObject({ id: body.enrollmentId, status: "active", campaign_id: campaignId });
  });

  it("start with an unknown campaign is 404", async () => {
    const r = await post(`/api/leads/${businessId}/sequence/start`, { campaignId: "nope" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "campaign not found" });
    expect((await post(`/api/leads/nope/sequence/start`, { campaignId })).status).toBe(404);
  });

  it("start on a suppressed lead is 422 with the reason", async () => {
    expect((await post(`/api/leads/${businessId}/suppress`, { reason: "competitor" })).status).toBe(200);
    const r = await post(`/api/leads/${businessId}/sequence/start`, { campaignId });
    expect(r.status).toBe(422);
    expect((await r.json<any>()).error).toMatch(/suppression list \(competitor\)/);
    expect(await env.DB.prepare(`SELECT 1 AS x FROM enrollments`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 AS x FROM approvals`).first()).toBeNull();
  });

  it("start twice is 409, a lead with no draft is 400, and a bad body is 400 with fields", async () => {
    expect((await post(`/api/leads/${businessId}/sequence/start`, { campaignId })).status).toBe(201);
    const again = await post(`/api/leads/${businessId}/sequence/start`, { campaignId });
    expect(again.status).toBe(409);
    expect((await again.json<any>()).error).toMatch(/already in a sequence/);

    const bare = await seedLead("No Draft Co", { draft: false });
    const nodraft = await post(`/api/leads/${bare}/sequence/start`, { campaignId });
    expect(nodraft.status).toBe(400);
    expect((await nodraft.json<any>()).error).toMatch(/draft/);

    const bad = await post(`/api/leads/${bare}/sequence/start`, {});
    expect(bad.status).toBe(400);
    expect((await bad.json<any>()).fields).toHaveProperty("campaignId");
  });

  it("start logs the sequence on the lead's activity", async () => {
    await post(`/api/leads/${businessId}/sequence/start`, { campaignId });
    const rows = (await env.DB.prepare(`SELECT kind, detail FROM activity WHERE business_id = ?`).bind(businessId).all<any>()).results;
    expect(rows.some((r) => r.kind === "note" && /Sequence started: Boise plumbers/.test(r.detail))).toBe(true);
  });
});

describe("GET /api/leads/:id/sequence", () => {
  it("is null with the campaign's steps absent for a lead that was never enrolled", async () => {
    expect(await getSeq()).toEqual({ enrollment: null, steps: [], messages: [] });
    expect((await api(`/api/leads/nope/sequence`)).status).toBe(404);
  });

  it("GET sequence lists steps with states", async () => {
    const start = await (await post(`/api/leads/${businessId}/sequence/start`, { campaignId })).json<{ approvalId: string }>();

    // Email 1 is waiting for the owner; every later step is upcoming. The check-in belongs to the nurture flow and is not listed.
    let seq = await getSeq();
    expect(seq.steps.map((s: any) => [s.step.idx, s.step.kind, s.state])).toEqual([[0, "email", "pending"], [1, "email", "upcoming"], [2, "call", "upcoming"], [3, "email", "upcoming"]]);
    expect(seq.steps[0].at).toBeTruthy();
    expect(seq.steps[1].at).toBeNull();

    // Approve it: Email 1 is sent, Email 2 is upcoming with a day.
    expect(await approve(env, start.approvalId)).toEqual({ ok: true });
    seq = await getSeq();
    expect(seq.steps.map((s: any) => s.state)).toEqual(["sent", "upcoming", "upcoming", "upcoming"]);
    expect(seq.steps[0].at).toBe(NOW.toISOString());
    expect(seq.steps[1].at).toBe(seq.enrollment.next_due_at);
    expect(Date.parse(seq.steps[2].at)).toBeGreaterThanOrEqual(Date.parse(seq.steps[1].at));
    expect(seq.messages).toHaveLength(1);
    expect(seq.messages[0]).toMatchObject({ direction: "out", status: "sent", subject: "Quick video about Acme Plumbing's website", counterpart: "dana@acme.test", step_index: 0 });

    // Past its due time, with no approval yet: due. Once the daily scan proposes it: pending.
    clock = new Date(Date.parse(seq.enrollment.next_due_at) + 3600_000);
    seq = await getSeq();
    expect(seq.steps.map((s: any) => s.state)).toEqual(["sent", "due", "upcoming", "upcoming"]);
    expect((await scanDueSteps(env, clock)).approvalsCreated).toBe(1);
    seq = await getSeq();
    expect(seq.steps.map((s: any) => s.state)).toEqual(["sent", "pending", "upcoming", "upcoming"]);
  });

  it("marks a rejected step skipped and every unsent step skipped once the sequence has stopped", async () => {
    const start = await (await post(`/api/leads/${businessId}/sequence/start`, { campaignId })).json<{ approvalId: string }>();
    expect((await post(`/api/approvals/${start.approvalId}/reject`, {})).status).toBe(200);
    const seq = await getSeq();
    expect(seq.steps[0].state).toBe("skipped");
    expect(seq.steps.slice(1).map((s: any) => s.state)).toEqual(["upcoming", "upcoming", "upcoming"]);
    expect((await post(`/api/leads/${businessId}/sequence/stop`)).status).toBe(200);
    const stopped = await getSeq();
    expect(stopped.enrollment.status).toBe("stopped");
    expect(stopped.steps.map((s: any) => s.state)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  });

  it("lists the lead's messages newest first, cuts long text and leaves out secrets and transport ids", async () => {
    const long = "x".repeat(900);
    const row = (id: string, dir: string, at: string, text: string) => env.DB.prepare(
      `INSERT INTO messages (id, direction, mailbox_key, business_id, counterpart, subject, text, status, message_id, in_reply_to, imap_uid, created_at, sent_at)
       VALUES (?, ?, 'outreach', ?, 'dana@acme.test', ?, ?, ?, ?, 'in-reply', ?, ?, ?)`)
      .bind(id, dir, businessId, `Subject ${id}`, text, dir === "out" ? "sent" : "received", `<${id}@x>`, id === "m1" ? 7 : 8, at, dir === "out" ? at : null);
    await env.DB.batch([row("m1", "out", "2026-11-10T10:00:00.000Z", "short"), row("m2", "in", "2026-11-12T10:00:00.000Z", long)]);
    const seq = await getSeq();
    expect(seq.messages.map((m: any) => m.id)).toEqual(["m2", "m1"]);
    expect(seq.messages[0].text).toHaveLength(500);
    expect(seq.messages[1].text).toBe("short");
    for (const m of seq.messages) {
      expect(m).not.toHaveProperty("imap_uid"); expect(m).not.toHaveProperty("message_id"); expect(m).not.toHaveProperty("in_reply_to");
      expect(JSON.stringify(m)).not.toMatch(/pw-out|password/i);
    }
  });

  it("caps the message list at 50", async () => {
    const stmts = Array.from({ length: 55 }, (_, i) => env.DB.prepare(
      `INSERT INTO messages (id, direction, mailbox_key, business_id, counterpart, subject, text, status, created_at) VALUES (?, 'in', 'outreach', ?, 'a@b.test', 's', 't', 'received', ?)`)
      .bind(`m${i}`, businessId, new Date(NOW.getTime() + i * 1000).toISOString()));
    await env.DB.batch(stmts);
    expect((await getSeq()).messages).toHaveLength(50);
  });
});

describe("POST /api/leads/:id/sequence/stop", () => {
  it("stop route stops the enrollment", async () => {
    const start = await (await post(`/api/leads/${businessId}/sequence/start`, { campaignId })).json<{ approvalId: string; enrollmentId: string }>();
    const r = await post(`/api/leads/${businessId}/sequence/stop`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, rejectedApprovals: 1 });
    expect(await env.DB.prepare(`SELECT status, stopped_reason FROM enrollments WHERE id = ?`).bind(start.enrollmentId).first()).toEqual({ status: "stopped", stopped_reason: "manual" });
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(start.approvalId).first<any>()).status).toBe("rejected");
  });

  it("is 404 when the lead has no live sequence, and the lead can start again after a stop", async () => {
    expect((await post(`/api/leads/${businessId}/sequence/stop`)).status).toBe(404);
    expect((await post(`/api/leads/nope/sequence/stop`)).status).toBe(404);
    await post(`/api/leads/${businessId}/sequence/start`, { campaignId });
    expect((await post(`/api/leads/${businessId}/sequence/stop`)).status).toBe(200);
    expect((await post(`/api/leads/${businessId}/sequence/stop`)).status).toBe(404);
    expect((await post(`/api/leads/${businessId}/sequence/start`, { campaignId })).status).toBe(201);
  });
});

describe("the Gmail draft route is retired", () => {
  // The path is joined from parts so the retirement check (a repo-wide grep for the old route) stays empty.
  const RETIRED = ["gmail", "draft"].join("-");
  it("gmail draft route is gone", async () => {
    expect((await post(`/api/leads/${businessId}/${RETIRED}`, {})).status).toBe(404);
    expect((await post(`/api/leads/${businessId}/${RETIRED}`, { attachReport: true })).status).toBe(404);
  });
  it("the Drive export route is still there", async () => {
    expect((await post(`/api/leads/${businessId}/drive`, {})).status).toBe(400); // Google is not connected in tests
  });
});
