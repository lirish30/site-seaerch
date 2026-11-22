import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelSeoReport, getSeoReport, insertSeoReport, markSeoSent, revokeSeoReport, setSeoSummary, setSeoTaskAndApproval, type SeoReport } from "../src/worker/db/seoReports";
import { newClientToken } from "../src/worker/documents/token";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { publicSeoReport } from "../src/worker/seo/reportPublic";
import { seedClient } from "./fixtures/clients";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const e = env as Env;
// 2026-12-02 03:30 UTC is still 1 December in Los Angeles: the day a report is "sent on" is the booking zone's.
const SENT_AT = "2026-12-02T03:30:00.000Z";
const NOW = new Date("2026-12-03T18:00:00.000Z");
const NOT_FOUND = { error: "not found" };
const SUMMARY = "In our check the business showed in the top three at two of nine points for drain cleaning.";
const RECOMMENDATION = "Ask recent customers to leave a review.";
const PRIORITIES = ["Answer the one low review", "Fix the address on the website", "Publish the water heater page"];
const nine = (top: number) => Array.from({ length: 9 }, (_, i) => ({ pos: i < top ? 2 : 9, ok: true }));
// The stored facts carry more than a client may see (and, here, things no facts builder writes) to prove the page is built field by field.
const FACTS = {
  version: 1, period: "2026-11", label: "November 2026", clientName: "Ace Plumbing", rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01",
  terms: [
    { term: "drain cleaning", town: "Tigard", points: nine(2), measured: 9, visible: 2, previousVisible: 5, placeId: "ChIJ-secret-place-id", lat: 45.43, lng: -122.77 },
    { term: "water heater repair", town: null, points: [...nine(3).slice(0, 6), { pos: null, ok: false }, { pos: null, ok: false }, { pos: null, ok: false }], measured: 6, visible: null, previousVisible: null },
  ],
  gbp: { rating: 4.7, reviewCount: 43, reviewsGained: 3, ratingChange: 0.2, placeId: "ChIJ-secret-place-id" },
  reviews: { seen: 3, posted: 2, needsYou: 1, text: "Bob Smith said the plumber was rude and late", reviewer: "Bob Smith" },
  content: { published: [{ kind: "page", title: "Drain cleaning in Tigard" }, { kind: "gbp_post", title: "Winter pipe tips" }], drafted: 1, planned: 1 },
  citations: { listed: 6, needsFix: 2, todo: 4 }, nap: { phone: "match", address: "mismatch", name: "missing" },
  generatedAt: "2026-12-01T17:00:00.000Z", alias: "ace-prod", vaultItem: "Ace WP admin", ssh: "ssh ace-prod", placeId: "ChIJ-secret-place-id",
};

async function seed(o: { status?: "collecting" | "ready" | "sent" | "revoked" | "cancelled"; facts?: unknown; token?: string; priorities?: string[] } = {}) {
  const s = await seedClient();
  const token = o.token ?? newClientToken();
  const { report } = await insertSeoReport(env.DB, { businessId: s.businessId, period: "2026-11", token, facts: o.facts ?? FACTS, test: false, now: "2026-12-01T17:00:00.000Z" });
  const status = o.status ?? "sent";
  if (status !== "collecting" && status !== "cancelled") await setSeoSummary(env.DB, report.id, ["collecting"], { summary: SUMMARY, recommendation: RECOMMENDATION, priorities: o.priorities ?? PRIORITIES, source: "claude", now: "2026-12-01T18:00:00.000Z" });
  if (status === "sent" || status === "revoked") await markSeoSent(env.DB, report.id, SENT_AT);
  if (status === "revoked") await revokeSeoReport(env.DB, report.id, "2026-12-04T10:00:00.000Z");
  if (status === "cancelled") await cancelSeoReport(env.DB, report.id);
  await setSeoTaskAndApproval(env.DB, report.id, { approvalId: "approval-xyz", claudeTaskId: "task-xyz" });
  return { token, id: report.id, businessId: s.businessId };
}
const views = async (id: string): Promise<SeoReport> => (await getSeoReport(env.DB, id))!;
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x/api/public${path}`, init), e as never, ctx);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.prepare(`DELETE FROM seo_reports`).run();
});
afterEach(() => { errors.mockRestore(); });

describe("publicSeoReport", () => {
  it("a sent report gives exactly the public shape, and counts one view", async () => {
    const r = await seed();
    const page = await publicSeoReport(e, r.token, NOW);
    expect(page).toEqual({
      clientName: "Ace Plumbing", label: "November 2026", summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01",
      terms: [
        { term: "drain cleaning", town: "Tigard", points: nine(2), measured: 9, visible: 2, previousVisible: 5 },
        { term: "water heater repair", town: null, points: [...nine(3).slice(0, 6), { pos: null, ok: false }, { pos: null, ok: false }, { pos: null, ok: false }], measured: 6, visible: null, previousVisible: null },
      ],
      gbp: { rating: 4.7, reviewCount: 43, reviewsGained: 3, ratingChange: 0.2 },
      reviews: { seen: 3, posted: 2 },
      content: { published: [{ kind: "page", title: "Drain cleaning in Tigard" }, { kind: "gbp_post", title: "Winter pipe tips" }] },
      citations: { listed: 6, needsFix: 2, todo: 4 },
      video: false, sentOn: "2026-12-01",
    });
    const row = await views(r.id);
    expect(row.viewCount).toBe(1);
    expect(row.firstViewedAt).toBe(NOW.toISOString());
    await publicSeoReport(e, r.token, new Date("2026-12-05T10:00:00.000Z"));
    expect(await views(r.id)).toMatchObject({ viewCount: 2, firstViewedAt: NOW.toISOString() });
  });

  it("a report with no priorities (a plain summary) gives an empty list, and a client with no directory list has citations null", async () => {
    const r = await seed({ priorities: [], facts: { ...FACTS, citations: null } });
    const page = (await publicSeoReport(e, r.token, NOW))!;
    expect(page.priorities).toEqual([]);
    expect(page.citations).toBeNull();
  });

  it("collecting, ready, revoked, cancelled, unknown and malformed tokens are all null, and record no view", async () => {
    const dead: { token: string; id: string }[] = [];
    for (const status of ["collecting", "ready", "revoked", "cancelled"] as const) dead.push(await seed({ status }));
    const sent = await seed();
    const bad = ["A".repeat(43), "short", "", `${sent.token}x`, sent.token.slice(1), `${sent.token.slice(0, 42)}+`, "A".repeat(42), "../etc/passwd"];
    for (const d of dead) expect(await publicSeoReport(e, d.token, NOW), d.id).toBeNull();
    for (const t of bad) expect(await publicSeoReport(e, t, NOW), t).toBeNull();
    for (const d of dead) expect((await views(d.id)).viewCount, d.id).toBe(0);
    expect((await views(sent.id)).viewCount).toBe(0);
  });

  it("a sent report whose facts cannot be read is null and records no view", async () => {
    const r = await seed({ facts: { version: 2 } });
    expect(await publicSeoReport(e, r.token, NOW)).toBeNull();
    expect((await views(r.id)).viewCount).toBe(0);
  });

  it("a revoked link stops working: sent, then revoked", async () => {
    const r = await seed();
    expect(await publicSeoReport(e, r.token, NOW)).not.toBeNull();
    await revokeSeoReport(env.DB, r.id, "2026-12-04T10:00:00.000Z");
    expect(await publicSeoReport(e, r.token, NOW)).toBeNull();
    expect((await views(r.id)).viewCount).toBe(1);
  });

  it("counts no view when told not to, and still shows the page", async () => {
    const r = await seed();
    expect(await publicSeoReport(e, r.token, NOW, { countView: false })).not.toBeNull();
    expect((await views(r.id)).viewCount).toBe(0);
    expect(await publicSeoReport(e, r.token, NOW)).not.toBeNull();
    expect((await views(r.id)).viewCount).toBe(1);
  });
});

describe("GET /api/public/l/:token", () => {
  it("answers a sent report with the page, no-store and noindex", async () => {
    const r = await seed();
    const res = await call(`/l/${r.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(((await res.json()) as { clientName: string }).clientName).toBe("Ace Plumbing");
    expect((await views(r.id)).viewCount).toBe(1);
  });

  it("the JSON holds only the public fields: no place id, location, token, id, approval or task id, review text, reviewer name, SSH alias or vault name", async () => {
    const r = await seed();
    const text = await (await call(`/l/${r.token}`)).text();
    for (const secret of [
      "placeId", "ChIJ", "secret-place-id", "lat", "lng", "45.43", "token", "approval", "approval-xyz", "task-xyz", "Bob Smith", "rude and late", "reviewer", "alias", "ace-prod", "ssh", "vault", "Ace WP admin",
      "facts", "needsYou", "nap", "generatedAt", r.id, r.businessId, r.token,
    ]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "citations", "clientName", "content", "gbp", "label", "previousRankAsOf", "priorities", "rankAsOf", "recommendation", "reviews", "sentOn", "summary", "terms", "video",
    ]);
    expect(Object.keys(JSON.parse(text).terms[0]).sort()).toEqual(["measured", "points", "previousVisible", "term", "town", "visible"]);
    expect(Object.keys(JSON.parse(text).terms[0].points[0]).sort()).toEqual(["ok", "pos"]);
    expect(Object.keys(JSON.parse(text).reviews).sort()).toEqual(["posted", "seen"]);
  });

  it("every link that is not live is the same 404, and records no view", async () => {
    const dead = [await seed({ status: "collecting" }), await seed({ status: "ready" }), await seed({ status: "revoked" }), await seed({ status: "cancelled" })];
    const bodies = new Set<string>();
    for (const t of [...dead.map((d) => d.token), newClientToken(), "A".repeat(42), "short"]) {
      const res = await call(`/l/${t}`);
      expect(res.status, t).toBe(404);
      expect(await res.json(), t).toEqual(NOT_FOUND);
      expect(res.headers.get("cache-control"), t).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), t).toMatch(/noindex/);
      bodies.add(JSON.stringify(Object.fromEntries(res.headers)).replace(/"content-length":"\d+",?/, ""));
    }
    expect(bodies.size).toBe(1);
    for (const d of dead) expect((await views(d.id)).viewCount).toBe(0);
  });

  it("a Care report's link does not open a Local SEO report, and the other way round", async () => {
    const r = await seed();
    expect((await call(`/m/${r.token}`)).status).toBe(404);
  });

  it("the owner's own visit (a valid session cookie) shows the page and counts no view; a stranger, or an expired cookie, counts one", async () => {
    const r = await seed();
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), e as never, ctx);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const own = await call(`/l/${r.token}`, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { clientName: string }).clientName).toBe("Ace Plumbing");
    expect((await views(r.id)).viewCount).toBe(0);
    expect((await views(r.id)).firstViewedAt).toBeNull();
    expect((await call(`/l/${r.token}`, { headers: { cookie: "session=not-a-real-session" } })).status).toBe(200);
    expect((await views(r.id)).viewCount).toBe(1);
    expect((await call(`/l/${r.token}`)).status).toBe(200);
    expect((await views(r.id)).viewCount).toBe(2);
  });

  it("each request counts one view", async () => {
    const r = await seed();
    for (let i = 1; i <= 3; i++) {
      expect((await call(`/l/${r.token}`)).status).toBe(200);
      expect((await views(r.id)).viewCount).toBe(i);
    }
  });

  it("only GET reads it: a write to the same address is turned away without a session and counts nothing", async () => {
    const r = await seed();
    expect((await call(`/l/${r.token}`, { method: "POST" })).status).toBe(401);
    expect((await call(`/l/${r.token}`, { method: "DELETE" })).status).toBe(401);
    expect((await views(r.id)).viewCount).toBe(0);
  });
});
