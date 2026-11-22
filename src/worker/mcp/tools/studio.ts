import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBusiness } from "../../db/businesses";
import { listPosts, type StudioStatus } from "../../db/studio";
import type { ToolCtx } from "./context";

const STATUSES = ["draft", "writing", "review", "approved", "posted", "discarded"] as const satisfies readonly StudioStatus[];

/** The words of a post's copy, or nulls while it has none. The copy is stored as JSON Claude wrote, so each field is checked, not trusted. */
function wordsOf(copy: unknown): { headline: string | null; caption: string | null; tags: string[] } {
  const c = (copy && typeof copy === "object" ? copy : {}) as Record<string, unknown>;
  return {
    headline: typeof c.headline === "string" ? c.headline : null,
    caption: typeof c.caption === "string" ? c.caption : null,
    tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

/**
 * The Studio's posts, read only. The answer is built field by field: the kind, the status, the words, how many pictures are drawn, and the client's name only on a post that is not anonymous
 * (an anonymous post carries no client name and no client id). Never an R2 key, an approval id, a task id or the source's ids.
 */
export function registerStudioTools(server: McpServer, ctx: ToolCtx): void {
  const { db, log, text } = ctx;

  server.registerTool("get_studio_posts", {
    description: "The Studio's social posts, newest first: kind (before_after, audit_tip, case_study), status (draft, writing, review, approved, posted, discarded), the headline, the caption, the tags, how many slide images are drawn, whether the post is anonymous, and the client's name only when the post is not anonymous. Pass status to see only posts in that state. Read only: nothing is posted anywhere, and no image or file location is shown.",
    inputSchema: { status: z.enum(STATUSES).optional() },
  }, async ({ status }) => {
    const rows = await listPosts(db, status ? { status: [status] } : {});
    const posts = [];
    for (const p of rows) {
      const client = !p.anonymize && p.businessId ? ((await getBusiness(db, p.businessId))?.name ?? null) : null;
      posts.push({ id: p.id, kind: p.kind, status: p.status, anonymous: p.anonymize, client, ...wordsOf(p.copy), slides: p.imageKeys.length, postedOn: p.postedOn, createdAt: p.createdAt });
    }
    await log("get_studio_posts", `get_studio_posts${status ? ` ${status}` : ""} -> ${posts.length} ${posts.length === 1 ? "post" : "posts"}`);
    return text({ posts });
  });
}
