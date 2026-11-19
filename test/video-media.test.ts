import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { setVideoStatus } from "../src/worker/db/videoAudits";
import { createReport, ensureReport, revokeReports } from "../src/worker/db/reports";
import { saveSettings } from "../src/worker/db/settings";
import { insertTestAudit, renderedVideo, VIDEO_BYTES, wait } from "./fixtures/video";

const media = (token: string, name: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://x/api/public/report/${token}/media/${name}`, { headers });
const publish = (id: string) => setVideoStatus(env.DB, id, "published");
const body = async (r: Response) => [...new Uint8Array(await r.arrayBuffer())];

beforeEach(async () => { await saveSettings(env.DB, { booking_url: "", ai_voice_note: 1 }); });

describe("public media", () => {
  it("unpublished video is not served", async () => {
    const { token } = await renderedVideo();
    for (const n of ["video.mp4", "poster.jpg", "preview.gif"]) expect((await media(token, n)).status).toBe(404);
  });

  it("serves the published files with their types and a private cache", async () => {
    const { v, token } = await renderedVideo();
    await publish(v.id);
    const r = await media(token, "video.mp4");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(r.headers.get("content-length")).toBe("100");
    expect(await body(r)).toEqual([...VIDEO_BYTES]);
    expect((await media(token, "poster.jpg")).headers.get("content-type")).toBe("image/jpeg");
    expect((await media(token, "preview.gif")).headers.get("content-type")).toBe("image/gif");
    expect((await media(token, "video.webm")).status).toBe(404);
    expect((await media(token, "..%2Fvideo.mp4")).status).toBe(404);
  });

  it("public media is served with nosniff, in full and by range", async () => {
    const { v, token } = await renderedVideo();
    await publish(v.id);
    for (const headers of [{} as Record<string, string>, { range: "bytes=0-9" }]) {
      for (const n of ["video.mp4", "poster.jpg", "preview.gif"]) expect((await media(token, n, headers)).headers.get("x-content-type-options"), n).toBe("nosniff");
    }
  });

  it("token for another audit does not serve this video", async () => {
    const { v, b } = await renderedVideo();
    await publish(v.id);
    await wait(10);
    const other = await insertTestAudit(b.id); // the same lead, a newer audit: its link has no video of its own
    const t2 = (await ensureReport(env.DB, b.id, other.id)).token;
    expect((await media(t2, "video.mp4")).status).toBe(404);
    const second = await renderedVideo();
    await publish(second.v.id);
    expect((await media(second.token, "video.mp4")).status).toBe(200);
  });

  it("expired and revoked tokens get 404", async () => {
    const { v, b, audit, token } = await renderedVideo();
    await publish(v.id);
    const old = await createReport(env.DB, b.id, audit.id, new Date(Date.now() - 40 * 86_400_000));
    expect((await media(old.token, "video.mp4")).status).toBe(404);
    expect((await media(token, "video.mp4")).status).toBe(200);
    await revokeReports(env.DB, b.id);
    expect((await media(token, "video.mp4")).status).toBe(404);
    expect((await media("short", "video.mp4")).status).toBe(404);
    expect((await media("A".repeat(43), "video.mp4")).status).toBe(404);
  });

  it("a range request returns 206 with Content-Range", async () => {
    const { v, token } = await renderedVideo();
    await publish(v.id);
    const r = await media(token, "video.mp4", { range: "bytes=10-19" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(r.headers.get("content-length")).toBe("10");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(await body(r)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const open = await media(token, "video.mp4", { range: "bytes=95-" });
    expect(open.headers.get("content-range")).toBe("bytes 95-99/100");
    expect(await body(open)).toEqual([95, 96, 97, 98, 99]);
    const suffix = await media(token, "video.mp4", { range: "bytes=-3" });
    expect(suffix.headers.get("content-range")).toBe("bytes 97-99/100");
    const clamped = await media(token, "video.mp4", { range: "bytes=98-500" });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("content-range")).toBe("bytes 98-99/100");
  });

  it("a range past the end returns 416", async () => {
    const { v, token } = await renderedVideo();
    await publish(v.id);
    const r = await media(token, "video.mp4", { range: "bytes=100-120" });
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */100");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("several ranges are not supported and serve the whole file", async () => {
    const { v, token } = await renderedVideo();
    await publish(v.id);
    const r = await media(token, "video.mp4", { range: "bytes=0-9,20-29" });
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual([...VIDEO_BYTES]);
    expect((await media(token, "video.mp4", { range: "garbage" })).status).toBe(200);
  });

  it("public headers keep noindex and no referrer, and everything else stays no-store", async () => {
    const { v, token } = await renderedVideo();
    await publish(v.id);
    for (const r of [await media(token, "video.mp4"), await media(token, "video.mp4", { range: "bytes=0-1" }), await media(token, "nope.mp4")]) {
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect((await media(token, "nope.mp4")).headers.get("cache-control")).toBe("no-store");
    const report = await SELF.fetch(`https://x/api/public/report/${token}`);
    expect(report.status).toBe(200);
    expect(report.headers.get("cache-control")).toBe("no-store");
    expect((await SELF.fetch(`https://x/api/public/report/not-a-token`)).headers.get("cache-control")).toBe("no-store");
  });

  it("non-https booking url is dropped", async () => {
    const { v, token } = await renderedVideo();
    await publish(v.id);
    const get = async () => (await (await SELF.fetch(`https://x/api/public/report/${token}`)).json<any>());
    await env.DB.prepare(`UPDATE settings SET booking_url = 'http://cal.example.com/me' WHERE id = 1`).run();
    expect((await get()).bookingUrl).toBe("");
    await env.DB.prepare(`UPDATE settings SET booking_url = 'javascript:alert(1)' WHERE id = 1`).run();
    expect((await get()).bookingUrl).toBe("");
    await env.DB.prepare(`UPDATE settings SET booking_url = 'https://cal.example.com/me' WHERE id = 1`).run();
    expect((await get()).bookingUrl).toBe("https://cal.example.com/me");
  });
});
