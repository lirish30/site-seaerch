import { env } from "cloudflare:test";
import { insertAudit } from "../../src/worker/db/audits";
import { createVideoAudit, getVideoAudit, savePlan, setVideoStatus } from "../../src/worker/db/videoAudits";
import { ensureReport } from "../../src/worker/db/reports";
import type { Segment, VideoPlan } from "../../src/worker/video/plan";
import { seedBusiness } from "./cro";

const FINDINGS = [
  { code: "no_https", category: "technical", severity: "critical", points: 15, evidence: "no padlock", recommendation: "Add HTTPS", source: "rule" },
] as const;

export const insertTestAudit = (businessId: string) => insertAudit(env.DB, {
  business_id: businessId, site_status: "ok", partial: false, pagespeed_mobile: 60, lcp_ms: null, cls: null, mobile_friendly: true,
  https: false, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
  score: 70, offer: "seo_basics", findings: FINDINGS as any, raw_r2_key: null, health_score: 50, niche: "trades", category_scores: {}, ai_review: null,
  screenshots: { desktop: null, mobile: null }, site_links: {}, platform: null, seo_score: null, accessibility_score: null, mail_warning: null,
});

export const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** The bytes of the rendered "video": 0, 1, 2 ... 99, so a range can be checked by value. */
export const VIDEO_BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);

const segs = (source: "clone" | "recorded"): Segment[] => [
  { id: "s1", role: "hook", text: "This is the first line of the script.", shotId: "d1", markups: [], audio: { key: "video/x/a.wav", source, durationMs: 4000, textHash: "aaaaaaaa" } },
  { id: "s2", role: "cta", text: "Book a call and we will fix it.", shotId: "d1", markups: [], audio: { key: "video/x/b.wav", source: "recorded", durationMs: 3000, textHash: "bbbbbbbb" } },
];

/** A lead with an audit, a video that has been rendered (its files are in R2) and a live report link for the audit. */
export async function renderedVideo(o: { source?: "clone" | "recorded"; name?: string } = {}) {
  const b = await seedBusiness({ name: o.name });
  const audit = await insertTestAudit(b.id);
  const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: audit.id }))!;
  const plan: VideoPlan = {
    shots: [{ id: "d1", viewport: "desktop", scrollY: 0, width: 1280, height: 720, fullKey: `video/${v.id}/shots/d1.jpg`, previewKey: `video/${v.id}/shots/d1.preview.jpg` }],
    segments: segs(o.source ?? "clone"), narration: "clone", version: 0,
  };
  await savePlan(env.DB, v.id, plan);
  const keys = { video_key: `video/${v.id}/out/video.mp4`, gif_key: `video/${v.id}/out/preview.gif`, poster_key: `video/${v.id}/out/poster.jpg` };
  await env.RAW.put(keys.video_key, VIDEO_BYTES, { httpMetadata: { contentType: "video/mp4" } });
  await env.RAW.put(keys.gif_key, new Uint8Array([71, 73, 70]), { httpMetadata: { contentType: "image/gif" } });
  await env.RAW.put(keys.poster_key, new Uint8Array([255, 216, 255]), { httpMetadata: { contentType: "image/jpeg" } });
  await setVideoStatus(env.DB, v.id, "rendered", { ...keys, duration_ms: 95_000 });
  const report = await ensureReport(env.DB, b.id, audit.id);
  return { b, audit, v: (await getVideoAudit(env.DB, v.id))!, token: report.token, keys };
}
