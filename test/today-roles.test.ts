import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { addSuppression } from "../src/worker/db/suppression";
import { buildToday, MAX_ROLE_ITEMS } from "../src/worker/today";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

beforeEach(async () => {
  for (const t of ["activity", "drafts", "audits", "search_results", "businesses", "suppressions", "job_postings"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

let searchId = "";
async function lead(name: string, o: { status?: string; archived?: boolean; website?: string; dealValue?: number } = {}) {
  if (!searchId) searchId = (await createSearch(env.DB, { location: "Boise", businessType: "agency", radiusKm: 10, maxResults: 5 })).id;
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: o.website ?? null, mapsUrl: null, rating: null, reviewCount: null }, searchId);
  await env.DB.prepare(`UPDATE businesses SET lead_status = ?, archived_at = ?, deal_value = ? WHERE id = ?`).bind(o.status ?? "new", o.archived ? ago(1) : null, o.dealValue ?? null, b.id).run();
  return b.id;
}
interface P { title?: string; kind?: string | null; posted?: string | null; firstSeen?: string; baseline?: number; closed?: string | null; lastSeen?: string }
const posting = (businessId: string, o: P = {}) => env.DB.prepare(
  `INSERT INTO job_postings (id, business_id, external_id, title, url, role_kind, posted_at, first_seen_at, last_seen_at, closed_at, baseline) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(crypto.randomUUID(), businessId, crypto.randomUUID(), o.title ?? "SEO Manager", "https://x.example/1", o.kind === undefined ? "seo" : o.kind, o.posted ?? null, o.firstSeen ?? ago(1), o.lastSeen ?? ago(0), o.closed ?? null, o.baseline ?? 0).run();
const act = (businessId: string, kind: string, createdAt: string, detail: string | null = null) => env.DB.prepare(
  `INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), businessId, kind, detail, createdAt).run();
const roles = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "open_role");

describe("open_role", () => {
  it("lists a role the board dated in the last 3 days as fresh (95)", async () => {
    const id = await lead("Acme");
    await posting(id, { title: "SEO Manager", posted: ago(1) });
    const [it] = await roles();
    expect([it.businessId, it.priority, it.reason]).toEqual([id, 95, "Hiring: SEO Manager. Posted 1 day ago"]);
  });

  it("says 'Posted today' for a role dated today", async () => {
    await posting(await lead("Acme"), { posted: ago(0) });
    expect((await roles())[0].reason).toBe("Hiring: SEO Manager. Posted today");
  });

  it("with no date from the board, a role first seen after the first look is fresh and says 'First seen'", async () => {
    await posting(await lead("Acme"), { firstSeen: ago(2), baseline: 0 });
    const [it] = await roles();
    expect([it.priority, it.reason]).toEqual([95, "Hiring: SEO Manager. First seen 2 days ago"]);
  });

  it("lists a role open for 30+ days as long-open (75)", async () => {
    await posting(await lead("Acme"), { posted: ago(45) });
    const [it] = await roles();
    expect([it.priority, it.reason]).toEqual([75, "Hiring: SEO Manager. Open for 45 days"]);
  });

  it("shows nothing for a role between 4 and 29 days old", async () => {
    await posting(await lead("Acme"), { posted: ago(10) });
    expect(await roles()).toEqual([]);
  });

  it("shows nothing for a baseline role the board did not date: its age is unknown", async () => {
    await posting(await lead("Acme"), { firstSeen: ago(0), baseline: 1 });
    await posting(await lead("Beta"), { firstSeen: ago(60), baseline: 1 });
    expect(await roles()).toEqual([]);
  });

  it("uses the board's date even for a baseline role", async () => {
    await posting(await lead("Acme"), { posted: ago(50), baseline: 1 });
    expect((await roles())[0].priority).toBe(75);
  });

  it("ignores closed roles and roles outside the field", async () => {
    const id = await lead("Acme");
    await posting(id, { posted: ago(1), closed: ago(0) });
    await posting(id, { posted: ago(1), kind: null, title: "Welder" });
    expect(await roles()).toEqual([]);
  });

  it("ignores a role the board has not shown us in the last 48 hours, even if never marked closed", async () => {
    await posting(await lead("Acme"), { posted: ago(1), lastSeen: ago(3) });
    expect(await roles()).toEqual([]);
  });

  it("one item per lead: the freshest role wins over a long-open one", async () => {
    const id = await lead("Acme");
    await posting(id, { title: "Old Role", posted: ago(60) });
    await posting(id, { title: "New Role", posted: ago(1) });
    const r = await roles();
    expect(r).toHaveLength(1);
    expect(r[0].reason).toContain("New Role");
  });

  it("only for leads not yet contacted; archived and suppressed leads get nothing", async () => {
    await posting(await lead("Contacted", { status: "contacted" }), { posted: ago(1) });
    await posting(await lead("Won", { status: "won" }), { posted: ago(1) });
    await posting(await lead("Archived", { archived: true }), { posted: ago(1) });
    await posting(await lead("Blocked", { website: "https://blocked.example" }), { posted: ago(1) });
    await addSuppression(env.DB, { kind: "domain", value: "blocked.example", reason: "client" });
    await posting(await lead("Reviewed", { status: "reviewed" }), { posted: ago(1) });
    expect((await roles()).map((i) => i.businessName)).toEqual(["Reviewed"]);
  });

  it("Done hides it for a week and Snooze for as long as asked", async () => {
    const a = await lead("Acme"), b = await lead("Beta");
    await posting(a, { posted: ago(1) }); await posting(b, { posted: ago(1) });
    await act(a, "today_done", ago(1), "open_role");
    await act(b, "snoozed", ago(0), `open_role|${new Date(NOW.getTime() + DAY).toISOString()}`);
    expect(await roles()).toEqual([]);
  });

  it("caps the list and keeps the freshest first", async () => {
    for (let i = 0; i < MAX_ROLE_ITEMS + 3; i++) await posting(await lead(`L${i}`), { posted: ago(i % 3) });
    const r = await roles();
    expect(r).toHaveLength(MAX_ROLE_ITEMS);
    expect(r.every((i) => i.priority === 95)).toBe(true);
  });

  it("a job_found row is not contact with the prospect: a quiet deal still shows as stalled", async () => {
    const id = await lead("Deal", { status: "contacted", dealValue: 500 });
    await act(id, "status", ago(20), "contacted");
    await act(id, "job_found", ago(1), "SEO Manager");
    expect((await buildToday(env.DB, NOW)).some((i) => i.kind === "stalled_deal" && i.businessId === id)).toBe(true);
  });
});
