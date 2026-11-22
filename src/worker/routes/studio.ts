import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getPost, listPosts, type StudioPost } from "../db/studio";
import { StudioCopyResult } from "../queue/studioCopy";
import { htmlToPng } from "../render/render";
import { MAX_UPLOAD_BYTES, renderPostImages, storeUpload, StudioBrowserMissingError, StudioRenderError, StudioUploadError } from "../studio/images";
import { createStudioPost, discardStudioPost, markStudioPosted, queueStudioCopy, saveStudioCopy, StudioInputError, StudioStateError } from "../studio/service";

/** A post as the page sees it: the picture keys in R2 are never sent (the pictures come through the authenticated image route), only how many there are. */
export function postView(p: StudioPost) {
  const { imageKeys, ...rest } = p;
  return { ...rest, images: imageKeys.length };
}

const Create = z.object({
  kind: z.enum(["before_after", "audit_tip", "case_study"]),
  businessId: z.string().trim().min(1).max(100).optional(),
  auditId: z.string().trim().min(1).max(100).optional(),
  anonymize: z.boolean().optional(),
  agreed: z.boolean().optional(),
});

/** The only two uploads a post takes. A slot is checked here at runtime: a slot like `1.png` would overwrite a drawn slide. */
const SLOTS = ["before", "after"] as const;
const isSlot = (s: string): s is (typeof SLOTS)[number] => (SLOTS as readonly string[]).includes(s);

/** The Studio's routes (all behind the session, mounted under /api). The renderer is a dependency so a test can hand in a fake. */
export function studioRoutes(deps: { png?: typeof htmlToPng } = {}) {
  const app = new Hono<{ Bindings: Env }>();

  /** The post, or a 404 answer. */
  async function found(env: Env, id: string) {
    const post = await getPost(env.DB, id);
    return post ?? null;
  }
  const notFound = { error: "that post was not found" };

  /** Plain-sentence refusals (a post that cannot be made or changed) are 422, a post in the wrong state 409; anything else is a real fault and is left to the app's error handler. */
  const refuse = (c: { json: (b: unknown, s: 409 | 422 | 501) => Response }, e: unknown): Response => {
    if (e instanceof StudioInputError || e instanceof StudioUploadError) return c.json({ error: e.message }, 422);
    if (e instanceof StudioStateError) return c.json({ error: e.message }, 409);
    if (e instanceof StudioBrowserMissingError) return c.json({ error: "Image drawing needs the Browser Rendering binding" }, 501);
    if (e instanceof StudioRenderError) return c.json({ error: e.message }, 422);
    throw e;
  };

  app.get("/", async (c) => c.json({ posts: (await listPosts(c.env.DB)).map(postView) }));

  app.post("/", async (c) => {
    const p = Create.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    try { return c.json(postView(await createStudioPost(c.env, p.data, new Date())), 201); }
    catch (e) { return refuse(c, e); }
  });

  app.post("/:id/write", async (c) => {
    if (!(await found(c.env, c.req.param("id")))) return c.json(notFound, 404);
    try { await queueStudioCopy(c.env, c.req.param("id")); }
    catch (e) { return refuse(c, e); }
    return c.json(postView((await getPost(c.env.DB, c.req.param("id")))!));
  });

  app.post("/:id/upload/:slot", async (c) => {
    const slot = c.req.param("slot");
    if (!isSlot(slot)) return c.json({ error: "The picture is either the before or the after." }, 422);
    const post = await found(c.env, c.req.param("id"));
    if (!post) return c.json(notFound, 404);
    if (post.kind !== "before_after") return c.json({ error: "Only a before and after post takes pictures." }, 422);
    if (post.status === "posted" || post.status === "discarded") return c.json({ error: "This post can no longer be changed." }, 409);
    let file: unknown;
    try { file = (await c.req.formData()).get("file"); } catch { return c.json({ error: "invalid body" }, 400); }
    if (!(file instanceof File)) return c.json({ error: "Choose an image file to upload." }, 422);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "That image is over 1 MB; shrink it and try again." }, 422);
    try { await storeUpload(c.env, post.id, slot, { type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }); }
    catch (e) { return refuse(c, e); }
    return c.json(postView((await getPost(c.env.DB, post.id))!));
  });

  app.post("/:id/render", async (c) => {
    const id = c.req.param("id");
    const post = await found(c.env, id);
    if (!post) return c.json(notFound, 404);
    if (post.status === "posted" || post.status === "discarded") return c.json({ error: "This post can no longer be changed." }, 409);
    try { await renderPostImages(c.env, id, deps.png ?? htmlToPng); }
    catch (e) {
      if (e instanceof StudioRenderError) return refuse(c, e);
      console.error("studio render failed", e instanceof Error ? e.message : "unknown error");
      return c.json({ error: "could not draw the images, please try again" }, 502);
    }
    return c.json(postView((await getPost(c.env.DB, id))!));
  });

  /** One drawn slide as a PNG. Only here does a picture leave the bucket, and only for a session; the number is an index into the post's own list, never a key. */
  app.get("/:id/image/:n", async (c) => {
    const post = await found(c.env, c.req.param("id"));
    const n = /^\d{1,2}$/.test(c.req.param("n")) ? Number(c.req.param("n")) : 0;
    const key = post && n >= 1 ? post.imageKeys[n - 1] : undefined;
    const obj = key ? await c.env.RAW.get(key) : null;
    if (!obj) return c.json({ error: "no such image" }, 404);
    return new Response(await obj.arrayBuffer(), { headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  });

  app.put("/:id/copy", async (c) => {
    const copy = StudioCopyResult.safeParse(await c.req.json().catch(() => ({})));
    if (!copy.success) return c.json({ error: copy.error.issues.map((i) => `${i.path.join(".") || "copy"}: ${i.message}`).join("; ") }, 422);
    if (!(await found(c.env, c.req.param("id")))) return c.json(notFound, 404);
    try { return c.json(postView(await saveStudioCopy(c.env, c.req.param("id"), copy.data, new Date()))); }
    catch (e) { return refuse(c, e); }
  });

  app.post("/:id/posted", async (c) => {
    if (!(await found(c.env, c.req.param("id")))) return c.json(notFound, 404);
    try { return c.json(postView(await markStudioPosted(c.env, c.req.param("id"), new Date()))); }
    catch (e) { return refuse(c, e); }
  });

  app.post("/:id/discard", async (c) => {
    if (!(await found(c.env, c.req.param("id")))) return c.json(notFound, 404);
    try { return c.json(postView(await discardStudioPost(c.env, c.req.param("id"), new Date()))); }
    catch (e) { return refuse(c, e); }
  });

  return app;
}
