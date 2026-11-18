import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_KIND_ORDER, parseKindOrder, pickRole, postingState } from "../src/worker/jobs/select";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { buildToday } from "../src/worker/today";
import { kindOrder, moveKind } from "../src/client/jobsView";
import type { JobPosting, RoleKind } from "../src/worker/types";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const post = (id: string, o: Partial<JobPosting> = {}): JobPosting => ({ id, business_id: "b", external_id: id, title: id, url: `https://x.example/${id}`, location: null, department: null,
  role_kind: "seo", posted_at: null, first_seen_at: ago(1), last_seen_at: ago(0), closed_at: null, baseline: false, ...o });
const pick = (ps: JobPosting[], order: RoleKind[] = DEFAULT_KIND_ORDER) => pickRole(ps, order, NOW.getTime())?.id ?? null;

describe("parseKindOrder", () => {
  it("keeps a full ranking as given", () => expect(parseKindOrder("marketing,seo,cro,design,web_dev")).toEqual(["marketing", "seo", "cro", "design", "web_dev"]));
  it("drops unknown and repeated kinds and puts missing ones last in the default order", () => {
    expect(parseKindOrder("seo, bogus,seo,design")).toEqual(["seo", "design", "web_dev", "cro", "marketing"]);
    expect(parseKindOrder("")).toEqual(DEFAULT_KIND_ORDER);
    expect(parseKindOrder(null)).toEqual(DEFAULT_KIND_ORDER);
  });
});

describe("postingState", () => {
  it("is open only when not closed and seen within 48 hours", () => {
    const t = NOW.getTime();
    expect(postingState(post("a", { last_seen_at: ago(1.9) }), t)).toBe("open");
    expect(postingState(post("a", { last_seen_at: ago(2.1) }), t)).toBe("unseen");
    expect(postingState(post("a", { closed_at: ago(0) }), t)).toBe("closed");
    expect(postingState(post("a", { last_seen_at: "garbage" }), t)).toBe("unseen");
  });
});

describe("pickRole", () => {
  it("ranks by kind before age: an older web_dev role beats a brand-new marketing one", () => {
    expect(pick([post("growth", { role_kind: "marketing", posted_at: ago(0) }), post("dev", { role_kind: "web_dev", posted_at: ago(20) })])).toBe("dev");
  });
  it("follows the owner's order", () => {
    const ps = [post("growth", { role_kind: "marketing" }), post("dev", { role_kind: "web_dev" })];
    expect(pick(ps, parseKindOrder("marketing"))).toBe("growth");
  });
  it("within a kind takes the newest by the board's date, else first seen, and breaks exact ties by id", () => {
    expect(pick([post("old", { posted_at: ago(9) }), post("new", { posted_at: ago(2) })])).toBe("new");
    expect(pick([post("dated", { posted_at: ago(5) }), post("seen", { first_seen_at: ago(1) })])).toBe("seen");
    expect(pick([post("b", { posted_at: ago(2) }), post("a", { posted_at: ago(2) })])).toBe("a");
  });
  it("never picks a closed role, an unseen one, or one outside the field", () => {
    expect(pick([post("closed", { role_kind: "web_dev", closed_at: ago(0) }), post("unseen", { role_kind: "web_dev", last_seen_at: ago(3) }), post("off", { role_kind: null })])).toBeNull();
    expect(pick([post("closed", { role_kind: "web_dev", closed_at: ago(0) }), post("ok", { role_kind: "design" })])).toBe("ok");
  });
  it("sorts an unreadable date as oldest", () => {
    expect(pick([post("bad", { first_seen_at: "garbage" }), post("good", { first_seen_at: ago(30) })])).toBe("good");
  });
});

describe("client ranking helpers", () => {
  it("kindOrder mirrors the server and moveKind swaps neighbours", () => {
    expect(kindOrder("seo,bogus")).toEqual(["seo", "web_dev", "cro", "design", "marketing"]);
    expect(kindOrder(undefined)).toHaveLength(5);
    expect(moveKind(["seo", "cro"], 1, -1)).toEqual(["cro", "seo"]);
    expect(moveKind(["seo", "cro"], 0, -1)).toEqual(["seo", "cro"]);
  });
});

beforeEach(async () => {
  for (const t of ["activity", "drafts", "audits", "search_results", "businesses", "suppressions", "job_postings"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await saveSettings(env.DB, { role_kind_order: DEFAULT_KIND_ORDER.join(",") });
});

let searchId = "";
async function lead(name: string) {
  if (!searchId) searchId = (await createSearch(env.DB, { location: "Boise", businessType: "agency", radiusKm: 10, maxResults: 5 })).id;
  return (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, searchId)).id;
}
const insert = (businessId: string, title: string, kind: RoleKind, o: { posted?: string; lastSeen?: string; closed?: string | null } = {}) => env.DB.prepare(
  `INSERT INTO job_postings (id, business_id, external_id, title, url, role_kind, posted_at, first_seen_at, last_seen_at, closed_at, baseline) VALUES (?,?,?,?,?,?,?,?,?,?,0)`)
  .bind(crypto.randomUUID(), businessId, crypto.randomUUID(), title, "https://x.example/1", kind, o.posted ?? null, o.posted ?? ago(1), o.lastSeen ?? ago(0), o.closed ?? null).run();
const roles = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "open_role");

describe("Today uses the same pick", () => {
  it("names the higher-ranked kind even when a lower-ranked role is fresher", async () => {
    const id = await lead("Acme");
    await insert(id, "Growth Equity Analyst", "marketing", { posted: ago(0) });
    await insert(id, "WordPress Developer", "web_dev", { posted: ago(45) });
    expect((await roles()).map((i) => i.reason)).toEqual(["Hiring: WordPress Developer. Open for 45 days"]);
  });

  it("follows the role priority setting", async () => {
    const id = await lead("Acme");
    await insert(id, "Growth Marketer", "marketing", { posted: ago(0) });
    await insert(id, "WordPress Developer", "web_dev", { posted: ago(45) });
    await saveSettings(env.DB, { role_kind_order: "marketing,web_dev,cro,seo,design" });
    expect((await roles()).map((i) => i.reason)).toEqual(["Hiring: Growth Marketer. Posted today"]);
  });

  it("shows nothing when the top-ranked role is 4-29 days old, rather than promoting a lower-ranked one", async () => {
    const id = await lead("Acme");
    await insert(id, "WordPress Developer", "web_dev", { posted: ago(10) });
    await insert(id, "Growth Marketer", "marketing", { posted: ago(0) });
    expect(await roles()).toEqual([]);
  });

  it("ignores a top-ranked role the board has not shown in 2 days", async () => {
    const id = await lead("Acme");
    await insert(id, "WordPress Developer", "web_dev", { posted: ago(1), lastSeen: ago(3) });
    await insert(id, "SEO Manager", "seo", { posted: ago(1) });
    expect((await roles()).map((i) => i.reason)).toEqual(["Hiring: SEO Manager. Posted 1 day ago"]);
  });
});
