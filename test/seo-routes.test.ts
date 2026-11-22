import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { proposeSeoReportApproval } from "../src/worker/approvals/seoReport";
import { ensureCitations, setCitation } from "../src/worker/db/seo";
import { getSeoReport, setSeoTaskAndApproval } from "../src/worker/db/seoReports";
import { ensureSeedSops } from "../src/worker/db/sops";
import type { Env } from "../src/worker/env";
import { enqueueTask } from "../src/worker/queue/db";
import "../src/worker/queue/kinds";
import { SEO_REPORT_KIND, SEO_REPORT_TARGET } from "../src/worker/queue/seoReport";
import { resetProjectWork } from "./fixtures/projects";
import { E } from "./fixtures/close";
import {
  MAPS_URL, PLACE_ID, PRIORITIES, RECOMMENDATION, REPLY_DRAFT, SUMMARY, resetSeo, seoClient, seoContent, seoRanked, seoReport, seoReview, seoSnapshot,
} from "./fixtures/seo";

// The owner's Local SEO routes (Plan 14, Task 11): the aggregate for one client, the board, the month's reports, Logan's edit of the words and the take-back. The clock: 2 December 2026, so last month is November.
const NOW = new Date("2026-12-02T18:00:00.000Z");
const BASE = "https://clients.hellositeline.test";
const ctx = () => createExecutionContext();
const e = { ...E, CLIENT_LINK_BASE: BASE } as Env;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetSeo();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "messages"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

let cookie = "";
async function signIn() {
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
}
const call = async (method: string, path: string, body?: unknown, session = true) => {
  if (session && !cookie) await signIn();
  return worker.fetch(new Request(`https://x/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(session ? { cookie } : {}), "content-type": "application/json" },
  }), e, ctx());
};
const json = async <T = any>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await call(method, path, body);
  expect(r.status, `${method} ${path}`).toBe(status);
  return (await r.json()) as T;
};
const approvalOf = (id: string) => env.DB.prepare(`SELECT status, preview, decision_note, title FROM approvals WHERE id = ?`).bind(id).first<{ status: string; preview: string; decision_note: string | null; title: string }>();
const taskOf = (id: string) => env.DB.prepare(`SELECT status FROM claude_tasks WHERE id = ?`).bind(id).first<{ status: string }>();
const words = (over: Record<string, unknown> = {}) => ({ summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, ...over });

describe("owner session", () => {
  it("every route is 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/clients/x/seo"], ["GET", "/seo/board"], ["GET", "/seo/reports"], ["PUT", "/seo/reports/x", words()], ["POST", "/seo/reports/x/revoke"],
    ];
    for (const [m, p, b] of calls) expect((await call(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });
});

describe("GET /clients/:id/seo", () => {
  it("gives the profile, keywords, the latest grid, the snapshot, the name check, reviews, content, citations and the latest report in one answer", async () => {
    const s = await seoClient({ name: "Ace Plumbing" });
    await env.DB.prepare(`UPDATE seo_profiles SET nap_result = ? WHERE business_id = ?`).bind(JSON.stringify({ phone: "match", address: "mismatch", name: "missing", checkedPages: 3 }), s.businessId).run();
    const kw = await seoRanked(s.businessId, { top: 2, day: "2026-11-15" });
    await seoRanked(s.businessId, { top: 4, day: "2026-12-01" }); // the same keyword, a later check: the latest one speaks
    await seoSnapshot(s.businessId, { rating: 4.4, reviewCount: 40, day: "2026-11-15" });
    await seoSnapshot(s.businessId, { rating: 4.6, reviewCount: 42, day: "2026-12-01" });
    const old = await seoReview(s.businessId, { rating: 5, day: "2026-11-02" });
    const low = await seoReview(s.businessId, { rating: 2, status: "drafted", day: "2026-12-01" });
    const item = await seoContent(s.businessId);
    await ensureCitations(env.DB, s.businessId, ["google", "bing"], NOW.toISOString());
    await setCitation(env.DB, s.businessId, "google", { status: "listed" }, "2026-12-01");
    const sentOld = await seoReport(s.businessId, "sent", { period: "2026-10", token: "tok-aggregate-OLD-0123456789abcdef" });
    const sent = await seoReport(s.businessId, "sent", { token: "tok-aggregate-SENT-0123456789abcdef" });

    const a = await json<any>("GET", `/clients/${s.businessId}/seo`);
    expect(Object.keys(a).sort()).toEqual(["citations", "content", "keywords", "latestGrid", "nap", "profile", "report", "reviews", "snapshot"]);
    expect(a.profile).toMatchObject({ businessId: s.businessId, placeId: PLACE_ID, trade: "plumber", towns: ["Tigard"], gridKm: 3, status: "active" });
    expect(a.profile).not.toHaveProperty("napResult");
    expect(a.nap).toEqual({ phone: "match", address: "mismatch", name: "missing", checkedPages: 3 });
    expect(a.keywords).toEqual([expect.objectContaining({ id: kw.id, term: "drain cleaning", town: "Tigard", active: true })]);
    expect(a.latestGrid).toEqual([{ term: "drain cleaning", town: "Tigard", points: expect.any(Array), measured: 9, takenOn: "2026-12-01", visible: 4, previous: { takenOn: "2026-11-15", visible: 2 } }]);
    expect(a.latestGrid[0].points).toHaveLength(9);
    expect(a.latestGrid[0].points[0]).toEqual({ pos: 2, ok: true }); // no map location on a point
    expect(a.latestGrid[0].points.filter((p: { pos: number }) => p.pos === 2)).toHaveLength(4);
    expect(a.snapshot).toMatchObject({ takenOn: "2026-12-01", rating: 4.6, reviewCount: 42 });
    expect(a.reviews.map((r: { id: string }) => r.id)).toEqual([low.id, old.id]); // newest first
    expect(a.reviews[0]).toMatchObject({ rating: 2, replyStatus: "drafted", replyDraft: REPLY_DRAFT, flagged: true });
    expect(a.content).toEqual([expect.objectContaining({ id: item.id, status: "drafted", title: "Drain cleaning in Tigard" })]);
    expect(a.citations.map((x: { directory: string; status: string }) => [x.directory, x.status])).toEqual([["google", "listed"], ["bing", "todo"]]);
    expect(a.report).toEqual({
      id: sent.id, period: "2026-11", status: "sent", summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, source: "claude", sentOn: "2026-12-01", views: 0, test: false,
      linkPath: `/l/${sent.token}`,
    });
    // The token is in the answer once, as the path of the sent report's page, and the older report's token not at all.
    const text = JSON.stringify(a);
    expect(text.split(sent.token)).toHaveLength(2);
    expect(text).not.toContain(sentOld.token);
    expect(text).not.toContain("napResult");
  });

  it("gives no link path for a report that is not sent", async () => {
    const s = await seoClient();
    for (const status of ["ready", "revoked"] as const) {
      await env.DB.prepare(`DELETE FROM seo_reports`).run();
      const r = await seoReport(s.businessId, status);
      const a = await json<any>("GET", `/clients/${s.businessId}/seo`);
      expect(a.report, status).toMatchObject({ id: r.id, status });
      expect(a.report, status).not.toHaveProperty("linkPath");
      expect(JSON.stringify(a), status).not.toContain(r.token);
    }
  });

  it("answers a client with only a profile with empty lists and nulls, and a client with no profile the same with a null profile", async () => {
    const only = await seoClient({ status: "setup" });
    expect(await json("GET", `/clients/${only.businessId}/seo`)).toEqual({
      profile: expect.objectContaining({ businessId: only.businessId, status: "setup" }), keywords: [], latestGrid: [], snapshot: null, nap: null, reviews: [], content: [], citations: [], report: null,
    });
    const none = await seoClient({ profile: false });
    expect(await json("GET", `/clients/${none.businessId}/seo`)).toEqual({ profile: null, keywords: [], latestGrid: [], snapshot: null, nap: null, reviews: [], content: [], citations: [], report: null });
  });

  it("leaves a keyword with no check out of the grid, and a keyword switched off", async () => {
    const s = await seoClient();
    await seoRanked(s.businessId, { term: "drain cleaning" });
    const off = await seoRanked(s.businessId, { term: "sewer repair" });
    await env.DB.prepare(`UPDATE seo_keywords SET active = 0 WHERE id = ?`).bind(off.id).run();
    const a = await json<any>("GET", `/clients/${s.businessId}/seo`);
    expect(a.latestGrid.map((g: { term: string }) => g.term)).toEqual(["drain cleaning"]);
    expect(a.keywords.map((k: { term: string; active: boolean }) => [k.term, k.active])).toEqual([["drain cleaning", true], ["sewer repair", false]]);
  });

  it("works for a rehearsal client and is 404 for something that is not a client", async () => {
    const t = await seoClient({ test: true });
    expect((await call("GET", `/clients/${t.businessId}/seo`)).status).toBe(200);
    expect((await call("GET", "/clients/nope/seo")).status).toBe(404);
  });
});

describe("GET /seo/board", () => {
  it("lists only real clients whose watch is on, by name, with what to do next, the drafts waiting, the low reviews and last month's report", async () => {
    const bay = await seoClient({ name: "Bay Roofing" });
    const ace = await seoClient({ name: "Ace Plumbing" });
    const cedar = await seoClient({ name: "Cedar Dental" });
    const none = await seoClient({ name: "No Keywords" });
    await seoClient({ name: "Rehearsal Co", test: true });
    await seoClient({ name: "Paused Co", status: "paused" });
    await seoClient({ name: "Setup Co", status: "setup" });
    await seoClient({ name: "No Profile Co", profile: false });
    for (const c of [bay, ace, cedar]) await seoRanked(c.businessId);
    await seoReview(ace.businessId, { rating: 2, status: "drafted" });
    await seoReview(ace.businessId, { rating: 5, status: "drafted" });
    await seoContent(ace.businessId, { status: "drafted" });
    await seoContent(ace.businessId, { status: "planned", slot: 2 });
    await seoReview(bay.businessId, { rating: 5, status: "drafted" });
    const ready = await seoReport(cedar.businessId, "ready");
    await seoReport(bay.businessId, "sent");

    const board = await json<{ period: string; rows: any[] }>("GET", "/seo/board");
    expect(board.period).toBe("2026-11");
    expect(board.rows.map((r) => r.client)).toEqual(["Ace Plumbing", "Bay Roofing", "Cedar Dental", "No Keywords"]);
    const by = (name: string) => board.rows.find((r) => r.client === name);
    expect(by("Ace Plumbing")).toEqual({ clientId: ace.businessId, client: "Ace Plumbing", next: "Answer the low-rated review.", draftsWaiting: 3, flaggedReviews: 1, report: null });
    expect(by("Bay Roofing")).toMatchObject({ next: "Look at the draft waiting for you.", draftsWaiting: 1, flaggedReviews: 0, report: { period: "2026-11", status: "sent" } });
    expect(by("Cedar Dental")).toMatchObject({ next: "Approve the 2026-11 report.", draftsWaiting: 0, report: { id: ready.id, status: "ready" } });
    expect(by("No Keywords")).toMatchObject({ next: "Add the search terms to track.", draftsWaiting: 0, flaggedReviews: 0, report: null });
  });

  it("is an empty list when nobody is being watched", async () => {
    expect(await json("GET", "/seo/board")).toEqual({ period: "2026-11", rows: [] });
  });
});

describe("GET /seo/reports", () => {
  it("lists last month's reports with the client, status, words, priorities and a link only for ready and sent", async () => {
    const a = await seoClient({ name: "Ace Plumbing" });
    const b = await seoClient({ name: "Bay Roofing" });
    const c = await seoClient({ name: "Cedar Dental" });
    const d = await seoClient({ name: "Delta Auto" });
    const x = await seoClient({ name: "Echo Fencing" });
    const ready = await seoReport(a.businessId, "ready");
    const sent = await seoReport(b.businessId, "sent");
    const collecting = await seoReport(c.businessId, "collecting");
    const revoked = await seoReport(d.businessId, "revoked");
    const cancelled = await seoReport(x.businessId, "cancelled");
    await seoReport(a.businessId, "ready", { period: "2026-10" });

    const body = await json<{ period: string; reports: any[] }>("GET", "/seo/reports");
    expect(body.period).toBe("2026-11");
    expect(body.reports).toHaveLength(5);
    const by = (r: { id: string }) => body.reports.find((y) => y.id === r.id);
    expect(by(ready)).toEqual({
      id: ready.id, client: "Ace Plumbing", clientId: a.businessId, period: "2026-11", status: "ready", summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, source: "claude",
      sentOn: null, views: 0, test: false, link: `${BASE}/l/${ready.token}`,
    });
    expect(by(sent)).toMatchObject({ status: "sent", sentOn: "2026-12-01", link: `${BASE}/l/${sent.token}` });
    for (const r of [collecting, revoked, cancelled]) expect(by(r).link, r.status).toBeNull();
    expect(by(collecting)).toMatchObject({ status: "collecting", summary: "", priorities: [], source: "none" });
    const text = JSON.stringify(body);
    for (const r of [collecting, revoked, cancelled]) expect(text).not.toContain(r.token);
    expect(text.split(ready.token)).toHaveLength(2); // only inside its link
    for (const r of body.reports) expect(Object.keys(r).sort()).toEqual(["client", "clientId", "id", "link", "period", "priorities", "recommendation", "sentOn", "source", "status", "summary", "test", "views"]);
  });

  it("takes ?period, narrows with ?clientId (every month, newest first, when no period) and refuses a bad month", async () => {
    const a = await seoClient({ name: "Ace Plumbing" });
    const b = await seoClient({ name: "Bay Roofing" });
    const nov = await seoReport(a.businessId, "sent");
    const oct = await seoReport(a.businessId, "sent", { period: "2026-10" });
    await seoReport(b.businessId, "ready");
    expect((await json<{ reports: { id: string }[] }>("GET", "/seo/reports?period=2026-10")).reports.map((r) => r.id)).toEqual([oct.id]);
    expect(await json("GET", "/seo/reports?period=2026-09")).toEqual({ period: "2026-09", reports: [] });
    const all = await json<{ period: string | null; reports: { id: string }[] }>("GET", `/seo/reports?clientId=${a.businessId}`);
    expect(all.period).toBeNull();
    expect(all.reports.map((r) => r.id)).toEqual([nov.id, oct.id]);
    for (const bad of ["2026-13", "november", "2026-1", "2026-11-01", ""]) expect((await call("GET", `/seo/reports?period=${bad}`)).status, bad).toBe(400);
  });
});

describe("PUT /seo/reports/:id", () => {
  const NEW = { summary: "  Up in the top three at four points for drain cleaning in our check.  ", recommendation: "Keep asking for reviews.", priorities: ["Answer reviews", "Fix the address", "Add a service page"] };

  it("edits the words of a ready report, trimmed; they become Logan's", async () => {
    const r = await seoReport((await seoClient()).businessId, "ready");
    const out = await json<{ report: any }>("PUT", `/seo/reports/${r.id}`, NEW);
    expect(out.report).toMatchObject({
      id: r.id, status: "ready", summary: "Up in the top three at four points for drain cleaning in our check.", recommendation: "Keep asking for reviews.", priorities: ["Answer reviews", "Fix the address", "Add a service page"], source: "logan",
    });
    expect(await getSeoReport(env.DB, r.id)).toMatchObject({ summary: "Up in the top three at four points for drain cleaning in our check.", summarySource: "logan", status: "ready", priorities: NEW.priorities });
  });

  it("rewrites the pending approval's card, so Logan approves the words the card shows", async () => {
    const r = await seoReport((await seoClient()).businessId, "ready");
    const approvalId = await proposeSeoReportApproval(e, r);
    expect((await approvalOf(approvalId))!.preview).toContain(SUMMARY);

    await json("PUT", `/seo/reports/${r.id}`, NEW);
    const after = (await approvalOf(approvalId))!;
    expect(after.status).toBe("pending");
    expect(after.preview).toContain("Up in the top three at four points for drain cleaning in our check.");
    expect(after.preview).toContain("Recommendation: Keep asking for reviews.");
    for (const p of NEW.priorities) expect(after.preview).toContain(p);
    expect(after.preview).toContain("you edited it");
    for (const old of [SUMMARY, RECOMMENDATION, ...PRIORITIES]) expect(after.preview).not.toContain(old);
  });

  it("leaves a decided approval alone", async () => {
    const r = await seoReport((await seoClient()).businessId, "ready");
    const approvalId = await proposeSeoReportApproval(e, r);
    await env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE id = ?`).bind(approvalId).run();
    const before = (await approvalOf(approvalId))!.preview;
    await json("PUT", `/seo/reports/${r.id}`, NEW);
    expect((await approvalOf(approvalId))!.preview).toBe(before);
  });

  it("refuses a sent, revoked, cancelled and collecting report with a plain sentence and changes nothing", async () => {
    const a = await seoClient();
    for (const [i, status] of (["sent", "revoked", "cancelled", "collecting"] as const).entries()) {
      const r = await seoReport(a.businessId, status, { period: `2026-0${i + 1}` });
      const res = await call("PUT", `/seo/reports/${r.id}`, NEW);
      expect(res.status, status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/ready/);
      expect(await getSeoReport(env.DB, r.id), status).toMatchObject({ summary: status === "collecting" ? "" : SUMMARY, priorities: status === "collecting" ? [] : PRIORITIES });
    }
  });

  it("refuses words that break the text rules (a link, a promise, an address, a price, markdown, a blank run, too long) with a sentence naming the field, and changes nothing", async () => {
    const approving = await seoClient();
    const r = await seoReport(approving.businessId, "ready");
    const approvalId = await proposeSeoReportApproval(e, r);
    const before = (await approvalOf(approvalId))!.preview;
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ summary: "See https://evil.example for more." }, /summary.*link/i], [{ summary: "Visit www.ace.com now." }, /summary.*link/i], [{ summary: "Write to me@ace.com." }, /summary/i],
      [{ summary: "It costs $50 a month." }, /summary.*price/i], [{ summary: "**Bold** words." }, /summary.*markdown/i], [{ summary: "One.\n\n\n\nTwo." }, /summary.*blank/i],
      [{ summary: "We guarantee the first page." }, /summary.*promise/i], [{ summary: "You will rank number one." }, /summary.*promise/i], [{ summary: "   " }, /summary.*1 to 600/i], [{ summary: "x".repeat(601) }, /summary.*1 to 600/i],
      [{ recommendation: "We promise a top spot." }, /recommendation.*promise/i], [{ recommendation: "- a bullet" }, /recommendation.*markdown/i], [{ recommendation: "" }, /recommendation.*1 to 300/i], [{ recommendation: "y".repeat(301) }, /recommendation.*1 to 300/i],
      [{ priorities: ["Fine", "Check https://evil.example", "Fine too"] }, /priority 2.*link/i], [{ priorities: ["Fine", "Fine too", "This will rank first"] }, /priority 3.*promise/i], [{ priorities: ["Fine", "Fine too", "z".repeat(121)] }, /priority 3.*1 to 120/i],
      [{ priorities: ["", "Fine", "Fine too"] }, /priority 1.*1 to 120/i],
    ];
    for (const [over, name] of bad) {
      const res = await call("PUT", `/seo/reports/${r.id}`, words(over));
      expect(res.status, JSON.stringify(over).slice(0, 60)).toBe(400);
      expect(((await res.json()) as { error: string }).error, JSON.stringify(over).slice(0, 60)).toMatch(name);
    }
    expect(await getSeoReport(env.DB, r.id)).toMatchObject({ summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, summarySource: "claude" });
    expect((await approvalOf(approvalId))!.preview).toBe(before);
  });

  it("refuses four priorities, two priorities, none, a missing field and an unknown field", async () => {
    const r = await seoReport((await seoClient()).businessId, "ready");
    for (const body of [
      words({ priorities: [...PRIORITIES, "A fourth one"] }), words({ priorities: PRIORITIES.slice(0, 2) }), words({ priorities: [] }), { summary: SUMMARY, recommendation: RECOMMENDATION },
      { summary: SUMMARY, priorities: PRIORITIES }, words({ status: "sent" }), words({ priorities: "one, two, three" }), words({ summary: 5 }),
    ]) {
      const res = await call("PUT", `/seo/reports/${r.id}`, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(10);
    }
    const four = (await (await call("PUT", `/seo/reports/${r.id}`, words({ priorities: [...PRIORITIES, "A fourth one"] }))).json()) as { error: string };
    expect(four.error).toBe("Give exactly three priorities.");
    expect(await getSeoReport(env.DB, r.id)).toMatchObject({ summary: SUMMARY, priorities: PRIORITIES, summarySource: "claude" });
  });

  it("is 404 for a report nobody has, and for one whose business is not a client", async () => {
    expect((await call("PUT", "/seo/reports/nope", words())).status).toBe(404);
    const s = await seoClient();
    const r = await seoReport(s.businessId, "ready");
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'new' WHERE id = ?`).bind(s.businessId).run();
    await env.DB.prepare(`DELETE FROM projects WHERE business_id = ?`).bind(s.businessId).run();
    expect((await call("PUT", `/seo/reports/${r.id}`, words())).status).toBe(404);
  });
});

describe("POST /seo/reports/:id/revoke", () => {
  it("takes back a ready report: it is revoked, its queued Claude task is closed and its pending approval is rejected with a note", async () => {
    const r = await seoReport((await seoClient()).businessId, "ready");
    const approvalId = await proposeSeoReportApproval(e, r);
    const { id: taskId } = await enqueueTask(env.DB, SEO_REPORT_KIND, { reportId: r.id }, { dedupeKey: r.id, targetType: SEO_REPORT_TARGET, targetId: r.id });
    await setSeoTaskAndApproval(env.DB, r.id, { claudeTaskId: taskId });

    const out = await json<{ report: any }>("POST", `/seo/reports/${r.id}/revoke`);
    expect(out.report).toMatchObject({ id: r.id, status: "revoked", link: null });
    expect(JSON.stringify(out)).not.toContain(r.token);
    expect(await getSeoReport(env.DB, r.id)).toMatchObject({ status: "revoked" });
    expect((await taskOf(taskId))!.status).toBe("stale");
    expect(await approvalOf(approvalId)).toMatchObject({ status: "rejected", decision_note: "the report was revoked" });
  });

  it("takes back a sent report; its approval, already used, stays as it was", async () => {
    const r = await seoReport((await seoClient()).businessId, "ready");
    const approvalId = await proposeSeoReportApproval(e, r);
    await env.DB.prepare(`UPDATE approvals SET status = 'approved' WHERE id = ?`).bind(approvalId).run();
    await env.DB.prepare(`UPDATE seo_reports SET status = 'sent', sent_at = '2026-12-01T17:00:00.000Z' WHERE id = ?`).bind(r.id).run();
    expect((await json<{ report: any }>("POST", `/seo/reports/${r.id}/revoke`)).report).toMatchObject({ status: "revoked", link: null });
    expect((await approvalOf(approvalId))!.status).toBe("approved");
  });

  it("refuses a collecting, revoked or cancelled report and an unknown one", async () => {
    const a = await seoClient();
    for (const [i, status] of (["collecting", "revoked", "cancelled"] as const).entries()) {
      const r = await seoReport(a.businessId, status, { period: `2026-0${i + 1}` });
      const res = await call("POST", `/seo/reports/${r.id}/revoke`);
      expect(res.status, status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/ready or sent/);
      expect((await getSeoReport(env.DB, r.id))!.status).toBe(status);
    }
    expect((await call("POST", "/seo/reports/nope/revoke")).status).toBe(404);
  });
});

it("never returns a Google place id from the board, the report list or a report edit (only the one-client aggregate, for the owner, has the profile)", async () => {
  const s = await seoClient({ name: "Ace Plumbing" });
  await seoRanked(s.businessId);
  const r = await seoReport(s.businessId, "ready");
  for (const [m, p, b] of [["GET", "/seo/board"], ["GET", "/seo/reports"], ["PUT", `/seo/reports/${r.id}`, words()]] as [string, string, unknown?][]) {
    const text = JSON.stringify(await json(m, p, b));
    expect(text, p).not.toContain(PLACE_ID);
    expect(text, p).not.toContain(MAPS_URL);
  }
});
