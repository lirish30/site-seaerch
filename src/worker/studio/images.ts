// The Studio's image storage and rendering (Plan 15): uploads of the before and after pictures, and the post's slides drawn to PNGs, both in `RAW`.
// Everything stays inside the Worker: the slides are drawn by the browser binding from escaped, self-contained HTML.
import type { Env } from "../env";
import { getPost, patchPost } from "../db/studio";
import { htmlToPng } from "../render/render";
import { renderSlideHtml, slidesFor, STUDIO_SIZE, type StudioCopy } from "./templates";

/** A refusal with a plain sentence the route can show as it is (422). */
export class StudioUploadError extends Error {}
/** The post cannot be drawn yet; the message says why in a plain sentence (422). */
export class StudioRenderError extends Error {}
/** There is no browser binding to draw with: the route answers 501, like the deck PDF, rather than 422 (nothing the person can fix in the post). */
export class StudioBrowserMissingError extends StudioRenderError {}

export const MAX_UPLOAD_BYTES = 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
type UploadType = typeof TYPES[number];

const startsWith = (b: Uint8Array, at: number, sig: number[]) => sig.every((v, i) => b[at + i] === v);
/** The first bytes (the magic number) each type must start with. */
const MAGIC: Record<UploadType, (b: Uint8Array) => boolean> = {
  "image/png": (b) => startsWith(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, 0, [0xff, 0xd8, 0xff]),
  "image/webp": (b) => startsWith(b, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, 8, [0x57, 0x45, 0x42, 0x50]),
};

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Keeps an uploaded before or after picture at `studio/<postId>/<slot>` and returns that key. Only PNG, JPEG and WebP, at most 1 MB, and the bytes must be the type claimed. */
export async function storeUpload(env: Env, postId: string, slot: "before" | "after", file: { type: string; bytes: Uint8Array }): Promise<string> {
  if (!SAFE_ID.test(postId)) throw new StudioUploadError("That post id is not valid.");
  if (!(TYPES as readonly string[]).includes(file.type)) throw new StudioUploadError("Upload a PNG, JPEG or WebP image.");
  if (file.bytes.length === 0) throw new StudioUploadError("That file is empty.");
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new StudioUploadError("That image is over 1 MB; shrink it and try again.");
  if (!MAGIC[file.type as UploadType](file.bytes)) throw new StudioUploadError(`That file does not look like a ${file.type.slice(6).toUpperCase()} image.`);
  const key = `studio/${postId}/${slot}`;
  await env.RAW.put(key, file.bytes, { httpMetadata: { contentType: file.type } });
  return key;
}

const base64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A stored upload as a `data:` URI, or undefined when it is not there. (Uploads are capped at 1 MB on the way in.) */
async function uploadDataUri(bucket: R2Bucket, key: string): Promise<string | undefined> {
  const obj = await bucket.get(key);
  if (!obj) return undefined;
  const type = obj.httpMetadata?.contentType;
  if (!type || !(TYPES as readonly string[]).includes(type)) return undefined;
  return `data:${type};base64,${base64(new Uint8Array(await obj.arrayBuffer()))}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** The post's stored copy as a `StudioCopy`, or null when it has no headline yet (the copy is stored as given, so it is read defensively). */
function readCopy(v: unknown): StudioCopy | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  const headline = str(c.headline).trim();
  if (!headline) return null;
  const slides = (Array.isArray(c.slides) ? c.slides : []).filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null).map((s) => ({ title: str(s.title), body: str(s.body) }));
  return { headline, caption: str(c.caption), slides, tags: (Array.isArray(c.tags) ? c.tags : []).filter((t): t is string => typeof t === "string") };
}

/**
 * Draws the post's slides to `studio/<postId>/<n>.png` (n from 1) in `RAW`, replaces the post's `image_keys` with them and returns the keys.
 * Every slide is drawn before anything is stored, so a failure leaves the old keys and pictures as they were; pictures of an earlier, longer render are removed afterwards.
 * `png` is the renderer (tests hand in a fake).
 */
export async function renderPostImages(env: Env, postId: string, png: typeof htmlToPng = htmlToPng): Promise<string[]> {
  if (!env.BROWSER) throw new StudioBrowserMissingError("Images cannot be drawn here because the browser binding is not set up.");
  const post = await getPost(env.DB, postId);
  if (!post) throw new StudioRenderError("That post does not exist.");
  const copy = readCopy(post.copy);
  if (!copy) throw new StudioRenderError("Write the copy for this post before drawing its images.");

  let assets: { before?: string; after?: string } = {};
  if (post.kind === "before_after") {
    assets = { before: await uploadDataUri(env.RAW, `studio/${postId}/before`), after: await uploadDataUri(env.RAW, `studio/${postId}/after`) };
    if (!assets.before || !assets.after) throw new StudioRenderError("Upload the before and after images before drawing this post.");
  }

  const drawn: Uint8Array[] = [];
  for (const slide of slidesFor(post.kind, copy, assets)) drawn.push(await png(env.BROWSER, renderSlideHtml(slide), STUDIO_SIZE));

  const keys = drawn.map((_, i) => `studio/${postId}/${i + 1}.png`);
  for (const [i, bytes] of drawn.entries()) await env.RAW.put(keys[i], bytes, { httpMetadata: { contentType: "image/png" } });
  await patchPost(env.DB, postId, { imageKeys: keys }, new Date().toISOString());
  const stale = post.imageKeys.filter((k) => !keys.includes(k) && k.startsWith(`studio/${postId}/`) && /\/\d+\.png$/.test(k));
  if (stale.length) await env.RAW.delete(stale);
  return keys;
}
