import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { listActivity } from "../src/worker/db/activity";

let cookie = "";
const post = (path: string, body: unknown) =>
  SELF.fetch(`https://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { cookie, "content-type": "application/json" } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

async function lead() {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  return (await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Biz", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id)).id;
}

describe("POST /api/leads/:id/notes", () => {
  it("adds a trimmed note to the lead's activity", async () => {
    const id = await lead();
    const r = await post(`/api/leads/${id}/notes`, { text: "  Spoke to Dana. Quotes before Thanksgiving.  " });
    expect(r.status).toBe(201);
    const [a] = await listActivity(env.DB, id);
    expect(a).toMatchObject({ kind: "note", detail: "Spoke to Dana. Quotes before Thanksgiving." });
  });
  it("refuses an empty or oversized note and an unknown lead", async () => {
    const id = await lead();
    expect((await post(`/api/leads/${id}/notes`, { text: "   " })).status).toBe(400);
    expect((await post(`/api/leads/${id}/notes`, { text: "x".repeat(2001) })).status).toBe(400);
    expect((await post(`/api/leads/${id}/notes`, {})).status).toBe(400);
    expect((await post(`/api/leads/nope/notes`, { text: "hi" })).status).toBe(404);
    expect(await listActivity(env.DB, id)).toEqual([]);
  });
});
