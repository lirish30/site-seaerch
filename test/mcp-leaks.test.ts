import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/worker/approvals/leadNote";
import "../src/worker/approvals/changeOrderSend";
import "../src/worker/approvals/proposalSend";
import "../src/worker/approvals/subscriptionStart";
import { createWelcomeApproval } from "../src/worker/approvals/onboardingWelcome";
import { proposeSubscription } from "../src/worker/billing/subscriptions";
import { getOnboarding } from "../src/worker/db/onboardings";
import { createApproval } from "../src/worker/db/approvals";
import { logActivity } from "../src/worker/db/activity";
import { attachStripeInvoice } from "../src/worker/db/invoices";
import { insertBookingIfFree } from "../src/worker/db/bookings";
import { insertMeetingIfNew } from "../src/worker/db/meetings";
import { createOnboarding, listItems, saveItemText } from "../src/worker/db/onboardings";
import { setAccess } from "../src/worker/db/sites";
import { openIncident } from "../src/worker/db/monitoring";
import { createSingleBatch, insertRun, setRunStatus } from "../src/worker/db/careUpdates";
import { insertReport, setSummary } from "../src/worker/db/careReports";
import { markSubscription } from "../src/worker/db/subscriptions";
import { markSent } from "../src/worker/db/changeOrders";
import { sha256Hex, canonicalJson } from "../src/worker/documents/hash";
import { addChangeOrder, seedClient } from "./fixtures/clients";
import { insertTasks } from "../src/worker/db/tasks";
import { newTask, resetProjectWork } from "./fixtures/projects";
import { tool } from "./fixtures/mcp";
import { redactLinks } from "../src/worker/mcp/tools/views";

/** Every value an agent must never read, each unmistakable in a response. */
const SENTINELS = {
  vaultName: "VAULT-NAME-SENTINEL", accessNote: "ACCESS-NOTE-SENTINEL", clientAnswer: "CLIENT-ANSWER-SENTINEL", subscriptionToken: "SUBSCRIPTION-TOKEN-SENTINEL",
  documentToken: "DOCUMENT-TOKEN-SENTINEL", bookingCancelToken: "BOOKING-CANCEL-TOKEN-SENTINEL", onboardingToken: "ONBOARDING-TOKEN-SENTINEL",
  changeOrderToken: "CHANGE-ORDER-TOKEN-SENTINEL", hostedUrl: "https://invoice.stripe.com/i/HOSTED-URL-SENTINEL", stripeInvoice: "in_STRIPE-INVOICE-SENTINEL",
  stripeCustomer: "cus_STRIPE-CUSTOMER-SENTINEL", stripeSubscription: "sub_STRIPE-SUBSCRIPTION-SENTINEL", transcriptKey: "transcript.json",
  reportToken: "CARE-REPORT-TOKEN-SENTINEL", sshAlias: "SSH-ALIAS-SENTINEL-host", wpPath: "/var/www/WP-PATH-SENTINEL", backupFile: "BACKUP-FILE-SENTINEL",
  mailboxOut: env.MAILBOX_OUTREACH_PASSWORD, mailboxMain: env.MAILBOX_MAIN_PASSWORD,
};
const TRANSCRIPT = "TRANSCRIPT-SENTINEL";
/** Meetily's notes: `get_meeting` shows them (the owner decided so), no other tool may. */
const NOTES = "MEETING-NOTES-SENTINEL";
const BASE = "https://clients.hellositeline.test";

let ids: { businessId: string; dealId: string; siteId: string; projectId: string; meetingId: string };

beforeAll(async () => {
  await env.DB.batch(["meetings", "invoices", "subscriptions", "bookings"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await resetProjectWork();
  const s = await seedClient({ subs: [{ monthlyCents: 12900, key: "care" }, { monthlyCents: 5000, key: "website_subscription", status: "planned" }], invoice: { cents: 50000 } });
  // Access: a vault item name and a note on the site.
  await setAccess(env.DB, s.site!.id, "hosting", { status: "received", vaultItem: SENTINELS.vaultName, note: SENTINELS.accessNote }, "2026-12-05T10:00:00.000Z");
  // The client's own answer to an access question, and the onboarding token.
  const { onboarding } = await createOnboarding(env.DB, {
    businessId: s.businessId, dealId: s.dealId, documentId: s.documentId, kind: "build", test: false,
    items: [{ key: "access_hosting", label: "Hosting", instructions: "Where is the site hosted?", kind: "text", phase: 1 }],
  });
  await saveItemText(env.DB, (await listItems(env.DB, onboarding.id))[0].id, SENTINELS.clientAnswer, "2026-12-05T10:00:00.000Z");
  await env.DB.prepare(`UPDATE onboardings SET token = ? WHERE id = ?`).bind(SENTINELS.onboardingToken, onboarding.id).run();
  // The welcome approval the app builds itself: its preview is the mail, with the client's link (and the onboarding token) in it.
  await createWelcomeApproval(env, (await getOnboarding(env.DB, onboarding.id))!);
  // Subscription token and Stripe ids.
  await markSubscription(env.DB, s.subIds[0], { token: SENTINELS.subscriptionToken, stripeCustomerId: SENTINELS.stripeCustomer, stripeSubscriptionId: SENTINELS.stripeSubscription });
  // The subscription link approval the app builds itself (its link is made on approval, so its preview carries no token), and the links an approval could carry once a token exists.
  await proposeSubscription(env, s.subIds[1], "2027-02-01");
  for (const [kind, link] of [["subscription.start", `${BASE}/s/${SENTINELS.subscriptionToken}`], ["proposal.send", `${BASE}/p/${SENTINELS.documentToken}`],
    ["change_order.send", `${BASE}/c/${SENTINELS.changeOrderToken}`], ["onboarding.nudge", `${BASE}/o/${SENTINELS.onboardingToken}`],
    ["email.send", `https://go.hellositeline.test/r/${SENTINELS.bookingCancelToken}/book?cancel=${SENTINELS.bookingCancelToken}`]] as const) {
    await createApproval(env.DB, { kind, title: `Send ${kind}`, preview: `To: Pat\n\nYour page:\n${link}\n\nThanks`, payload: { link }, record_type: "business", record_id: s.businessId, drafted_by: "logan" });
  }
  // The document's client token.
  await env.DB.prepare(`UPDATE documents SET token = ? WHERE id = ?`).bind(SENTINELS.documentToken, s.documentId).run();
  // A booking's cancel token.
  const booking = (await insertBookingIfFree(env.DB, {
    businessId: s.businessId, dealId: s.dealId, kind: "discovery", startAt: "2026-12-01T17:00:00.000Z", endAt: "2026-12-01T17:20:00.000Z", contactName: "Pat Jones",
    contactEmail: "pat@ace.test", contactPhone: null, answers: null, source: "visitor",
  }))!;
  await env.DB.prepare(`UPDATE bookings SET cancel_token = ? WHERE id = ?`).bind(SENTINELS.bookingCancelToken, booking.id).run();
  // A change order sent with a token.
  const co = await addChangeOrder(s, s.project!.id);
  await markSent(env.DB, co.id, { token: SENTINELS.changeOrderToken, content: co.content, contentSha256: await sha256Hex(canonicalJson(co.content)), sentAt: "2026-12-05T10:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", approvalId: null });
  // The invoice's Stripe ids and hosted link.
  await env.DB.prepare(`UPDATE invoices SET status = 'draft', stripe_customer_id = NULL, stripe_invoice_id = NULL, hosted_url = NULL WHERE id = ?`).bind(s.invoice!.id).run();
  await attachStripeInvoice(env.DB, s.invoice!.id, { stripeCustomerId: SENTINELS.stripeCustomer, stripeInvoiceId: SENTINELS.stripeInvoice, hostedUrl: SENTINELS.hostedUrl, dueOn: "2027-01-20", now: "2026-12-20T10:00:00.000Z" });
  // A meeting with a transcript line.
  const meetingId = crypto.randomUUID();
  const key = `meetings/${meetingId}/transcript.json`;
  await env.RAW.put(key, JSON.stringify({ lines: [{ speaker: "Pat", atSec: 1, text: TRANSCRIPT }] }));
  await insertMeetingIfNew(env.DB, {
    id: meetingId, meetilyId: `m-${meetingId}`, businessId: s.businessId, bookingId: booking.id, windowKey: "w", title: "Kickoff call", startedAt: "2026-12-01T17:00:00.000Z",
    endedAt: "2026-12-01T17:30:00.000Z", transcriptKey: key, notes: NOTES,
  });
  await insertTasks(env.DB, [newTask(s.project!.id, s.businessId, { stepKey: "a", title: "Write copy", owner: "logan" }), newTask(s.project!.id, s.businessId, { stepKey: "b", position: 1, title: "Draft", owner: "claude" })]);
  // The Care updates access and a finished run with a backup: the Care tools must never say the alias, the folder or the backup file's name.
  await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = ?, wp_path = ?, care_paths = '["/"]' WHERE id = ?`).bind(SENTINELS.sshAlias, SENTINELS.wpPath, s.site!.id).run();
  const careBatch = await createSingleBatch(env.DB, s.site!.id, "2026-W49", "2026-12-05T08:00:00.000Z");
  const careRun = await insertRun(env.DB, { batchId: careBatch.id, siteId: s.site!.id, wave: 0, now: "2026-12-05T08:00:00.000Z" });
  await setRunStatus(env.DB, careRun.id, ["queued"], "ok", { summary: "1 applied", backupFile: `siteline-backups/${SENTINELS.backupFile}.sql.gz` }, "2026-12-05T08:30:00.000Z");
  // A monthly report with its client token, and a backup file name and alias stored inside its numbers: the report tool must say neither.
  const { report } = await insertReport(env.DB, {
    businessId: s.businessId, period: "2026-11", token: SENTINELS.reportToken, test: false, now: "2026-12-01T10:00:00.000Z",
    facts: { version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T08:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing", sites: [], edits: null, renewals: [], generatedAt: "2026-12-01T10:00:00.000Z", alias: SENTINELS.sshAlias, backupFile: SENTINELS.backupFile },
  });
  await setSummary(env.DB, report.id, ["collecting"], { summary: "The site was up all month.", recommendation: "Nothing to fix.", source: "claude", now: "2026-12-01T11:00:00.000Z" });
  // An open down incident on the client's site, so the Care tools have something to show.
  await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "HTTP 503", now: "2026-12-05T09:00:00.000Z" });
  await logActivity(env.DB, s.businessId, "note" as never, "Called Pat");
  await createApproval(env.DB, { kind: "lead.note", title: "Note", preview: "p", payload: { businessId: s.businessId, text: "hello" }, record_type: "business", record_id: s.businessId, drafted_by: "mcp" });
  ids = { businessId: s.businessId, dealId: s.dealId, siteId: s.site!.id, projectId: s.project!.id, meetingId };
});

/** Every tool with every id it accepts, in the order a session would call them (the timeline last, so it also carries what the other calls logged). */
const calls = (): [string, unknown][] => [
  ["search_leads", { query: "ace" }], ["search_leads", {}], ["get_lead", { id: ids.businessId }], ["list_approvals", {}], ["list_approvals", { status: "approved" }],
  ["search_clients", {}], ["search_clients", { query: "ace.com" }], ["get_client", { id: ids.businessId }], ["get_site", { id: ids.siteId }],
  ["list_projects", {}], ["list_projects", { business_id: ids.businessId }], ["get_project", { id: ids.projectId }],
  ["list_open_tasks", {}], ["list_open_tasks", { owner: "logan" }], ["list_open_tasks", { owner: "claude" }], ["list_open_tasks", { owner: "client" }],
  ["get_deal", { id: ids.dealId }], ["list_invoices", {}], ["list_invoices", { business_id: ids.businessId }], ["list_invoices", { status: "open" }],
  ["list_meetings", {}], ["list_meetings", { business_id: ids.businessId }], ["get_meeting", { id: ids.meetingId }],
  ["get_care_overview", {}], ["get_care_updates", {}], ["get_care_report", {}], ["get_care_report", { period: "2026-11" }], ["get_care_report", { period: "2026-11", clientId: ids.businessId }], ["list_incidents", {}], ["list_incidents", { open: true }], ["list_incidents", { open: false }], ["list_incidents", { clientId: ids.businessId }],
  ["get_seo_status", {}], ["get_seo_status", { period: "2026-11", clientId: ids.businessId }], ["list_batches", {}],
  ["get_timeline", { record_type: "business", record_id: ids.businessId }], ["get_timeline", { record_type: "project", record_id: ids.projectId }],
];

describe("what no tool may say", () => {
  it("the sentinels are really in the data the tools read", async () => {
    expect(SENTINELS.mailboxOut).toBeTruthy();
    expect(SENTINELS.mailboxMain).toBeTruthy();
    expect((await env.DB.prepare(`SELECT preview FROM approvals WHERE kind = 'onboarding.welcome'`).first<{ preview: string }>())!.preview).toContain(SENTINELS.onboardingToken);
    expect((await env.DB.prepare(`SELECT notes FROM meetings WHERE id = ?`).bind(ids.meetingId).first<{ notes: string }>())!.notes).toBe(NOTES);
    expect((await env.DB.prepare(`SELECT vault_item, note FROM site_access_items WHERE site_id = ? AND key = 'hosting'`).bind(ids.siteId).first())).toEqual({ vault_item: SENTINELS.vaultName, note: SENTINELS.accessNote });
    expect((await env.DB.prepare(`SELECT text_value FROM onboarding_items WHERE key = 'access_hosting'`).first<{ text_value: string }>())!.text_value).toBe(SENTINELS.clientAnswer);
    expect((await env.DB.prepare(`SELECT hosted_url, stripe_invoice_id FROM invoices WHERE business_id = ?`).bind(ids.businessId).first())).toEqual({ hosted_url: SENTINELS.hostedUrl, stripe_invoice_id: SENTINELS.stripeInvoice });
    expect((await env.DB.prepare(`SELECT token FROM change_orders WHERE business_id = ?`).bind(ids.businessId).first<{ token: string }>())!.token).toBe(SENTINELS.changeOrderToken);
  });

  it("list_approvals shows the pending approvals with their client links cut to host and prefix, and no payload", async () => {
    const r = JSON.parse((await tool("list_approvals", {})).text) as { kind: string; preview: string; payload?: unknown }[];
    const kinds = r.map((a) => a.kind);
    for (const k of ["onboarding.welcome", "subscription.start", "proposal.send", "change_order.send", "onboarding.nudge", "email.send"]) expect(kinds, k).toContain(k);
    expect(r.every((a) => !("payload" in a))).toBe(true);
    expect(r.find((a) => a.kind === "onboarding.welcome")!.preview).toContain(`${BASE}/o/[link]`);
    expect(r.find((a) => a.kind === "proposal.send")!.preview).toContain(`${BASE}/p/[link]`);
  });

  it("no read tool, and none of the existing ones, shows a secret, whichever id it is given", async () => {
    for (const [name, args] of calls()) {
      const r = await tool(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.text.slice(0, 200)}`).toBe(false);
      for (const [what, value] of Object.entries(SENTINELS)) expect(r.text, `${name} ${JSON.stringify(args)} shows ${what}`).not.toContain(value);
      expect(r.text, `${name} shows the transcript`).not.toContain(TRANSCRIPT);
      if (name !== "get_meeting") expect(r.text, `${name} shows Meetily's notes`).not.toContain(NOTES);
    }
  });

  it("the Care tools show the incident and the client, but never the site's address or a link", async () => {
    const overview = await tool("get_care_overview", {});
    expect(JSON.parse(overview.text).clients).toEqual([expect.objectContaining({ clientId: ids.businessId, openIncidents: 1 })]);
    const incidents = await tool("list_incidents", { open: true });
    expect(JSON.parse(incidents.text).incidents).toEqual([expect.objectContaining({ clientId: ids.businessId, domain: "ace.com", kind: "down", detail: "HTTP 503" })]);
    for (const r of [overview, incidents]) for (const bad of ["http", "vault", "url", "ace.com/", "token", "stripe"]) expect(r.text).not.toContain(bad);
  });

  it("only get_meeting with include_transcript carries the transcript", async () => {
    const r = await tool("get_meeting", { id: ids.meetingId, include_transcript: true });
    expect(r.text).toContain(TRANSCRIPT);
    expect(r.text).toContain(NOTES);
    for (const [what, value] of Object.entries(SENTINELS)) expect(r.text, `shows ${what}`).not.toContain(value);
  });
});

describe("redactLinks", () => {
  it("keeps the host and prefix, cuts the token, and leaves ordinary text and links alone", () => {
    expect(redactLinks("Your page:\nhttps://c.example/o/AbCdEf123456_-xyz0123456789AbCdEf123456789")).toBe("Your page:\nhttps://c.example/o/[link]");
    expect(redactLinks("https://c.example/r/tok_12345678/book?cancel=abc&x=1")).toBe("https://c.example/r/[link]/book?cancel=[link]&x=1");
    expect(redactLinks("https://c.example/api/public/report/tok_12345678/media/preview.gif")).toBe("https://c.example/api/public/report/[link]/media/preview.gif");
    expect(redactLinks("https://c.example/x/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("https://c.example/x/[link]");
    expect(redactLinks("https://invoice.stripe.com/i/acct_1/live_abc")).toBe("https://invoice.stripe.com/[link]");
    expect(redactLinks("see /s/tok_12345678 now")).toBe("see /s/[link] now");
    expect(redactLinks("https://c.example/s/(the link is made when you approve)")).toBe("https://c.example/s/(the link is made when you approve)");
    expect(redactLinks("https://ace.com/about?page=2 and no links")).toBe("https://ace.com/about?page=2 and no links");
  });

  // A client link is often the last thing in a sentence or a list item: the token must go whatever punctuation follows it.
  const TOKEN = "Zx9_-Qw3Er5TyUiOp7AsDfGhJkL1MnBvCxZ2QwErT4y";
  it("uses a 43-character token for the punctuation cases", () => { expect(TOKEN).toHaveLength(43); });
  it.each([",", ";", ":", "!", "*", "?", "."])("cuts a 43-character token followed by %s and keeps the punctuation", (p) => {
    expect(redactLinks(`Your page: https://c.example/o/${TOKEN}${p}`)).toBe(`Your page: https://c.example/o/[link]${p}`);
    expect(redactLinks(`https://c.example/p/${TOKEN}${p} Thanks`)).toBe(`https://c.example/p/[link]${p} Thanks`);
    expect(redactLinks(`https://c.example/anything/${TOKEN}${p}${p}`)).toBe(`https://c.example/anything/[link]${p}${p}`); // a token with no known prefix, and the mark twice
    expect(redactLinks(`link: /s/${TOKEN}${p}`)).toBe(`link: /s/[link]${p}`); // a bare path
    expect(redactLinks(`https://c.example/r/tok_12345678${p}`)).toBe(`https://c.example/r/[link]${p}`); // a short token after a known prefix
    expect(redactLinks(`https://invoice.stripe.com/i/acct_1/live_abc${p}`)).toBe(`https://invoice.stripe.com/[link]${p}`);
    expect(redactLinks(`https://c.example/r/x/book?cancel=${TOKEN}${p}`)).toBe(`https://c.example/r/x/book?cancel=[link]${p}`);
  });
});
