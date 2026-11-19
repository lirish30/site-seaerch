import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import "../src/worker/approvals/videoPublish";
import { createPublishApproval } from "../src/worker/approvals/videoPublish";
import { approve, reject } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { createApproval } from "../src/worker/db/approvals";
import { addSuppression } from "../src/worker/db/suppression";
import { getVideoAudit, setVideoStatus } from "../src/worker/db/videoAudits";
import { publicReport } from "../src/worker/db/reports";
import { enqueueHelperJob } from "../src/worker/helper/jobs";
import "../src/worker/helper/kinds";
import { insertTestAudit, renderedVideo, wait } from "./fixtures/video";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["suppressions", "do_not_contact", "helper_jobs", "approvals"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const approvalOf = async (videoId: string) => {
  const v = (await getVideoAudit(env.DB, videoId))!;
  return (await env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(v.publish_approval_id).first<any>())!;
};

describe("video.publish approval", () => {
  it("createPublishApproval stores the approval with the lead, the duration and the script in its preview", async () => {
    const { b, v } = await renderedVideo({ name: "Ace Plumbing" });
    await createPublishApproval(env, v.id);
    const a = await approvalOf(v.id);
    expect(a).toMatchObject({ kind: "video.publish", status: "pending", record_type: "lead", record_id: b.id });
    expect(JSON.parse(a.payload)).toEqual({ videoId: v.id });
    expect(a.title).toContain("Ace Plumbing");
    expect(a.preview).toContain("Ace Plumbing");
    expect(a.preview).toContain("1:35"); // 95 seconds
    expect(a.preview).toContain("This is the first line of the script.");
    // a second call while one is waiting makes no second approval
    await createPublishApproval(env, v.id);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'video.publish'`).first<any>()).n).toBe(1);
  });

  it("execute publishes a rendered video", async () => {
    const { v, audit, token } = await renderedVideo();
    await createPublishApproval(env, v.id);
    const a = await approvalOf(v.id);
    expect((await approve(env, a.id)).ok).toBe(true);
    const after = (await getVideoAudit(env.DB, v.id))!;
    expect(after.status).toBe("published");
    expect(after.published_at).not.toBeNull();
    const report = await publicReport(env.DB, token);
    expect(report?.video).toEqual({ durationMs: 95_000, aiVoiceNote: true });
    expect(audit.id).toBe(after.audit_id);
  });

  it("execute twice publishes once", async () => {
    const { v } = await renderedVideo();
    await createPublishApproval(env, v.id);
    const a = await approvalOf(v.id);
    const h = getHandler("video.publish")!;
    await h.execute(env, { videoId: v.id }, a);
    const first = (await getVideoAudit(env.DB, v.id))!;
    await wait(10);
    await h.execute(env, { videoId: v.id }, a);
    const second = (await getVideoAudit(env.DB, v.id))!;
    expect(second.status).toBe("published");
    expect(second.published_at).toBe(first.published_at);
  });

  it("execute refuses a suppressed lead and the approval goes back to pending", async () => {
    const { v } = await renderedVideo();
    await createPublishApproval(env, v.id);
    await addSuppression(env.DB, { kind: "domain", value: "ace.com", reason: "opt_out" });
    const a = await approvalOf(v.id);
    const r = await approve(env, a.id);
    expect(r.ok).toBe(false);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("rendered");
    expect(await approvalOf(v.id)).toMatchObject({ status: "pending" });
    expect((await approvalOf(v.id)).error).toMatch(/suppress/i);
  });

  it("execute refuses a superseded audit", async () => {
    const { v, b } = await renderedVideo();
    await createPublishApproval(env, v.id);
    await wait(10);
    await insertTestAudit(b.id); // a newer audit makes the video's audit old
    const a = await approvalOf(v.id);
    const r = await approve(env, a.id);
    expect(r.ok).toBe(false);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("rendered");
    expect((await approvalOf(v.id)).error).toMatch(/newer audit/i);
  });

  it("execute refuses a video that is not rendered", async () => {
    const { v } = await renderedVideo();
    await createPublishApproval(env, v.id);
    await setVideoStatus(env.DB, v.id, "cancelled");
    const r = await approve(env, (await approvalOf(v.id)).id);
    expect(r.ok).toBe(false);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("cancelled");
  });

  it("rejected publish leaves the page without a video", async () => {
    const { v, token } = await renderedVideo();
    await createPublishApproval(env, v.id);
    expect(await reject(env.DB, (await approvalOf(v.id)).id, "not good")).toBe(true);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("rendered");
    expect((await publicReport(env.DB, token))!.video).toBeNull();
  });

  it("rejected video can be re-edited and returns to review", async () => {
    const { v } = await renderedVideo();
    await createPublishApproval(env, v.id);
    const a = await approvalOf(v.id);
    await reject(env.DB, a.id);
    await enqueueHelperJob(env.DB, "voice.segment", { videoId: v.id, segmentId: "s1", engine: "qwen3-tts", text: "x", refKey: "r" }, { videoId: v.id, dedupeKey: "k1" });

    // the editor reads the rejected approval
    const got = await (await api(`/api/video-audits/${v.id}`)).json<any>();
    expect(got.publishApproval).toMatchObject({ id: a.id, status: "rejected" });

    const r = await api(`/api/video-audits/${v.id}/reopen`, { method: "POST" });
    expect(r.status).toBe(200);
    const after = (await getVideoAudit(env.DB, v.id))!;
    expect(after.status).toBe("review");
    expect(after.plan!.version).toBe(v.plan!.version + 1);
    expect((await env.DB.prepare(`SELECT status FROM helper_jobs WHERE video_id = ?`).bind(v.id).all<any>()).results.every((j) => j.status !== "pending")).toBe(true);

    expect((await api(`/api/video-audits/${v.id}/reopen`, { method: "POST" })).status).toBe(409); // only from rendered
    expect((await api(`/api/video-audits/nope/reopen`, { method: "POST" })).status).toBe(404);
  });

  it("reopening a video with a waiting approval rejects that approval", async () => {
    const { v } = await renderedVideo();
    await createPublishApproval(env, v.id);
    const a = await approvalOf(v.id);
    expect((await api(`/api/video-audits/${v.id}/reopen`, { method: "POST" })).status).toBe(200);
    expect(await approvalOf(v.id).catch(() => null)).toBeNull(); // the link to it is cleared
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(a.id).first<any>()).status).toBe("rejected");
  });

  it("the owner can watch a rendered video before it is published", async () => {
    const { v } = await renderedVideo();
    const r = await api(`/api/video-audits/${v.id}/media/video.mp4`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect((await api(`/api/video-audits/${v.id}/media/other.mp4`)).status).toBe(404);
    const nokey = await api(`/api/video-audits/nope/media/video.mp4`);
    expect(nokey.status).toBe(404);
  });

  it("a video of another status than rendered/published has no owner media", async () => {
    const { v } = await renderedVideo();
    await setVideoStatus(env.DB, v.id, "cancelled");
    expect((await api(`/api/video-audits/${v.id}/media/video.mp4`)).status).toBe(404);
    void createApproval;
  });

  it("video.publish is still registered on the worker entry path", async () => {
    // Through the Worker (SELF), not this file's own import: the approvals route must find the handler.
    const { v } = await renderedVideo();
    await createPublishApproval(env, v.id);
    const a = await approvalOf(v.id);
    const r = await api(`/api/approvals/${a.id}/approve`, { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect((await getVideoAudit(env.DB, v.id))!.status).toBe("published");
    const list = await (await api(`/api/approvals?status=approved`)).json<any>();
    expect(list.items.find((i: any) => i.id === a.id)?.label).toBe("Publish video");
  });
});
