import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { proposeStrategyApproval } from "../src/worker/approvals/strategyMemo";
import { listActivity } from "../src/worker/db/activity";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { activeHolds, liftHold, placeHold } from "../src/worker/db/holds";
import * as messagesDb from "../src/worker/db/messages";
import { addKeyword, upsertProfile, upsertSnapshot } from "../src/worker/db/seo";
import { getMemo, getMemoByToken, listMemos, revokeMemo, setMemoBody } from "../src/worker/db/strategy";
import { saveLink, saveTrafficMonth } from "../src/worker/db/traffic";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import * as queue from "../src/worker/queue/strategyMemo";
import { buildMemoFacts, MemoFacts, MemoRefused } from "../src/worker/strategy/facts";
import { renderStrategyMail, strategyLink } from "../src/worker/strategy/mail";
import { startStrategyMemo } from "../src/worker/strategy/start";
import type { TrafficFacts } from "../src/worker/traffic/facts";
import { seedClient, type SubSpec } from "./fixtures/clients";
import { OWNER_EMAIL, readyToSend } from "./fixtures/documents";
import { resetProjectWork } from "./fixtures/projects";

// The strategy memo's facts, start, approval and mail (Plan 16, Task 9). Claude's words and the public page come in Task 10; here the body is put in by hand.
// The mail goes out on Tuesday 1 December 2026 (readyToSend's clock), so "last month" is November and the three months looked at are November, October and September.
const NOW = new Date("2026-12-01T17:00:00.000Z");
const STAMP = NOW.toISOString();
const BASE = "https://clients.hellositeline.test";
const COLD = "https://go.hellositeline.test";
const e = env as Env;
const BODY = {
  standing: "STANDING-WORDS-FROM-CLAUDE: your site shows up for a few searches and there is room to grow.",
  priorities: [
    { title: "PRIORITY-ONE-TITLE", why: "WHY-ONE", firstStep: "STEP-ONE" },
    { title: "PRIORITY-TWO-TITLE", why: "WHY-TWO", firstStep: "STEP-TWO" },
    { title: "PRIORITY-THREE-TITLE", why: "WHY-THREE", firstStep: "STEP-THREE" },
  ],
  needFromYou: ["NEED-ONE", "NEED-TWO"],
};

let mail: Awaited<ReturnType<typeof readyToSend>>;
let queued: ReturnType<typeof vi.spyOn>;
let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
  queued = vi.spyOn(queue, "queueStrategyMemo").mockResolvedValue(undefined);
  for (const t of ["strategy_memos", "traffic_months", "site_analytics", "seo_gbp_snapshots", "seo_keywords", "seo_profiles"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "do_not_contact", "messages"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'strategy.memo'`).run();
  mail = await readyToSend();
});
afterEach(() => { vi.restoreAllMocks(); setMailDeps(null); });

const ask = (over: Partial<Env> = {}) => ({ ...env, ...over }) as Env;
const search = (o: Partial<NonNullable<TrafficFacts["search"]>> = {}): NonNullable<TrafficFacts["search"]> => ({
  clicks: 40, impressions: 900, position: 7.3, previousClicks: 30, previousImpressions: 700,
  queries: [{ query: "ace plumbing boise", clicks: 12, impressions: 300 }], pages: [{ path: "/drains", clicks: 9 }], ...o,
});
const visits = (o: Partial<NonNullable<TrafficFacts["visits"]>> = {}): NonNullable<TrafficFacts["visits"]> => ({
  sessions: 100, users: 80, organic: 60, keyEvents: 7, previousSessions: 90, previousOrganic: 50, channels: [{ channel: "Organic Search", sessions: 60 }], ...o,
});
const month = (period: string, o: Partial<TrafficFacts> = {}): TrafficFacts => ({ version: 1, period, search: search(), visits: visits(), profile: null, ...o });

/** Stores a pulled month for the client's site (linked to Search Console first). */
async function pulled(siteId: string, period: string, facts: TrafficFacts, status: "ok" | "partial" | "failed" = "ok") {
  await saveLink(env.DB, siteId, { gscProperty: "sc-domain:ace.com" }, "2026-10-01T00:00:00.000Z");
  await saveTrafficMonth(env.DB, { siteId, period, status, facts }, STAMP);
}
/** A client with a Local SEO profile (a plumber in two towns), two keywords and a Search Console month. */
async function measured(o: { test?: boolean; subs?: SubSpec[] } = {}) {
  const s = await seedClient({ test: o.test, subs: o.subs });
  await upsertProfile(env.DB, s.businessId, { napName: "Ace Plumbing", trade: "plumber", towns: ["Tigard", "Beaverton"], status: "active" }, "2026-10-01T00:00:00.000Z");
  await addKeyword(env.DB, s.businessId, { term: "drain cleaning", town: "Tigard" }, STAMP);
  await addKeyword(env.DB, s.businessId, { term: "water heater repair", town: "" }, STAMP);
  await pulled(s.site!.id, "2026-11", month("2026-11"));
  return s;
}
/** A memo that is `ready` with Claude's words, and the card proposed for it. */
async function readyMemo(s: { businessId: string }) {
  const { memo } = await startStrategyMemo(e, s.businessId, { now: NOW });
  expect(await setMemoBody(env.DB, memo.id, BODY, STAMP)).toBe(true);
  const approval = await proposeStrategyApproval(e, memo.id);
  return { memo: (await getMemo(env.DB, memo.id))!, approval };
}
const approvalRow = (id: string) => env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null; preview: string; kind: string; title: string; record_type: string; record_id: string; drafted_by: string }>();
const lines = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 100)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'strategy.memo'`).first<{ n: number }>())!.n;

describe("buildMemoFacts", () => {
  it("refuses with no profile, no keyword and no search", async () => {
    const s = await seedClient();
    const err = await buildMemoFacts(e, s.businessId, NOW).catch((x) => x);
    expect(err).toBeInstanceOf(MemoRefused);
    expect((err as MemoRefused).message).toBe("Nothing has been measured for this client yet. Set up their Local SEO profile or link their Search Console first.");
    // Visits alone (no search block, no profile, no keyword) are not enough either.
    await pulled(s.site!.id, "2026-11", month("2026-11", { search: null }));
    await expect(buildMemoFacts(e, s.businessId, NOW)).rejects.toBeInstanceOf(MemoRefused);
  });

  it("carries trade, towns, keywords and the newest merged traffic month", async () => {
    const s = await measured();
    // October is older than November, so November wins; a failed month is never used.
    await pulled(s.site!.id, "2026-10", month("2026-10", { search: search({ clicks: 5 }) }));
    await upsertSnapshot(env.DB, { businessId: s.businessId, takenOn: "2026-11-01", rating: 4.1, reviewCount: 30, category: null, photoCount: null, hasHours: null, now: STAMP });
    await upsertSnapshot(env.DB, { businessId: s.businessId, takenOn: "2026-11-20", rating: 4.7, reviewCount: 43, category: null, photoCount: null, hasHours: null, now: STAMP });
    const facts = await buildMemoFacts(e, s.businessId, NOW);
    expect(MemoFacts.safeParse(facts).success).toBe(true);
    expect(facts).toMatchObject({
      version: 1, clientName: expect.any(String), trade: "plumber", towns: ["Tigard", "Beaverton"], keywords: ["drain cleaning in Tigard", "water heater repair"],
      period: "2026-11", profile: { rating: 4.7, reviewCount: 43 }, generatedAt: STAMP,
    });
    expect(facts.search).toEqual({ clicks: 40, impressions: 900, position: 7.3, previousClicks: 30, previousImpressions: 700, queries: [], pages: [] });
    expect(facts.visits).toMatchObject({ sessions: 100, organic: 60, channels: [{ channel: "Organic Search", sessions: 60 }] });
    // What strangers typed (search queries, page paths) never reaches the memo.
    expect(JSON.stringify(facts)).not.toMatch(/ace plumbing boise|\/drains/);
  });

  it("uses the newest of the last three months that has data, skipping a failed month and a month with a profile block only", async () => {
    const s = await measured();
    await env.DB.prepare(`DELETE FROM traffic_months`).run();
    await pulled(s.site!.id, "2026-11", month("2026-11"), "failed");
    await pulled(s.site!.id, "2026-10", { version: 1, period: "2026-10", search: null, visits: null, profile: { calls: 1, directions: 1, websiteClicks: 1, previousCalls: null } });
    await pulled(s.site!.id, "2026-09", month("2026-09", { search: search({ clicks: 3 }), visits: null }), "partial");
    const facts = await buildMemoFacts(e, s.businessId, NOW);
    expect(facts.period).toBe("2026-09");
    expect(facts.search?.clicks).toBe(3);
    expect(facts.visits).toBeNull();
    // Older than three months back is not looked at: with a profile and keywords the memo is still made, with no traffic.
    await env.DB.prepare(`DELETE FROM traffic_months`).run();
    await pulled(s.site!.id, "2026-08", month("2026-08"));
    const none = await buildMemoFacts(e, s.businessId, NOW);
    expect(none).toMatchObject({ period: null, search: null, visits: null, profile: null });
  });

  it("makes a memo from a search block alone, with no profile and no keyword", async () => {
    const s = await seedClient();
    await pulled(s.site!.id, "2026-11", month("2026-11"));
    const facts = await buildMemoFacts(e, s.businessId, NOW);
    expect(facts).toMatchObject({ trade: null, towns: [], keywords: [], period: "2026-11", profile: null });
    expect(facts.search?.clicks).toBe(40);
  });

  it("makes a memo from a Local SEO profile alone: no keyword, no traffic, search null", async () => {
    const s = await seedClient();
    await upsertProfile(env.DB, s.businessId, { trade: "plumber", towns: ["Tigard"], status: "active" }, "2026-10-01T00:00:00.000Z");
    const facts = await buildMemoFacts(e, s.businessId, NOW);
    expect(facts).toMatchObject({ trade: "plumber", towns: ["Tigard"], keywords: [], search: null, visits: null, period: null, profile: null });
  });

  it("looks back across the year boundary: in January 2027 the three months are December, November and October", async () => {
    const s = await measured();
    await env.DB.prepare(`DELETE FROM traffic_months`).run();
    await pulled(s.site!.id, "2026-11", month("2026-11", { search: search({ clicks: 11 }) }));
    const jan = new Date("2027-01-05T17:00:00.000Z");
    const facts = await buildMemoFacts(e, s.businessId, jan);
    expect(facts.period).toBe("2026-11");
    expect(facts.search?.clicks).toBe(11);
    // September is the fourth month back from January: not looked at.
    await env.DB.prepare(`DELETE FROM traffic_months`).run();
    await pulled(s.site!.id, "2026-09", month("2026-09"));
    expect((await buildMemoFacts(e, s.businessId, jan)).period).toBeNull();
  });

  it("cleans what was typed and keeps the lists inside their caps", async () => {
    const s = await seedClient();
    await upsertProfile(env.DB, s.businessId, { trade: "plumber\u0000  and​   heating", towns: Array.from({ length: 12 }, (_, i) => `Town ${i}`), status: "active" }, "2026-10-01T00:00:00.000Z");
    for (let i = 0; i < 15; i++) await addKeyword(env.DB, s.businessId, { term: `term ${i}`, town: "" }, STAMP);
    const facts = await buildMemoFacts(e, s.businessId, NOW);
    expect(facts.trade).toBe("plumber and heating");
    expect(facts.towns).toHaveLength(8);
    expect(facts.keywords).toHaveLength(12);
    expect(MemoFacts.safeParse(facts).success).toBe(true);
  });
});

describe("startStrategyMemo", () => {
  it("twice returns the same open memo with created false", async () => {
    const s = await measured();
    const first = await startStrategyMemo(e, s.businessId, { now: NOW });
    expect(first.created).toBe(true);
    expect(first.memo).toMatchObject({ businessId: s.businessId, version: 1, status: "collecting", test: false });
    expect(MemoFacts.safeParse(first.memo.facts).success).toBe(true);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued).toHaveBeenCalledWith(expect.anything(), first.memo.id);

    const second = await startStrategyMemo(e, s.businessId, { now: NOW });
    expect(second).toMatchObject({ created: false });
    expect(second.memo.id).toBe(first.memo.id);
    expect(second.memo.token).toBe(first.memo.token);
    expect(await listMemos(env.DB, s.businessId)).toHaveLength(1);
  });

  it("asks for Claude again for an open memo that has no task yet, and not for one that has", async () => {
    const s = await measured();
    const { memo } = await startStrategyMemo(e, s.businessId, { now: NOW });
    await startStrategyMemo(e, s.businessId, { now: NOW });
    expect(queued).toHaveBeenCalledTimes(2); // the first call left no task on the row (the queue is stubbed), so the second asks again
    await env.DB.prepare(`UPDATE strategy_memos SET claude_task_id = 'task-1' WHERE id = ?`).bind(memo.id).run();
    await startStrategyMemo(e, s.businessId, { now: NOW });
    expect(queued).toHaveBeenCalledTimes(2);
  });

  it("for a lead that is not a client is refused", async () => {
    const lead = await seedClient({ won: false, project: false });
    const err = await startStrategyMemo(e, lead.businessId, { now: NOW }).catch((x) => x);
    expect(err).toBeInstanceOf(MemoRefused);
    expect((err as MemoRefused).message).toBe("Only a client can get a strategy memo.");
    expect(await listMemos(env.DB, lead.businessId)).toHaveLength(0);
    expect(queued).not.toHaveBeenCalled();
  });

  it("refuses a client with nothing measured, and makes no memo", async () => {
    const s = await seedClient();
    await expect(startStrategyMemo(e, s.businessId, { now: NOW })).rejects.toBeInstanceOf(MemoRefused);
    expect(await listMemos(env.DB, s.businessId)).toHaveLength(0);
  });

  it("marks a rehearsal memo as a test", async () => {
    const s = await measured({ test: true });
    const { memo } = await startStrategyMemo(e, s.businessId, { now: NOW, test: true });
    expect(memo.test).toBe(true);
  });
});

describe("strategyLink and renderStrategyMail", () => {
  it("links the memo page at /y/ on an https base of its own, never the cold-email host, and not at all without one", () => {
    const withBase = (CLIENT_LINK_BASE: string | undefined, OUTREACH_LINK_BASE?: string) => ({ CLIENT_LINK_BASE, OUTREACH_LINK_BASE });
    expect(strategyLink(withBase("https://clients.example.com"), "tok")).toBe("https://clients.example.com/y/tok");
    expect(strategyLink(withBase("https://clients.example.com/"), "tok")).toBe("https://clients.example.com/y/tok");
    for (const base of [undefined, "", "http://clients.example.com", "https://app.workers.dev", "not a url"]) expect(strategyLink(withBase(base), "tok"), String(base)).toBeNull();
    expect(strategyLink(withBase("https://mail.example.com", "https://mail.example.com"), "tok")).toBeNull();
  });

  it("is a fixed template with the greeting, the plan, the link on its own line and the sign-off", () => {
    const m = renderStrategyMail({ clientName: "Ace Plumbing", contactName: "Pat Jones", yourName: "Logan Irish", link: "https://clients.example.com/y/tok" });
    expect(m.subject).toBe("Your plan, Ace Plumbing");
    const paragraphs = m.body.split("\n\n");
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs[0]).toBe("Hi Pat,");
    expect(paragraphs[2]).toBe("https://clients.example.com/y/tok");
    expect(paragraphs[4]).toBe("Thanks,\nLogan Irish");
    expect(m.body).not.toMatch(/\$\d|\d{4}|guarantee|promise|%/);
    const bare = renderStrategyMail({ clientName: "Ace", contactName: " ", yourName: "", link: "https://x.example/y/t" });
    expect(bare.body.startsWith("Hi,\n\n")).toBe(true);
    expect(bare.body.endsWith("Thanks,")).toBe(true);
  });
});

describe("proposeStrategyApproval", () => {
  it("makes one approval per memo, however often it is asked, and records it on the memo", async () => {
    const s = await measured();
    const { memo } = await startStrategyMemo(e, s.businessId, { now: NOW });
    expect(await setMemoBody(env.DB, memo.id, BODY, STAMP)).toBe(true);
    const first = await proposeStrategyApproval(e, memo.id);
    expect(first).toMatchObject({ kind: "strategy.memo", status: "pending", record_type: "business", record_id: s.businessId, drafted_by: "job", payload: { memoId: memo.id } });
    const again = await proposeStrategyApproval(e, memo.id);
    expect(again.id).toBe(first.id);
    expect((await Promise.all([proposeStrategyApproval(e, memo.id), proposeStrategyApproval(e, memo.id)])).map((a) => a.id)).toEqual([first.id, first.id]);
    expect(await count()).toBe(1);
    expect((await getMemo(env.DB, memo.id))!.approvalId).toBe(first.id);
    expect(getHandler("strategy.memo")!.parse({ memoId: "m" })).toEqual({ memoId: "m" });
    expect(getHandler("strategy.memo")!.label).toBe("Send strategy memo");
  });

  it("shows Logan who it goes to, the mail as it reads, the standing paragraph and the three priorities", async () => {
    const s = await measured();
    const { memo, approval } = await readyMemo(s);
    const a = (await approvalRow(approval.id))!;
    expect(a.title).toContain("Ace");
    for (const part of ["To: Pat Jones <pat@ace.test>", "Subject: Your plan,", "Hi Pat,", `${BASE}/y/${memo.token}`, BODY.standing, "1. PRIORITY-ONE-TITLE", "2. PRIORITY-TWO-TITLE", "3. PRIORITY-THREE-TITLE", "Nothing is mailed until you approve"])
      expect(a.preview, part).toContain(part);
  });

  it("makes a card for a memo with no words yet, and for a client with no usable link or contact", async () => {
    const s = await measured();
    const { memo } = await startStrategyMemo(e, s.businessId, { now: NOW });
    await env.DB.prepare(`DELETE FROM people WHERE business_id = ?`).bind(s.businessId).run();
    const approval = await proposeStrategyApproval(ask({ CLIENT_LINK_BASE: "https://x.workers.dev" }), memo.id);
    const a = (await approvalRow(approval.id))!;
    expect(a.preview).toContain("The memo has no words yet.");
    expect(a.preview).toMatch(/CLIENT_LINK_BASE/);
    expect(a.preview).toMatch(/nobody yet|contact email/i);
    expect(a.preview).not.toContain(memo.token);
  });

  it("throws for a memo that does not exist", async () => {
    await expect(proposeStrategyApproval(e, "nope")).rejects.toThrow(/not found/i);
  });
});

describe("approving a strategy.memo", () => {
  it("sends one mail with the link and none of Claude's words, and twice sends once", async () => {
    const s = await measured();
    const { memo, approval } = await readyMemo(s);
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test", subject: expect.stringMatching(/^Your plan, /) });
    const text = mail.sent[0].text;
    expect(text).toContain(`${BASE}/y/${memo.token}`);
    expect([...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])).toEqual([`${BASE}/y/${memo.token}`]);
    for (const claude of [BODY.standing, ...BODY.priorities.flatMap((p) => [p.title, p.why, p.firstStep]), ...BODY.needFromYou, "Tigard", "plumber", "drain cleaning"]) expect(text, claude).not.toContain(claude);
    expect(text.replace(`${BASE}/y/${memo.token}`, "")).not.toMatch(/[A-Za-z0-9_-]{30,}/);

    const after = (await getMemo(env.DB, memo.id))!;
    expect(after.status).toBe("sent");
    expect(after.sentAt).toBe(STAMP);
    expect(await lines(s.businessId, "strategy_sent")).toEqual(["Strategy memo sent to pat@ace.test"]);
    expect(await approvalRow(approval.id)).toMatchObject({ status: "approved", error: null });

    // A second approval, and the handler run again, send nothing more.
    expect(await approve(ask(), approval.id)).toMatchObject({ ok: false, status: 409 });
    const row = (await approvalRow(approval.id))!;
    await getHandler("strategy.memo")!.execute(ask(), { memoId: memo.id }, { ...row, id: approval.id, payload: { memoId: memo.id } } as never);
    expect(mail.sent).toHaveLength(1);
    expect(await lines(s.businessId, "strategy_sent")).toHaveLength(1);
  });

  it("a send that fails after the memo was marked sent is mailed on the next approval, once", async () => {
    const s = await measured();
    const { memo, approval } = await readyMemo(s);
    mail.failures.push(new Error("smtp down"));
    expect(await approve(ask(), approval.id)).toMatchObject({ ok: false });
    expect(mail.sent).toHaveLength(0);
    expect(await approvalRow(approval.id)).toMatchObject({ status: "pending" });
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getMemo(env.DB, memo.id))!.status).toBe("sent");
    expect(await lines(s.businessId, "strategy_sent")).toHaveLength(1);
  });

  it("after a billing hold started sends nothing and says why, and sends once the hold is lifted", async () => {
    const held = await seedClient({ invoice: { cents: 5000 } });
    await upsertProfile(env.DB, held.businessId, { trade: "plumber", status: "active" }, "2026-10-01T00:00:00.000Z");
    const { memo, approval } = await readyMemo(held);
    expect(await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice!.id, now: STAMP })).toBe(true);
    const r = await approve(ask(), approval.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/billing hold/);
    expect(mail.sent).toHaveLength(0);
    expect(await approvalRow(approval.id)).toMatchObject({ status: "pending" });
    expect((await getMemo(env.DB, memo.id))!.status).toBe("ready");

    const [hold] = await activeHolds(env.DB, held.businessId);
    expect(await liftHold(env.DB, hold.id, "manual", STAMP)).toBe(true);
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });

  it("a revoked, a sent and a cancelled memo send nothing and say why on the timeline", async () => {
    const cases: [string, (id: string) => Promise<unknown>, RegExp][] = [
      ["revoked", (id) => revokeMemo(env.DB, id, STAMP), /taken back/],
      ["cancelled", (id) => env.DB.prepare(`UPDATE strategy_memos SET status = 'cancelled' WHERE id = ?`).bind(id).run(), /cancelled/],
      ["sent", (id) => env.DB.prepare(`UPDATE strategy_memos SET status = 'sent', sent_at = ? WHERE id = ?`).bind(STAMP, id).run(), /already sent/],
    ];
    for (const [status, change, why] of cases) {
      const s = await measured();
      const { memo, approval } = await readyMemo(s);
      await change(memo.id);
      expect(await approve(ask(), approval.id), status).toEqual({ ok: true });
      expect(mail.sent, status).toHaveLength(0);
      const notes = (await lines(s.businessId, "note")).filter((d) => d.startsWith("Strategy memo not sent"));
      expect(notes, status).toHaveLength(1);
      expect(notes[0]).toMatch(why);
      expect(await lines(s.businessId, "strategy_sent")).toHaveLength(0);
    }
  });

  it("a memo that is not ready yet sends nothing", async () => {
    const s = await measured();
    const { memo } = await startStrategyMemo(e, s.businessId, { now: NOW });
    const approval = await proposeStrategyApproval(e, memo.id);
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect((await lines(s.businessId, "note")).find((d) => d.startsWith("Strategy memo not sent"))).toMatch(/not ready/);
  });

  it("a business that is no longer a client gets nothing, and the timeline says why", async () => {
    const s = await measured();
    const { approval } = await readyMemo(s);
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'lost' WHERE id = ?`).bind(s.businessId).run();
    await env.DB.prepare(`DELETE FROM projects WHERE business_id = ?`).bind(s.businessId).run();
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    expect((await lines(s.businessId, "note")).find((d) => d.startsWith("Strategy memo not sent"))).toMatch(/no longer a client/);
  });

  it("a client whose subscriptions are all cancelled has ended: nothing is sent, the timeline says why and the approval is used up", async () => {
    const s = await measured({ subs: [{ monthlyCents: 60_000, status: "cancelled" }] });
    const { memo, approval } = await readyMemo(s);
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(0);
    const notes = (await lines(s.businessId, "note")).filter((d) => d.startsWith("Strategy memo not sent"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/client has ended/);
    expect(await approvalRow(approval.id)).toMatchObject({ status: "approved", error: null });
    expect((await getMemo(env.DB, memo.id))!.status).toBe("ready");
    expect(await lines(s.businessId, "strategy_sent")).toHaveLength(0);
  });

  it("a client with one cancelled and one active subscription, and a build-only client, have not ended and are mailed", async () => {
    for (const subs of [[{ monthlyCents: 60_000, status: "cancelled" as const }, { monthlyCents: 30_000 }], []]) {
      const s = await measured({ subs });
      const { approval } = await readyMemo(s);
      expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    }
    expect(mail.sent).toHaveLength(2);
  });

  it("with no contact email sends nothing and says so, and the approval stays pending", async () => {
    const s = await measured();
    const { memo, approval } = await readyMemo(s);
    await env.DB.prepare(`DELETE FROM people WHERE business_id = ?`).bind(s.businessId).run();
    const r = await approve(ask(), approval.id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/nobody to go to/);
    expect(mail.sent).toHaveLength(0);
    expect(await approvalRow(approval.id)).toMatchObject({ status: "pending" });
    expect((await getMemo(env.DB, memo.id))!.status).toBe("ready");
  });

  it("a do-not-contact address and a mailbox that cannot send leave the memo ready", async () => {
    const s = await measured();
    const { memo, approval } = await readyMemo(s);
    await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    const blocked = await approve(ask(), approval.id);
    expect((blocked as { error: string }).error).toMatch(/^Blocked: .*do-not-contact/);
    await env.DB.prepare(`DELETE FROM do_not_contact`).run();
    await readyToSend({ mailbox: false });
    const off = await approve(ask(), approval.id);
    expect((off as { error: string }).error).toMatch(/main mailbox cannot send/);
    expect(mail.sent).toHaveLength(0);
    expect((await getMemo(env.DB, memo.id))!.status).toBe("ready");
  });

  it("the mail link is refused when CLIENT_LINK_BASE is the cold-email host, and for any unusable base", async () => {
    for (const base of [COLD, undefined, "https://app.workers.dev", "http://clients.example.com", ""]) {
      const s = await measured();
      const { memo, approval } = await readyMemo(s);
      const r = await approve(ask({ CLIENT_LINK_BASE: base, OUTREACH_LINK_BASE: COLD }), approval.id);
      expect(r, String(base)).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toMatch(/CLIENT_LINK_BASE/);
      expect(await approvalRow(approval.id)).toMatchObject({ status: "pending" });
      expect((await getMemo(env.DB, memo.id))!.status).toBe("ready");
      expect(await approve(ask(), approval.id)).toEqual({ ok: true });
      expect((await getMemo(env.DB, memo.id))!.status).toBe("sent");
    }
    // The first case is the cold-email host as the client base: the base check refuses it, nothing was mailed with it.
    expect(mail.sent.every((m) => !m.text.includes(COLD))).toBe(true);
  });

  it("a rehearsal memo goes to the owner alone, with [Test] on the subject, and ignores a billing hold", async () => {
    const s = await measured({ test: true });
    const { memo } = await startStrategyMemo(e, s.businessId, { now: NOW, test: true });
    await setMemoBody(env.DB, memo.id, BODY, STAMP);
    const approval = await proposeStrategyApproval(e, memo.id);
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: OWNER_EMAIL, subject: expect.stringMatching(/^\[Test\] Your plan, /) });
    expect(mail.sent[0].text).toContain(`${BASE}/y/${memo.token}`);
    expect((await getMemoByToken(env.DB, memo.token))!.status).toBe("sent");
  });
});

describe("a rehearsal client's memo", () => {
  it("stored with test false still goes to the owner alone, with [Test] on the subject, and the card says so", async () => {
    const s = await measured({ test: true });
    const { memo, approval } = await readyMemo(s);
    expect(memo.test).toBe(false);
    expect((await approvalRow(approval.id))!.preview).toContain(`To: ${OWNER_EMAIL} (a test: nothing goes to Pat Jones <pat@ace.test>)`);
    expect(await approve(ask(), approval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(OWNER_EMAIL);
    expect(mail.sent[0].subject).toMatch(/^\[Test\] Your plan, /);
    expect(mail.sent.some((m) => m.to === "pat@ace.test")).toBe(false);
    expect(await lines(s.businessId, "strategy_sent")).toEqual([`Strategy memo sent to ${OWNER_EMAIL} (test)`]);
  });
});

describe("a send that does not finish", () => {
  it("leaves the memo marked sent, and says so on the timeline, when the mail row is still sending", async () => {
    const s = await measured();
    const { memo, approval } = await readyMemo(s);
    mail.failures.push(new Error("smtp dropped"));
    vi.spyOn(messagesDb, "markFailed").mockRejectedValue(new Error("database is busy"));
    expect(await approve(ask(), approval.id)).toMatchObject({ ok: false, error: "smtp dropped" });
    expect((await getMemo(env.DB, memo.id))!.status).toBe("sent");
    expect((await lines(s.businessId, "note")).filter((d) => d.startsWith("Strategy memo: the mail may or may not have gone out"))).toHaveLength(1);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("POST /api/clients/:id/strategy-memo", () => {
  const post = (id: string, auth = true) => SELF.fetch(`https://x/api/clients/${id}/strategy-memo`, { method: "POST", headers: auth ? { cookie } : {} });
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts a memo for a measured client, and answers the same one when asked again", async () => {
    const s = await measured();
    const r = await post(s.businessId);
    expect(r.status).toBe(201);
    const body = (await r.json()) as { memoId: string; status: string; created: boolean };
    expect(body).toEqual({ memoId: expect.any(String), status: "collecting", created: true });
    const second = await post(s.businessId);
    expect(second.status).toBe(200);
    const again = (await second.json()) as typeof body;
    expect(again).toEqual({ ...body, created: false });
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });

  it("marks a rehearsal client's memo as a test", async () => {
    const s = await measured({ test: true });
    expect((await post(s.businessId)).status).toBe(201);
    expect((await listMemos(env.DB, s.businessId))[0].test).toBe(true);
    const real = await measured();
    expect((await post(real.businessId)).status).toBe(201);
    expect((await listMemos(env.DB, real.businessId))[0].test).toBe(false);
  });

  it("is 409 with a plain sentence for a client with nothing measured, and for a lead", async () => {
    const s = await seedClient();
    const r = await post(s.businessId);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "Nothing has been measured for this client yet. Set up their Local SEO profile or link their Search Console first." });
    const lead = await seedClient({ won: false, project: false });
    const l = await post(lead.businessId);
    expect(l.status).toBe(409);
    expect(await l.json()).toEqual({ error: "Only a client can get a strategy memo." });
  });

  it("is 404 for a business that does not exist, and 401 without a session", async () => {
    expect((await post("nope")).status).toBe(404);
    const s = await measured();
    expect((await post(s.businessId, false)).status).toBe(401);
  });
});
