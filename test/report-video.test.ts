import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicReport } from "../src/worker/care/reportPublic";
import { cancel, insertReport, markSent, revoke, setSummary, getReport, type CareReport } from "../src/worker/db/careReports";
import { getVideoFor, insertVideo, finishVideo, failVideo, resetVideo } from "../src/worker/db/reportVideos";
import { cancelSeoReport, getSeoReport, insertSeoReport, markSeoSent, revokeSeoReport, setSeoSummary } from "../src/worker/db/seoReports";
import { newClientToken } from "../src/worker/documents/token";
import type { Env } from "../src/worker/env";
import { createDevice } from "../src/worker/helper/auth";
import { claimHelperJob, completeHelperJob, expireOldHelperJobs, failHelperJob } from "../src/worker/helper/jobs";
import { HelperRefused, REPORT_RENDER_KIND, ReportRenderPayload, getHelperKind, reportVideoKeys } from "../src/worker/helper/kinds";
import worker from "../src/worker/index";
import * as approvalMod from "../src/worker/approvals/careReport";
import * as seoApprovalMod from "../src/worker/approvals/seoReport";
import { completeTask } from "../src/worker/queue/db";
import { queueReport } from "../src/worker/queue/careReport";
import { queueSeoReport } from "../src/worker/queue/seoReport";
import "../src/worker/queue/kinds";
import { applyReportVideo, enqueueReportVideo, retryReportVideo } from "../src/worker/report/videoJob";
import * as videoJobMod from "../src/worker/report/videoJob";
import { buildScenes } from "../src/worker/report/videoScenes";
import { publicSeoReport } from "../src/worker/seo/reportPublic";
import { claimById } from "./fixtures/draftTask";
import { seedClient } from "./fixtures/clients";

const e = env as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOW = "2026-12-01T10:00:00.000Z";
const SENT_AT = "2026-12-02T03:30:00.000Z";
const SUMMARY = "SECRET-SUMMARY-WORDS the site did well.";
const RECOMMENDATION = "SECRET-RECOMMENDATION-WORDS do more.";
const PRIORITIES = ["SECRET-PRIORITY-ONE", "SECRET-PRIORITY-TWO", "SECRET-PRIORITY-THREE"];
const NOT_FOUND = { error: "not found" };

const site = (domain: string, over: Record<string, unknown> = {}) => ({
  domain, monitoredSince: "2026-10-03", uptimePercent: 99.9, coveredDays: 30, incidents: 0, longestOutageMinutes: null,
  updatesApplied: 4, updatesRolledBack: 0, updatesFailed: 0, updatesTracked: true, backups: 2, speedScore: 81, ...over,
});
const TRAFFIC = {
  version: 1, period: "2026-11",
  search: {
    clicks: 1234, impressions: 40_000, position: 8.2, previousClicks: 1000, previousImpressions: 30_000,
    queries: [{ query: "SECRET-QUERY emergency plumber", clicks: 50, impressions: 900 }], pages: [{ path: "/secret-page-path", clicks: 40 }],
  },
  visits: {
    sessions: 5678, users: 4000, organic: 2000, keyEvents: 12, previousSessions: 5000, previousOrganic: 1800,
    channels: [{ channel: "SECRET-CHANNEL Direct", sessions: 3000 }],
  },
  profile: null,
};
const careFacts = (over: Record<string, unknown> = {}) => ({
  version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T08:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Acme Dental",
  sites: [site("acme-dental.example"), site("shop.acme-dental.example", { uptimePercent: 99.5, backups: 1 })],
  edits: null, renewals: [], traffic: TRAFFIC, generatedAt: NOW, ...over,
});
const nine = (top: number) => Array.from({ length: 9 }, (_, i) => ({ pos: i < top ? 2 : 9, ok: true }));
const seoFacts = (over: Record<string, unknown> = {}) => ({
  version: 1, period: "2026-11", label: "November 2026", clientName: "Ace Plumbing", rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01",
  terms: [
    { term: "SECRET-TERM drain cleaning", town: "Tigard", points: nine(5), measured: 9, visible: 5, previousVisible: 2 },
    { term: "water heater repair", town: null, points: nine(3).slice(0, 6), measured: 6, visible: null, previousVisible: null },
  ],
  gbp: { rating: 4.7, reviewCount: 43, reviewsGained: 3, ratingChange: 0.2 }, reviews: { seen: 3, posted: 2, needsYou: 1 },
  content: { published: [{ kind: "page", title: "SECRET-TITLE Drain cleaning in Tigard" }], drafted: 1, planned: 1 }, citations: null, nap: null,
  traffic: TRAFFIC, generatedAt: NOW, ...over,
});

type Kind = "care" | "seo";
let seq = 0;
/** A report of either kind in the given status, with its words stored the way Claude's task would have. */
async function seed(kind: Kind, o: { status?: "collecting" | "ready" | "sent" | "revoked" | "cancelled"; facts?: unknown } = {}) {
  const s = await seedClient();
  const token = newClientToken();
  const status = o.status ?? "sent";
  seq += 1;
  if (kind === "care") {
    const { report } = await insertReport(env.DB, { businessId: s.businessId, period: "2026-11", token, facts: o.facts ?? careFacts(), test: false, now: NOW });
    if (status !== "collecting" && status !== "cancelled") await setSummary(env.DB, report.id, ["collecting"], { summary: SUMMARY, recommendation: RECOMMENDATION, source: "claude", now: NOW });
    if (status === "sent" || status === "revoked") await markSent(env.DB, report.id, SENT_AT);
    if (status === "revoked") await revoke(env.DB, report.id, NOW);
    if (status === "cancelled") await cancel(env.DB, report.id);
    return { id: report.id, token };
  }
  const { report } = await insertSeoReport(env.DB, { businessId: s.businessId, period: "2026-11", token, facts: o.facts ?? seoFacts(), test: false, now: NOW });
  if (status !== "collecting" && status !== "cancelled") await setSeoSummary(env.DB, report.id, ["collecting"], { summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, source: "claude", now: NOW });
  if (status === "sent" || status === "revoked") await markSeoSent(env.DB, report.id, SENT_AT);
  if (status === "revoked") await revokeSeoReport(env.DB, report.id, NOW);
  if (status === "cancelled") await cancelSeoReport(env.DB, report.id);
  return { id: report.id, token };
}

const jobsOf = async () => (await env.DB.prepare(`SELECT * FROM helper_jobs WHERE kind = ? ORDER BY created_at, id`).bind(REPORT_RENDER_KIND).all<Record<string, any>>()).results;
const put = async (...keys: string[]) => { for (const k of keys) await env.RAW.put(k, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])); };
const route = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://x/api/public${path}`, { headers }), e as never, ctx);

let device = "";
beforeEach(async () => {
  await env.DB.batch(["helper_jobs", "helper_devices", "report_videos", "care_reports", "seo_reports", "claude_tasks"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`UPDATE settings SET your_name = 'Logan Irish', business_name = 'Siteline' WHERE id = 1`).run();
  device = (await createDevice(env.DB, "Mac A")).device.id;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("buildScenes", () => {
  it("buildScenes for a care report omits a scene whose number is null and never exceeds 6 scenes", () => {
    const full = buildScenes("care", careFacts() as never);
    expect(full.length).toBeLessThanOrEqual(6);
    expect(full[0]).toEqual({ title: "Acme Dental", big: "November 2026", small: "Your monthly report" });
    expect(full.at(-1)).toMatchObject({ title: "Acme Dental", big: "Thank you" });
    // up to four middle scenes, in order: uptime, updates, backups, search clicks (visits are the fifth and left out)
    expect(full.map((s) => s.big)).toEqual(["November 2026", "99.5%", "8", "3", "1,234", "Thank you"]);
    expect(full.find((s) => s.big === "1,234")!.small).toContain("counted by Google");

    // no uptime figure measured: that scene is left out and the next ones come in; nothing is shown as 0 or 100%
    const noUptime = buildScenes("care", careFacts({ sites: [site("a.example", { uptimePercent: null, monitoredSince: null, coveredDays: 0 })] }) as never);
    expect(noUptime.some((s) => /%/.test(s.big))).toBe(false);
    expect(noUptime.map((s) => s.big)).toEqual(["November 2026", "4", "2", "1,234", "5,678", "Thank you"]);

    // a site no update run covered says nothing about updates or backups
    const untracked = buildScenes("care", careFacts({ sites: [site("a.example", { updatesTracked: false })], traffic: null }) as never);
    expect(untracked.map((s) => s.big)).toEqual(["November 2026", "99.9%", "Thank you"]);

    // visits count when there are no search clicks
    const visitsOnly = buildScenes("care", careFacts({ sites: [site("a.example", { uptimePercent: null, updatesTracked: false })], traffic: { ...TRAFFIC, search: null } }) as never);
    expect(visitsOnly.map((s) => s.big)).toEqual(["November 2026", "5,678", "Thank you"]);
    expect(visitsOnly.find((s) => s.big === "5,678")!.small).toContain("counted by Google");
  });

  it("the uptime scene says when a site was only watched part of the month", () => {
    const up = (sites: unknown[]) => buildScenes("care", careFacts({ sites, traffic: null }) as never).find((x) => x.big.endsWith("%"));
    // watched all month: the plain line
    expect(up([site("a.example", { uptimePercent: 100, monitoredSince: "2026-10-03", coveredDays: 30 })])).toEqual({ title: "Your site stayed up", big: "100%", small: "Of the time this month, as measured by our monitoring" });
    // watched from the 27th: four days, said so
    const late = up([site("a.example", { uptimePercent: 100, monitoredSince: "2026-11-27", coveredDays: 4 })])!;
    expect(late.big).toBe("100%");
    expect(late.small).toBe("Of the time we checked this month (4 days), as measured by our monitoring");
    // one day reads as a day
    expect(up([site("a.example", { monitoredSince: "2026-11-30", coveredDays: 1 })])!.small).toContain("(1 day)");
    // two sites: the lowest figure and the smaller number of days
    const two = up([site("a.example", { uptimePercent: 99.9, monitoredSince: "2026-10-03", coveredDays: 30 }), site("b.example", { uptimePercent: 98.2, monitoredSince: "2026-11-20", coveredDays: 11 })])!;
    expect(two.big).toBe("98.2%");
    expect(two.small).toContain("(11 days)");
    expect(two.small).toContain("lowest of your sites");
    // fewer covered days than the month has, even if the first day is not after the 1st
    expect(up([site("a.example", { monitoredSince: "2026-10-03", coveredDays: 25 })])!.small).toContain("(25 days)");
    // M4: the figure and the days come from the SAME site, the lowest one: a full-month site at 98.2 beside a newer, higher one says "this month", not the newer one's days
    const same = up([site("a.example", { uptimePercent: 98.2, monitoredSince: "2026-10-03", coveredDays: 30 }), site("b.example", { uptimePercent: 99.9, monitoredSince: "2026-11-20", coveredDays: 11 })])!;
    expect(same.big).toBe("98.2%");
    expect(same.small).toBe("Of the time this month at the lowest of your sites, as measured by our monitoring");
    // a tie on the figure takes the site watched for fewer days
    const tie = up([site("a.example", { uptimePercent: 99, monitoredSince: "2026-10-03", coveredDays: 30 }), site("b.example", { uptimePercent: 99, monitoredSince: "2026-11-20", coveredDays: 11 })])!;
    expect(tie.small).toContain("(11 days)");
    // M3: a measured 0% is a zero, and a zero never gets a scene (the next numbers come in instead)
    expect(up([site("a.example", { uptimePercent: 0, monitoredSince: "2026-10-03", coveredDays: 30 })])).toBeUndefined();
    expect(up([site("a.example", { uptimePercent: 0 }), site("b.example", { uptimePercent: 99.9 })])).toBeUndefined();
    // not measured, or no date to tell by: no scene
    expect(up([site("a.example", { uptimePercent: null, monitoredSince: null, coveredDays: 0 })])).toBeUndefined();
    expect(up([site("a.example", { uptimePercent: 99.9, monitoredSince: null, coveredDays: 30 })])).toBeUndefined();
  });

  it("a rank of 0 points in the top 3 gets no scene, like every other zero", () => {
    const zero = seoFacts({ terms: [{ term: "t", town: null, points: nine(0), measured: 9, visible: 0, previousVisible: 1 }], gbp: { rating: 4.7, reviewCount: 43, reviewsGained: 0, ratingChange: null } });
    expect(buildScenes("seo", zero as never).map((x) => x.big)).toEqual(["November 2026", "1,234", "5,678", "Thank you"]);
  });

  it("buildScenes returns nothing when fewer than three scenes can be built", () => {
    expect(buildScenes("care", careFacts({ sites: [], traffic: null }) as never)).toEqual([]);
    expect(buildScenes("care", careFacts({ sites: [site("a.example", { uptimePercent: null, updatesTracked: false })], traffic: null }) as never)).toEqual([]);
    expect(buildScenes("seo", seoFacts({ rankAsOf: null, gbp: { rating: null, reviewCount: null, reviewsGained: null, ratingChange: null }, traffic: null }) as never)).toEqual([]);
  });

  it("buildScenes for a Local SEO report says the rank in our own words, and leaves out what was not measured", () => {
    const s = buildScenes("seo", seoFacts() as never);
    expect(s.map((x) => x.big)).toEqual(["November 2026", "5 of 9", "3", "1,234", "5,678", "Thank you"]);
    expect(s[1]).toMatchObject({ big: "5 of 9", small: "points in the top 3 in our check" });
    expect(s[0]).toEqual({ title: "Ace Plumbing", big: "November 2026", small: "Your monthly report" });
    // no usable check: no rank scene; no review gain: none either
    const none = buildScenes("seo", seoFacts({ rankAsOf: null, gbp: { rating: 4.7, reviewCount: 43, reviewsGained: null, ratingChange: null } }) as never);
    expect(none.map((x) => x.big)).toEqual(["November 2026", "1,234", "5,678", "Thank you"]);
  });

  it("buildScenes holds no text from summary or recommendation", () => {
    const care = careFacts({ summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, domainNote: "SECRET-NOTE" });
    const seo = seoFacts({ summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, reviewText: "SECRET-REVIEW-TEXT" });
    for (const [kind, facts] of [["care", care], ["seo", seo]] as const) {
      const text = JSON.stringify(buildScenes(kind, facts as never));
      expect(text.length).toBeGreaterThan(50);
      expect(text).not.toMatch(/SECRET/);
      // no query, page, channel, domain, term, content title or link either
      expect(text).not.toMatch(/https?:|www\.|\.example|@|emergency|Tigard|drain/i);
    }
    for (const s of buildScenes("care", careFacts() as never)) {
      expect(s.title.length).toBeLessThanOrEqual(80);
      expect(s.big.length).toBeLessThanOrEqual(40);
      expect(s.small.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("the helper kind", () => {
  const scenes = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, big: `B${i}`, small: `S${i}` }));
  const keys = reportVideoKeys("care", "r1");

  it("reportVideoKeys names the two files of a report", () => {
    expect(keys).toEqual({ mp4: "report-video/care/r1/v1.mp4", jpg: "report-video/care/r1/v1.jpg" });
  });

  it("checks the payload: 1 to 6 scenes, capped text, a brand, exactly two output keys", () => {
    const ok = { videoId: "v1", scenes: scenes(3), brand: { name: "Siteline" }, outputs: [keys.mp4, keys.jpg] };
    expect(ReportRenderPayload.safeParse(ok).success).toBe(true);
    expect(ReportRenderPayload.safeParse({ ...ok, scenes: scenes(6) }).success).toBe(true);
    expect(ReportRenderPayload.safeParse({ ...ok, scenes: scenes(7) }).success).toBe(false);
    expect(ReportRenderPayload.safeParse({ ...ok, scenes: [] }).success).toBe(false);
    expect(ReportRenderPayload.safeParse({ ...ok, scenes: [{ title: "x".repeat(81), big: "b", small: "s" }] }).success).toBe(false);
    expect(ReportRenderPayload.safeParse({ ...ok, scenes: [{ title: "t", big: "x".repeat(41), small: "s" }] }).success).toBe(false);
    expect(ReportRenderPayload.safeParse({ ...ok, scenes: [{ title: "t", big: "b", small: "x".repeat(121) }] }).success).toBe(false);
    expect(ReportRenderPayload.safeParse({ ...ok, brand: { name: "x".repeat(81) } }).success).toBe(false);
    expect(ReportRenderPayload.safeParse({ ...ok, outputs: [keys.mp4] }).success).toBe(false);
    expect(ReportRenderPayload.safeParse({ ...ok, outputs: ["somewhere/else.mp4", "somewhere/else.jpg"] }).success).toBe(false);
  });

  it("reads nothing and may write only the two files", () => {
    const def = getHelperKind(REPORT_RENDER_KIND)!;
    const p = { videoId: "v1", scenes: scenes(3), brand: { name: "Siteline" }, outputs: [keys.mp4, keys.jpg] };
    expect(def.inputs(p)).toEqual([]);
    expect(def.outputs(p)).toEqual([keys.mp4, keys.jpg]);
  });
});

describe("enqueueReportVideo", () => {
  it("enqueueReportVideo twice makes one job", async () => {
    const r = await seed("care", { status: "ready" });
    await enqueueReportVideo(e, "care", r.id);
    await enqueueReportVideo(e, "care", r.id);
    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "report.render", status: "pending", dedupe_key: `care:${r.id}` });
    const video = (await getVideoFor(env.DB, "care", r.id))!;
    expect(video.status).toBe("queued");
    const p = JSON.parse(jobs[0].payload);
    expect(p).toMatchObject({ videoId: video.id, brand: { name: "Siteline" }, outputs: [`report-video/care/${r.id}/v1.mp4`, `report-video/care/${r.id}/v1.jpg`] });
    expect(p.scenes[0]).toEqual({ title: "Acme Dental", big: "November 2026", small: "Your monthly report" });
    // nothing Claude wrote, and no search term, page or channel, is in the job
    expect(jobs[0].payload).not.toMatch(/SECRET/);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM report_videos`).first<{ n: number }>())!.n).toBe(1);
  });

  it("makes one video for a Local SEO report too, and its own job", async () => {
    const r = await seed("seo", { status: "ready" });
    await enqueueReportVideo(e, "seo", r.id);
    await enqueueReportVideo(e, "seo", r.id);
    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupe_key).toBe(`seo:${r.id}`);
    expect(JSON.parse(jobs[0].payload).outputs).toEqual([`report-video/seo/${r.id}/v1.mp4`, `report-video/seo/${r.id}/v1.jpg`]);
    expect(jobs[0].payload).not.toMatch(/SECRET/);
  });

  it("does nothing for a report with too little to show, one that is gone, or numbers that cannot be read", async () => {
    const thin = await seed("care", { status: "ready", facts: careFacts({ sites: [], traffic: null }) });
    await enqueueReportVideo(e, "care", thin.id);
    const bad = await seed("seo", { status: "ready", facts: { nonsense: true } });
    await enqueueReportVideo(e, "seo", bad.id);
    await enqueueReportVideo(e, "care", "no-such-report");
    expect(await jobsOf()).toEqual([]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM report_videos`).first<{ n: number }>())!.n).toBe(0);
  });

  it("a plain enqueue never retries a failed video, but a deliberate retry does, once", async () => {
    const r = await seed("care", { status: "ready" });
    await enqueueReportVideo(e, "care", r.id);
    const video = (await getVideoFor(env.DB, "care", r.id))!;
    await failVideo(env.DB, video.id, "The report video could not be made.");
    await enqueueReportVideo(e, "care", r.id);
    expect(await getVideoFor(env.DB, "care", r.id)).toMatchObject({ status: "failed" });
    expect(await jobsOf()).toHaveLength(1);

    expect(await retryReportVideo(e, "care", r.id)).toBe(true);
    expect(await getVideoFor(env.DB, "care", r.id)).toMatchObject({ status: "queued" });
    expect((await jobsOf()).filter((j) => j.status === "pending")).toHaveLength(1);
    // a video that is not failed is not retried
    expect(await retryReportVideo(e, "care", r.id)).toBe(false);
    expect(await retryReportVideo(e, "care", "no-such-report")).toBe(false);
    expect((await jobsOf()).filter((j) => j.status === "pending")).toHaveLength(1);
  });
});

describe("resetVideo", () => {
  it("moves a failed video back to queued and nothing else", async () => {
    const a = (await insertVideo(env.DB, { kind: "care", reportId: "rv1", now: NOW })).video;
    expect(await resetVideo(env.DB, a.id)).toBe(false); // queued
    await failVideo(env.DB, a.id, "it broke");
    expect(await resetVideo(env.DB, a.id)).toBe(true);
    expect(await getVideoFor(env.DB, "care", "rv1")).toMatchObject({ status: "queued", error: "" });
    expect(await resetVideo(env.DB, a.id)).toBe(false); // queued again
    expect(await finishVideo(env.DB, a.id, { videoKey: "v.mp4", posterKey: "p.jpg", durationMs: 1000 })).toBe(true);
    expect(await resetVideo(env.DB, a.id)).toBe(false); // rendered
    const d = (await insertVideo(env.DB, { kind: "seo", reportId: "rv2", now: NOW })).video;
    await env.DB.prepare(`UPDATE report_videos SET status = 'discarded' WHERE id = ?`).bind(d.id).run();
    expect(await resetVideo(env.DB, d.id)).toBe(false);
    expect(await resetVideo(env.DB, "no-such-video")).toBe(false);
  });
});

describe("applying a rendered video", () => {
  async function queued(kind: Kind = "care") {
    const r = await seed(kind, { status: "ready" });
    await enqueueReportVideo(e, kind, r.id);
    const job = (await claimHelperJob(env.DB, device, new Date(), [REPORT_RENDER_KIND]))!;
    const k = reportVideoKeys(kind, r.id);
    return { r, job, k, result: { videoKey: k.mp4, posterKey: k.jpg, durationMs: 36_000 } };
  }

  it("applying a result with other keys is refused", async () => {
    const { r, job, k, result } = await queued();
    await put(k.mp4, k.jpg, "report-video/care/other/v1.mp4", "elsewhere/poster.jpg");
    const payload = job.payload as never;
    await expect(applyReportVideo(e, payload, { ...result, videoKey: "report-video/care/other/v1.mp4" })).rejects.toBeInstanceOf(HelperRefused);
    await expect(applyReportVideo(e, payload, { ...result, posterKey: "elsewhere/poster.jpg" })).rejects.toBeInstanceOf(HelperRefused);
    await expect(applyReportVideo(e, payload, { ...result, videoKey: k.jpg, posterKey: k.mp4 })).rejects.toBeInstanceOf(HelperRefused);
    // and through the queue: the job stays claimed with the reason, the video stays queued
    const refused = await completeHelperJob(e, job.id, device, { ...result, videoKey: "report-video/care/other/v1.mp4" });
    expect(refused).toMatchObject({ ok: false });
    expect((await getVideoFor(env.DB, "care", r.id))!.status).toBe("queued");
  });

  it("refuses a file that was never uploaded", async () => {
    const { r, job, k, result } = await queued();
    await put(k.mp4); // the poster is missing
    await expect(applyReportVideo(e, job.payload as never, result)).rejects.toThrow(/never uploaded/);
    expect((await getVideoFor(env.DB, "care", r.id))!.status).toBe("queued");
  });

  it("a good result makes the video rendered, once, through the queue", async () => {
    const { r, job, k, result } = await queued("seo");
    await put(k.mp4, k.jpg);
    expect(await completeHelperJob(e, job.id, device, result)).toEqual({ ok: true });
    expect(await getVideoFor(env.DB, "seo", r.id)).toMatchObject({ status: "rendered", videoKey: k.mp4, posterKey: k.jpg, durationMs: 36_000 });
    // a video that is no longer queued is left alone
    await applyReportVideo(e, job.payload as never, { ...result, durationMs: 1 });
    expect((await getVideoFor(env.DB, "seo", r.id))!.durationMs).toBe(36_000);
  });

  it("leaves a discarded video alone", async () => {
    const { r, job, k, result } = await queued();
    await put(k.mp4, k.jpg);
    await env.DB.prepare(`UPDATE report_videos SET status = 'discarded' WHERE report_id = ?`).bind(r.id).run();
    await applyReportVideo(e, job.payload as never, result);
    expect(await getVideoFor(env.DB, "care", r.id)).toMatchObject({ status: "discarded", videoKey: null });
  });

  it("a job the helper gave up on fails the video with a plain sentence, as does one nobody picked up", async () => {
    const a = await queued();
    expect(await failHelperJob(e, a.job.id, device, "hyperframes exited with code 1: Chrome not found")).toBe(true);
    const failed = (await getVideoFor(env.DB, "care", a.r.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/video could not be made/i);

    const b = await seed("seo", { status: "ready" });
    await enqueueReportVideo(e, "seo", b.id);
    expect(await expireOldHelperJobs(e, new Date(Date.now() + 30 * 86_400_000))).toBe(1);
    expect(await getVideoFor(env.DB, "seo", b.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/Mac helper/) });
  });
});

describe("the video route", () => {
  const url = (kind: Kind, token: string) => `/${kind === "care" ? "m" : "l"}/${token}/video.mp4`;
  async function rendered(kind: Kind, status: "sent" | "ready" | "collecting" | "revoked" | "cancelled" = "sent") {
    const r = await seed(kind, { status });
    const v = (await insertVideo(env.DB, { kind, reportId: r.id, now: NOW })).video;
    const k = reportVideoKeys(kind, r.id);
    await env.RAW.put(k.mp4, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    await finishVideo(env.DB, v.id, { videoKey: k.mp4, posterKey: k.jpg, durationMs: 36_000 });
    return { ...r, v, k };
  }

  it("the video route is 404 for a report that is not sent and for an unrendered video", async () => {
    for (const kind of ["care", "seo"] as const) {
      // not sent (or no longer live), even with a rendered video: exactly the answer an unknown token gets
      const unknown = await route(url(kind, newClientToken()));
      const unknownBody = await unknown.text();
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknownBody)).toEqual(NOT_FOUND);
      for (const status of ["collecting", "ready", "revoked", "cancelled"] as const) {
        const notLive = await rendered(kind, status);
        const r1 = await route(url(kind, notLive.token));
        expect(r1.status, `${kind} ${status}`).toBe(unknown.status);
        expect(r1.headers.get("content-type"), `${kind} ${status}`).toBe(unknown.headers.get("content-type"));
        expect(await r1.text(), `${kind} ${status}`).toBe(unknownBody);
      }

      // sent, but the video is queued / failed / discarded / missing
      for (const state of ["queued", "failed", "discarded", "none"] as const) {
        const r = await seed(kind);
        if (state !== "none") {
          const v = (await insertVideo(env.DB, { kind, reportId: r.id, now: NOW })).video;
          if (state === "failed") await failVideo(env.DB, v.id, "broke");
          if (state === "discarded") await env.DB.prepare(`UPDATE report_videos SET status = 'discarded' WHERE id = ?`).bind(v.id).run();
        }
        const res = await route(url(kind, r.token));
        expect(res.status, `${kind} ${state}`).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }

      // an unknown and a malformed token are the same 404
      expect((await route(url(kind, newClientToken()))).status).toBe(404);
      expect((await route(url(kind, "short"))).status).toBe(404);
    }
    // a Care token on the SEO route (and the other way round) is a stranger too
    const care = await rendered("care");
    expect((await route(url("seo", care.token))).status).toBe(404);
    const seo = await rendered("seo");
    expect((await route(url("care", seo.token))).status).toBe(404);
  });

  it("streams a rendered video of a sent report, whole and by byte range", async () => {
    for (const kind of ["care", "seo"] as const) {
      const r = await rendered(kind);
      const whole = await route(url(kind, r.token));
      expect(whole.status).toBe(200);
      expect(whole.headers.get("content-type")).toBe("video/mp4");
      expect(whole.headers.get("accept-ranges")).toBe("bytes");
      expect(whole.headers.get("x-robots-tag")).toMatch(/noindex/);
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
      const part = await route(url(kind, r.token), { range: "bytes=2-5" });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]));
      expect((await route(url(kind, r.token), { range: "bytes=50-" })).status).toBe(416);
    }
  });

  it("the public report says video true only when the file would stream", async () => {
    const care = await seed("care");
    const seo = await seed("seo");
    expect((await publicReport(e, care.token, new Date(), { countView: false }))!.video).toBe(false);
    expect((await publicSeoReport(e, seo.token, new Date(), { countView: false }))!.video).toBe(false);
    for (const [kind, r] of [["care", care], ["seo", seo]] as const) {
      const v = (await insertVideo(env.DB, { kind, reportId: r.id, now: NOW })).video;
      await finishVideo(env.DB, v.id, { videoKey: reportVideoKeys(kind, r.id).mp4, posterKey: reportVideoKeys(kind, r.id).jpg, durationMs: 1 });
    }
    const c = (await publicReport(e, care.token, new Date(), { countView: false }))!;
    const s = (await publicSeoReport(e, seo.token, new Date(), { countView: false }))!;
    expect(c.video).toBe(true);
    expect(s.video).toBe(true);
    // never the key
    expect(JSON.stringify(c) + JSON.stringify(s)).not.toMatch(/report-video/);
  });
});

describe("storing a report's words queues its video", () => {
  const standIn = async () => "approval-1";
  beforeEach(() => {
    vi.spyOn(approvalMod, "proposeReportApproval").mockImplementation(standIn as never);
    vi.spyOn(seoApprovalMod, "proposeSeoReportApproval").mockImplementation(standIn as never);
  });
  const GOOD_CARE = { summary: "The site was up almost all month.", recommendation: "Look at why the shop site went down twice." };
  const GOOD_SEO = { ...GOOD_CARE, priorities: ["Answer the one low review", "Fix the address", "Publish the page"] };

  it("after Claude's words are stored, one video job is queued (Care and Local SEO)", async () => {
    const care = await seed("care", { status: "collecting" });
    await queueReport(env, care.id);
    const t1 = await claimById((await env.DB.prepare(`SELECT id FROM claude_tasks WHERE kind = 'care.report' AND target_id = ?`).bind(care.id).first<{ id: string }>())!.id);
    expect(await completeTask(env, t1.id, GOOD_CARE)).toEqual({ ok: true });
    const seo = await seed("seo", { status: "collecting" });
    await queueSeoReport(env, seo.id);
    const t2 = await claimById((await env.DB.prepare(`SELECT id FROM claude_tasks WHERE kind = 'seo.report' AND target_id = ?`).bind(seo.id).first<{ id: string }>())!.id);
    expect(await completeTask(env, t2.id, GOOD_SEO)).toEqual({ ok: true });
    expect((await jobsOf()).map((j) => j.dedupe_key).sort()).toEqual([`care:${care.id}`, `seo:${seo.id}`].sort());
  });

  it("a failing enqueue does not fail storing the report's words", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(videoJobMod, "enqueueReportVideo").mockRejectedValue(new Error("the video queue is down"));
    const care = await seed("care", { status: "collecting" });
    await queueReport(env, care.id);
    const t1 = await claimById((await env.DB.prepare(`SELECT id FROM claude_tasks WHERE kind = 'care.report' AND target_id = ?`).bind(care.id).first<{ id: string }>())!.id);
    expect(await completeTask(env, t1.id, GOOD_CARE)).toEqual({ ok: true });
    const done: CareReport = (await getReport(env.DB, care.id))!;
    expect(done).toMatchObject({ status: "ready", summary: GOOD_CARE.summary, approvalId: "approval-1" });

    const seo = await seed("seo", { status: "collecting" });
    await queueSeoReport(env, seo.id);
    const t2 = await claimById((await env.DB.prepare(`SELECT id FROM claude_tasks WHERE kind = 'seo.report' AND target_id = ?`).bind(seo.id).first<{ id: string }>())!.id);
    expect(await completeTask(env, t2.id, GOOD_SEO)).toEqual({ ok: true });
    expect(await getSeoReport(env.DB, seo.id)).toMatchObject({ status: "ready", summary: GOOD_SEO.summary, approvalId: "approval-1" });
    expect(log).toHaveBeenCalled();
    expect(await jobsOf()).toEqual([]);
  });
});
