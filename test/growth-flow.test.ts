import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import "../src/worker/approvals/ladderMail";
import "../src/worker/approvals/studioPost";
import { insertAudit } from "../src/worker/db/audits";
import { addCadence, createProject } from "../src/worker/db/projects";
import { upsertProfile } from "../src/worker/db/seo";
import { ensureSeedSops } from "../src/worker/db/sops";
import type { Env } from "../src/worker/env";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import { monitoringDeps } from "../src/worker/monitoring/sweep";
import "../src/worker/queue/kinds";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import * as images from "../src/worker/studio/images";
import type { Finding } from "../src/worker/types";
import { seedDoc, sentInvoice } from "./fixtures/billing";
import { seedClient } from "./fixtures/clients";
import { seedBusiness } from "./fixtures/cro";
import { readyToSend } from "./fixtures/documents";
import { expectFiniteNumbers } from "./fixtures/numbers";
import { mcp, tool } from "./fixtures/mcp";
import { T0, resetProjectWork, seedSteps } from "./fixtures/projects";

// The growth and retain work (Plan 15), end to end, through the entry points the app really uses on a fixed calendar (Los Angeles): the owner's routes under /api with a real session, the daily cron
// (`runScheduled` with the daily cron string and a date of the test's choosing), the real task service (a step finished through POST /api/tasks/:id/complete), the real approval path (POST /api/approvals/:id/approve),
// the MCP route (the queue's claim and completion, and the Studio read) and the real billing reminder sweep inside the daily cron. The only fakes are the outside world: the registry lookup the daily cron makes,
// the mail transport (which counts what really goes out) and the image drawing (the Browser Rendering binding hangs in this pool, so `renderPostImages` is given a stand-in PNG function, as test/studio-copy.test.ts
// does). Nothing is mailed except through an approval, and no Google, Stripe or Claude call is ever made.
const e = env as Env;
const D0 = new Date("2026-12-03T17:00:00.000Z"); // Thursday 3 December, 09:00 in Los Angeles: the build is finished and the day's cron runs
const D10 = new Date("2026-12-13T17:00:00.000Z"); // ten days later
const D30 = new Date("2027-01-02T17:00:00.000Z"); // thirty days after launch
const R1 = new Date("2027-01-17T17:00:00.000Z"); // three days before the invoice is due: reminder 1
const R4 = new Date("2027-01-27T17:00:00.000Z"); // seven days after it was due: the last reminder
const at = (d: Date) => vi.setSystemTime(d);
const ctx = () => createExecutionContext();
const PLACE = "ChIJ-GROWTH-FLOW-PLACE";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let cookie = "";
let errors: unknown[][] = [];
let mail: Awaited<ReturnType<typeof readyToSend>>;
const realFetch = monitoringDeps.fetch;
const apiBodies: string[] = [];

beforeEach(async () => {
  errors = []; cookie = ""; apiBodies.length = 0;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(D0);
  monitoringDeps.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch; // the registry answers nothing
  // The drawing stand-in: the real renderPostImages (R2 writes, keys, the post's image list) with a fake PNG instead of the browser.
  const real = images.renderPostImages;
  vi.spyOn(images, "renderPostImages").mockImplementation((en, id) => real(en, id, async () => PNG));
  await env.DB.batch(["studio_posts", "ladder_steps", "auto_approvals", "auto_approve_rules", "seo_profiles"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const t of ["care_page_checks", "care_runs", "care_batches", "care_updates", "site_inventories", "site_incidents", "site_checks", "helper_jobs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "messages", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "approvals"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
  mail = await readyToSend();
  setMailDeps({ ...getMailDeps(), now: () => new Date() }); // the mail transport's clock is the test's clock
});
afterEach(() => {
  monitoringDeps.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailDeps(null);
});

// --- the owner's side -----------------------------------------------------------------------------------------------------------------------------------------------------

async function owner(method: string, path: string, body?: unknown) {
  if (!cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), e, ctx());
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), e, ctx());
}
/** A JSON route that must answer `expected`; every body is kept so the last check can look through all of them. */
const api = async <T = any>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
  const r = await owner(method, path, body);
  const text = await r.text();
  expect(r.status, `${method} ${path} ${r.status} ${text.slice(0, 200)}`).toBe(expected);
  apiBodies.push(text);
  return JSON.parse(text) as T;
};
/** The daily cron on a given morning. The owner's session does not last weeks, so after a jump in time the owner logs in again, as a person would. */
const cron = async (d: Date) => { at(d); cookie = ""; await runScheduled(e, DAILY_CRON, d); };

const count = async (table: string, where = "1 = 1") => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
const pendingOf = async (kind: string) => (await api<{ items: { id: string; kind: string; title: string; preview: string; status: string; payload: string }[] }>("GET", "/approvals?status=pending")).items.filter((a) => a.kind === kind);
type LadderRow = { id: string; step: string; dueOn: string; status: string; approvalId: string | null; link: string | null; note: string; doneAt: string | null };
const ladderOf = async (businessId: string) => (await api<{ rows: LadderRow[] }>("GET", `/clients/${businessId}/ladder`)).rows;
const todayItems = async () => (await api<{ items: { kind: string; businessId: string; reason: string; priority: number }[] }>("GET", "/today")).items;

const finding = (evidence: string, o: Partial<Finding> = {}): Finding => ({ code: "no_cta", category: "cro", severity: "important", points: 5, evidence, recommendation: "Add a button.", source: "rule", ...o });
async function audit(businessId: string, findings: Finding[]) {
  return insertAudit(env.DB, {
    business_id: businessId, site_status: "ok", partial: false, pagespeed_mobile: 31, lcp_ms: 4100, cls: 0.2, mobile_friendly: null, https: true, has_title: true, has_meta_description: true,
    has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0, platform: "wix", seo_score: 62, accessibility_score: 71, score: 8000, offer: "new_site", findings,
    raw_r2_key: null, mail_warning: null, health_score: 40, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {},
  } as never);
}

describe("growth and retain, end to end", () => {
  it("a finished build climbs the ladder, the boards and capacity read the week's work, a switched-on rule sends the first reminder but never the last, and a Studio post goes from audit to posted", async () => {
    // --- The world. Ace Plumbing: a real client with a finished-to-be build, a Local SEO place id and a live Care project with the weekly checklist.
    const ace = await seedClient();
    await upsertProfile(env.DB, ace.businessId, { placeId: PLACE }, D0.toISOString());
    const care = (await createProject(env.DB, {
      businessId: ace.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false, startedAt: T0,
    })).project;
    await addCadence(env.DB, care.id, "CARE-1");
    const [lastStep] = await seedSteps(ace.project!.id, ace.businessId, [{ key: "7.4", title: "Launch the site" }]);
    expect(await count("ladder_steps")).toBe(0);
    expect(mail.sent).toEqual([]);

    // --- (1) The build's last step is finished through the real task route: the project is done and the ladder has its five steps, dated from the launch day in the booking zone.
    const done = await api<{ task: { status: string } }>("POST", `/tasks/${lastStep.id}/complete`);
    expect(done.task.status).toBe("done");
    expect((await api<{ project: { status: string } }>("GET", `/projects/${ace.project!.id}`)).project.status).toBe("done");
    let rows = await ladderOf(ace.businessId);
    expect(rows.map((r) => [r.step, r.dueOn, r.status])).toEqual([
      ["review_request", "2026-12-03", "waiting"], ["testimonial", "2026-12-13", "waiting"], ["thank_you", "2027-01-02", "waiting"], ["check_in", "2027-03-03", "waiting"], ["case_study", "2027-04-02", "waiting"],
    ]);
    expect(mail.sent).toEqual([]);

    // --- (2) The daily cron on launch day drafts the review request as an approval and mails nothing.
    await cron(D0);
    rows = await ladderOf(ace.businessId);
    expect(rows.map((r) => [r.step, r.status])).toEqual([["review_request", "drafted"], ["testimonial", "waiting"], ["thank_you", "waiting"], ["check_in", "waiting"], ["case_study", "waiting"]]);
    const reviewApproval = (await pendingOf("ladder.mail"));
    expect(reviewApproval).toHaveLength(1);
    expect(reviewApproval[0].id).toBe(rows[0].approvalId);
    expect(reviewApproval[0].title).toBe("Review request for Ace Plumbing");
    expect(reviewApproval[0].preview).toContain("To: Pat Jones <pat@ace.test>");
    expect(reviewApproval[0].preview).toContain(`https://search.google.com/local/writereview?placeid=${PLACE}`); // made from the Local SEO place id
    expect(mail.sent).toEqual([]); // drafted, not sent
    // A second run the same morning drafts nothing more.
    await cron(D0);
    expect(await count("approvals", "kind = 'ladder.mail'")).toBe(1);

    // The owner approves it through the route: exactly one message goes, to the contact, and the step is done.
    expect(await api("POST", `/approvals/${reviewApproval[0].id}/approve`, {})).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("pat@ace.test");
    expect(mail.sent[0].text).toContain(`https://search.google.com/local/writereview?placeid=${PLACE}`);
    expect(mail.sent[0].text).not.toMatch(/guarantee|\$\d|#1/i);
    rows = await ladderOf(ace.businessId);
    expect(rows[0]).toMatchObject({ step: "review_request", status: "done" });
    expect(rows[0].doneAt).not.toBeNull();

    // --- (3) Ten days later the cron drafts the testimonial request. Nothing more is mailed.
    await cron(D10);
    rows = await ladderOf(ace.businessId);
    expect(rows.map((r) => [r.step, r.status])).toEqual([["review_request", "done"], ["testimonial", "drafted"], ["thank_you", "waiting"], ["check_in", "waiting"], ["case_study", "waiting"]]);
    const testimonial = await pendingOf("ladder.mail");
    expect(testimonial).toHaveLength(1);
    expect(testimonial[0].title).toBe("Testimonial request for Ace Plumbing");
    expect(testimonial[0].id).toBe(rows[1].approvalId);
    expect(mail.sent).toHaveLength(1);

    // --- (4) Thirty days after launch the thank-you package is a Today item (a task for Logan, not a mail), and marking it done clears it.
    await cron(D30);
    rows = await ladderOf(ace.businessId);
    const thankYou = rows.find((r) => r.step === "thank_you")!;
    expect(thankYou.status).toBe("due");
    const due = (await todayItems()).filter((i) => i.kind === "ladder_due");
    expect(due).toEqual([expect.objectContaining({ businessId: ace.businessId, reason: "Thank-you package is due for Ace Plumbing", priority: 56 })]);
    expect(await count("approvals", "kind = 'ladder.mail' AND status = 'pending'")).toBe(1); // still only the testimonial draft: the thank-you is not a mail
    expect((await api<{ row: { status: string } }>("POST", `/ladder/${thankYou.id}/done`)).row.status).toBe("done");
    expect((await todayItems()).filter((i) => i.kind === "ladder_due")).toEqual([]);
    expect((await ladderOf(ace.businessId)).find((r) => r.step === "thank_you")).toMatchObject({ status: "done" });
    expect(mail.sent).toHaveLength(1);

    // --- (5) The batch board lists Ace under the Care template for this week, once the real project sweep (inside the cron) made its weekly task; the capacity card counts that task.
    const weekly = (await env.DB.prepare(`SELECT id, title, owner, est_minutes, due_on, period_key FROM tasks WHERE project_id = ? AND cadence_key = 'CARE-1' ORDER BY period_key`).bind(care.id).all<{ id: string; title: string; owner: string; est_minutes: number; due_on: string; period_key: string }>()).results;
    expect(weekly.map((t) => t.period_key)).toEqual(["2026-W49", "2026-W50", "2026-W53"]); // the cron made one on 3 December, one on 13 December and one on 2 January
    const thisWeek = weekly[2];
    const { groups } = await api<{ groups: { templateKey: string; period: string; open: number; tasks: { taskId: string; client: string; businessId?: string }[] }[] }>("GET", "/batches");
    const careGroup = groups.find((g) => g.templateKey === "CARE-1" && g.period === "2026-W53")!;
    expect(careGroup).toBeTruthy();
    expect(careGroup.tasks.map((t) => [t.taskId, t.client])).toEqual([[thisWeek.id, "Ace Plumbing"]]);
    expect(groups.some((g) => g.templateKey === "CARE-1" && g.period === "2026-W49")).toBe(false); // the old week is not on the board
    const cap = await api<{ weeks: { monday: string; bookedMinutes: number; limitMinutes: number }[]; carryOverMinutes: number; clients: { count: number; limit: number }; sentence: string }>("GET", "/capacity");
    expect(cap.weeks[0].monday).toBe("2026-12-28");
    expect(cap.weeks[0].limitMinutes).toBe(20 * 60);
    expect(thisWeek.est_minutes).toBeGreaterThan(0);
    // Your time: yours in full, the ones Claude drafts for your review at a quarter, Claude's own not at all.
    const mine = (t: { owner: string; est_minutes: number }) => (t.owner === "logan" ? t.est_minutes : t.owner === "claude_drafts" ? t.est_minutes * 0.25 : 0);
    expect(mine(thisWeek)).toBeGreaterThan(0);
    const share = mine(thisWeek) / thisWeek.est_minutes;
    const carried = mine(weekly[0]) + mine(weekly[1]); // the two earlier weeks are still open and were due before this Monday
    expect(cap.weeks[0].bookedMinutes).toBeCloseTo(thisWeek.est_minutes * share + carried, 5);
    expect(cap.carryOverMinutes).toBeCloseTo(carried, 5);
    expect(cap.clients).toEqual({ count: 1, limit: 45 });
    expect(cap.sentence).toMatch(/^This week is .* of 20 hours booked/);

    // --- (6) The auto-approve rule for invoice reminders is switched on through its route. A real open invoice, mailed to the client on 13 January and due on the 20th, goes through the daily cron's real billing sweep:
    // reminder 1 (three days before it is due) goes out with nobody pressing anything; the last reminder (seven days after) stays pending for the owner.
    const billed = await seedDoc();
    const invoice = await sentInvoice(billed, { dueOn: "2027-01-20" });
    at(new Date(R1.getTime() - 3_600_000));
    cookie = "";
    const rule = await api<{ rules: { kind: string; enabled: boolean }[] }>("PUT", "/auto-approve/invoice.reminder", { enabled: true });
    expect(rule.rules.filter((r) => r.enabled).map((r) => r.kind)).toEqual(["invoice.reminder"]);
    const mailedBefore = mail.sent.length;
    await cron(R1);
    const reminders = async () => (await env.DB.prepare(`SELECT id, status, json_extract(payload, '$.step') AS step FROM approvals WHERE kind = 'invoice.reminder' ORDER BY created_at, rowid`).all<{ id: string; status: string; step: number }>()).results;
    expect((await reminders()).map((r) => [r.step, r.status])).toEqual([[1, "approved"]]);
    expect(mail.sent).toHaveLength(mailedBefore + 1);
    expect(mail.sent[mailedBefore].to).toBe("pat@ace.test");
    expect(mail.sent[mailedBefore].subject).toMatch(/invoice|reminder|payment/i);
    expect(mail.sent[mailedBefore].text).toContain("https://invoice.stripe.com/i/abc");
    const auto = await api<{ today: number; cap: number; rules: { kind: string; enabled: boolean }[]; recent: { kind: string; outcome: string; businessName: string }[] }>("GET", "/auto-approve");
    expect(auto).toMatchObject({ today: 1, cap: 20 });
    expect(auto.recent).toEqual([expect.objectContaining({ kind: "invoice.reminder", outcome: "sent" })]);
    // Seven days after the due date the last reminder is drafted, and waits.
    await cron(R4);
    expect((await reminders()).map((r) => [r.step, r.status])).toEqual([[1, "approved"], [4, "pending"]]);
    expect(mail.sent).toHaveLength(mailedBefore + 1); // the last step needs a person
    expect((await api<{ today: number }>("GET", "/auto-approve")).today).toBe(0); // a new day: the count is per day
    expect(await count("auto_approvals")).toBe(1);
    expect(invoice.id).toBeTruthy();
    // Only the person can send it: the owner presses the button, and the second message goes.
    const last = (await reminders())[1];
    expect(await api("POST", `/approvals/${last.id}/approve`, {})).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(mailedBefore + 2);

    // --- (7) A Studio audit tip: an anonymous post made from a real audit of a business with a name, a site and a phone number that must never reach Claude or the page.
    const lead = await seedBusiness({ name: "Pinecrest Roofing", websiteUrl: "https://pinecrest-roofing.example.com" });
    const a = await audit(lead.id, [
      finding("Pinecrest Roofing hides its phone number on a phone", { recommendation: "Show it at the top of every page.", severity: "critical" }),
      finding("The page at pinecrest-roofing.example.com loads slowly on a phone", { code: "slow_mobile", recommendation: "Shrink the large photos." }),
      // The seeded phone and address are written into a finding on purpose, so the secrets check below has something real to catch.
      finding("Call (208) 555-1234 or visit 12 Main St, Boise, ID 83702 is not a link people can tap", { recommendation: "Make the number a tap-to-call link." }),
    ]);
    const post = await api<{ id: string; status: string; anonymize: boolean; images: number }>("POST", "/studio", { kind: "audit_tip", auditId: a.id }, 201);
    expect(post).toMatchObject({ status: "draft", anonymize: true, images: 0 });
    const written = await api<{ status: string; claudeTaskId: string }>("POST", `/studio/${post.id}/write`);
    expect(written.status).toBe("writing");
    expect(await count("claude_tasks", "kind = 'studio.copy' AND status = 'pending'")).toBe(1);

    // Claude claims it through the MCP route and is shown the facts in the untrusted block only; the business is not named anywhere in what it is shown.
    const claimed = await tool("next_claude_task", { kinds: ["studio.copy"] });
    expect(claimed.isError).toBe(false);
    expect(claimed.text).toContain("<untrusted_site_content>");
    const [head, block] = claimed.text.split("<untrusted_site_content>");
    // The seeded phone is "(208) 555-1234": every way it could be written is checked whole (a bare "208" would match a random id or timestamp), and so are the seeded address and its pieces.
    const PHONE = ["(208) 555-1234", "208-555-1234", "208.555.1234", "208 555 1234", "2085551234", "+1 208 555 1234", "555-1234"];
    for (const secret of ["Pinecrest", "pinecrest-roofing", ...PHONE, "12 Main St", "83702", lead.id]) {
      expect(head, `${secret} is above the untrusted block`).not.toContain(secret);
      expect(block, `${secret} is in the untrusted block`).not.toContain(secret);
    }
    expect(block).toContain("phone number on a phone"); // the facts did arrive, with the name taken out
    const claimedId = (await env.DB.prepare(`SELECT id FROM claude_tasks WHERE kind = 'studio.copy'`).first<{ id: string }>())!.id;
    // A result that promises a ranking is refused and the task stays claimed; a good one is applied.
    const refused = await tool("complete_claude_task", { id: claimedId, result: { headline: "Fix your site", caption: "We guarantee the first page of Google.", slides: [{ title: "Show your phone", body: "Put it at the top." }], tags: ["roofing"] } });
    expect(refused.isError).toBe(true);
    expect((await env.DB.prepare(`SELECT status FROM claude_tasks WHERE id = ?`).bind(claimedId).first<{ status: string }>())!.status).toBe("claimed");
    expect(await count("approvals", "kind = 'studio.post'")).toBe(0);
    const GOOD = {
      headline: "Three fixes a roofer's website needs",
      caption: "Most roofing sites lose people in the first few seconds.\n\nHere are the fixes we see most often, and what to do about each.",
      slides: [{ title: "Show your phone number", body: "Put it at the top of every page so people can call in one tap." }, { title: "Make the page load fast", body: "Shrink big photos so the page opens quickly on a phone." },
        { title: "Ask us to check your site", body: "Send us a message and we will look at yours the same way." }],
      tags: ["roofing", "smallbusiness"],
    };
    const finished = await tool("complete_claude_task", { id: claimedId, result: GOOD });
    expect(finished, finished.text).toMatchObject({ isError: false, text: "done" });
    // The copy is saved, the pictures are drawn, the post is in review and exactly one studio.post approval waits.
    const reviewPost = (await api<{ posts: { id: string; status: string; images: number }[] }>("GET", "/studio")).posts.find((p) => p.id === post.id)!;
    expect(reviewPost).toMatchObject({ status: "review", images: 5 }); // the cover, the tip slides and the closing card
    const studioApprovals = await pendingOf("studio.post");
    expect(studioApprovals).toHaveLength(1);
    expect(studioApprovals[0].title).toBe(`Approve the audit tip post "${GOOD.headline}"`);
    expect(studioApprovals[0].preview).toContain("Anonymous: the business is not named.");
    // Logan approves it: nothing is posted anywhere, the post is approved; he posts it by hand and marks it posted.
    expect(await api("POST", `/approvals/${studioApprovals[0].id}/approve`, {})).toEqual({ ok: true });
    expect((await api<{ posts: { id: string; status: string }[] }>("GET", "/studio")).posts.find((p) => p.id === post.id)!.status).toBe("approved");
    const posted = await api<{ status: string; postedOn: string | null }>("POST", `/studio/${post.id}/posted`);
    expect(posted.status).toBe("posted");
    expect(posted.postedOn).toMatch(/^2027-01-27/);
    // A picture is served only through the authenticated route, as a PNG.
    const pic = await owner("GET", `/studio/${post.id}/image/1`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await pic.arrayBuffer())).toEqual(PNG);

    // --- Nothing leaked, nothing was mailed that nobody approved, nothing was logged as an error.
    const mcpStudio = await tool("get_studio_posts", {});
    const mcpBatches = await tool("list_batches", {});
    for (const r of [mcpStudio, mcpBatches]) expect(r.isError, r.text).toBe(false);
    for (const body of [...apiBodies, mcpStudio.text, mcpBatches.text]) {
      expect(body).not.toMatch(/studio\/[A-Za-z0-9_-]+\//); // no R2 key of a post's picture in any JSON an agent or the page reads
      expect(body).not.toContain(".png");
    }
    for (const body of [...apiBodies.filter((b) => b.includes("studio")), mcpStudio.text]) {
      expect(body).not.toContain("Pinecrest");
      expect(body).not.toContain(lead.id);
    }
    expect(mail.sent.map((m) => m.to)).toEqual(["pat@ace.test", "pat@ace.test", "pat@ace.test"]); // the review request, reminder 1 and the last reminder: each one's own approval
    expectFiniteNumbers(cap);
    expect(await mcp("tools/list", {}).then((j) => j.result.tools.length)).toBe(33);
    expect(errors).toEqual([]);
  });
});
