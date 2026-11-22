import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { describeActivity } from "../src/client/activityView";
import { insertVideo, finishVideo, failVideo, getVideoFor } from "../src/worker/db/reportVideos";
import { createSite, archiveSite } from "../src/worker/db/sites";
import { countMemoView, getMemo, getMemoByToken, insertMemo, listMemos, markMemoSent, revokeMemo, setMemoBody, setMemoLinks } from "../src/worker/db/strategy";
import { deleteLink, getLink, getTrafficMonth, linksForBusiness, monthsFor, saveLink, saveTrafficMonth, setLinkError } from "../src/worker/db/traffic";
import { seedClient } from "./fixtures/clients";

const T0 = "2026-12-01T10:00:00.000Z";
const T1 = "2026-12-01T11:00:00.000Z";
const T2 = "2026-12-01T12:00:00.000Z";
const token = () => crypto.randomUUID();

describe("site links", () => {
  it("saveLink changes only the keys given", async () => {
    const s = await seedClient();
    const siteId = s.site!.id;
    const a = await saveLink(env.DB, siteId, { gscProperty: "sc-domain:ace.com", ga4Property: "properties/1" }, T0);
    expect(a).toEqual({ siteId, gscProperty: "sc-domain:ace.com", ga4Property: "properties/1", gbpLocation: null, linkedAt: T0, checkedAt: null, lastError: "" });
    const b = await saveLink(env.DB, siteId, { ga4Property: null, gbpLocation: "locations/9" }, T1);
    expect(b).toEqual({ siteId, gscProperty: "sc-domain:ace.com", ga4Property: null, gbpLocation: "locations/9", linkedAt: T0, checkedAt: null, lastError: "" });
    expect(await getLink(env.DB, siteId)).toEqual(b);
    await setLinkError(env.DB, siteId, "token revoked", T1);
    expect(await getLink(env.DB, siteId)).toMatchObject({ lastError: "token revoked", checkedAt: T1 });
    await setLinkError(env.DB, siteId, "", T2);
    expect(await getLink(env.DB, siteId)).toMatchObject({ lastError: "", checkedAt: T2 });
    await deleteLink(env.DB, siteId);
    expect(await getLink(env.DB, siteId)).toBeNull();
  });
});

describe("traffic months", () => {
  const facts = (clicks: number) => ({ search: { clicks } });

  it("saveTrafficMonth ok then failed keeps the ok row and its facts", async () => {
    const s = await seedClient();
    const siteId = s.site!.id;
    await saveTrafficMonth(env.DB, { siteId, period: "2026-11", status: "ok", facts: facts(10) }, T0);
    await saveTrafficMonth(env.DB, { siteId, period: "2026-11", status: "failed", facts: null, error: "quota" }, T1);
    expect(await getTrafficMonth(env.DB, siteId, "2026-11")).toEqual({ siteId, period: "2026-11", status: "ok", facts: facts(10), pulledAt: T0, attempts: 1, error: "" });
  });

  it("saveTrafficMonth failed then ok replaces it and attempts is 2", async () => {
    const s = await seedClient();
    const siteId = s.site!.id;
    await saveTrafficMonth(env.DB, { siteId, period: "2026-11", status: "failed", facts: {}, error: "quota" }, T0);
    expect(await getTrafficMonth(env.DB, siteId, "2026-11")).toMatchObject({ status: "failed", error: "quota", attempts: 1 });
    await saveTrafficMonth(env.DB, { siteId, period: "2026-11", status: "ok", facts: facts(7) }, T1);
    expect(await getTrafficMonth(env.DB, siteId, "2026-11")).toEqual({ siteId, period: "2026-11", status: "ok", facts: facts(7), pulledAt: T1, attempts: 2, error: "" });
  });

  it("saveTrafficMonth with force replaces an ok row", async () => {
    const s = await seedClient();
    const siteId = s.site!.id;
    await saveTrafficMonth(env.DB, { siteId, period: "2026-11", status: "ok", facts: facts(10) }, T0);
    await saveTrafficMonth(env.DB, { siteId, period: "2026-11", status: "partial", facts: facts(12), error: "ga4 down", force: true }, T1);
    expect(await getTrafficMonth(env.DB, siteId, "2026-11")).toEqual({ siteId, period: "2026-11", status: "partial", facts: facts(12), pulledAt: T1, attempts: 2, error: "ga4 down" });
    expect(await getTrafficMonth(env.DB, siteId, "2026-10")).toBeNull();
  });

  it("monthsFor leaves out an archived site", async () => {
    const s = await seedClient();
    const second = (await createSite(env.DB, { businessId: s.businessId, url: "https://ace-two.com" })).site;
    for (const [site, clicks] of [[s.site!.id, 1], [second.id, 2]] as const) {
      await saveLink(env.DB, site, { gscProperty: `sc-domain:${site}` }, T0);
      await saveTrafficMonth(env.DB, { siteId: site, period: "2026-11", status: "ok", facts: facts(clicks) }, T0);
    }
    expect((await monthsFor(env.DB, s.businessId, "2026-11")).map((m) => m.siteId)).toEqual([s.site!.id, second.id]);
    expect((await linksForBusiness(env.DB, s.businessId)).map((l) => l.domain)).toEqual(["ace.com", "ace-two.com"]);
    await archiveSite(env.DB, second.id, T1);
    expect((await monthsFor(env.DB, s.businessId, "2026-11")).map((m) => m.siteId)).toEqual([s.site!.id]);
    expect((await linksForBusiness(env.DB, s.businessId)).map((l) => l.siteId)).toEqual([s.site!.id]);
    expect(await monthsFor(env.DB, s.businessId, "2026-10")).toEqual([]);
  });
});

describe("strategy memos", () => {
  it("insertMemo twice for one client returns the open memo with created false and version 1", async () => {
    const s = await seedClient();
    const a = await insertMemo(env.DB, { businessId: s.businessId, token: token(), facts: { n: 1 }, test: false, now: T0 });
    expect(a.created).toBe(true);
    expect(a.memo).toMatchObject({ businessId: s.businessId, version: 1, status: "collecting", facts: { n: 1 }, body: {}, test: false, createdAt: T0, readyAt: null, sentAt: null, viewCount: 0 });
    const b = await insertMemo(env.DB, { businessId: s.businessId, token: token(), facts: { n: 2 }, test: false, now: T1 });
    expect(b.created).toBe(false);
    expect(b.memo).toEqual(a.memo);
    expect(await setMemoBody(env.DB, a.memo.id, { headline: "Hi" }, T1)).toBe(true);
    const c = await insertMemo(env.DB, { businessId: s.businessId, token: token(), facts: {}, test: false, now: T2 });
    expect(c).toMatchObject({ created: false, memo: { id: a.memo.id, status: "ready", body: { headline: "Hi" }, readyAt: T1 } });
    expect(await getMemo(env.DB, a.memo.id)).toEqual(c.memo);
    expect(await getMemoByToken(env.DB, a.memo.token)).toEqual(c.memo);
    expect(await getMemo(env.DB, "missing")).toBeNull();
  });

  it("insertMemo after the first is sent makes version 2", async () => {
    const s = await seedClient();
    const a = await insertMemo(env.DB, { businessId: s.businessId, token: token(), facts: {}, test: false, now: T0 });
    await setMemoBody(env.DB, a.memo.id, { x: 1 }, T0);
    await setMemoLinks(env.DB, a.memo.id, { claudeTaskId: "task-1", approvalId: "appr-1" });
    expect(await markMemoSent(env.DB, a.memo.id, T1)).toBe(true);
    expect(await markMemoSent(env.DB, a.memo.id, T2)).toBe(false);
    const b = await insertMemo(env.DB, { businessId: s.businessId, token: token(), facts: {}, test: true, now: T2 });
    expect(b).toMatchObject({ created: true, memo: { version: 2, status: "collecting", test: true } });
    expect((await listMemos(env.DB, s.businessId)).map((m) => m.version)).toEqual([2, 1]);
    expect(await getMemo(env.DB, a.memo.id)).toMatchObject({ status: "sent", sentAt: T1, claudeTaskId: "task-1", approvalId: "appr-1" });
    // A sent memo can be taken back, and the client then gets a third.
    expect(await revokeMemo(env.DB, a.memo.id, T2)).toBe(true);
    expect(await getMemo(env.DB, a.memo.id)).toMatchObject({ status: "revoked", revokedAt: T2 });
  });

  it("markMemoSent from collecting is refused (false)", async () => {
    const s = await seedClient();
    const a = await insertMemo(env.DB, { businessId: s.businessId, token: token(), facts: {}, test: false, now: T0 });
    expect(await markMemoSent(env.DB, a.memo.id, T1)).toBe(false);
    expect(await getMemo(env.DB, a.memo.id)).toMatchObject({ status: "collecting", sentAt: null });
    expect(await setMemoBody(env.DB, a.memo.id, {}, T1)).toBe(true);
    expect(await setMemoBody(env.DB, a.memo.id, { again: true }, T2)).toBe(false);
  });

  it("countMemoView keeps the first view time and counts two", async () => {
    const s = await seedClient();
    const a = await insertMemo(env.DB, { businessId: s.businessId, token: token(), facts: {}, test: false, now: T0 });
    await countMemoView(env.DB, a.memo.id, T1);
    await countMemoView(env.DB, a.memo.id, T2);
    expect(await getMemo(env.DB, a.memo.id)).toMatchObject({ firstViewedAt: T1, viewCount: 2 });
  });
});

describe("report videos", () => {
  it("insertVideo twice for one report returns created false", async () => {
    const a = await insertVideo(env.DB, { kind: "care", reportId: "r1", now: T0 });
    expect(a.created).toBe(true);
    expect(a.video).toMatchObject({ reportKind: "care", reportId: "r1", status: "queued", videoKey: null, posterKey: null, durationMs: null, error: "", createdAt: T0 });
    const b = await insertVideo(env.DB, { kind: "care", reportId: "r1", now: T1 });
    expect(b).toEqual({ video: a.video, created: false });
    expect((await insertVideo(env.DB, { kind: "seo", reportId: "r1", now: T1 })).created).toBe(true);
    expect(await finishVideo(env.DB, a.video.id, { videoKey: "v.mp4", posterKey: "p.jpg", durationMs: 31000 })).toBe(true);
    expect(await finishVideo(env.DB, a.video.id, { videoKey: "v2.mp4", posterKey: "p2.jpg", durationMs: 1 })).toBe(false);
    expect(await getVideoFor(env.DB, "care", "r1")).toMatchObject({ status: "rendered", videoKey: "v.mp4", posterKey: "p.jpg", durationMs: 31000 });
    const c = await insertVideo(env.DB, { kind: "care", reportId: "r2", now: T0 });
    await failVideo(env.DB, c.video.id, "render timed out");
    expect(await getVideoFor(env.DB, "care", "r2")).toMatchObject({ status: "failed", error: "render timed out" });
    expect(await getVideoFor(env.DB, "care", "nope")).toBeNull();
  });
});

describe("tables", () => {
  it("status outside the CHECK is refused", async () => {
    const s = await seedClient();
    await expect(env.DB.prepare(`INSERT INTO traffic_months (site_id, period, status, facts, pulled_at) VALUES (?, '2026-11', 'bogus', '{}', ?)`).bind(s.site!.id, T0).run()).rejects.toThrow();
    await expect(env.DB.prepare(
      `INSERT INTO strategy_memos (id, business_id, version, status, token, facts, created_at) VALUES ('m1', ?, 1, 'bogus', 't1', '{}', ?)`,
    ).bind(s.businessId, T0).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO report_videos (id, report_kind, report_id, status, created_at) VALUES ('v1', 'care', 'r', 'bogus', ?)`).bind(T0).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO report_videos (id, report_kind, report_id, status, created_at) VALUES ('v2', 'other', 'r', 'queued', ?)`).bind(T0).run()).rejects.toThrow();
  });
});

describe("traffic activity kinds", () => {
  it("have labels", () => {
    expect(describeActivity({ kind: "traffic_linked", detail: null }).title).toBe("Traffic linked");
    expect(describeActivity({ kind: "strategy_sent", detail: null }).title).toBe("Strategy memo sent");
  });
});
