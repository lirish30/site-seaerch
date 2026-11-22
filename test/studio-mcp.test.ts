import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createPost, patchPost, type StudioStatus } from "../src/worker/db/studio";
import { actionCount, mcp, ok, tool } from "./fixtures/mcp";
import { seedBusiness } from "./fixtures/cro";

// The read-only Studio tool (Plan 15, Task 10): kind, status, words and how many slides; never an R2 key, and never the client's name on an anonymous post.
const T0 = "2026-12-01T10:00:00.000Z";
const COPY = { headline: "Three fixes", caption: "Plain tips.", slides: [{ title: "One", body: "Do it." }], tags: ["plumber"] };
const KEY = "studio/KEY-SENTINEL/1.png";

beforeEach(async () => { await env.DB.prepare(`DELETE FROM studio_posts`).run(); });

async function made(o: { status: StudioStatus; anonymize: boolean; businessId?: string | null }) {
  const p = await createPost(env.DB, { kind: "audit_tip", businessId: o.businessId ?? null, source: { auditId: "a1" }, anonymize: o.anonymize }, T0);
  return (await patchPost(env.DB, p.id, { status: o.status, copy: COPY, imageKeys: [KEY, "studio/KEY-SENTINEL/2.png"], agreedAt: o.anonymize ? undefined : T0 }, T0))!;
}

type Answer = { posts: { id: string; kind: string; status: string; client: string | null; headline: string | null; caption: string | null; tags: string[]; slides: number; anonymous: boolean }[] };

describe("get_studio_posts", () => {
  it("is registered, which makes 32 tools in all", async () => {
    const names = (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_studio_posts");
    expect(names).toHaveLength(32);
  });

  it("hides the client name and any R2 key for an anonymous post", async () => {
    const b = await seedBusiness({ name: "Zed Roofing Sentinel" });
    await made({ status: "review", anonymize: true, businessId: b.id });
    const r = await tool("get_studio_posts", {});
    expect(r.isError).toBe(false);
    for (const bad of ["Zed Roofing Sentinel", b.id, "KEY-SENTINEL", "studio/", ".png"]) expect(r.text, bad).not.toContain(bad);
    const a = JSON.parse(r.text) as Answer;
    expect(a.posts).toHaveLength(1);
    expect(a.posts[0]).toMatchObject({ kind: "audit_tip", status: "review", anonymous: true, client: null, headline: "Three fixes", caption: "Plain tips.", tags: ["plumber"], slides: 2 });
    expect(Object.keys(a.posts[0])).not.toContain("imageKeys");
  });

  it("names the client only when the post is not anonymous", async () => {
    const b = await seedBusiness({ name: "Zed Roofing Sentinel" });
    await made({ status: "approved", anonymize: false, businessId: b.id });
    const r = await tool("get_studio_posts", {});
    expect(JSON.parse(r.text).posts[0]).toMatchObject({ client: "Zed Roofing Sentinel", anonymous: false });
    expect(r.text).not.toContain("KEY-SENTINEL");
  });

  it("filters by status", async () => {
    await made({ status: "review", anonymize: true });
    await made({ status: "approved", anonymize: true });
    await made({ status: "posted", anonymize: true });
    expect(((await ok("get_studio_posts", {})) as Answer).posts).toHaveLength(3);
    const approved = (await ok("get_studio_posts", { status: "approved" })) as Answer;
    expect(approved.posts.map((p) => p.status)).toEqual(["approved"]);
    expect((await tool("get_studio_posts", { status: "nonsense" })).isError).toBe(true);
  });

  it("the call is logged", async () => {
    await made({ status: "review", anonymize: true });
    const before = await actionCount("get_studio_posts");
    await ok("get_studio_posts", { status: "review" });
    expect(await actionCount("get_studio_posts")).toBe(before + 1);
    const row = await env.DB.prepare(`SELECT summary FROM agent_actions WHERE tool = 'get_studio_posts' ORDER BY rowid DESC LIMIT 1`).first<{ summary: string }>();
    expect(row!.summary).toContain("1 post");
  });
});
