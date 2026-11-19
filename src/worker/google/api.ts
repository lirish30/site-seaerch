import type { Fetch } from "./oauth";

const te = new TextEncoder();

export async function google<T>(f: Fetch, token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await f(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const json = await res.json<any>().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${json.error?.message ?? "request failed"}`);
  return json as T;
}

/** Our app folder; recreated if the user deleted it (drive.file can only see files this app made). */
export async function ensureFolder(f: Fetch, token: string, folderId: string | null, name: string): Promise<string> {
  if (folderId) {
    try {
      const r = await google<{ id: string; trashed: boolean }>(f, token, `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,trashed`);
      if (!r.trashed) return r.id;
    } catch { /* gone: recreate */ }
  }
  const r = await google<{ id: string }>(f, token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  return r.id;
}

/** Multipart upload; pass mimeType "application/vnd.google-apps.document" with HTML content to get a Google Doc. */
export async function uploadFile(f: Fetch, token: string, meta: { name: string; parents: string[]; mimeType?: string },
  content: { type: string; bytes: Uint8Array | string }) {
  const boundary = `ss_${crypto.randomUUID().replace(/-/g, "")}`;
  const bytes = typeof content.bytes === "string" ? te.encode(content.bytes) : content.bytes;
  const pre = te.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${content.type}\r\n\r\n`);
  const post = te.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(pre.length + bytes.length + post.length);
  body.set(pre, 0); body.set(bytes, pre.length); body.set(post, pre.length + bytes.length);
  return google<{ id: string; webViewLink: string }>(f, token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
}
