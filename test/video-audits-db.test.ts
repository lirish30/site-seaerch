import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createVideoAudit, getVideoAudit, latestVideoFor, publishedVideoForAudit, savePlan, setVideoStatus } from "../src/worker/db/videoAudits";
import type { VideoPlan } from "../src/worker/video/plan";
import { seedBusiness } from "./fixtures/cro";

const plan = (): VideoPlan => ({
  shots: [{ id: "s1", viewport: "desktop", scrollY: 0, width: 1440, height: 900, fullKey: "k/full.png", previewKey: "k/p.jpg" }],
  segments: [{ id: "a", role: "hook", text: "Hello there, this is a quick look.", shotId: "s1", markups: [] }],
  narration: "clone", version: 0,
});

describe("video audits db", () => {
  it("creates a capturing video with no plan yet", async () => {
    const b = await seedBusiness();
    const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-1" }))!;
    expect(v).toMatchObject({ business_id: b.id, audit_id: "aud-1", status: "capturing", plan: null, steering_note: null, video_key: null, published_at: null });
    expect(await getVideoAudit(env.DB, v.id)).toEqual(v);
    expect(await getVideoAudit(env.DB, "missing")).toBeNull();
  });

  it("second open video for one audit returns null", async () => {
    const b = await seedBusiness();
    expect(await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-2" })).not.toBeNull();
    expect(await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-2" })).toBeNull();
    expect(await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-3" })).not.toBeNull(); // another audit is unaffected
  });

  it("a failed video frees the audit", async () => {
    const b = await seedBusiness();
    const first = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-4" }))!;
    await setVideoStatus(env.DB, first.id, "failed", { error: "capture timed out" });
    expect(await getVideoAudit(env.DB, first.id)).toMatchObject({ status: "failed", error: "capture timed out" });
    const second = await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-4" });
    expect(second).not.toBeNull();
    await setVideoStatus(env.DB, second!.id, "cancelled");
    expect(await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-4" })).not.toBeNull();
  });

  it("savePlan bumps version", async () => {
    const b = await seedBusiness();
    const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-5" }))!;
    const one = await savePlan(env.DB, v.id, plan());
    expect(one.version).toBe(1);
    expect((await getVideoAudit(env.DB, v.id))!.plan).toEqual({ ...plan(), version: 1 });
    const edited = { ...plan(), narration: "recorded" as const, version: 1 };
    const two = await savePlan(env.DB, v.id, edited);
    expect(two.version).toBe(2);
    expect((await getVideoAudit(env.DB, v.id))!.plan).toMatchObject({ narration: "recorded", version: 2 });
  });

  it("setVideoStatus patches columns and stamps published_at", async () => {
    const b = await seedBusiness();
    const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-6" }))!;
    await setVideoStatus(env.DB, v.id, "rendered", { video_key: "v.mp4", gif_key: "v.gif", poster_key: "v.jpg", duration_ms: 95_000 });
    expect(await getVideoAudit(env.DB, v.id)).toMatchObject({ status: "rendered", video_key: "v.mp4", gif_key: "v.gif", poster_key: "v.jpg", duration_ms: 95_000, published_at: null });
    const p = (await setVideoStatus(env.DB, v.id, "published", { publish_approval_id: "appr-1" }))!;
    expect(p.status).toBe("published");
    expect(p.publish_approval_id).toBe("appr-1");
    expect(p.published_at).toMatch(/^\d{4}-/);
    expect(p.video_key).toBe("v.mp4"); // an unmentioned column keeps its value
  });

  it("latestVideoFor and publishedVideoForAudit pick the right rows", async () => {
    const b = await seedBusiness();
    expect(await latestVideoFor(env.DB, b.id)).toBeNull();
    const old = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-7" }))!;
    await setVideoStatus(env.DB, old.id, "published");
    const newer = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-8" }))!;
    expect((await latestVideoFor(env.DB, b.id))!.id).toBe(newer.id);
    expect(await publishedVideoForAudit(env.DB, "aud-8")).toBeNull();
    expect((await publishedVideoForAudit(env.DB, "aud-7"))!.id).toBe(old.id);
  });
});
