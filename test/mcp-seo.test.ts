import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { previousMonth } from "../src/worker/care/reportSweep";
import { getSettings } from "../src/worker/db/settings";
import { zoneOf } from "../src/worker/sop/cadence";
import { actionCount, mcp, ok, tool } from "./fixtures/mcp";
import { resetProjectWork } from "./fixtures/projects";
import {
  MAPS_URL, PLACE_ID, PRIORITIES, RECOMMENDATION, REPLY_DRAFT, REVIEW_BODY, REVIEWER, SUMMARY, resetSeo, seoClient, seoContent, seoRanked, seoReport, seoReview, seoSnapshot,
} from "./fixtures/seo";

// The read-only Local SEO tool through the MCP route (Plan 14, Task 11): per client the watch, the terms, the latest grid as visible points, the profile's numbers, what waits on Logan and the month's report words;
// never a token, a link, a place id, a review's text or its writer's name.
const TOKEN = "tok-mcp-seo-SECRETTOKEN-0123456789abcdef";

beforeEach(async () => {
  await resetSeo();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

type Row = {
  clientId: string; client: string; status: string; keywords: { term: string; town: string | null; active: boolean }[];
  grid: { term: string; town: string | null; takenOn: string; measured: number; visible: number | null }[];
  rating: number | null; reviewCount: number | null; waiting: { replies: number; content: number; flagged: number };
  report: null | { period: string; status: string; summary: string; recommendation: string; priorities: string[]; sentOn: string | null; views: number };
};
type Answer = { period: string; clients: Row[] };

describe("the tool", () => {
  it("is registered", async () => {
    const names = (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_seo_status");
    expect(names).toHaveLength(31);
  });

  it("is refused without the token, like every other tool", async () => {
    const call = (token: string | null) => SELF.fetch("https://x/mcp", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_seo_status", arguments: {} } }),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    expect((await call(null)).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
  });
});

describe("get_seo_status", () => {
  it("gives each client's status, terms, latest grid as visible points, profile numbers, what waits and the month's report words, ordered by client name", async () => {
    const bay = await seoClient({ name: "Bay Roofing", status: "paused" });
    const ace = await seoClient({ name: "Ace Plumbing" });
    await seoRanked(ace.businessId, { term: "drain cleaning", town: "Tigard", top: 2, day: "2026-11-15" });
    await seoRanked(ace.businessId, { term: "drain cleaning", town: "Tigard", top: 4, day: "2026-12-01" });
    await seoRanked(ace.businessId, { term: "sewer repair", town: "", top: 0, day: "2026-12-01" });
    await seoSnapshot(ace.businessId, { rating: 4.6, reviewCount: 42 });
    await seoReview(ace.businessId, { rating: 2, status: "drafted" });
    await seoReview(ace.businessId, { rating: 5, status: "drafted", day: "2026-12-02" });
    await seoReview(ace.businessId, { rating: 5, status: "posted", day: "2026-12-03" });
    await seoContent(ace.businessId, { status: "drafted" });
    await seoReport(ace.businessId, "sent");

    const out = await ok<Answer>("get_seo_status", { period: "2026-11" });
    expect(out.period).toBe("2026-11");
    expect(out.clients.map((c) => [c.client, c.status])).toEqual([["Ace Plumbing", "active"], ["Bay Roofing", "paused"]]);
    expect(out.clients[0]).toEqual({
      clientId: ace.businessId, client: "Ace Plumbing", status: "active",
      keywords: [{ term: "drain cleaning", town: "Tigard", active: true }, { term: "sewer repair", town: null, active: true }],
      grid: [{ term: "drain cleaning", town: "Tigard", takenOn: "2026-12-01", measured: 9, visible: 4 }, { term: "sewer repair", town: null, takenOn: "2026-12-01", measured: 9, visible: 0 }],
      rating: 4.6, reviewCount: 42, waiting: { replies: 2, content: 1, flagged: 1 },
      report: { period: "2026-11", status: "sent", summary: SUMMARY, recommendation: RECOMMENDATION, priorities: PRIORITIES, sentOn: "2026-12-01", views: 0 },
    });
    expect(out.clients[1]).toEqual({
      clientId: bay.businessId, client: "Bay Roofing", status: "paused", keywords: [], grid: [], rating: null, reviewCount: null, waiting: { replies: 0, content: 0, flagged: 0 }, report: null,
    });
  });

  it("says visible null when too few points were measured, never a zero", async () => {
    const s = await seoClient();
    const kw = await seoRanked(s.businessId);
    const points = Array.from({ length: 9 }, (_, i) => ({ lat: 45, lng: -122, pos: i < 2 ? 2 : null, ok: i < 2 }));
    await env.DB.prepare(`UPDATE seo_rank_checks SET points = ? WHERE keyword_id = ?`).bind(JSON.stringify(points), kw.id).run();
    const [row] = (await ok<Answer>("get_seo_status", {})).clients;
    expect(row.grid).toEqual([{ term: "drain cleaning", town: "Tigard", takenOn: "2026-12-01", measured: 2, visible: null }]);
  });

  it("never returns a token, a link, a place id, a review's text or its writer's name, even when they are all stored", async () => {
    const s = await seoClient({ name: "Ace Plumbing" });
    await seoRanked(s.businessId);
    await seoSnapshot(s.businessId);
    await seoReview(s.businessId, { rating: 1, status: "drafted" });
    await seoContent(s.businessId, { status: "drafted" });
    const r = await seoReport(s.businessId, "sent", { token: TOKEN });
    const answer = await tool("get_seo_status", { period: "2026-11" });
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.text).clients[0].report.status).toBe("sent");
    for (const bad of [TOKEN, r.token, PLACE_ID, "PLACE-ID", MAPS_URL, "MAPS-SENTINEL", REVIEW_BODY, "REVIEW-BODY", REVIEWER, "REVIEWER-SENTINEL", REPLY_DRAFT, "REPLY-DRAFT", "http", "/l/", "token", "placeId", "place_id", "lat", "lng", "mapsUrl"])
      expect(answer.text, `shows ${bad}`).not.toContain(bad);
  });

  it("leaves out a rehearsal client and an archived one, and takes clientId to narrow to one client", async () => {
    const a = await seoClient({ name: "Ace Plumbing" });
    await seoClient({ name: "Rehearsal Co", test: true });
    const gone = await seoClient({ name: "Gone Co" });
    await env.DB.prepare(`UPDATE businesses SET archived_at = '2026-12-01T00:00:00.000Z' WHERE id = ?`).bind(gone.businessId).run();
    const other = await seoClient({ name: "Other Co" });
    await seoClient({ name: "No Profile Co", profile: false });
    expect((await ok<Answer>("get_seo_status", {})).clients.map((c) => c.client)).toEqual(["Ace Plumbing", "Other Co"]);
    expect((await ok<Answer>("get_seo_status", { clientId: other.businessId })).clients.map((c) => c.client)).toEqual(["Other Co"]);
    expect((await ok<Answer>("get_seo_status", { clientId: "nope" })).clients).toEqual([]);
    expect(a.businessId).not.toBe(other.businessId);
  });

  it("leaves out a rehearsal client's report words", async () => {
    const a = await seoClient({ name: "Ace Plumbing" });
    await seoReport(a.businessId, "ready", { test: true });
    expect((await ok<Answer>("get_seo_status", { period: "2026-11" })).clients[0].report).toBeNull();
  });

  it("defaults to last month in the booking zone and gives a null report for a month with none", async () => {
    const a = await seoClient({ name: "Ace Plumbing" });
    const last = previousMonth(new Date(), zoneOf(await getSettings(env.DB)));
    await seoReport(a.businessId, "ready", { period: last });
    const out = await ok<Answer>("get_seo_status", {});
    expect(out.period).toBe(last);
    expect(out.clients[0].report).toMatchObject({ period: last, status: "ready" });
    expect((await ok<Answer>("get_seo_status", { period: "1999-01" })).clients[0].report).toBeNull();
  });

  it("refuses a period that is not YYYY-MM and writes one agent action per call", async () => {
    for (const period of ["2026-13", "last month", "2026-1", "2026-11-01"]) expect((await tool("get_seo_status", { period })).isError, period).toBe(true);
    const before = await actionCount("get_seo_status");
    await tool("get_seo_status", { period: "2026-11" });
    expect(await actionCount("get_seo_status")).toBe(before + 1);
  });
});
