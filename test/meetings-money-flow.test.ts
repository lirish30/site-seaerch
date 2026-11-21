import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import "../src/worker/queue/kinds";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import { insertBookingIfFree } from "../src/worker/db/bookings";
import { markInvoice } from "../src/worker/db/invoices";
import { setAccess } from "../src/worker/db/sites";
import { markSubscription } from "../src/worker/db/subscriptions";
import { listTasks } from "../src/worker/db/tasks";
import { createDevice } from "../src/worker/helper/auth";
import { MEETILY_SYNC_KIND, syncFileKey, type MatchedMeetingsFile, type MeetilySyncPayload } from "../src/worker/meetings/syncKind";
import { MAIL_SYNC_CRON, runScheduled } from "../src/worker/schedule";
import type { OutboundMessage } from "../src/worker/mail/types";
import { E } from "./fixtures/close";
import { seedClient } from "./fixtures/clients";
import { readyToSend, stubPdfRenderer } from "./fixtures/documents";
import { ok, tool } from "./fixtures/mcp";
import { resetProjectWork } from "./fixtures/projects";
import { setPdfRendererForTests } from "../src/worker/documents/signed";

// Meetings, the MCP tools and the money page, end to end, through the entry points the app really uses: the 15-minute cron, the Mac helper's routes with a device token, the owner's routes
// under /api, the MCP route and the approvals route, with the world replaced by fakes (the mail transport, the PDF browser) and the clock (a fixed calendar in Los Angeles). One story, told in order.
const NOW = "2026-12-01T18:30:00.000Z"; // Tue 1 Dec 10:30 in Los Angeles
const BOOKED_AT = "2026-12-01T17:00:00.000Z"; // the call: 90 minutes ago
const BOOKED_END = "2026-12-01T17:20:00.000Z";
const PAID_AT = "2026-12-01T16:00:00.000Z"; // December in Los Angeles
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const ctx = () => createExecutionContext();

/** Every value an agent must never read, each unmistakable in a response. */
const SECRETS = {
  vaultName: "VAULT-NAME-SENTINEL", accessNote: "ACCESS-NOTE-SENTINEL", subscriptionToken: "SUBSCRIPTION-TOKEN-SENTINEL",
  stripeCustomer: "cus_STRIPE-CUSTOMER-SENTINEL", stripeSubscription: "sub_STRIPE-SUBSCRIPTION-SENTINEL", transcriptKey: "transcript.json",
};
/** What was said in the call: only `get_meeting` with `include_transcript` may carry it. */
const TRANSCRIPT = "TRANSCRIPT-SENTINEL we want a store too";
/** Meetily's own notes: `get_meeting` shows them (the owner decided so), no other tool may. */
const NOTES = "MEETING-NOTES-SENTINEL";
/** A recording the helper matched to a window nobody asked for: the worker drops it. */
const STRAY = "STRAY-RECORDING-SENTINEL";

let mail: Awaited<ReturnType<typeof readyToSend>>;
let cookie = "";
let ipN = 0;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(NOW);
  await resetProjectWork();
  // Everything the money page and the sync read, emptied (children before parents), so the story counts only its own rows.
  await env.DB.batch([
    "helper_jobs", "helper_devices", "billing_holds", "invoice_nudges", "invoices", "task_comments", "time_entries", "tasks", "change_order_views", "change_orders", "project_milestones",
    "project_cadences", "subscriptions", "projects", "onboarding_nudges", "onboarding_answers", "onboarding_files", "onboarding_items", "onboardings", "document_signatures", "document_views",
    "documents", "booking_reminders", "meetings", "bookings", "deals", "site_access_items", "sites", "stripe_customers", "usage", "spend_caps", "approvals", "messages", "google_auth",
  ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM businesses`).run();
  for (const o of (await env.RAW.list({ prefix: "meetings/" })).objects) await env.RAW.delete(o.key);
  await env.DB.prepare(`UPDATE mailboxes SET enabled = 0`).run(); // the cron's mail sync has no mailbox to reach
  stubPdfRenderer();
  cookie = "";
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailDeps(null); setPdfRendererForTests(null);
});

/** The owner's browser: the session cookie. */
async function owner(method: string, path: string, body?: unknown) {
  if (!cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
}
const api = async <T = any>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await owner(method, path, body);
  expect(r.status, `${method} ${path} ${r.status}`).toBe(status);
  return (await r.json()) as T;
};

/** The Mac helper: a device token and nothing else. */
function helperOf(token: string) {
  const ip = `203.0.113.${++ipN}`;
  return (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x/helper${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  }), E, ctx());
}

const approvals = (kind: string) => env.DB.prepare(`SELECT id, status, title, preview, payload FROM approvals WHERE kind = ? ORDER BY created_at, id`).bind(kind)
  .all<{ id: string; status: string; title: string; preview: string; payload: string }>().then((r) => r.results);
const claudeTasks = (kind: string) => env.DB.prepare(`SELECT id, status FROM claude_tasks WHERE kind = ?`).bind(kind).all<{ id: string; status: string }>().then((r) => r.results);

/** A summary Claude would send back, with one action item for Logan, one possible change order and a follow-up. */
const RESULT = {
  summary: "Pat wants a new site with a store. We agreed to start in January.",
  decisions: ["Start in January"],
  actionItems: [{ title: "Draft the sitemap", owner: "logan", dueOn: "2026-12-10" }],
  possibleChangeOrders: [{ title: "Add a store", summary: "Pat wants to sell prints online.", reason: "A store is not in the signed scope.", hours: 8 }],
  followUp: { subject: "Recap of today", body: "Hi Pat, thanks for the time today. I will send the sitemap by Thursday." },
};

describe("meetings, MCP and money, end to end", () => {
  it("a booked call is synced by the helper, summarized by Claude through MCP, mailed only on approval, and the client's money shows while a test client's does not", async () => {
    // --- The world: a client with a build project, a Care subscription and a paid deposit, a booking 90 minutes ago, and a test client with money of its own.
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }], invoice: { cents: 100_000, dueOn: "2026-12-20" } });
    expect(await markInvoice(env.DB, s.invoice!.id, { status: "paid", paidAt: PAID_AT })).toBe(true);
    await setAccess(env.DB, s.site!.id, "hosting", { status: "received", vaultItem: SECRETS.vaultName, note: SECRETS.accessNote }, PAID_AT);
    await markSubscription(env.DB, s.subIds[0], { token: SECRETS.subscriptionToken, stripeCustomerId: SECRETS.stripeCustomer, stripeSubscriptionId: SECRETS.stripeSubscription });
    const booking = (await insertBookingIfFree(env.DB, {
      businessId: s.businessId, dealId: s.dealId, kind: "discovery", startAt: BOOKED_AT, endAt: BOOKED_END, contactName: "Pat Jones", contactEmail: "pat@ace.test", contactPhone: null, answers: null, source: "visitor",
    }))!;
    const test = await seedClient({ test: true, subs: [{ key: "care", monthlyCents: 55_500 }], invoice: { cents: 777_000 } });
    expect(await markInvoice(env.DB, test.invoice!.id, { status: "paid", paidAt: PAID_AT })).toBe(true);

    // --- The 15-minute cron queues one meetily.sync job for the booking's window, and a second tick while it is open queues nothing.
    await runScheduled(E, MAIL_SYNC_CRON, new Date());
    await runScheduled(E, MAIL_SYNC_CRON, new Date());
    const queued = (await env.DB.prepare(`SELECT id, kind, status, payload FROM helper_jobs`).all<{ id: string; kind: string; status: string; payload: string }>()).results;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: MEETILY_SYNC_KIND, status: "pending" });
    const asked = JSON.parse(queued[0].payload) as MeetilySyncPayload;
    expect(asked.windows).toEqual([{ key: `booking:${booking.id}`, businessId: s.businessId, startAt: BOOKED_AT, endAt: BOOKED_END, bookingId: booking.id, source: "booking" }]);
    expect(JSON.stringify(asked)).not.toMatch(/ace\.test|Pat|VAULT|SENTINEL/); // the window says when and for whom (an id), nothing else
    expect((await api("GET", "/meetings/sync-status"))).toMatchObject({ pending: true, lastStatus: "pending" });

    // --- Now the fake transport goes in (after the cron, whose mail sync must not find a mailbox): from here on, every message the app sends is seen.
    mail = await readyToSend();
    setMailDeps({ ...getMailDeps(), now: () => new Date() });

    // --- The Mac helper: claims the job with its device token, uploads one matched meeting and one with a window nobody asked for, and completes.
    const { token } = await createDevice(env.DB, "Mac");
    const helper = helperOf(token);
    const claimed = (await (await helper("/jobs/claim", { method: "POST", body: JSON.stringify({ kinds: [MEETILY_SYNC_KIND] }) })).json()) as { job: { id: string; kind: string; inputs: string[]; outputs: string[]; payload: MeetilySyncPayload } };
    expect(claimed.job).toMatchObject({ kind: MEETILY_SYNC_KIND, inputs: [], outputs: [syncFileKey(asked.syncId)] });
    const [key] = claimed.job.outputs;
    const file: MatchedMeetingsFile = { meetings: [
      { meetilyId: "meetily-call-1", windowKey: `booking:${booking.id}`, title: "Kickoff call with Pat", startedAt: "2026-12-01T17:01:30.000Z", endedAt: "2026-12-01T17:19:00.000Z", notes: NOTES,
        transcript: [{ speaker: "Pat", atSec: 3, text: TRANSCRIPT }, { speaker: null, atSec: 9, text: "Sure, let's talk about the store." }] },
      { meetilyId: "meetily-stray", windowKey: "booking:made-up", title: STRAY, startedAt: "2026-12-01T17:01:30.000Z", endedAt: "2026-12-01T17:19:00.000Z", notes: STRAY, transcript: [{ speaker: "Sam", atSec: 1, text: STRAY }] },
    ] };
    const put = await helper(`/jobs/${claimed.job.id}/output?key=${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(file), headers: { "content-type": "application/json" } });
    expect(put.status).toBe(200);
    // Only the job's own output key is writable.
    expect((await helper(`/jobs/${claimed.job.id}/output?key=${encodeURIComponent("meetings/sync/other.json")}`, { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
    const done = await helper(`/jobs/${claimed.job.id}/complete`, { method: "POST", body: JSON.stringify({ result: { scanned: 3, matched: 2, key } }) });
    expect({ status: done.status, body: await done.json() }).toEqual({ status: 200, body: { ok: true } });
    expect(await env.RAW.get(key)).toBeNull(); // the sync file is deleted once applied
    expect((await api("GET", "/meetings/sync-status"))).toMatchObject({ pending: false, lastStatus: "done" });

    // --- The meeting is on the client's list, once: the stray recording was dropped and left no trace.
    const listed = (await api<{ meetings: { id: string; title: string; status: string; summary: string | null; followupSent: boolean }[] }>("GET", `/meetings?businessId=${s.businessId}`)).meetings;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ title: "Kickoff call with Pat", status: "received", summary: null, followupSent: false });
    const meetingId = listed[0].id;
    expect((await api<{ meetings: unknown[] }>("GET", `/meetings`)).meetings).toHaveLength(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM meetings`).first<{ n: number }>())!.n).toBe(1);
    expect(JSON.stringify(listed)).not.toContain(STRAY);
    expect((await env.RAW.list({ prefix: "meetings/" })).objects.map((o) => o.key)).toEqual([`meetings/${meetingId}/transcript.json`]);
    expect(JSON.stringify(listed)).not.toContain(TRANSCRIPT); // the list never carries the transcript
    expect(await api("GET", `/meetings/${meetingId}`)).toMatchObject({ meeting: { id: meetingId, status: "received", summarizing: true, followupPending: false, notes: NOTES } });
    const summarizeTasks = await claudeTasks("meeting.summarize");
    expect(summarizeTasks).toHaveLength(1);
    expect(summarizeTasks[0].status).toBe("pending");
    // Recording a meeting changes nothing else: no task, no approval, no mail.
    expect(await approvals("meeting.followup")).toEqual([]);
    expect(mail.sent).toEqual([]);

    // --- Claude works the task through MCP: next_claude_task hands out the transcript in the untrusted block only, and a refused result changes nothing.
    const next = await tool("next_claude_task", {});
    expect(next.isError).toBe(false);
    expect(next.text).toContain(summarizeTasks[0].id);
    expect(next.text).toContain("meeting.summarize");
    const split = next.text.indexOf("<untrusted_site_content>");
    expect(split).toBeGreaterThan(0);
    expect(next.text.slice(split)).toContain(TRANSCRIPT);
    expect(next.text.slice(0, split)).not.toContain(TRANSCRIPT);
    expect(next.text).not.toContain(SECRETS.vaultName);
    expect(next.text).not.toContain(SECRETS.accessNote);
    const priced = await tool("complete_claude_task", { id: summarizeTasks[0].id, result: { ...RESULT, followUp: { subject: "Recap", body: "Hi Pat, the store will be $4,000." } } });
    expect(priced.isError).toBe(true);
    expect(priced.text).toMatch(/dollar sign|price/i);
    expect(await approvals("meeting.followup")).toEqual([]);
    expect((await api("GET", `/meetings/${meetingId}`)).meeting.status).toBe("received");
    const good = await tool("complete_claude_task", { id: summarizeTasks[0].id, result: RESULT });
    expect(good.isError, good.text).toBe(false);

    // --- A task for Logan, a change-order draft and the follow-up are waiting; nothing has been mailed.
    const made = (await listTasks(env.DB, s.project!.id)).filter((t) => !t.isStep);
    expect(made.map((t) => ({ title: t.title, owner: t.owner, dueOn: t.dueOn }))).toEqual([{ title: "Draft the sitemap", owner: "logan", dueOn: "2026-12-10" }]);
    const drafts = await approvals("change_order.draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("pending");
    expect(JSON.parse(drafts[0].payload)).toMatchObject({ projectId: s.project!.id, title: "Add a store", hours: 8, source: "meeting" });
    const followups = await approvals("meeting.followup");
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({ status: "pending" });
    expect(JSON.parse(followups[0].payload)).toEqual({ meetingId });
    expect(followups[0].preview).toContain("Subject: Recap of today");
    expect(mail.sent).toEqual([]); // nothing goes out until Logan approves
    const summarized = await api<{ meeting: { status: string; followupPending: boolean; followupSentAt: string | null; summarizing: boolean; summary: { actionItems: unknown[]; possibleChangeOrders: unknown[] } } }>("GET", `/meetings/${meetingId}`);
    expect(summarized.meeting).toMatchObject({ status: "summarized", followupPending: true, followupSentAt: null, summarizing: false });
    expect(summarized.meeting.summary).toMatchObject({ actionItems: [expect.anything()], possibleChangeOrders: [expect.anything()] });
    expect((await claudeTasks("meeting.summarize"))[0].status).toBe("done");

    // --- Approving the follow-up through the real route sends exactly one mail, to the booking's contact, and says so on the meeting.
    const approve = await owner("POST", `/approvals/${followups[0].id}/approve`, {});
    expect({ status: approve.status, body: await approve.json() }).toEqual({ status: 200, body: { ok: true } });
    const sent: OutboundMessage[] = mail.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "pat@ace.test", subject: "Recap of today" });
    expect(sent[0].text).toContain("I will send the sitemap by Thursday.");
    expect(sent[0].text).not.toMatch(/SENTINEL/);
    expect((await api("GET", `/meetings?businessId=${s.businessId}`)).meetings[0]).toMatchObject({ followupSent: true });
    expect((await approvals("change_order.draft"))[0].status).toBe("pending"); // the change order is still Logan's to decide
    const again = await owner("POST", `/approvals/${followups[0].id}/approve`, {});
    expect(again.status).not.toBe(200);
    expect(mail.sent).toHaveLength(1);

    // --- Claude reads the client, the meeting and the money through MCP, and no tool shows a secret.
    const client = await tool("get_client", { id: s.businessId });
    const meeting = await tool("get_meeting", { id: meetingId });
    const money = await tool("get_money_summary", {});
    for (const [name, r] of [["get_client", client], ["get_meeting", meeting], ["get_money_summary", money]] as const) {
      expect(r.isError, `${name}: ${r.text.slice(0, 200)}`).toBe(false);
      for (const [what, value] of Object.entries(SECRETS)) expect(r.text, `${name} shows ${what}`).not.toContain(value);
      expect(r.text, `${name} shows the transcript`).not.toContain(TRANSCRIPT);
      expect(r.text, `${name} shows the stray recording`).not.toContain(STRAY);
      expect(r.text, `${name} has a NaN`).not.toMatch(/NaN|Infinity/);
    }
    expect(client.text).not.toContain(NOTES);
    expect(money.text).not.toContain(NOTES);
    expect(meeting.text).toContain(NOTES); // intended: Meetily's own notes
    expect(JSON.parse(meeting.text)).toMatchObject({ id: meetingId, status: "summarized" });
    const withTranscript = await tool("get_meeting", { id: meetingId, include_transcript: true });
    expect(withTranscript.text).toContain(TRANSCRIPT); // intended, and only here
    for (const [what, value] of Object.entries(SECRETS)) expect(withTranscript.text, `get_meeting with the transcript shows ${what}`).not.toContain(value);
    expect((await ok<{ id: string }[]>("list_meetings", { business_id: s.businessId })).map((m) => m.id)).toEqual([meetingId]);

    // --- The money page and its MCP twin show the client's paid deposit and Care, and none of the test client's.
    const page = await api<{ revenue: { monthCents: number; months: { month: string; cents: number }[] }; mrr: { cents: number; subscriptions: number }; ltv: { businessId: string; paidCents: number; mrrCents: number }[]; ar: { openCents: number }; freedom: { mrrCents: number } }>("GET", "/money");
    expect(page.revenue.monthCents).toBe(100_000);
    expect(page.revenue.months.at(-1)).toEqual({ month: "2026-12", cents: 100_000 });
    expect(page.mrr).toMatchObject({ cents: 12_900, subscriptions: 1 });
    expect(page.ltv).toEqual([{ businessId: s.businessId, name: expect.any(String), paidCents: 100_000, mrrCents: 12_900 }]);
    expect(page.ar.openCents).toBe(0);
    expect(page.freedom.mrrCents).toBe(12_900);
    const raw = JSON.stringify(page);
    for (const testFigure of ["777000", "55500", test.businessId]) expect(raw, `the test client's ${testFigure} is on the page`).not.toContain(testFigure);
    expect(raw).not.toMatch(/NaN|Infinity/);
    expect(JSON.parse(money.text)).toMatchObject({ revenue: { monthCents: 100_000 }, mrr: { cents: 12_900, subscriptions: 1 } });
    // The page carries no token or Stripe id either.
    for (const value of [SECRETS.subscriptionToken, SECRETS.stripeCustomer, SECRETS.stripeSubscription, SECRETS.vaultName, SECRETS.accessNote]) expect(raw).not.toContain(value);
    // Still one mail, and nothing was approved but the follow-up.
    expect(mail.sent).toHaveLength(1);
    expect((await approvals("meeting.followup")).map((a) => a.status)).toEqual(["approved"]);
  });

  it("the money page and its MCP tool with nothing but a test client's data are zeros, never NaN", async () => {
    const test = await seedClient({ test: true, subs: [{ key: "care", monthlyCents: 55_500 }], invoice: { cents: 777_000 } });
    expect(await markInvoice(env.DB, test.invoice!.id, { status: "paid", paidAt: PAID_AT })).toBe(true);
    const page = await api<any>("GET", "/money");
    expect(page).toMatchObject({
      revenue: { monthCents: 0 }, ar: { openCents: 0, oldest: [] }, mrr: { cents: 0, subscriptions: 0, churnedLast30Cents: 0, churnRatePct: null },
      bookedNotBilled: { cents: 0, rows: [] }, profit: [], ltv: [], freedom: { mrrCents: 0, pct: 0 },
    });
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/NaN|Infinity/);
    expect(text).not.toContain(test.businessId);
    const viaMcp = await tool("get_money_summary", {});
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.text).not.toMatch(/NaN|Infinity/);
    expect(JSON.parse(viaMcp.text)).toMatchObject({ revenue: { monthCents: 0 }, mrr: { cents: 0 }, ltv: [] });
  });
});
