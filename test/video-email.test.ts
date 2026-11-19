import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setMailDeps } from "../src/worker/mail/deps";
import { approve } from "../src/worker/approvals/decide";
import { EmailSendSchema, buildEmailSendApproval } from "../src/worker/approvals/emailSend";
import { saveMailbox } from "../src/worker/db/mailboxes";
import { saveSettings } from "../src/worker/db/settings";
import { replaceContacts } from "../src/worker/db/contacts";
import { insertDraft } from "../src/worker/db/drafts";
import { createCampaign, updateCampaign } from "../src/worker/db/campaigns";
import { setVideoStatus } from "../src/worker/db/videoAudits";
import { startSequence } from "../src/worker/sequence/engine";
import type { OutboundMessage } from "../src/worker/mail/types";
import { renderedVideo } from "./fixtures/video";

const NOW = new Date("2026-11-18T10:00:00.000Z");
const BASE = "https://go.hellositeline.test";
const CONFIG = {
  enabled: 1 as const, smtp_host: "smtp.mail.test", smtp_port: 465, imap_host: "imap.mail.test", imap_port: 993,
  username: "hello@outreach.test", from_email: "hello@outreach.test", from_name: "Logan at Siteline",
};

let smtpCalls: OutboundMessage[] = [];
let campaignId = "";

/** A lead with an audit, a draft, an address, and a rendered video (not yet published). */
async function lead(name = "Acme Plumbing") {
  const t = await renderedVideo({ name });
  const list = await replaceContacts(env.DB, t.b.id, [{ type: "email", value: "dana@acme.test", source_url: "https://acme.test", person_name: "Dana Smith", role: "Owner", confidence: 0.9 }]);
  await insertDraft(env.DB, { business_id: t.b.id, audit_id: t.audit.id, to_contact_id: list[0].id, recipient_reason: "owner", subject: "Quick video about your site",
    body: "Hi Dana,\n\nI made a short video about your site.", offer: "new_site", steering_note: null });
  return t;
}
const publish = (videoId: string) => setVideoStatus(env.DB, videoId, "published");
const approvals = async () => (await env.DB.prepare(`SELECT * FROM approvals ORDER BY created_at, id`).all<any>()).results.map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, any> }));
const reportCount = async (businessId: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_reports WHERE business_id = ?`).bind(businessId).first<{ n: number }>())!.n;

beforeEach(async () => {
  smtpCalls = [];
  setMailDeps({ smtp: async (_mb, _pw, msg) => { smtpCalls.push(msg); }, now: () => NOW });
  await env.DB.batch(["enrollments", "approvals", "messages", "campaigns", "activity", "audit_reports", "video_audits", "audits", "drafts", "contacts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await saveMailbox(env.DB, "outreach", { ...CONFIG, warmup_started_at: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  await saveSettings(env.DB, { physical_address: "12 Main St, Boise ID 83702", opt_out_line: "Reply stop.", signature: "Logan", signature_json: "" });
  campaignId = (await createCampaign(env.DB, { name: "Boise plumbers", niche: "plumber", region: "Treasure Valley, ID", towns: ["Boise, ID"] })).id;
});
afterEach(() => setMailDeps(null));

describe("a video campaign's Email 1", () => {
  it("video campaign refuses to start without a published video", async () => {
    const t = await lead();
    await updateCampaign(env.DB, campaignId, { video_email: 1 });
    // rendered is not published
    expect(await startSequence(env, { businessId: t.b.id, campaignId })).toEqual({ ok: false, error: "make and approve the video first", status: 400 });
    expect(await approvals()).toHaveLength(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM enrollments`).first<{ n: number }>())!.n).toBe(0);
    expect(await reportCount(t.b.id)).toBe(1); // only the one the fixture made: refusing mints nothing
  });

  it("video campaign puts the gif and link in the approval payload", async () => {
    const t = await lead();
    await publish(t.v.id);
    await updateCampaign(env.DB, campaignId, { video_email: 1 });
    await env.DB.prepare(`DELETE FROM audit_reports`).run(); // nothing minted the link yet: starting the sequence must
    const r = await startSequence(env, { businessId: t.b.id, campaignId });
    expect(r.ok).toBe(true);
    const [a] = await approvals();
    const token = (await env.DB.prepare(`SELECT token FROM audit_reports WHERE business_id = ? AND audit_id = ? AND revoked = 0`).bind(t.b.id, t.audit.id).first<{ token: string }>())!.token;
    expect(a.payload.heroImage).toEqual({
      src: `${BASE}/api/public/report/${token}/media/preview.gif`, href: `${BASE}/r/${token}`, alt: "Video audit for Acme Plumbing",
    });
    expect(a.payload.stepIndex).toBe(0);
    expect(a.preview).toContain(`Video: ${BASE}/r/${token}`);
    expect(a.payload.body).not.toContain("/r/"); // the link is the hero's, not pasted into the draft

    // approving it sends the gif and the plain-text line
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(smtpCalls).toHaveLength(1);
    expect(smtpCalls[0].text).toContain(`Watch it here: ${BASE}/r/${token}`);
    expect(smtpCalls[0].html).toContain(`<img src="${BASE}/api/public/report/${token}/media/preview.gif"`);
    expect(smtpCalls[0].html).toContain(`<a href="${BASE}/r/${token}"`);
  });

  it("the alt text is one line of at most 120 characters whatever the scraped name holds", async () => {
    const t = await lead(`  Acme "Best" <Plumbing>\n  & Sons ${"x".repeat(200)}`);
    await publish(t.v.id);
    await updateCampaign(env.DB, campaignId, { video_email: 1 });
    expect((await startSequence(env, { businessId: t.b.id, campaignId })).ok).toBe(true);
    const alt = (await approvals())[0].payload.heroImage.alt as string;
    expect(alt.length).toBeLessThanOrEqual(120);
    expect(alt).not.toMatch(/[\r\n]/);
    expect(alt.startsWith('Video audit for Acme "Best" <Plumbing> & Sons')).toBe(true);
  });

  it("campaign with the switch off is unchanged", async () => {
    const t = await lead();
    await publish(t.v.id);
    await env.DB.prepare(`DELETE FROM audit_reports`).run();
    expect((await startSequence(env, { businessId: t.b.id, campaignId })).ok).toBe(true);
    const [a] = await approvals();
    expect(Object.keys(a.payload).sort()).toEqual(["body", "businessId", "enrollmentId", "includeFooter", "mailbox", "stepIndex", "subject", "to"]);
    expect(a.preview).not.toContain("Video:");
    expect(await reportCount(t.b.id)).toBe(0); // no link minted
    expect(a.preview).toBe(`From: hello@outreach.test\nTo: dana@acme.test\nSubject: Quick video about your site\n\nHi Dana,\n\nI made a short video about your site.\n\nLogan\n\n12 Main St, Boise ID 83702\nReply stop.`);
  });

  it("a video campaign needs a usable OUTREACH_LINK_BASE and starts nothing without one", async () => {
    const t = await lead();
    await publish(t.v.id);
    await updateCampaign(env.DB, campaignId, { video_email: 1 });
    const e = env as { OUTREACH_LINK_BASE?: string };
    const saved = e.OUTREACH_LINK_BASE;
    try {
      for (const bad of [undefined, "http://go.example.test", "https://x.someone.workers.dev"]) {
        e.OUTREACH_LINK_BASE = bad;
        const r = await startSequence(env, { businessId: t.b.id, campaignId });
        expect(r).toMatchObject({ ok: false, status: 422 });
        expect((r as { error: string }).error).toContain("OUTREACH_LINK_BASE");
      }
    } finally { e.OUTREACH_LINK_BASE = saved; }
    expect(await approvals()).toHaveLength(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM enrollments`).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("the hero image in the email.send payload", () => {
  const ok = { src: `${BASE}/api/public/report/tok_1-A/media/preview.gif`, href: `${BASE}/r/tok_1-A`, alt: "Video audit for Acme" };
  const parse = (heroImage: unknown) => EmailSendSchema.safeParse({ mailbox: "outreach", businessId: "b1", to: "dana@acme.test", subject: "Hi", body: "Hello", includeFooter: true, heroImage });

  it("accepts a hero on the outreach host", () => { expect(parse(ok).success).toBe(true); });

  it("hero on another host is refused by the schema", () => {
    expect(parse({ ...ok, src: "https://evil.test/api/public/report/tok_1-A/media/preview.gif" }).success).toBe(false); // src and href on different hosts
    expect(parse({ ...ok, href: "https://evil.test/r/tok_1-A" }).success).toBe(false);
    const on = (host: string) => ({ ...ok, src: `https://${host}/api/public/report/t/media/preview.gif`, href: `https://${host}/r/t` });
    expect(parse(on("acme-demo.someone.workers.dev")).success).toBe(false);
    expect(parse(on("sitelineweb.com")).success).toBe(false);
    expect(parse(on("clients.sitelineweb.com")).success).toBe(false);
    expect(parse(on("go.hellositeline.test")).success).toBe(true);
  });

  it("hero must be https", () => {
    expect(parse({ ...ok, src: ok.src.replace("https:", "http:"), href: ok.href.replace("https:", "http:") }).success).toBe(false);
    expect(parse({ ...ok, src: "javascript:alert(1)" }).success).toBe(false);
    expect(parse({ ...ok, src: "/api/public/report/t/media/preview.gif", href: "/r/t" }).success).toBe(false);
  });

  it("hero href not under /r/ is refused", () => {
    for (const path of ["/p/abc", "/", "/r", "/rx/abc", "/admin/r/abc", "/r/../admin"]) expect(parse({ ...ok, href: `${BASE}${path}` }).success, path).toBe(false);
  });

  it("hero src not under /api/public/report/ is refused", () => {
    for (const path of ["/img.gif", "/r/abc", "/api/leads", "/api/public/reportx/a", "/api/public/report/../leads"]) expect(parse({ ...ok, src: `${BASE}${path}` }).success, path).toBe(false);
  });

  it("alt is one line of at most 120 characters, and nothing else is accepted in the hero", () => {
    expect(parse({ ...ok, alt: "two\nlines" }).success).toBe(false);
    expect(parse({ ...ok, alt: "x".repeat(121) }).success).toBe(false);
    expect(parse({ ...ok, alt: "x".repeat(120) }).success).toBe(true);
    expect(parse({ ...ok, alt: "" }).success).toBe(false);
    expect(parse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("the approval preview names the video link", () => {
    const spec = buildEmailSendApproval({ mailbox: "outreach", businessId: "b1", to: "dana@acme.test", subject: "Hi", body: "Hello", includeFooter: true, heroImage: ok, title: "t", drafted_by: "logan" }, { physical_address: "", opt_out_line: "", signature: "", signature_json: "" } as never);
    expect(spec.preview).toContain(`Video: ${ok.href}`);
  });
});
