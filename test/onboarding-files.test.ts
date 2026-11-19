import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { createDraft } from "../src/worker/db/documents";
import {
  addFile, closeOnboarding, createOnboarding, listFiles, listItems, markWelcomeSent, setItemStatus, setRevoked, type NewItem,
} from "../src/worker/db/onboardings";
import { ALLOWED_TYPES, UPLOAD_LIMITS, acceptUpload, removeClientFile, safeFileName, sniffOk } from "../src/worker/onboarding/files";
import { proposal, seedDeal } from "./fixtures/documents";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type E = typeof env;
const DAY = 86_400_000;
const MB = 1024 * 1024;

const ITEMS: NewItem[] = [
  { key: "logo", label: "Logo files", instructions: "Upload your logo", kind: "files", phase: 1 },
  { key: "photos", label: "Photos", instructions: "Upload photos", kind: "files", phase: 1 },
  { key: "about", label: "About text", instructions: "Tell us about you", kind: "text", phase: 1 },
];

// Real magic bytes, then padding.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [...new TextEncoder().encode("GIF89a")];
const PDF = [...new TextEncoder().encode("%PDF-1.7\n")];
const ZIPHEAD = [0x50, 0x4b, 0x03, 0x04];
const WEBP = [...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")];
const HEIC = [0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic")];
const bytes = (head: number[], total = head.length) => { const b = new Uint8Array(Math.max(total, head.length)); b.set(head); return b; };

/** The Worker as a client's browser reaches it: no cookie. */
const call = (path: string, init: RequestInit = {}, e: Partial<E> = {}) => worker.fetch(new Request(`https://x/api${path}`, init), { ...env, ...e } as E, ctx);

/** A multipart body with one `file` part, built by hand so the test controls Content-Length (honest, lying or absent). */
function multipart(name: string, content: Uint8Array, type = "application/octet-stream", field = "file") {
  const boundary = "----testboundary7f3a";
  const pre = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name.replace(/"/g, "%22")}"\r\nContent-Type: ${type}\r\n\r\n`);
  const post = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  return { boundary, parts: [pre, content, post], length: pre.length + content.length + post.length };
}
const upload = (token: string, itemId: string, name: string, content: Uint8Array, o: { type?: string; length?: "honest" | "none" | number; field?: string } = {}) => {
  const m = multipart(name, content, o.type, o.field);
  const headers: Record<string, string> = { "content-type": `multipart/form-data; boundary=${m.boundary}` };
  const how = o.length ?? "honest";
  if (how === "honest") headers["content-length"] = String(m.length);
  else if (how !== "none") headers["content-length"] = String(how);
  const body: BodyInit = how === "none"
    ? new ReadableStream({ start(c) { for (const p of m.parts) c.enqueue(p); c.close(); } })
    : new Blob(m.parts as BlobPart[]);
  return call(`/public/o/${token}/items/${itemId}/files`, { method: "POST", headers, body, ...(how === "none" && { duplex: "half" }) } as RequestInit);
};
const del = (token: string, fileId: string) => call(`/public/o/${token}/files/${fileId}`, { method: "DELETE" });
const file = (name: string, content: Uint8Array, type = "") => new File([content as BlobPart], name, { type });

async function seed(o: { items?: NewItem[] } = {}) {
  const s = await seedDeal();
  const doc = await createDraft(env.DB, { dealId: s.dealId, businessId: s.businessId, optionId: "b", content: proposal() });
  const { onboarding } = await createOnboarding(env.DB, { businessId: s.businessId, dealId: s.dealId, documentId: doc.id, kind: "build", test: false, items: o.items ?? ITEMS });
  const sentAt = new Date(Date.now() - DAY).toISOString();
  await markWelcomeSent(env.DB, onboarding.id, { sentAt, questionnaireDueAt: sentAt, phaseDue: { 1: sentAt, 2: sentAt } });
  const items = await listItems(env.DB, onboarding.id);
  const by = (key: string) => items.find((i) => i.key === key)!;
  return { ...s, id: onboarding.id, token: onboarding.token, logo: by("logo"), photos: by("photos"), about: by("about") };
}
const item = async (id: string, key: string) => (await listItems(env.DB, id)).find((i) => i.key === key)!;
const stored = async (id: string) => (await env.RAW.list({ prefix: `onboarding/${id}/` })).objects;
const rows = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId)).filter((a) => a.kind === kind);

/** A database that behaves like the real one, except the batch that records a file fails. */
const failingInsert = (): D1Database =>
  new Proxy(env.DB, {
    get: (t, k) => {
      if (k === "batch") return async () => { throw new Error("insert failed"); };
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });

/** Pre-fills an item with file rows of a given size (the bytes themselves are not needed: the limits count what the rows say is stored). */
async function fill(itemId: string, n: number, size: number, tag = "f") {
  for (let i = 0; i < n; i++) {
    await addFile(env.DB, { id: `${tag}${i}-${itemId}`, itemId, r2Key: `onboarding/x/${itemId}/${tag}${i}`, fileName: `${tag}${i}.png`, contentType: "image/png", sizeBytes: size, now: new Date().toISOString() });
  }
}

describe("the rules", () => {
  it("lists the limits and the allowed extensions, and nothing risky", () => {
    expect(UPLOAD_LIMITS).toEqual({ fileBytes: 20 * 1024 * 1024, perItem: 10, totalBytes: 250 * 1024 * 1024 });
    expect(Object.keys(ALLOWED_TYPES).sort()).toEqual(["docx", "gif", "heic", "jpeg", "jpg", "pdf", "png", "txt", "webp"]);
    for (const bad of ["svg", "html", "htm", "zip", "exe", "mp4", "mov", "js", "sh", "xml"]) expect(ALLOWED_TYPES[bad]).toBeUndefined();
  });

  it("sniffOk checks the magic bytes against the extension", () => {
    expect(sniffOk("png", bytes(PNG))).toBe(true);
    expect(sniffOk("jpg", bytes(JPEG))).toBe(true);
    expect(sniffOk("jpeg", bytes(JPEG))).toBe(true);
    expect(sniffOk("gif", bytes(GIF))).toBe(true);
    expect(sniffOk("webp", bytes(WEBP))).toBe(true);
    expect(sniffOk("pdf", bytes(PDF))).toBe(true);
    expect(sniffOk("docx", bytes(ZIPHEAD))).toBe(true);
    expect(sniffOk("heic", bytes(HEIC))).toBe(true);
    // The wrong bytes for the extension, an empty file, and unknown extensions.
    expect(sniffOk("png", bytes(JPEG))).toBe(false);
    expect(sniffOk("jpg", bytes(PNG))).toBe(false);
    expect(sniffOk("webp", bytes([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WAVE")]))).toBe(false);
    expect(sniffOk("pdf", new Uint8Array())).toBe(false);
    expect(sniffOk("png", new Uint8Array(3))).toBe(false);
    expect(sniffOk("svg", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe(false);
    expect(sniffOk("html", new TextEncoder().encode("<html>"))).toBe(false);
    expect(sniffOk("exe", new TextEncoder().encode("MZ\u0090"))).toBe(false);
  });

  it("a txt must be valid UTF-8 with no NUL byte", () => {
    const enc = new TextEncoder();
    expect(sniffOk("txt", enc.encode("hello \u00e9\u4e16 world\n"))).toBe(true);
    expect(sniffOk("txt", new Uint8Array())).toBe(true);
    expect(sniffOk("txt", new Uint8Array([0x68, 0x00, 0x69]))).toBe(false); // NUL
    expect(sniffOk("txt", new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false); // UTF-16, not UTF-8
    expect(sniffOk("txt", new Uint8Array([0xc3, 0x28]))).toBe(false); // invalid sequence
  });

  it("safeFileName keeps the basename, cleans it, caps it and never comes back empty", () => {
    expect(safeFileName("../../x.png")).toBe("x.png");
    expect(safeFileName("C:\\Users\\pat\\logo.PNG")).toBe("logo.PNG");
    expect(safeFileName("a/b/c.pdf")).toBe("c.pdf");
    expect(safeFileName("  my\u0000 \u202elogo.png ")).toBe("my logo.png");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName("../")).toBe("file");
    expect(safeFileName(".png")).toBe("file.png");
    expect(safeFileName("\u0000.jpg")).toBe("file.jpg");
    const long = safeFileName(`${"a".repeat(300)}.png`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".png")).toBe(true);
    expect(safeFileName("a".repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

describe("uploading", () => {
  it("a png uploads and the item becomes received", async () => {
    const a = await seed();
    const res = await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 2000), { type: "image/png" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: { id: string; fileName: string; sizeBytes: number } };
    expect(body.file).toMatchObject({ fileName: "logo.png", sizeBytes: 2000 });
    expect((await item(a.id, "logo")).status).toBe("received");
    const [row] = await listFiles(env.DB, a.logo.id);
    expect(row).toMatchObject({ id: body.file.id, fileName: "logo.png", contentType: "image/png", sizeBytes: 2000 });
    const obj = await env.RAW.get(row.r2Key);
    expect(obj?.size).toBe(2000);
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
    // The page now shows it.
    const page = (await (await call(`/public/o/${a.token}`)).json()) as { items: { key: string; files: { id: string }[] }[] };
    expect(page.items.find((i) => i.key === "logo")!.files.map((f) => f.id)).toEqual([row.id]);
  });

  it("logs what came in, once a day, and stamps the client's activity", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "one.png", bytes(PNG, 100));
    await upload(a.token, a.logo.id, "two.png", bytes(PNG, 100));
    const got = await rows(a.businessId, "onboarding_received");
    expect(got).toHaveLength(1);
    expect(got[0].detail).toContain("Logo files");
    const o = await env.DB.prepare(`SELECT last_client_activity_at AS at FROM onboardings WHERE id = ?`).bind(a.id).first<{ at: string | null }>();
    expect(o?.at).not.toBeNull();
  });

  it("logs a return after a long silence", async () => {
    const a = await seed();
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    await env.DB.prepare(`UPDATE onboardings SET last_client_activity_at = ?, welcome_sent_at = ? WHERE id = ?`).bind(old, old, a.id).run();
    const res = await upload(a.token, a.logo.id, "back.png", bytes(PNG, 100));
    expect(res.status).toBe(201);
    expect(await rows(a.businessId, "onboarding_resumed")).toHaveLength(1);
  });

  it("an html file renamed .jpg is refused by the sniff (415)", async () => {
    const a = await seed();
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    for (const type of ["image/jpeg", "text/html", ""]) {
      const res = await upload(a.token, a.logo.id, "photo.jpg", html, { type });
      expect(res.status).toBe(415);
    }
    expect(await stored(a.id)).toHaveLength(0);
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(0);
    expect((await item(a.id, "logo")).status).toBe("waiting");
  });

  it("an svg is refused, whatever it is called or claims to be", async () => {
    const a = await seed();
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`);
    expect((await upload(a.token, a.logo.id, "logo.svg", svg, { type: "image/svg+xml" })).status).toBe(415);
    expect((await upload(a.token, a.logo.id, "logo.png", svg, { type: "image/svg+xml" })).status).toBe(415);
    expect((await upload(a.token, a.logo.id, "logo.svgz", svg)).status).toBe(415);
    expect(await stored(a.id)).toHaveLength(0);
  });

  it("html, zip, executables, video and files with no extension are refused", async () => {
    const a = await seed();
    for (const [name, head] of [
      ["page.html", new TextEncoder().encode("<html>")], ["a.zip", ZIPHEAD], ["setup.exe", [0x4d, 0x5a, 0x90, 0]], ["clip.mp4", [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]],
      ["clip.mov", [0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]], ["run.sh", new TextEncoder().encode("#!/bin/sh")], ["README", new TextEncoder().encode("hello")], ["a.", PNG],
    ] as [string, ArrayLike<number>][]) {
      const res = await upload(a.token, a.logo.id, name, Uint8Array.from(head));
      expect(res.status, name).toBe(415);
    }
    expect(await stored(a.id)).toHaveLength(0);
  });

  it("a client's claimed content type that does not fit the extension is refused", async () => {
    const a = await seed();
    expect((await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100), { type: "text/html" })).status).toBe(415);
    // An unknown or generic claim is fine: the sniff decides.
    expect((await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100), { type: "application/octet-stream" })).status).toBe(201);
    expect((await upload(a.token, a.logo.id, "logo2.png", bytes(PNG, 100), { type: "" })).status).toBe(201);
  });

  it("the content type stored is chosen from the extension, never from the client", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "doc.pdf", bytes(PDF, 100), { type: "application/pdf" });
    await upload(a.token, a.logo.id, "notes.txt", new TextEncoder().encode("hi there"), { type: "text/plain" });
    await upload(a.token, a.logo.id, "photo.JPG", bytes(JPEG, 100), { type: "image/jpeg" });
    const got = Object.fromEntries((await listFiles(env.DB, a.logo.id)).map((f) => [f.fileName, f.contentType]));
    expect(got).toEqual({ "doc.pdf": "application/pdf", "notes.txt": "text/plain; charset=utf-8", "photo.JPG": "image/jpeg" });
    for (const f of await listFiles(env.DB, a.logo.id)) expect((await env.RAW.get(f.r2Key))?.httpMetadata?.contentType).toBe(f.contentType);
  });

  it("a 21 MB file is 413 and nothing is stored", async () => {
    const a = await seed();
    const res = await upload(a.token, a.logo.id, "big.png", bytes(PNG, 21 * MB));
    expect(res.status).toBe(413);
    expect(await stored(a.id)).toHaveLength(0);
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(0);
  });

  it("the size is checked from Content-Length before the body is read", async () => {
    const a = await seed();
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); if (pulled > 5) c.close(); } });
    const res = await call(`/public/o/${a.token}/items/${a.logo.id}/files`, {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(40 * MB) }, body, duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("a request with no Content-Length cannot get past the cap", async () => {
    const a = await seed();
    const res = await upload(a.token, a.logo.id, "big.png", bytes(PNG, 21 * MB), { length: "none" });
    expect(res.status).toBe(413);
    expect(await stored(a.id)).toHaveLength(0);
  });

  it("a Content-Length that understates the body cannot get past the cap", async () => {
    const a = await seed();
    const res = await upload(a.token, a.logo.id, "big.png", bytes(PNG, 21 * MB), { length: 1000 });
    expect(res.status).toBe(413);
    expect(await stored(a.id)).toHaveLength(0);
  });

  it("the cap is on the bytes: acceptUpload measures the file it was given", async () => {
    const a = await seed();
    const now = new Date();
    const r = await acceptUpload(env, a.token, a.logo.id, file("big.png", bytes(PNG, 20 * MB + 1)), now);
    expect(r).toEqual({ ok: false, status: 413, error: expect.any(String) });
    expect(await stored(a.id)).toHaveLength(0);
    const ok = await acceptUpload(env, a.token, a.logo.id, file("fits.png", bytes(PNG, 20 * MB)), now);
    expect(ok.ok).toBe(true);
  });

  it("an empty file is a 400", async () => {
    const a = await seed();
    expect((await upload(a.token, a.logo.id, "empty.png", new Uint8Array())).status).toBe(400);
    expect(await stored(a.id)).toHaveLength(0);
  });

  it("the 11th file on an item is refused", async () => {
    const a = await seed();
    await fill(a.logo.id, UPLOAD_LIMITS.perItem - 1, 10);
    expect((await upload(a.token, a.logo.id, "tenth.png", bytes(PNG, 100))).status).toBe(201);
    const res = await upload(a.token, a.logo.id, "eleventh.png", bytes(PNG, 100));
    expect(res.status).toBe(409);
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(10);
    expect(await stored(a.id)).toHaveLength(1);
    // Another item has its own ten.
    expect((await upload(a.token, a.photos.id, "p.png", bytes(PNG, 100))).status).toBe(201);
  });

  it("the total cap counts what is stored, not what the request claims", async () => {
    const a = await seed();
    // 249 MB already stored across two items.
    await fill(a.logo.id, 5, 25 * MB, "a");
    await fill(a.photos.id, 4, 31 * MB, "b");
    const res = await upload(a.token, a.photos.id, "over.png", bytes(PNG, 2 * MB), { length: "none" });
    expect(res.status).toBe(413);
    expect(await stored(a.id)).toHaveLength(0);
    // 1 MB still fits, and takes the total to 250 MB; one more byte does not.
    const fits = await acceptUpload(env, a.token, a.photos.id, file("fits.png", bytes(PNG, 1 * MB)), new Date());
    expect(fits.ok).toBe(true);
    const over = await acceptUpload(env, a.token, a.photos.id, file("one-more.png", bytes(PNG, 100)), new Date());
    expect(over).toMatchObject({ ok: false, status: 413 });
  });

  it("../../x.png is stored under a server key and the name is cut to its basename", async () => {
    const a = await seed();
    const res = await upload(a.token, a.logo.id, "../../x.png", bytes(PNG, 100));
    expect(res.status).toBe(201);
    const [row] = await listFiles(env.DB, a.logo.id);
    expect(row.fileName).toBe("x.png");
    expect(row.r2Key).toMatch(new RegExp(`^onboarding/${a.id}/${a.logo.id}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
  });

  it("the R2 key contains no part of the file name", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "secret-invoice-2026.png", bytes(PNG, 100));
    await upload(a.token, a.logo.id, "..%2F..%2Fetc%2Fpasswd.png", bytes(PNG, 100));
    const files = await listFiles(env.DB, a.logo.id);
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f.r2Key).not.toContain("secret");
      expect(f.r2Key).not.toContain("invoice");
      expect(f.r2Key).not.toContain("passwd");
      expect(f.r2Key).not.toContain(".png");
      expect(f.r2Key).not.toContain("%");
    }
    expect(new Set(files.map((f) => f.r2Key)).size).toBe(2);
  });

  it("a files upload on a text item is 400", async () => {
    const a = await seed();
    const res = await upload(a.token, a.about.id, "logo.png", bytes(PNG, 100));
    expect(res.status).toBe(400);
    expect(await stored(a.id)).toHaveLength(0);
  });

  it("an item of another onboarding is 404, the same as a missing item", async () => {
    const a = await seed();
    const b = await seed();
    const other = await upload(a.token, b.logo.id, "logo.png", bytes(PNG, 100));
    const missing = await upload(a.token, "no-such-item", "logo.png", bytes(PNG, 100));
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
    expect(await stored(b.id)).toHaveLength(0);
    expect(await listFiles(env.DB, b.logo.id)).toHaveLength(0);
  });

  it("an unknown, malformed or revoked link is the same 404, and a closed onboarding is a 409", async () => {
    const a = await seed();
    const dead = await upload("B".repeat(43), a.logo.id, "logo.png", bytes(PNG, 100));
    const short = await upload("short", a.logo.id, "logo.png", bytes(PNG, 100));
    await setRevoked(env.DB, a.id, true, new Date().toISOString());
    const revoked = await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100));
    expect([dead.status, short.status, revoked.status]).toEqual([404, 404, 404]);
    expect(await dead.text()).toBe(await revoked.text());
    await setRevoked(env.DB, a.id, false, new Date().toISOString());
    await closeOnboarding(env.DB, a.id, new Date().toISOString());
    expect((await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100))).status).toBe(409);
    expect(await stored(a.id)).toHaveLength(0);
  });

  it("a dead link is answered before the body is read", async () => {
    const a = await seed();
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); if (pulled > 5) c.close(); } });
    const res = await call(`/public/o/${"B".repeat(43)}/items/${a.logo.id}/files`, {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body, duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(404);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("a request that is not a multipart `file` is a 400", async () => {
    const a = await seed();
    const noField = await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100), { field: "other" });
    const json = await call(`/public/o/${a.token}/items/${a.logo.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const text = new FormData();
    text.set("file", "just text");
    const asText = await call(`/public/o/${a.token}/items/${a.logo.id}/files`, { method: "POST", body: text });
    expect([noField.status, json.status, asText.status]).toEqual([400, 400, 400]);
  });

  it("an error names nothing the client typed", async () => {
    const a = await seed();
    const res = await upload(a.token, a.logo.id, "<img src=x onerror=alert(1)>.exe", bytes(PNG, 100));
    expect(res.status).toBe(415);
    expect(await res.text()).not.toContain("onerror");
  });

  it("a failed row insert deletes the stored object", async () => {
    const a = await seed();
    await expect(acceptUpload({ ...env, DB: failingInsert() } as E, a.token, a.logo.id, file("logo.png", bytes(PNG, 500)), new Date())).rejects.toThrow("insert failed");
    expect(await stored(a.id)).toHaveLength(0);
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(0);
    expect((await item(a.id, "logo")).status).toBe("waiting");
  });

  it("a new file on an item the owner already accepted is refused", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100));
    await setItemStatus(env.DB, a.logo.id, "accepted");
    const res = await upload(a.token, a.logo.id, "more.png", bytes(PNG, 100));
    expect(res.status).toBe(409);
    expect((await item(a.id, "logo")).status).toBe("accepted");
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(1);
  });
});

describe("removing", () => {
  it("removing a file deletes the row and the object, and the item goes back to waiting", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100));
    const [row] = await listFiles(env.DB, a.logo.id);
    const res = await del(a.token, row.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(0);
    expect(await env.RAW.get(row.r2Key)).toBeNull();
    expect((await item(a.id, "logo")).status).toBe("waiting");
  });

  it("an item with files left stays received", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "one.png", bytes(PNG, 100));
    await upload(a.token, a.logo.id, "two.png", bytes(PNG, 100));
    const [first] = await listFiles(env.DB, a.logo.id);
    expect((await del(a.token, first.id)).status).toBe(200);
    expect((await item(a.id, "logo")).status).toBe("received");
    expect(await stored(a.id)).toHaveLength(1);
  });

  it("the client cannot remove a file once the item is accepted", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100));
    const [row] = await listFiles(env.DB, a.logo.id);
    await setItemStatus(env.DB, a.logo.id, "accepted");
    const res = await del(a.token, row.id);
    expect(res.status).toBe(409);
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(1);
    expect(await env.RAW.get(row.r2Key)).not.toBeNull();
    expect((await item(a.id, "logo")).status).toBe("accepted");
  });

  it("a file of another onboarding, an unknown file and a dead link are the same 404", async () => {
    const a = await seed();
    const b = await seed();
    await upload(b.token, b.logo.id, "logo.png", bytes(PNG, 100));
    const [theirs] = await listFiles(env.DB, b.logo.id);
    const other = await del(a.token, theirs.id);
    const missing = await del(a.token, "no-such-file");
    const dead = await del("B".repeat(43), theirs.id);
    expect([other.status, missing.status, dead.status]).toEqual([404, 404, 404]);
    expect(await other.text()).toBe(await missing.text());
    expect(await listFiles(env.DB, b.logo.id)).toHaveLength(1);
    expect(await env.RAW.get(theirs.r2Key)).not.toBeNull();
  });

  it("a closed onboarding keeps its files (409)", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100));
    const [row] = await listFiles(env.DB, a.logo.id);
    await closeOnboarding(env.DB, a.id, new Date().toISOString());
    expect((await del(a.token, row.id)).status).toBe(409);
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(1);
  });

  it("the row is gone even if the object cannot be deleted", async () => {
    const a = await seed();
    await upload(a.token, a.logo.id, "logo.png", bytes(PNG, 100));
    const [row] = await listFiles(env.DB, a.logo.id);
    const broken = { ...env, RAW: new Proxy(env.RAW, { get: (t, k) => (k === "delete" ? async () => { throw new Error("r2 down"); } : (t as never)[k]) }) } as E;
    const r = await removeClientFile(broken, a.token, row.id, new Date());
    expect(r.ok).toBe(true);
    expect(await listFiles(env.DB, a.logo.id)).toHaveLength(0);
  });
});
