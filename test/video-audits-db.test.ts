import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createVideoAudit, getVideoAudit, latestVideoFor, publishedVideoForAudit, savePlan, setVideoStatus } from "../src/worker/db/videoAudits";
import type { VideoPlan } from "../src/worker/video/plan";
import { seedBusiness } from "./fixtures/cro";
import { deleteBusiness, getBusiness } from "../src/worker/db/businesses";

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

describe("deleting a lead removes its video files", () => {
  const put = (key: string) => env.RAW.put(key, new Uint8Array([1, 2, 3]));
  const keysUnder = async (prefix: string) => (await env.RAW.list({ prefix })).objects.map((o) => o.key);

  it("deletes everything under video/<id>/ for each of the lead's videos, and nothing of anyone else's", async () => {
    const b = await seedBusiness();
    const other = await seedBusiness();
    const v1 = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-del-1" }))!;
    const v2 = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-del-2" }))!;
    const keep = (await createVideoAudit(env.DB, { businessId: other.id, auditId: "aud-del-3" }))!;
    for (const v of [v1, v2, keep]) for (const k of ["shots/d1.jpg", "shots/d1.preview.jpg", "recordings/s1-aaaa.webm", "audio/s1-bbbb.wav", "out/v1.mp4"]) await put(`video/${v.id}/${k}`);
    await put(`video/${v1.id}x/shots/neighbour.jpg`); // a prefix of another id's name must not be swept up
    await deleteBusiness(env.DB, b.id, env.RAW);
    expect(await getBusiness(env.DB, b.id)).toBeNull();
    expect(await keysUnder(`video/${v1.id}/`)).toEqual([]);
    expect(await keysUnder(`video/${v2.id}/`)).toEqual([]);
    expect(await keysUnder(`video/${keep.id}/`)).toHaveLength(5);
    expect(await keysUnder(`video/${v1.id}x/`)).toHaveLength(1);
  });

  it("deletes a video with more files than one listing page holds", async () => {
    const b = await seedBusiness();
    const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-del-4" }))!;
    const small = { list: (o: R2ListOptions) => env.RAW.list({ ...o, limit: 3 }), delete: (k: string | string[]) => env.RAW.delete(k) } as unknown as R2Bucket;
    for (let i = 0; i < 8; i++) await put(`video/${v.id}/shots/s${i}.jpg`);
    await deleteBusiness(env.DB, b.id, small);
    expect(await keysUnder(`video/${v.id}/`)).toEqual([]);
  });

  it("still deletes the lead when the storage cannot be cleaned", async () => {
    const b = await seedBusiness();
    await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-del-5" });
    const broken = { list: async () => { throw new Error("r2 down"); }, delete: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket;
    await expect(deleteBusiness(env.DB, b.id, broken)).resolves.toBeUndefined();
    expect(await getBusiness(env.DB, b.id)).toBeNull();
  });

  it("without a bucket only the database rows go", async () => {
    const b = await seedBusiness();
    const v = (await createVideoAudit(env.DB, { businessId: b.id, auditId: "aud-del-6" }))!;
    await put(`video/${v.id}/shots/d1.jpg`);
    await deleteBusiness(env.DB, b.id);
    expect(await keysUnder(`video/${v.id}/`)).toHaveLength(1);
  });
});
