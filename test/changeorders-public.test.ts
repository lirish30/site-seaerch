import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import * as service from "../src/worker/changeorders/service";
import { draftChangeOrder, markChangeOrderPaid } from "../src/worker/changeorders/service";
import {
  changeOrderPage, declineChangeOrderPublic, signChangeOrderPublic, type PublicChangeOrder,
} from "../src/worker/changeorders/public";
import { listActivity } from "../src/worker/db/activity";
import { expireDue, getChangeOrder, voidChangeOrder } from "../src/worker/db/changeOrders";
import { saveSettings } from "../src/worker/db/settings";
import { listTasks } from "../src/worker/db/tasks";
import { ESIGN_VERSION } from "../src/worker/documents/consent";
import { consentTextFor } from "../src/worker/documents/public";
import type { Env } from "../src/worker/env";
import { clearProjectHooksForTests } from "../src/worker/projects/hooks";
import { FAR, content, seal, seedOrder, sendOrder } from "./fixtures/changeorders";
import { readyToSend } from "./fixtures/documents";
import { newTask, seedProject } from "./fixtures/projects";

const e = env as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOW = new Date("2026-12-06T09:00:00.000Z");
const MIN = 60_000;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => { clearProjectHooksForTests(); errors = vi.spyOn(console, "error").mockImplementation(() => {}); await readyToSend(); });
afterEach(() => { clearProjectHooksForTests(); errors.mockRestore(); vi.restoreAllMocks(); });

/** The Worker as a client's browser reaches it: no cookie. */
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x/api${path}`, init), env as never, ctx);
const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const form = (hash: string, o: Record<string, unknown> = {}) => ({ name: "Pat Jones", consent: true, authority: true, sha256: hash, ...o });

const view = (token: string, now = NOW, userAgent: string | null = "TestBrowser/1.0") => changeOrderPage(env, token, { now, userAgent });
const sign = (token: string, hash: string, o: { name?: string; ip?: string | null; userAgent?: string | null; now?: Date } = {}) =>
  signChangeOrderPublic(env, token, form(hash, o.name === undefined ? {} : { name: o.name }), {
    now: o.now ?? NOW, ip: o.ip === undefined ? "203.0.113.9" : o.ip, userAgent: o.userAgent === undefined ? "TestBrowser/1.0" : o.userAgent,
  });

const FULL = { deliverables: ["Build the page", "Add the photos"], notIncluded: ["Writing the captions"], scheduleImpactDays: 3 };

/** A sent order (open for the life of the test run unless `expiresAt` is given), with its token and the hash a client would send. */
async function sent(o: { test?: boolean; content?: Parameters<typeof content>[0]; expiresAt?: string; originApprovalId?: string; approvalId?: string } = {}) {
  const s = await seedOrder({ test: o.test, content: { ...FULL, ...o.content }, originApprovalId: o.originApprovalId });
  const { co, hash } = await sendOrder(s.co, { expiresAt: o.expiresAt ?? FAR, approvalId: o.approvalId ?? null });
  return { ...s, co, hash, token: co.token! };
}
const open = (p: PublicChangeOrder | null) => { if (!p || p.state !== "open") throw new Error(`expected an open page, got ${p?.state ?? "null"}`); return p; };
const viewCount = async (id: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_order_views WHERE change_order_id = ?`).bind(id).first<{ n: number }>())!.n;
const logs = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind);
const NOT_FOUND = { error: "not found" };

describe("an unknown, malformed, draft or revoked token is the same 404", () => {
  it("answers the same body on all three routes, and the page functions answer null or 404", async () => {
    const a = await sent();
    const draft = await seedOrder(); // a draft has no token
    await env.DB.prepare(`UPDATE change_orders SET token = ? WHERE id = ?`).bind("D".repeat(43), draft.co.id).run(); // even a token forced onto a draft is not served
    const revoked = await sent();
    await env.DB.prepare(`UPDATE change_orders SET token = NULL WHERE id = ?`).bind(revoked.co.id).run();

    const dead = ["A".repeat(43), "short", `${a.token}x`, a.token.slice(1), `${a.token.slice(0, 42)}+`, "D".repeat(43), revoked.token];
    for (const t of dead) {
      const get = await call(`/public/c/${t}`);
      const sgn = await post(`/public/c/${t}/sign`, form(a.hash));
      const dec = await post(`/public/c/${t}/decline`, { reason: "no" });
      expect([get.status, sgn.status, dec.status], t).toEqual([404, 404, 404]);
      for (const r of [get, sgn, dec]) expect(await r.json(), t).toEqual(NOT_FOUND);
      expect(await view(t)).toBeNull();
      expect(await sign(t, a.hash)).toEqual({ ok: false, status: 404, error: "not found" });
      expect(await declineChangeOrderPublic(env, t, "no", NOW)).toEqual({ ok: false, status: 404, error: "not found" });
    }
    expect(await viewCount(draft.co.id)).toBe(0);
    expect(await viewCount(revoked.co.id)).toBe(0);
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("sent"); // the real order was never touched
  });

  it("a malformed token never reaches the database", async () => {
    const touched: string[] = [];
    const poisoned = new Proxy({} as D1Database, { get: (_t, k) => { touched.push(String(k)); throw new Error("the database was touched"); } });
    const bad = { ...env, DB: poisoned } as Env;
    expect(await changeOrderPage(bad, "short", { now: NOW, userAgent: null })).toBeNull();
    expect(await signChangeOrderPublic(bad, "short", {}, { now: NOW, ip: null, userAgent: null })).toMatchObject({ ok: false, status: 404 });
    expect(await declineChangeOrderPublic(bad, "short", "x", NOW)).toMatchObject({ ok: false, status: 404 });
    expect(touched).toEqual([]);
  });
});

describe("the page", () => {
  it("never includes other tasks, the cost rate, another client, ids or the approvals", async () => {
    await saveSettings(env.DB, { work_config: JSON.stringify({ costRateCentsPerHour: 7777 }), your_name: "Logan Irish", business_name: "Siteline" });
    const a = await sent({ originApprovalId: "approval-origin-9a1", approvalId: "approval-send-7b2", expiresAt: "2026-12-20T07:30:00.000Z" });
    const { insertTasks } = await import("../src/worker/db/tasks");
    await insertTasks(env.DB, [newTask(a.project.id, a.businessId, { title: "INTERNAL-ONLY step", description: "SECRET internal note", position: 90 })]);
    const other = await sent({ content: { clientName: "Zed Heating", contactName: "Zed Zane", contactEmail: "zed@heating.test", title: "Zed's other change" } });
    const open1 = open(await view(a.token));

    expect(Object.keys(open1).sort()).toEqual([
      "clientName", "closedReason", "consentText", "contactName", "contentSha256", "deliverables", "expiresOn", "hours", "notIncluded", "ownerBusiness", "ownerName", "payment", "priceCents",
      "projectName", "rateCents", "reason", "reference", "scheduleImpactDays", "signed", "state", "summary", "title",
    ]);
    expect(open1).toMatchObject({
      state: "open", reference: a.co.content.reference, clientName: "Ace Plumbing", contactName: "Pat Jones", projectName: "Website build", title: "Add a gallery page", summary: "A page of twelve job photos.",
      reason: "The client asked for it after launch planning.", deliverables: FULL.deliverables, notIncluded: FULL.notIncluded, hours: 2, rateCents: 12500, priceCents: 25000, scheduleImpactDays: 3,
      contentSha256: a.hash, consentText: consentTextFor("Ace Plumbing"), ownerName: "Logan Irish", ownerBusiness: "Siteline", signed: null, payment: "none", closedReason: null,
    });
    expect(open1.expiresOn).toBe("2026-12-19"); // a calendar date in the owner's zone (Los Angeles), not UTC
    const text = JSON.stringify(open1);
    for (const secret of [
      a.token, other.token, a.co.id, a.project.id, a.businessId, a.dealId ?? "-", a.documentId ?? "-", "approval-origin-9a1", "approval-send-7b2", "7777", "INTERNAL-ONLY", "SECRET internal",
      "Zed Heating", "zed@heating.test", "Zed's other", other.co.id, other.token, "pat@ace.test",
    ]) expect(text, secret).not.toContain(secret);
  });

  it("opening a sent order moves it to viewed, and a second open within 10 minutes adds no view", async () => {
    const a = await sent();
    expect(open(await view(a.token)).state).toBe("open");
    let co = (await getChangeOrder(env.DB, a.co.id))!;
    expect(co.status).toBe("viewed");
    expect(co.firstViewedAt).toBe(NOW.toISOString());
    expect(await viewCount(a.co.id)).toBe(1);
    await view(a.token, new Date(NOW.getTime() + 5 * MIN));
    expect(await viewCount(a.co.id)).toBe(1);
    await view(a.token, new Date(NOW.getTime() + 11 * MIN), "Other/2.0");
    expect(await viewCount(a.co.id)).toBe(2);
    co = (await getChangeOrder(env.DB, a.co.id))!;
    expect([co.status, co.firstViewedAt]).toEqual(["viewed", NOW.toISOString()]);
    const ua = await env.DB.prepare(`SELECT user_agent FROM change_order_views WHERE change_order_id = ? ORDER BY viewed_at`).bind(a.co.id).all<{ user_agent: string }>();
    expect(ua.results.map((r) => r.user_agent)).toEqual(["TestBrowser/1.0", "Other/2.0"]);
  });

  it("the user agent is capped when a view is recorded", async () => {
    const a = await sent();
    await view(a.token, NOW, "v".repeat(5000));
    const row = await env.DB.prepare(`SELECT user_agent FROM change_order_views WHERE change_order_id = ?`).bind(a.co.id).first<{ user_agent: string }>();
    expect(row!.user_agent).toBe("v".repeat(300));
  });

  it("a test order is viewable like a real one", async () => {
    const a = await sent({ test: true });
    expect(open(await view(a.token)).clientName).toBe("Ace Plumbing");
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("viewed");
  });

  it("a name with markup is plain data for the page, which shows it as text", async () => {
    const a = await sent({ content: { clientName: `<script>alert(1)</script> & "Co"`, title: "<img src=x onerror=alert(1)>" } });
    const page = open(await view(a.token));
    expect(page.clientName).toBe(`<script>alert(1)</script> & "Co"`);
    expect(page.title).toBe("<img src=x onerror=alert(1)>");
    expect(page.consentText).toContain(`I am authorized to sign for <script>alert(1)</script> & "Co"`);
  });
});

describe("signing", () => {
  it("records name, ip, user agent, consent text, version and hash", async () => {
    const a = await sent();
    await view(a.token);
    const r = await sign(a.token, a.hash, { name: "  Pat Jones ", ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Test)" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page).toMatchObject({ state: "signed", signed: { signerName: "Pat Jones", signedAt: NOW.toISOString() }, payment: "none", contentSha256: a.hash });
    const co = (await getChangeOrder(env.DB, a.co.id))!;
    expect(co).toMatchObject({
      status: "signed", signedAt: NOW.toISOString(), signerName: "Pat Jones", signerEmail: "pat@ace.test", signerIp: "203.0.113.9", signerUserAgent: "Mozilla/5.0 (Test)",
      consentText: consentTextFor("Ace Plumbing"), consentVersion: ESIGN_VERSION, contentSha256: a.hash,
    });
    expect((await logs(a.businessId, "change_order_signed")).map((l) => l.detail)).toEqual([expect.stringContaining("signed by Pat Jones")]);
  });

  it("signs through the route and answers the signed page", async () => {
    const a = await sent();
    const res = await post(`/public/c/${a.token}/sign`, form(a.hash));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "signed", signed: { signerName: "Pat Jones" } });
  });

  it("the ip and user agent are cleaned and capped, the name is trimmed", async () => {
    const a = await sent();
    expect((await sign(a.token, a.hash, { userAgent: `u\u0000${"u".repeat(5000)}`, ip: "9".repeat(500) })).ok).toBe(true);
    const co = (await getChangeOrder(env.DB, a.co.id))!;
    expect(co.signerUserAgent).toBe("u".repeat(300));
    expect(co.signerIp).toBe("9".repeat(64));
  });

  it("a name with hidden or control characters is a 400 and stores nothing", async () => {
    const a = await sent();
    for (const name of ["Pat‮Jones", "Pat\u0000Jones", "", "A", "x".repeat(121)]) {
      expect(await sign(a.token, a.hash, { name }), JSON.stringify(name)).toMatchObject({ ok: false, status: 400 });
    }
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("sent");
  });

  it("a name that is markup is stored as typed", async () => {
    const a = await sent();
    expect((await sign(a.token, a.hash, { name: "<img src=x onerror=alert(1)> Jones" })).ok).toBe(true);
    expect((await getChangeOrder(env.DB, a.co.id))!.signerName).toBe("<img src=x onerror=alert(1)> Jones");
  });

  it("a changed hash is a 409 and stores nothing", async () => {
    const a = await sent();
    expect(await sign(a.token, "0".repeat(64))).toEqual({ ok: false, status: 409, error: "this change order changed, reload" });
    const res = await post(`/public/c/${a.token}/sign`, form("0".repeat(64)));
    expect(res.status).toBe(409);
    expect((await getChangeOrder(env.DB, a.co.id))).toMatchObject({ status: "sent", signedAt: null, signerName: null });
  });

  it("each missing consent box is a 400 naming the field", async () => {
    const a = await sent();
    for (const bad of [{ consent: false }, { authority: false }, { sha256: "xyz" }, { extra: 1 }]) {
      const res = await post(`/public/c/${a.token}/sign`, form(a.hash, bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid body" });
    }
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("sent");
  });

  it("signing twice answers with the first signature and stores one", async () => {
    const a = await sent();
    const first = await sign(a.token, a.hash, { name: "Pat Jones", ip: "203.0.113.9" });
    const second = await sign(a.token, a.hash, { name: "Someone Else", ip: "198.51.100.7", now: new Date(NOW.getTime() + 5 * MIN) });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.page.signed).toEqual({ signerName: "Pat Jones", signedAt: NOW.toISOString() });
    expect(second.page).toEqual(first.page);
    expect((await getChangeOrder(env.DB, a.co.id))).toMatchObject({ signerName: "Pat Jones", signerIp: "203.0.113.9", signedAt: NOW.toISOString() });
    expect(await logs(a.businessId, "change_order_signed")).toHaveLength(1);
    // A retry with a stale hash is not an answer to the signed paper.
    expect(await sign(a.token, "0".repeat(64))).toMatchObject({ ok: false, status: 409 });
  });

  it("two signs at once leave one signature", async () => {
    const a = await sent();
    const results = await Promise.all([sign(a.token, a.hash), sign(a.token, a.hash), sign(a.token, a.hash)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("signed");
    expect(await logs(a.businessId, "change_order_signed")).toHaveLength(1);
  });

  it("a test order is signable like a real one", async () => {
    const a = await sent({ test: true });
    expect((await sign(a.token, a.hash)).ok).toBe(true);
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("signed");
  });

  it("a bad form on an unreal token is 404 not 400", async () => {
    const a = await sent();
    const ghost = "G".repeat(43);
    for (const body of [{}, "not json", form(a.hash, { consent: false }), form(a.hash, { name: "A" })]) {
      expect((await post(`/public/c/${ghost}/sign`, body)).status, JSON.stringify(body)).toBe(404);
    }
    expect(await sign(ghost, a.hash, { name: "A" })).toEqual({ ok: false, status: 404, error: "not found" });
    // The same forms on a real link are the 400 they should be.
    expect((await post(`/public/c/${a.token}/sign`, {})).status).toBe(400);
    expect((await post(`/public/c/${a.token}/sign`, "not json")).status).toBe(400);
    expect((await post(`/public/c/${a.token}/sign`, form(a.hash, { consent: false }))).status).toBe(400);
  });

  it("a body over 4 KB is a 413", async () => {
    const a = await sent();
    expect((await post(`/public/c/${a.token}/sign`, form(a.hash, { name: "A".repeat(5000) }))).status).toBe(413);
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("sent");
  });

  it("a failure after the stored signature still answers ok, and the page can be loaded again", async () => {
    const a = await sent();
    const spy = vi.spyOn(service, "afterSigned").mockRejectedValue(new Error("boom"));
    const r = await sign(a.token, a.hash);
    expect(r).toMatchObject({ ok: true, page: { state: "signed", signed: { signerName: "Pat Jones" } } });
    expect(spy).toHaveBeenCalledTimes(1); // the failing step really ran
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("signed");
    vi.restoreAllMocks();
    // The retry runs afterSigned again (it is idempotent) and logs the signature once.
    expect((await sign(a.token, a.hash)).ok).toBe(true);
    expect(await logs(a.businessId, "change_order_signed")).toHaveLength(1);
  });

  it("signed does not unlock by itself; paid does", async () => {
    const s = await seedProject();
    const draft = await draftChangeOrder(e, { projectId: s.project.id, title: "Add a gallery page", summary: "Twelve photos.", reason: "Asked for.", hours: 2, deliverables: ["Build the page", "Add the photos"], sourceType: "logan" });
    const co = await seal(draft);
    const lockedOf = async () => (await listTasks(env.DB, s.project.id)).filter((t) => t.changeOrderId === co.id).map((t) => t.status);
    expect(await lockedOf()).toEqual(["locked", "locked"]);
    const r = await sign(co.token!, co.contentSha256!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page).toMatchObject({ state: "signed", payment: "none" });
    expect(await lockedOf()).toEqual(["locked", "locked"]);
    await markChangeOrderPaid(e, co.id, { via: "manual", now: new Date("2026-12-07T10:00:00.000Z") });
    expect(await lockedOf()).toEqual(["todo", "todo"]);
    expect((await view(co.token!))).toMatchObject({ state: "signed", payment: "paid" });
  });
});

describe("a closed order", () => {
  it("an expired or voided order answers closed with nothing of the order in it, and records no view", async () => {
    const v = await sent();
    await voidChangeOrder(env.DB, v.co.id, "wrong scope");
    const closed = await view(v.token);
    expect(closed).toMatchObject({ state: "closed", closedReason: "void", reference: v.co.content.reference, clientName: "Ace Plumbing", signed: null });
    expect(closed).toMatchObject({ summary: "", reason: "", deliverables: [], notIncluded: [], hours: 0, priceCents: 0, contentSha256: "", consentText: "" });
    expect(JSON.stringify(closed)).not.toContain("twelve job photos");

    const ex = await sent({ expiresAt: "2026-12-10T00:00:00.000Z" });
    expect(await view(ex.token, new Date("2026-12-10T00:00:01.000Z"))).toMatchObject({ state: "closed", closedReason: "expired" }); // past its time, before the sweep
    expect(open(await view(ex.token, new Date("2026-12-10T00:00:00.000Z"))).state).toBe("open"); // the instant itself is still open, as signing allows
    const swept = await sent({ expiresAt: "2026-12-10T00:00:00.000Z" });
    expect((await expireDue(env.DB, "2027-01-01T00:00:00.000Z")).map((x) => x.id)).toEqual(expect.arrayContaining([swept.co.id, ex.co.id]));
    expect((await getChangeOrder(env.DB, swept.co.id))!.status).toBe("expired");
    expect(await view(swept.token)).toMatchObject({ state: "closed", closedReason: "expired" });
    expect(await viewCount(v.co.id)).toBe(0);
    expect(await viewCount(swept.co.id)).toBe(0);
  });

  it("signing a closed order is a 409 and stores nothing", async () => {
    const v = await sent();
    await voidChangeOrder(env.DB, v.co.id, "x");
    expect(await sign(v.token, v.hash)).toEqual({ ok: false, status: 409, error: "this change order is no longer open" });
    const late = await sent({ expiresAt: "2026-12-10T00:00:00.000Z" });
    expect(await sign(late.token, late.hash, { now: new Date("2026-12-10T00:00:01.000Z") })).toMatchObject({ ok: false, status: 409 });
    expect((await post(`/public/c/${v.token}/sign`, form(v.hash))).status).toBe(409);
    expect((await getChangeOrder(env.DB, v.co.id))).toMatchObject({ status: "void", signedAt: null });
    expect((await getChangeOrder(env.DB, late.co.id))).toMatchObject({ status: "sent", signedAt: null });
  });
});

describe("declining", () => {
  it("closes it, caps and cleans the reason, and unlocks nothing", async () => {
    const s = await seedProject();
    const draft = await draftChangeOrder(e, { projectId: s.project.id, title: "Add a gallery page", summary: "Twelve photos.", reason: "Asked for.", hours: 2, deliverables: ["Build the page", "Add the photos"], sourceType: "logan" });
    const co = await seal(draft);
    const r = await declineChangeOrderPublic(env, co.token!, `  too\u0000 much ‮${"x".repeat(1000)}`, NOW);
    expect(r).toMatchObject({ ok: true, page: { state: "closed", closedReason: "declined" } });
    const saved = (await getChangeOrder(env.DB, co.id))!;
    expect(saved.status).toBe("declined");
    expect(saved.declinedReason!.length).toBe(300);
    expect(saved.declinedReason!.startsWith("too much xxx")).toBe(true);
    expect(saved.declinedReason).not.toMatch(/[\u0000‮]/);
    expect((await listTasks(env.DB, s.project.id)).filter((t) => t.changeOrderId === co.id).map((t) => t.status)).toEqual(["locked", "locked"]);
    // It cannot be signed after, and a second no changes nothing.
    expect(await sign(co.token!, co.contentSha256!)).toMatchObject({ ok: false, status: 409 });
    expect(await declineChangeOrderPublic(env, co.token!, "other", NOW)).toMatchObject({ ok: true, page: { closedReason: "declined" } });
    expect((await getChangeOrder(env.DB, co.id))!.declinedReason).toBe(saved.declinedReason);
  });

  it("writes exactly one timeline line, with the reference and the short id, and a repeat writes none", async () => {
    const a = await sent();
    await declineChangeOrderPublic(env, a.token, `  not   now\n${"y".repeat(300)}`, NOW);
    const lines = (await logs(a.businessId, "change_order_declined")).map((l) => l.detail!);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${a.co.content.reference} (${a.co.id.slice(0, 8)}) declined: not now y`)).toBe(true);
    expect(lines[0].length).toBeLessThanOrEqual(`${a.co.content.reference} (${a.co.id.slice(0, 8)}) declined: `.length + 80);
    expect(lines[0]).not.toMatch(/\n/);
    await declineChangeOrderPublic(env, a.token, "something else", NOW);
    await post(`/public/c/${a.token}/decline`, { reason: "again" });
    expect(await logs(a.businessId, "change_order_declined")).toHaveLength(1);
    // A refused decline (signed order) writes nothing.
    const b = await sent();
    await sign(b.token, b.hash);
    await declineChangeOrderPublic(env, b.token, "x", NOW);
    expect(await logs(b.businessId, "change_order_declined")).toHaveLength(0);
  });

  it("works through the route, with or without a reason, and a non-text reason is no reason", async () => {
    const a = await sent(), b = await sent(), c = await sent();
    const res = await post(`/public/c/${a.token}/decline`, { reason: "not now" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "closed", closedReason: "declined" });
    expect((await getChangeOrder(env.DB, a.co.id))!.declinedReason).toBe("not now");
    expect((await call(`/public/c/${b.token}/decline`, { method: "POST" })).status).toBe(200); // no body at all
    expect((await getChangeOrder(env.DB, b.co.id))).toMatchObject({ status: "declined", declinedReason: "" });
    expect((await post(`/public/c/${c.token}/decline`, { reason: { a: 1 } })).status).toBe(200);
    expect((await getChangeOrder(env.DB, c.co.id))).toMatchObject({ status: "declined", declinedReason: "" });
  });

  it("a signed, void or expired order cannot be declined", async () => {
    const signed = await sent();
    await sign(signed.token, signed.hash);
    expect(await declineChangeOrderPublic(env, signed.token, "x", NOW)).toEqual({ ok: false, status: 409, error: "this change order is no longer open" });
    expect((await getChangeOrder(env.DB, signed.co.id))!.status).toBe("signed");
    const v = await sent();
    await voidChangeOrder(env.DB, v.co.id, "x");
    expect(await declineChangeOrderPublic(env, v.token, "x", NOW)).toMatchObject({ ok: false, status: 409 });
    const late = await sent({ expiresAt: "2026-12-10T00:00:00.000Z" });
    expect(await declineChangeOrderPublic(env, late.token, "x", new Date("2026-12-11T00:00:00.000Z"))).toMatchObject({ ok: false, status: 409 });
    expect((await getChangeOrder(env.DB, late.co.id))!.status).toBe("sent");
  });

  it("a body over 4 KB is a 413", async () => {
    const a = await sent();
    expect((await post(`/public/c/${a.token}/decline`, { reason: "r".repeat(5000) })).status).toBe(413);
    expect((await getChangeOrder(env.DB, a.co.id))!.status).toBe("sent");
  });
});

describe("public/_headers", () => {
  it("forbids framing and indexing on /c and /c/*, with the same four lines as /p", async () => {
    const text = await (await import("../public/_headers?raw")).default as string;
    const blocks = text.split(/\n(?=\S)/);
    const lines = (prefix: string) => blocks.filter((b) => b.split("\n")[0].trim() === prefix).map((b) => b.split("\n").slice(1).map((l) => l.trim()).filter(Boolean));
    expect(lines("/c")).toHaveLength(1);
    expect(lines("/c/*")).toHaveLength(1);
    expect(lines("/c")[0]).toHaveLength(4);
    expect(lines("/c")[0]).toEqual(lines("/p")[0]);
    expect(lines("/c/*")[0]).toEqual(lines("/p/*")[0]);
    expect(lines("/c")[0]).toEqual(["X-Robots-Tag: noindex, nofollow", "Referrer-Policy: no-referrer", "X-Frame-Options: DENY", "Content-Security-Policy: frame-ancestors 'none'"]);
  });
});

describe("the routes", () => {
  it("responses carry no-store and noindex, on every answer", async () => {
    const a = await sent();
    const b = await sent();
    const answers = [
      await call(`/public/c/${a.token}`),
      await post(`/public/c/${a.token}/sign`, form(a.hash)),
      await post(`/public/c/${a.token}/sign`, form(a.hash)), // the second sign
      await call(`/public/c/${"A".repeat(43)}`),
      await post(`/public/c/${a.token}/sign`, "not json"),
      await post(`/public/c/${a.token}/sign`, form("0".repeat(64))),
      await call("/public/c/short"),
      await post(`/public/c/${b.token}/decline`, { reason: "no" }),
      await post(`/public/c/${"A".repeat(43)}/decline`, {}),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 404, 400, 409, 404, 200, 404]);
    for (const r of answers) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("GET returns the page without a cookie", async () => {
    const a = await sent();
    const res = await call(`/public/c/${a.token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "open", contentSha256: a.hash, clientName: "Ace Plumbing", payment: "none" });
  });

  it("the three routes are public but an owner route such as /api/projects is still 401", async () => {
    const T = "A".repeat(43);
    expect((await call(`/public/c/${T}`)).status).toBe(404); // not 401
    expect((await post(`/public/c/${T}/sign`, {})).status).toBe(404);
    expect((await post(`/public/c/${T}/decline`, {})).status).toBe(404);
    for (const [method, path] of [
      ["GET", "/projects"], ["POST", "/projects"], ["GET", "/change-orders"], ["GET", `/public/c/${T}/sign`], ["GET", `/public/c/${T}/decline`], ["PUT", `/public/c/${T}`], ["DELETE", `/public/c/${T}`],
      ["POST", `/public/c/${T}`], ["POST", `/public/c/${T}/sign/x`], ["POST", `/public/c/${T}/signx`], ["POST", `/public/c/${T}/pdf`], ["GET", `/public/c/${T}/x`], ["POST", "/public/c//sign"],
      ["GET", "/public/c/"], ["GET", "/public/c"], ["POST", `/public/c/${T}/Sign`],
    ] as const) {
      const res = await call(path, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
