import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMemo, insertMemo, markMemoSent, revokeMemo, setMemoBody, setMemoLinks } from "../src/worker/db/strategy";
import { newClientToken } from "../src/worker/documents/token";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { publicMemo } from "../src/worker/strategy/public";
import { seedClient } from "./fixtures/clients";

// The client's strategy memo page (Plan 16, Task 10): `/y/<token>`, read only, the same 404 for everything that is not a sent memo.
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const e = env as Env;
// 2026-12-02 03:30 UTC is still 1 December in Los Angeles: the day a memo was prepared is the booking zone's.
const SENT_AT = "2026-12-02T03:30:00.000Z";
const NOW = new Date("2026-12-03T18:00:00.000Z");
const NOT_FOUND = { error: "not found" };
const BODY = {
  standing: "Google counted 40 clicks from search last month, up from 30.",
  priorities: [
    { title: "PRIORITY-ONE-TITLE", why: "WHY-ONE", firstStep: "STEP-ONE" },
    { title: "PRIORITY-TWO-TITLE", why: "WHY-TWO", firstStep: "STEP-TWO" },
    { title: "PRIORITY-THREE-TITLE", why: "WHY-THREE", firstStep: "STEP-THREE" },
  ],
  needFromYou: ["NEED-ONE", "NEED-TWO"],
};
// The stored facts carry more than a client may see (and, here, things no facts builder writes) to prove the page is built field by field.
const FACTS = {
  version: 1, clientName: "Ace Plumbing", trade: "plumber", towns: ["Tigard", "Beaverton"], keywords: ["drain cleaning in Tigard"],
  search: {
    clicks: 40, impressions: 900, position: 7.3, previousClicks: 30, previousImpressions: 700,
    queries: [{ query: "QUERY-SENTINEL-text", clicks: 4, impressions: 9 }], pages: [{ path: "/PAGE-SENTINEL", clicks: 2 }],
  },
  visits: { sessions: 100, users: 80, organic: 60, keyEvents: 7, previousSessions: 90, previousOrganic: 50, channels: [{ channel: "CHANNEL-SENTINEL", sessions: 60 }] },
  period: "2026-11", profile: { rating: 4.7, reviewCount: 43 }, generatedAt: "2026-12-01T17:00:00.000Z", alias: "ace-prod", vaultItem: "Ace WP admin", ssh: "ssh ace-prod",
};

type Status = "collecting" | "ready" | "sent" | "revoked" | "cancelled";
async function seed(o: { status?: Status; facts?: unknown; body?: unknown; token?: string; test?: boolean } = {}) {
  const s = await seedClient();
  const token = o.token ?? newClientToken();
  const { memo } = await insertMemo(env.DB, { businessId: s.businessId, token, facts: o.facts ?? FACTS, test: o.test ?? false, now: "2026-12-01T17:00:00.000Z" });
  const status = o.status ?? "sent";
  if (status === "cancelled") await env.DB.prepare(`UPDATE strategy_memos SET status = 'cancelled' WHERE id = ?`).bind(memo.id).run();
  if (status !== "collecting" && status !== "cancelled") await setMemoBody(env.DB, memo.id, o.body ?? BODY, "2026-12-01T18:00:00.000Z");
  if (status === "sent" || status === "revoked") await markMemoSent(env.DB, memo.id, SENT_AT);
  if (status === "revoked") await revokeMemo(env.DB, memo.id, "2026-12-04T10:00:00.000Z");
  await setMemoLinks(env.DB, memo.id, { approvalId: "approval-xyz", claudeTaskId: "task-xyz" });
  return { token, id: memo.id, businessId: s.businessId };
}
const stored = async (id: string) => (await getMemo(env.DB, id))!;
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x/api/public${path}`, init), e as never, ctx);

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.prepare(`DELETE FROM strategy_memos`).run();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("publicMemo", () => {
  it("a sent memo gives exactly the public shape, and counts one view", async () => {
    const r = await seed();
    const page = await publicMemo(e, r.token, NOW);
    expect(page).toEqual({
      clientName: "Ace Plumbing", version: 1, sentAt: "2026-12-01", body: BODY,
      traffic: {
        period: "2026-11",
        search: { clicks: 40, impressions: 900, position: 7.3, previousClicks: 30, previousImpressions: 700, queries: [], pages: [] },
        visits: { sessions: 100, users: 80, organic: 60, previousSessions: 90, previousOrganic: 50 },
      },
    });
    expect((await stored(r.id)).viewCount).toBe(1);
    expect((await stored(r.id)).firstViewedAt).not.toBeNull();
  });

  it("no search query, page path, channel, key event, trade, town, keyword, profile figure or internal field reaches the page", async () => {
    const r = await seed();
    const text = JSON.stringify(await publicMemo(e, r.token, NOW));
    for (const secret of ["QUERY-SENTINEL", "PAGE-SENTINEL", "CHANNEL-SENTINEL", "keyEvents", "channels", "plumber", "Tigard", "drain cleaning", "4.7", "reviewCount", "profile", "alias", "ace-prod", "vault", "Ace WP admin", "ssh", "facts", "generatedAt", "approval", "task-xyz", r.id, r.businessId, r.token]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("a memo whose facts carry no traffic has traffic null; one with only one block has only that block", async () => {
    const none = await seed({ facts: { ...FACTS, search: null, visits: null, period: null } });
    expect((await publicMemo(e, none.token, NOW, { countView: false }))!.traffic).toBeNull();
    const searchOnly = await seed({ facts: { ...FACTS, visits: null } });
    const t = (await publicMemo(e, searchOnly.token, NOW, { countView: false }))!.traffic!;
    expect(t.period).toBe("2026-11");
    expect(t.search).toMatchObject({ clicks: 40 });
    expect(t.visits).toBeUndefined();
    // A real zero is a real zero.
    const zero = await seed({ facts: { ...FACTS, visits: null, search: { ...FACTS.search, clicks: 0, impressions: 0, position: null, previousClicks: null, previousImpressions: null } } });
    expect((await publicMemo(e, zero.token, NOW, { countView: false }))!.traffic!.search).toMatchObject({ clicks: 0, impressions: 0, position: null });
  });

  it("a memo with facts that cannot be read, or with words that cannot be read, is not shown", async () => {
    const badFacts = await seed({ facts: { nonsense: true } });
    expect(await publicMemo(e, badFacts.token, NOW)).toBeNull();
    const badBody = await seed({ body: { standing: "only this" } });
    expect(await publicMemo(e, badBody.token, NOW)).toBeNull();
    expect((await stored(badFacts.id)).viewCount).toBe(0);
    expect((await stored(badBody.id)).viewCount).toBe(0);
  });

  it("countView false shows the page and counts nothing", async () => {
    const r = await seed();
    expect(await publicMemo(e, r.token, NOW, { countView: false })).not.toBeNull();
    expect((await stored(r.id)).viewCount).toBe(0);
    expect((await stored(r.id)).firstViewedAt).toBeNull();
  });

  it("is null for an unknown token, a malformed one, and a memo that is collecting, ready, revoked or cancelled", async () => {
    const dead = [await seed({ status: "collecting" }), await seed({ status: "ready" }), await seed({ status: "revoked" }), await seed({ status: "cancelled" })];
    for (const d of dead) expect(await publicMemo(e, d.token, NOW), d.token).toBeNull();
    for (const t of [newClientToken(), "A".repeat(42), "short", ""]) expect(await publicMemo(e, t, NOW), t).toBeNull();
    for (const d of dead) expect((await stored(d.id)).viewCount).toBe(0);
  });
});

describe("GET /api/public/y/:token", () => {
  it("GET /y/<token> is 404 for unknown, malformed, collecting, ready and revoked (same body)", async () => {
    const dead = [await seed({ status: "collecting" }), await seed({ status: "ready" }), await seed({ status: "revoked" }), await seed({ status: "cancelled" })];
    const bodies = new Set<string>();
    for (const t of [...dead.map((d) => d.token), newClientToken(), "A".repeat(42), "short"]) {
      const res = await call(`/y/${t}`);
      expect(res.status, t).toBe(404);
      expect(await res.json(), t).toEqual(NOT_FOUND);
      expect(res.headers.get("cache-control"), t).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), t).toMatch(/noindex/);
      bodies.add(JSON.stringify(Object.fromEntries(res.headers)).replace(/"content-length":"\d+",?/, ""));
    }
    expect(bodies.size).toBe(1);
    for (const d of dead) expect((await stored(d.id)).viewCount).toBe(0);
  });

  it("GET /y/<token> for a sent memo returns the body without a token, task id or approval id and counts one view", async () => {
    const r = await seed();
    const res = await call(`/y/${r.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ clientName: "Ace Plumbing", version: 1, sentAt: "2026-12-01", body: BODY });
    for (const secret of ["token", r.token, "approval", "approval-xyz", "task-xyz", "claude", r.id, r.businessId, "facts", "QUERY-SENTINEL", "PAGE-SENTINEL", "ace-prod"]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["body", "clientName", "sentAt", "traffic", "version"]);
    expect(Object.keys(JSON.parse(text).body).sort()).toEqual(["needFromYou", "priorities", "standing"]);
    expect(Object.keys(JSON.parse(text).body.priorities[0]).sort()).toEqual(["firstStep", "title", "why"]);
    const m = await stored(r.id);
    expect(m.viewCount).toBe(1);
    expect(m.firstViewedAt).not.toBeNull();
  });

  it("each request counts one view and the first view time stays the first", async () => {
    const r = await seed();
    await call(`/y/${r.token}`);
    const first = (await stored(r.id)).firstViewedAt;
    for (let i = 2; i <= 3; i++) {
      expect((await call(`/y/${r.token}`)).status).toBe(200);
      expect((await stored(r.id)).viewCount).toBe(i);
    }
    expect((await stored(r.id)).firstViewedAt).toBe(first);
  });

  it("the owner's own visit shows the page and counts no view; a stranger, or an expired cookie, counts one", async () => {
    const r = await seed();
    const own = await call(`/y/${r.token}`, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { clientName: string }).clientName).toBe("Ace Plumbing");
    expect((await stored(r.id)).viewCount).toBe(0);
    expect((await call(`/y/${r.token}`, { headers: { cookie: "session=not-a-real-session" } })).status).toBe(200);
    expect((await stored(r.id)).viewCount).toBe(1);
  });

  it("revoke makes a sent memo 404", async () => {
    const r = await seed();
    expect((await call(`/y/${r.token}`)).status).toBe(200);
    expect(await revokeMemo(env.DB, r.id, "2026-12-05T10:00:00.000Z")).toBe(true);
    const res = await call(`/y/${r.token}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect((await stored(r.id)).viewCount).toBe(1);
  });

  it("a Local SEO or Care report link does not open a memo, and a memo link does not open them", async () => {
    const r = await seed();
    expect((await call(`/l/${r.token}`)).status).toBe(404);
    expect((await call(`/m/${r.token}`)).status).toBe(404);
  });

  it("only GET reads it: a write to the same address is turned away without a session and counts nothing", async () => {
    const r = await seed();
    expect((await call(`/y/${r.token}`, { method: "POST" })).status).toBe(401);
    expect((await call(`/y/${r.token}`, { method: "DELETE" })).status).toBe(401);
    expect((await stored(r.id)).viewCount).toBe(0);
  });
});
