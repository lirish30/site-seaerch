import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPost, getPost, patchPost } from "../src/worker/db/studio";
import { StudioUploadError, renderPostImages, storeUpload } from "../src/worker/studio/images";

const T0 = "2026-12-01T10:00:00.000Z";
const BROWSER = { marker: "browser" } as unknown as Fetcher;
const withBrowser = { ...env, BROWSER } as typeof env;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
const COPY = { headline: "Five fixes", caption: "c", tags: [], slides: [1, 2, 3].map((i) => ({ title: `Tip ${i}`, body: `Body ${i}` })) };

function fakePng() {
  const calls: { binding: Fetcher; html: string; o: { width: number; height: number } }[] = [];
  const png = async (binding: Fetcher, html: string, o: { width: number; height: number }) => { calls.push({ binding, html, o }); return new Uint8Array([0x89, 0x50, 0x4e, 0x47, calls.length]); };
  return { calls, png };
}

describe("renderPostImages", () => {
  it("renderPostImages stores one object per slide and replaces image_keys", async () => {
    const post = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: false }, T0);
    await patchPost(env.DB, post.id, { copy: COPY, imageKeys: [`studio/${post.id}/1.png`, `studio/${post.id}/2.png`, `studio/${post.id}/3.png`, `studio/${post.id}/4.png`, `studio/${post.id}/5.png`, `studio/${post.id}/6.png`] }, T0);
    for (let i = 1; i <= 6; i++) await env.RAW.put(`studio/${post.id}/${i}.png`, new Uint8Array([9]));
    const f = fakePng();
    const keys = await renderPostImages(withBrowser, post.id, f.png);
    // cover + 3 tips + close
    expect(keys).toEqual([1, 2, 3, 4, 5].map((n) => `studio/${post.id}/${n}.png`));
    expect(f.calls).toHaveLength(5);
    expect(f.calls[0].binding).toBe(BROWSER);
    expect(f.calls[0].o).toEqual({ width: 1080, height: 1350 });
    expect(f.calls[0].html).toContain("Five fixes");
    for (const [i, k] of keys.entries()) {
      const obj = await env.RAW.get(k);
      expect(obj, k).not.toBeNull();
      expect(obj!.httpMetadata?.contentType).toBe("image/png");
      expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, i + 1]);
    }
    expect((await getPost(env.DB, post.id))!.imageKeys).toEqual(keys);
    // the sixth slide of the old render is gone
    expect(await env.RAW.get(`studio/${post.id}/6.png`)).toBeNull();
  });

  it("a before_after post carries the uploaded images into its image slide", async () => {
    const post = await createPost(env.DB, { kind: "before_after", source: {}, anonymize: false }, T0);
    await patchPost(env.DB, post.id, { copy: COPY }, T0);
    await storeUpload(env, post.id, "before", { type: "image/png", bytes: PNG_BYTES });
    await storeUpload(env, post.id, "after", { type: "image/jpeg", bytes: JPG_BYTES });
    const f = fakePng();
    const keys = await renderPostImages(withBrowser, post.id, f.png);
    expect(keys).toHaveLength(2);
    expect(f.calls[1].html).toContain("data:image/png;base64,iVBORw0KGgoBAgME");
    expect(f.calls[1].html).toContain("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("a missing BROWSER binding gives a plain sentence and keeps the old keys", async () => {
    const post = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: false }, T0);
    const old = [`studio/${post.id}/1.png`];
    await patchPost(env.DB, post.id, { copy: COPY, imageKeys: old }, T0);
    await env.RAW.put(old[0], new Uint8Array([9]));
    const f = fakePng();
    await expect(renderPostImages({ ...env, BROWSER: undefined } as typeof env, post.id, f.png)).rejects.toThrow(/browser/i);
    await expect(renderPostImages({ ...env, BROWSER: undefined } as typeof env, post.id, f.png)).rejects.toThrow(/^[A-Z][^<>{}]*\.$/);
    expect(f.calls).toHaveLength(0);
    expect((await getPost(env.DB, post.id))!.imageKeys).toEqual(old);
    expect(await env.RAW.get(old[0])).not.toBeNull();
  });

  it("a renderer failure part-way keeps the old keys and objects", async () => {
    const post = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: false }, T0);
    const old = [`studio/${post.id}/1.png`];
    await patchPost(env.DB, post.id, { copy: COPY, imageKeys: old }, T0);
    await env.RAW.put(old[0], new Uint8Array([9]));
    let n = 0;
    const png = async () => { if (++n === 3) throw new Error("boom"); return new Uint8Array([1]); };
    await expect(renderPostImages(withBrowser, post.id, png)).rejects.toThrow("boom");
    expect((await getPost(env.DB, post.id))!.imageKeys).toEqual(old);
    expect([...new Uint8Array(await (await env.RAW.get(old[0]))!.arrayBuffer())]).toEqual([9]);
  });

  it("a post that does not exist, has no copy, or lacks its before/after images gets a plain sentence", async () => {
    await expect(renderPostImages(withBrowser, "nope", fakePng().png)).rejects.toThrow(/post/i);
    const bare = await createPost(env.DB, { kind: "audit_tip", source: {}, anonymize: false }, T0);
    await expect(renderPostImages(withBrowser, bare.id, fakePng().png)).rejects.toThrow(/copy/i);
    const ba = await createPost(env.DB, { kind: "before_after", source: {}, anonymize: false }, T0);
    await patchPost(env.DB, ba.id, { copy: COPY }, T0);
    await expect(renderPostImages(withBrowser, ba.id, fakePng().png)).rejects.toThrow(/before and after/i);
  });
});

describe("storeUpload", () => {
  it("storeUpload refuses text/html, a file over 1 MB and a file whose bytes are not the claimed type", async () => {
    const post = await createPost(env.DB, { kind: "before_after", source: {}, anonymize: false }, T0);
    const refuse = async (file: { type: string; bytes: Uint8Array }, re: RegExp) => {
      const err = await storeUpload(env, post.id, "before", file).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(StudioUploadError);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).toMatch(/^[A-Z][^<>{}]*\.$/);
    };
    await refuse({ type: "text/html", bytes: new TextEncoder().encode("<html></html>") }, /PNG, JPEG or WebP/);
    await refuse({ type: "image/gif", bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) }, /PNG, JPEG or WebP/);
    const big = new Uint8Array(1024 * 1024 + 1); big.set(PNG_BYTES);
    await refuse({ type: "image/png", bytes: big }, /1 MB/);
    await refuse({ type: "image/png", bytes: JPG_BYTES }, /does not look like/);
    await refuse({ type: "image/jpeg", bytes: PNG_BYTES }, /does not look like/);
    await refuse({ type: "image/webp", bytes: PNG_BYTES }, /does not look like/);
    await refuse({ type: "image/png", bytes: new Uint8Array() }, /empty/);
    expect(await env.RAW.get(`studio/${post.id}/before`)).toBeNull();
    // exactly 1 MB is fine
    const edge = new Uint8Array(1024 * 1024); edge.set(PNG_BYTES);
    expect(await storeUpload(env, post.id, "after", { type: "image/png", bytes: edge })).toBe(`studio/${post.id}/after`);
  });

  it("storeUpload keeps a valid png under studio/<postId>/before", async () => {
    const post = await createPost(env.DB, { kind: "before_after", source: {}, anonymize: false }, T0);
    const key = await storeUpload(env, post.id, "before", { type: "image/png", bytes: PNG_BYTES });
    expect(key).toBe(`studio/${post.id}/before`);
    const obj = await env.RAW.get(key);
    expect(obj!.httpMetadata?.contentType).toBe("image/png");
    expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([...PNG_BYTES]);
    expect(await storeUpload(env, post.id, "before", { type: "image/jpeg", bytes: JPG_BYTES })).toBe(key);
    expect((await env.RAW.get(key))!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(await storeUpload(env, post.id, "after", { type: "image/webp", bytes: WEBP_BYTES })).toBe(`studio/${post.id}/after`);
  });

  it("a post id that could change the key is refused", async () => {
    await expect(storeUpload(env, "../x", "before", { type: "image/png", bytes: PNG_BYTES })).rejects.toBeInstanceOf(StudioUploadError);
  });
});
