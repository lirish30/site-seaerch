import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { seedBusiness, seedLeadAudit } from "./fixtures/cro";
import { getCareerSource, listPostingsForLead, saveCareerSource } from "../src/worker/db/jobs";
import { listActivity } from "../src/worker/db/activity";
import { checkLead, discoverSource, syncSource, type JobDeps } from "../src/worker/jobs/sync";

const H = 3_600_000;
const T0 = new Date("2026-10-14T12:00:00.000Z");
const at = (hours: number) => new Date(T0.getTime() + hours * H);

const gh = (...titles: string[]) => ({ jobs: titles.map((t, i) => ({ id: i + 1, title: t, absolute_url: `https://boards.greenhouse.io/acme/jobs/${i + 1}` })) });
interface Hit { url: string }
/** A fake internet: exact URL -> a Response factory. Anything else is a 404. Records every call. */
function net(routes: Record<string, () => Response>) {
  const hits: Hit[] = [];
  const f = async (url: string) => { hits.push({ url }); return routes[url]?.() ?? new Response("nope", { status: 404 }); };
  return { f, hits };
}
const ok = (body: unknown) => () => Response.json(body);
const html = (s: string) => () => new Response(s, { headers: { "content-type": "text/html" } });
const deps = (f: JobDeps["fetch"], now: Date): JobDeps => ({ db: env.DB, fetch: f, now: () => now, userAgent: "UA" });
const GH = "https://boards-api.greenhouse.io/v1/boards/acme/jobs";

beforeEach(async () => { for (const t of ["job_postings", "career_sources", "audits", "activity"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

async function leadWithCareers(careers: string | null) {
  const b = await seedBusiness();
  await seedLeadAudit(b.id);
  if (careers !== null) await env.DB.prepare(`UPDATE audits SET site_links = ? WHERE business_id = ?`).bind(JSON.stringify({ careers }), b.id).run();
  return b;
}
const source = async (id: string) => (await getCareerSource(env.DB, id))!;

describe("discoverSource", () => {
  it("does nothing for a lead that has not been scanned yet, so a later tick retries", async () => {
    const b = await seedBusiness();
    expect(await discoverSource(deps(net({}).f, T0), b.id)).toBeNull();
    expect(await getCareerSource(env.DB, b.id)).toBeNull();
  });

  it("records 'none' for 30 days when the site has no careers link", async () => {
    const b = await leadWithCareers(null);
    const n = net({});
    const s = (await discoverSource(deps(n.f, T0), b.id))!;
    expect([s.status, s.next_check_at]).toEqual(["none", at(30 * 24).toISOString()]);
    expect(n.hits).toHaveLength(0);
  });

  it("uses a board named directly in the careers link, then syncs it as the baseline", async () => {
    const b = await leadWithCareers("https://boards.greenhouse.io/acme");
    const n = net({ [GH]: ok(gh("SEO Manager", "Welder")) });
    const s = (await discoverSource(deps(n.f, T0), b.id))!;
    expect(n.hits.map((h) => h.url)).toEqual([GH]);
    expect([s.status, s.ats, s.token, s.last_ok_at]).toEqual(["active", "greenhouse", "acme", T0.toISOString()]);
    const posts = await listPostingsForLead(env.DB, b.id);
    expect(posts.map((p) => [p.title, p.role_kind, p.baseline])).toEqual(expect.arrayContaining([["SEO Manager", "seo", true], ["Welder", null, true]]));
    expect(await listActivity(env.DB, b.id)).toEqual([]); // baseline roles are not announced
  });

  it("opens the careers page to look for an embedded board", async () => {
    const b = await leadWithCareers("https://acme.com/careers");
    const n = net({ "https://acme.com/careers": html(`<a href="https://jobs.lever.co/acme">Open roles</a>`), "https://api.lever.co/v0/postings/acme?mode=json": ok([]) });
    const s = (await discoverSource(deps(n.f, T0), b.id))!;
    expect([s.status, s.ats, s.token]).toEqual(["active", "lever", "acme"]);
  });

  it("records 'none' when the page names no supported board, and 'error' (retry in 24h) when the page cannot be read", async () => {
    const a = await leadWithCareers("https://acme.com/careers");
    expect((await discoverSource(deps(net({ "https://acme.com/careers": html("<p>Email us your CV</p>") }).f, T0), a.id))!.status).toBe("none");
    const c = await leadWithCareers("https://beta.com/jobs");
    const boom = deps(async () => { throw new Error("connection reset"); }, T0);
    const s = (await discoverSource(boom, c.id))!;
    expect([s.status, s.last_error, s.next_check_at]).toEqual(["error", "connection reset", at(24).toISOString()]);
  });

  it("does not fetch a careers link that is not a public https address", async () => {
    const b = await leadWithCareers("http://169.254.169.254/latest/meta-data");
    const n = net({});
    const s = (await discoverSource(deps(n.f, T0), b.id))!;
    expect([s.status, s.careers_url]).toEqual(["none", null]);
    expect(n.hits).toHaveLength(0);
  });

  it("retries in 24h when the careers page answers 503 or 429, but a 403 is the site's answer and parks for 30 days", async () => {
    for (const code of [503, 429]) {
      const b = await leadWithCareers("https://acme.com/careers");
      const s = (await discoverSource(deps(net({ "https://acme.com/careers": () => new Response("busy", { status: code }) }).f, T0), b.id))!;
      expect([s.status, s.next_check_at]).toEqual(["error", at(24).toISOString()]);
      expect(s.last_error).toContain(String(code));
    }
    const b = await leadWithCareers("https://acme.com/careers");
    const s = (await discoverSource(deps(net({ "https://acme.com/careers": () => new Response("no", { status: 403 }) }).f, T0), b.id))!;
    expect([s.status, s.last_error, s.next_check_at]).toEqual(["none", null, at(30 * 24).toISOString()]);
  });

  it("records 'none' when the board named by the page does not exist", async () => {
    const b = await leadWithCareers("https://boards.greenhouse.io/acme");
    const s = (await discoverSource(deps(net({}).f, T0), b.id))!; // GH answers 404
    expect(s.status).toBe("none");
  });
});

describe("rediscovery", () => {
  const board = "https://boards.greenhouse.io/acme";
  /** A lead synced once (Welder as baseline) whose board then answered 404 and was parked 'none'. */
  async function parkedAfter404() {
    const b = await leadWithCareers(board);
    await discoverSource(deps(net({ [GH]: ok(gh("Welder")) }).f, T0), b.id);
    await syncSource(deps(net({}).f, at(12)), await source(b.id));
    expect((await source(b.id)).status).toBe("none");
    return b;
  }

  it("a board found again after a gap keeps its history, so a role that appeared meanwhile is announced", async () => {
    const b = await parkedAfter404();
    const s = (await discoverSource(deps(net({ [GH]: ok(gh("Welder", "SEO Manager")) }).f, at(30 * 24 + 12)), b.id))!;
    expect(s.status).toBe("active");
    const posts = await listPostingsForLead(env.DB, b.id);
    expect(posts.find((p) => p.title === "SEO Manager")!.baseline).toBe(false);
    expect((await listActivity(env.DB, b.id)).map((a) => [a.kind, a.detail])).toEqual([["job_found", "SEO Manager"]]);
  });

  it("a different board starts over: its roles are baseline and nothing is announced", async () => {
    const b = await parkedAfter404();
    await env.DB.prepare(`UPDATE audits SET site_links = ? WHERE business_id = ?`).bind(JSON.stringify({ careers: "https://boards.greenhouse.io/other" }), b.id).run();
    const other = "https://boards-api.greenhouse.io/v1/boards/other/jobs";
    const s = (await discoverSource(deps(net({ [other]: ok(gh("SEO Manager")) }).f, at(30 * 24 + 12)), b.id))!;
    expect([s.token, s.last_ok_at]).toEqual(["other", at(30 * 24 + 12).toISOString()]);
    expect((await listPostingsForLead(env.DB, b.id)).find((p) => p.title === "SEO Manager")!.baseline).toBe(true);
    expect(await listActivity(env.DB, b.id)).toEqual([]);
  });

  it("parking a lead that already had a board keeps the board, the last good look and the streak", async () => {
    const b = await parkedAfter404();
    const before = await source(b.id);
    await env.DB.prepare(`UPDATE career_sources SET empty_streak = 1 WHERE business_id = ?`).bind(b.id).run();
    await env.DB.prepare(`UPDATE audits SET site_links = ? WHERE business_id = ?`).bind(JSON.stringify({ careers: "https://acme.com/careers" }), b.id).run();
    const s = (await discoverSource(deps(net({ "https://acme.com/careers": () => new Response("busy", { status: 503 }) }).f, at(30 * 24 + 12)), b.id))!;
    expect([s.status, s.ats, s.token, s.last_ok_at, s.empty_streak]).toEqual(["error", "greenhouse", "acme", before.last_ok_at, 1]);
    expect(before.last_ok_at).toBe(T0.toISOString());
  });
});

describe("syncSource", () => {
  async function active(id: string, over: Partial<Parameters<typeof saveCareerSource>[1]> = {}) {
    await saveCareerSource(env.DB, { business_id: id, status: "active", ats: "greenhouse", token: "acme", careers_url: "https://boards.greenhouse.io/acme", checked_at: T0.toISOString(), next_check_at: T0.toISOString(), ...over });
    return source(id);
  }

  it("announces a new role in the field once, after the baseline", async () => {
    const b = await seedBusiness();
    await syncSource(deps(net({ [GH]: ok(gh("Welder")) }).f, T0), await active(b.id));
    const r = await syncSource(deps(net({ [GH]: ok(gh("Welder", "CRO Analyst", "Cook")) }).f, at(12)), await source(b.id));
    expect([r.added, r.relevantAdded]).toEqual([2, 1]);
    const log = await listActivity(env.DB, b.id);
    expect(log.map((a) => [a.kind, a.detail])).toEqual([["job_found", "CRO Analyst"]]);
    const again = await syncSource(deps(net({ [GH]: ok(gh("Welder", "CRO Analyst", "Cook")) }).f, at(24)), await source(b.id));
    expect(again.relevantAdded).toBe(0);
    expect(await listActivity(env.DB, b.id)).toHaveLength(1);
  });

  it("a board with no roles is not a first look: the next role that appears is new, not baseline", async () => {
    const b = await seedBusiness();
    await syncSource(deps(net({ [GH]: ok({ jobs: [] }) }).f, T0), await active(b.id));
    expect((await source(b.id)).last_ok_at).toBe(T0.toISOString());
    const r = await syncSource(deps(net({ [GH]: ok(gh("SEO Manager")) }).f, at(12)), await source(b.id));
    expect(r.relevantAdded).toBe(1);
    expect((await listPostingsForLead(env.DB, b.id))[0].baseline).toBe(false);
  });

  it("one empty answer closes nothing; two in a row close everything; recovery reopens without announcing", async () => {
    const b = await seedBusiness();
    await syncSource(deps(net({ [GH]: ok(gh("SEO Manager")) }).f, T0), await active(b.id));
    const empty = net({ [GH]: ok({ jobs: [] }) });
    await syncSource(deps(empty.f, at(12)), await source(b.id));
    expect((await source(b.id)).empty_streak).toBe(1);
    expect((await listPostingsForLead(env.DB, b.id))[0].closed_at).toBeNull();
    const second = await syncSource(deps(empty.f, at(24)), await source(b.id));
    expect(second.closed).toBe(1);
    expect((await listPostingsForLead(env.DB, b.id))[0].closed_at).toBe(at(24).toISOString());
    const back = await syncSource(deps(net({ [GH]: ok(gh("SEO Manager")) }).f, at(36)), await source(b.id));
    expect(back.relevantAdded).toBe(0);
    expect((await source(b.id)).empty_streak).toBe(0);
    expect((await listPostingsForLead(env.DB, b.id))[0].closed_at).toBeNull();
    expect(await listActivity(env.DB, b.id)).toEqual([]);
  });

  it("an error closes nothing, keeps the board active, and retries in 24 hours", async () => {
    const b = await seedBusiness();
    await syncSource(deps(net({ [GH]: ok(gh("SEO Manager")) }).f, T0), await active(b.id));
    const r = await syncSource(deps(net({ [GH]: () => new Response("bad gateway", { status: 502 }) }).f, at(12)), await source(b.id));
    expect(r.error).toMatch(/502/);
    const s = await source(b.id);
    expect([s.status, s.next_check_at, s.empty_streak, s.last_ok_at]).toEqual(["active", at(36).toISOString(), 0, T0.toISOString()]);
    expect((await listPostingsForLead(env.DB, b.id))[0].closed_at).toBeNull();
  });

  it("a board that has gone away is parked as 'none' for 30 days", async () => {
    const b = await seedBusiness();
    await syncSource(deps(net({}).f, T0), await active(b.id)); // GH answers 404
    const s = await source(b.id);
    expect([s.status, s.next_check_at]).toEqual(["none", at(30 * 24).toISOString()]);
  });

  it("schedules the next look 12 hours out after a good answer", async () => {
    const b = await seedBusiness();
    await syncSource(deps(net({ [GH]: ok(gh("SEO Manager")) }).f, T0), await active(b.id));
    expect((await source(b.id)).next_check_at).toBe(at(12).toISOString());
  });
});

describe("checkLead", () => {
  it("re-syncs an active board and discovers otherwise", async () => {
    const b = await leadWithCareers("https://boards.greenhouse.io/acme");
    const n = net({ [GH]: ok(gh("SEO Manager")) });
    expect((await checkLead(deps(n.f, T0), b.id))!.status).toBe("active");
    const s2 = (await checkLead(deps(n.f, at(1)), b.id))!;
    expect(s2.checked_at).toBe(at(1).toISOString());
    expect(n.hits.map((h) => h.url)).toEqual([GH, GH]);
  });
});
