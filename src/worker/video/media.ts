import type { Env } from "../env";
import { publishedVideoForToken } from "../db/reports";
import type { VideoAudit } from "../db/videoAudits";

/** The three files of a video, by their fixed public names. */
export const MEDIA = {
  "video.mp4": { column: "video_key", type: "video/mp4" },
  "poster.jpg": { column: "poster_key", type: "image/jpeg" },
  "preview.gif": { column: "gif_key", type: "image/gif" },
} as const;
export type MediaName = keyof typeof MEDIA;
export const isMediaName = (n: string): n is MediaName => Object.prototype.hasOwnProperty.call(MEDIA, n);

const CACHE = "private, max-age=3600";
const notFound = () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

/** A single byte range of `size` bytes, or: null (no usable range: serve it all) or "unsatisfiable". Several ranges and malformed headers are not ranges. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") { // the last n bytes
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Number(m[2]);
  if (m[2] !== "" && end < start) return null; // an inverted range is ignored
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

/** Streams one stored file, honouring a single `Range`. The body is never held in memory. A missing file is a 404. */
export async function serveObject(raw: R2Bucket, key: string, contentType: string, range: string | null): Promise<Response> {
  const head = await raw.head(key);
  if (!head) return notFound();
  const size = head.size;
  const base = { "content-type": contentType, "accept-ranges": "bytes", "x-content-type-options": "nosniff" };
  const r = parseRange(range, size);
  if (r === "unsatisfiable") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  if (r === null) {
    const obj = await raw.get(key);
    return obj ? new Response(obj.body, { status: 200, headers: { ...base, "content-length": String(size), "cache-control": CACHE } }) : notFound();
  }
  const length = r.end - r.start + 1;
  const obj = await raw.get(key, { range: { offset: r.start, length } });
  if (!obj) return notFound();
  return new Response(obj.body, { status: 206, headers: { ...base, "content-length": String(length), "content-range": `bytes ${r.start}-${r.end}/${size}`, "cache-control": CACHE } });
}

/** The file a video stores under a public name, or null when the name is unknown or the file was never made. */
export function mediaFor(video: Pick<VideoAudit, "video_key" | "gif_key" | "poster_key">, name: string): { key: string; type: string } | null {
  if (!isMediaName(name)) return null;
  const m = MEDIA[name];
  const key = video[m.column];
  return key ? { key, type: m.type } : null;
}

/**
 * One file of the video published for the report link's audit. The link is resolved exactly as the report page resolves it (a live token, the
 * audit it is for); anything else (unknown, expired, revoked or malformed token, an unknown name, a video that is not published) is a 404.
 */
export async function serveMedia(env: Env, token: string, name: string, range: string | null): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !isMediaName(name)) return notFound();
  const video = await publishedVideoForToken(env.DB, token);
  const file = video && mediaFor(video, name);
  return file ? serveObject(env.RAW, file.key, file.type, range) : notFound();
}
