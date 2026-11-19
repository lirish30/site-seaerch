import { getOnboardingByToken, listItems, removeFile, addFile, touchClient, type Onboarding, type OnboardingItem } from "../db/onboardings";
import type { Env } from "../env";
import { isClientToken } from "../documents/token";
import { endsSilence, logReceived, logResumed, type WriteResult } from "./public";
import { cleanText } from "./templates";

/**
 * What a client may upload for a checklist item. Everything about a file that is sent is untrusted: the name, the claimed type and the claimed size.
 * The name is never part of the storage key or of a header (it is only text shown back, escaped); the type stored is chosen here from the extension; the
 * size that counts is the number of bytes actually received; and the first bytes must be what the extension says they are.
 */

export const UPLOAD_LIMITS = { fileBytes: 20 * 1024 * 1024, perItem: 10, totalBytes: 250 * 1024 * 1024 } as const;

/** Extension -> the content types a browser may claim for it. SVG, HTML, ZIP, executables and video are not here, so they are refused. */
export const ALLOWED_TYPES: Record<string, string[]> = {
  jpg: ["image/jpeg", "image/pjpeg"],
  jpeg: ["image/jpeg", "image/pjpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  heic: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"],
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  txt: ["text/plain"],
};
/** What is stored and later served for each extension: ours, never the client's. */
const STORED_TYPE: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain; charset=utf-8",
};
/** A browser that does not know a file's type says one of these; the bytes decide then. */
const NO_CLAIM = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** The multipart envelope around the one file (boundaries, the field's headers). */
const ENVELOPE_BYTES = 64 * 1024;
const NAME_MAX = 120;

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Whether the first bytes are what the extension says: JPEG, PNG, GIF, WEBP, PDF, DOCX (a zip container) and HEIC (`ftyp` at 4); a txt must be UTF-8 with no NUL byte. */
export function sniffOk(ext: string, head: Uint8Array): boolean {
  switch (ext) {
    case "jpg": case "jpeg": return startsWith(head, [0xff, 0xd8, 0xff]);
    case "png": return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "gif": return startsWith(head, ascii("GIF8"));
    case "webp": return startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8);
    case "pdf": return startsWith(head, ascii("%PDF"));
    case "docx": return startsWith(head, ascii("PK"));
    case "heic": return startsWith(head, ascii("ftyp"), 4);
    case "txt":
      if (head.includes(0)) return false;
      try { new TextDecoder("utf-8", { fatal: true }).decode(head); return true; } catch { return false; }
    default: return false;
  }
}

/** The lower-cased extension after the last dot, or "" when there is none. */
const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/**
 * The name to show for a file: the last path segment only (either slash), cleaned of control and invisible characters, at most 120 characters (the end,
 * with the extension, is kept), and never empty: "file.<ext>", or "file" when there is no extension.
 */
export function safeFileName(name: string): string {
  const base = cleanText(String(name ?? "").split(/[\\/]/).pop() ?? "", 4 * NAME_MAX).replace(/\s+/g, " ").trim();
  const ext = /^\.{1,2}$/.test(base) ? "" : extOf(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1).trim() : base;
  const plain = /^\.{1,2}$/.test(stem) ? "" : stem;
  if (!plain) return ext ? `file.${ext}` : "file";
  if (base.length <= NAME_MAX) return base;
  const tail = ext ? `.${ext.slice(0, 16)}` : "";
  return `${plain.slice(0, NAME_MAX - tail.length).trimEnd()}${tail}`;
}

export type UploadResult =
  | { ok: true; file: { id: string; fileName: string; sizeBytes: number } }
  | { ok: false; status: 400 | 404 | 409 | 413 | 415; error: string };
type Refusal = Extract<UploadResult, { ok: false }>;
const refuse = (status: Refusal["status"], error: string): Refusal => ({ ok: false, status, error });
const NOT_FOUND = refuse(404, "not found");

/** The onboarding behind a link (a malformed token is never looked up). */
const find = (env: Env, token: string): Promise<Onboarding | null> => (isClientToken(token) ? getOnboardingByToken(env.DB, token) : Promise.resolve(null));

/** The onboarding and the files item to upload to: 404 for a dead link or an item of another onboarding (the same as a missing one), 409 closed, 400 for a text item. */
async function target(env: Env, token: string, itemId: string): Promise<{ o: Onboarding; item: OnboardingItem; items: OnboardingItem[] } | Refusal> {
  const o = await find(env, token);
  if (!o) return NOT_FOUND;
  if (o.closedAt) return refuse(409, "this onboarding is closed");
  const items = await listItems(env.DB, o.id);
  const item = items.find((i) => i.id === itemId);
  if (!item) return NOT_FOUND;
  if (item.kind !== "files") return refuse(400, "this item takes text, not files");
  // A file on an accepted item would reopen it, and the client could then remove what the owner accepted.
  if (item.status === "accepted") return refuse(409, "this item was already accepted");
  return { o, item, items };
}

/** Whether a link can take an upload for this item, answered before the body is read. */
export async function checkUploadTarget(env: Env, token: string, itemId: string): Promise<{ ok: true } | Refusal> {
  const t = await target(env, token, itemId);
  return "ok" in t ? t : { ok: true };
}

/** The request body, or null when it is longer than `max` bytes. The stream is cut off at the limit, so a body that lies about (or omits) its length is never held whole. */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  if (Number(req.headers.get("content-length")) > max) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** The largest request body the upload route reads: a full file and its multipart envelope. */
export const MAX_UPLOAD_BODY = UPLOAD_LIMITS.fileBytes + ENVELOPE_BYTES;

/**
 * Takes one file for a checklist item. Refused with nothing stored: a dead link or an item that is not this onboarding's (404), a closed onboarding or an item
 * already accepted or already holding ten files (409), a text item or an empty file (400), a file over 20 MB or one that would take the onboarding past 250 MB
 * of what is stored (413), an extension that is not allowed, a claimed type that does not fit it, or first bytes that are not what it says (415).
 * The object goes to `onboarding/<onboardingId>/<itemId>/<uuid>` with a content type chosen from the extension; if the row cannot be recorded the object is
 * deleted again and the error is thrown. Stamps the client's activity, logs what came in once per item per day, and logs a return after a long silence.
 */
export async function acceptUpload(env: Env, token: string, itemId: string, file: File, now: Date): Promise<UploadResult> {
  const t = await target(env, token, itemId);
  if ("ok" in t) return t;
  const { o, item, items } = t;

  const fileName = safeFileName(file.name);
  const ext = extOf(fileName);
  if (!ext || !has(ALLOWED_TYPES, ext)) return refuse(415, "this kind of file is not accepted");
  const claimed = (file.type ?? "").split(";")[0].trim().toLowerCase();
  if (!NO_CLAIM.has(claimed) && !ALLOWED_TYPES[ext].includes(claimed)) return refuse(415, "this kind of file is not accepted");

  if (file.size === 0) return refuse(400, "the file is empty");
  if (file.size > UPLOAD_LIMITS.fileBytes) return refuse(413, "the file is too large");

  // What is stored counts, not what the request said.
  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM onboarding_files WHERE item_id = ?`,
  ).bind(item.id).first<{ n: number; bytes: number }>();
  const total = await env.DB.prepare(
    `SELECT COALESCE(SUM(f.size_bytes), 0) AS bytes FROM onboarding_files f JOIN onboarding_items i ON i.id = f.item_id WHERE i.onboarding_id = ?`,
  ).bind(o.id).first<{ bytes: number }>();
  if ((used?.n ?? 0) >= UPLOAD_LIMITS.perItem) return refuse(409, `an item takes at most ${UPLOAD_LIMITS.perItem} files`);

  const data = new Uint8Array(await file.arrayBuffer());
  if (data.byteLength === 0) return refuse(400, "the file is empty");
  if (data.byteLength > UPLOAD_LIMITS.fileBytes) return refuse(413, "the file is too large");
  if ((total?.bytes ?? 0) + data.byteLength > UPLOAD_LIMITS.totalBytes) return refuse(413, "there is no room left for more files");
  if (!sniffOk(ext, data)) return refuse(415, "this file is not what its name says");

  const id = crypto.randomUUID();
  const r2Key = `onboarding/${o.id}/${item.id}/${id}`;
  const resuming = endsSilence(o, items, now);
  await env.RAW.put(r2Key, data, { httpMetadata: { contentType: STORED_TYPE[ext] } });
  try {
    await addFile(env.DB, { id, itemId: item.id, r2Key, fileName, contentType: STORED_TYPE[ext], sizeBytes: data.byteLength, now: now.toISOString() });
  } catch (e) {
    await env.RAW.delete(r2Key).catch((d) => console.error("onboarding: could not delete an upload that was not recorded", d instanceof Error ? d.message : "unknown error"));
    throw e;
  }
  // The file is in. Noting the visit must not turn it into a failure.
  try { await touchClient(env.DB, o.id, now.toISOString()); }
  catch (e) { console.error("onboarding: could not stamp the client's activity", e instanceof Error ? e.message : "unknown error"); }
  await logReceived(env, o, item, now);
  if (resuming) await logResumed(env, o, now);
  return { ok: true, file: { id, fileName, sizeBytes: data.byteLength } };
}

/**
 * Removes a file the client sent. The file must belong to this onboarding (404 otherwise, as for an unknown one). Closed (409) and, once the owner has
 * accepted the item, locked (409). Deletes the row, then the object (a failed delete is logged: the row is already gone). The item goes back to waiting
 * when that was its last file. Stamps the client's activity and logs a return after a long silence.
 */
export async function removeClientFile(env: Env, token: string, fileId: string, now: Date): Promise<WriteResult> {
  const o = await find(env, token);
  if (!o) return { ok: false, status: 404 };
  if (o.closedAt) return { ok: false, status: 409, error: "this onboarding is closed" };
  const row = await env.DB.prepare(
    `SELECT i.status AS status FROM onboarding_files f JOIN onboarding_items i ON i.id = f.item_id WHERE f.id = ? AND i.onboarding_id = ?`,
  ).bind(fileId, o.id).first<{ status: OnboardingItem["status"] }>();
  if (!row) return { ok: false, status: 404 };
  if (row.status === "accepted") return { ok: false, status: 409, error: "this item was already accepted" };

  const items = await listItems(env.DB, o.id);
  const resuming = endsSilence(o, items, now);
  const removed = await removeFile(env.DB, fileId);
  if (!removed) return { ok: false, status: 404 };
  await env.RAW.delete(removed.r2Key).catch((e) => console.error("onboarding: could not delete a removed upload", e instanceof Error ? e.message : "unknown error"));
  try { await touchClient(env.DB, o.id, now.toISOString()); }
  catch (e) { console.error("onboarding: could not stamp the client's activity", e instanceof Error ? e.message : "unknown error"); }
  if (resuming) await logResumed(env, o, now);
  return { ok: true };
}
