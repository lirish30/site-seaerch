import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { insertDraft } from "../src/worker/db/drafts";
import { queuesOf } from "../src/worker/routes/outreach";

let cookie = "";
const get = (path: string) => SELF.fetch(`https://x${path}`, { headers: { cookie } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

describe("queuesOf", () => {
  const d = { id: "d" };
  it("puts an untouched lead with a draft in Drafts ready", () => {
    expect(queuesOf({ lead_status: "new", follow_up_at: null }, d, "2026-10-15")).toEqual(["drafts"]);
    expect(queuesOf({ lead_status: "new", follow_up_at: null }, null, "2026-10-15")).toEqual([]);
  });
  it("moves a lead on once it is contacted or has replied", () => {
    expect(queuesOf({ lead_status: "contacted", follow_up_at: null }, d, "2026-10-15")).toEqual(["contacted"]);
    expect(queuesOf({ lead_status: "replied", follow_up_at: null }, d, "2026-10-15")).toEqual(["replied"]);
  });
  it("lists a due follow-up whether or not there is a draft, but not for closed deals", () => {
    expect(queuesOf({ lead_status: "contacted", follow_up_at: "2026-10-15" }, null, "2026-10-15")).toEqual(["followups"]);
    expect(queuesOf({ lead_status: "contacted", follow_up_at: "2026-10-16" }, null, "2026-10-15")).toEqual([]);
    expect(queuesOf({ lead_status: "won", follow_up_at: "2026-10-01" }, null, "2026-10-15")).toEqual([]);
  });
});

describe("GET /api/outreach", () => {
  it("returns each queue's leads with their current draft and counts for every queue", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const mk = async (name: string) => (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id)).id;
    const base = { audit_id: null, to_contact_id: null, recipient_reason: "x", offer: "new_site", steering_note: null };
    const a = await mk("Has FT draft"), b = await mk("Has freelance draft"), c = await mk("No draft");
    await insertDraft(env.DB, { ...base, business_id: a, subject: "S1", body: "B1", purpose: "full_time" } as never);
    await insertDraft(env.DB, { ...base, business_id: b, subject: "S2", body: "B2", purpose: "freelance" } as never);
    const all = await (await get("/api/outreach")).json<any>();
    const names = all.items.map((i: any) => i.row.business.name);
    expect(names).toEqual(expect.arrayContaining(["Has FT draft", "Has freelance draft"]));
    expect(names).not.toContain("No draft");
    expect(all.items.find((i: any) => i.row.business.id === a).draft).toMatchObject({ subject: "S1", purpose: "full_time" });
    expect(all.counts.drafts).toBeGreaterThanOrEqual(2);
    const ft = await (await get("/api/outreach?view=drafts&purpose=full_time")).json<any>();
    expect(ft.items.every((i: any) => i.draft.purpose === "full_time")).toBe(true);
    expect(await (await get("/api/outreach?counts=1")).json<any>()).toEqual({ counts: all.counts });
    expect((await get("/api/outreach?purpose=nope")).status).toBe(400);
    void c;
  });
});
