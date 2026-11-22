import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeStrategyApproval } from "../src/worker/approvals/strategyMemo";
import { cancelMemo, getMemo, insertMemo, markMemoSent, revokeMemo, setMemoBody, setMemoLinks, type StrategyMemo } from "../src/worker/db/strategy";
import type { Env } from "../src/worker/env";
import { enqueueTask } from "../src/worker/queue/db";
import { STRATEGY_TARGET } from "../src/worker/queue/strategyMemo";
import "../src/worker/queue/kinds";
import type { MemoFacts } from "../src/worker/strategy/facts";
import { seedClient } from "./fixtures/clients";

// The owner's side of the strategy memo (Plan 16, Task 10): cancel, revoke and the list of a client's memos.
const e = env as Env;
const NOW = "2026-12-01T17:00:00.000Z";
const LATER = "2026-12-02T17:00:00.000Z";
const FACTS: MemoFacts = {
  version: 1, clientName: "Ace Plumbing", trade: "plumber", towns: ["Tigard"], keywords: ["drain cleaning"],
  search: { clicks: 40, impressions: 900, position: 7.3, previousClicks: 30, previousImpressions: 700, queries: [], pages: [] }, visits: null, period: "2026-11", profile: null, generatedAt: NOW,
};
const BODY = {
  standing: "Google counted 40 clicks from search last month.",
  priorities: [
    { title: "ONE", why: "WHY-ONE", firstStep: "STEP-ONE" }, { title: "TWO", why: "WHY-TWO", firstStep: "STEP-TWO" }, { title: "THREE", why: "WHY-THREE", firstStep: "STEP-THREE" },
  ],
  needFromYou: ["NEED-ONE", "NEED-TWO"],
};

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.prepare(`DELETE FROM strategy_memos`).run();
  await env.DB.prepare(`DELETE FROM claude_tasks WHERE kind = 'strategy.memo'`).run();
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'strategy.memo'`).run();
});
afterEach(() => { vi.restoreAllMocks(); });

type Status = "collecting" | "ready" | "sent" | "revoked" | "cancelled";
/** A memo of `businessId` (a new client when not given) in the given state, with a queued Claude task while it is collecting and a card once it is ready. */
async function memoAt(status: Status, businessId?: string, o: { test?: boolean } = {}): Promise<{ memo: StrategyMemo; businessId: string }> {
  const id = businessId ?? (await seedClient()).businessId;
  const { memo } = await insertMemo(env.DB, { businessId: id, token: `tok-${crypto.randomUUID()}`, facts: FACTS, test: o.test ?? false, now: NOW });
  if (status === "collecting") {
    const { id: taskId } = await enqueueTask(env.DB, "strategy.memo", { memoId: memo.id }, { dedupeKey: memo.id, targetType: STRATEGY_TARGET, targetId: memo.id });
    await setMemoLinks(env.DB, memo.id, { claudeTaskId: taskId });
  }
  if (status === "cancelled") await cancelMemo(env.DB, memo.id, NOW);
  if (status === "ready" || status === "sent" || status === "revoked") {
    await setMemoBody(env.DB, memo.id, BODY, NOW);
    await proposeStrategyApproval(e, memo.id);
  }
  if (status === "sent" || status === "revoked") await markMemoSent(env.DB, memo.id, LATER);
  if (status === "revoked") await revokeMemo(env.DB, memo.id, LATER);
  return { memo: (await getMemo(env.DB, memo.id))!, businessId: id };
}
const post = (path: string, auth = true) => SELF.fetch(`https://x/api${path}`, { method: "POST", headers: auth ? { cookie } : {} });
const get = (path: string, auth = true) => SELF.fetch(`https://x/api${path}`, { headers: auth ? { cookie } : {} });
const taskOf = (memoId: string) => env.DB.prepare(`SELECT status FROM claude_tasks WHERE kind = 'strategy.memo' AND target_id = ?`).bind(memoId).first<{ status: string }>();
const approvalOf = (id: string | null) => env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(id).first<{ status: string }>();

describe("cancelMemo", () => {
  it("takes a collecting or a ready memo out of play, frees the one-open-memo slot, and does nothing for any other state", async () => {
    for (const from of ["collecting", "ready"] as const) {
      const { memo, businessId } = await memoAt(from);
      expect(await cancelMemo(env.DB, memo.id, LATER), from).toBe(true);
      expect(await getMemo(env.DB, memo.id)).toMatchObject({ status: "cancelled", sentAt: null });
      expect(await cancelMemo(env.DB, memo.id, LATER), `${from} twice`).toBe(false);
      // A new memo can be made for the client at once.
      const { created } = await insertMemo(env.DB, { businessId, token: `tok-${crypto.randomUUID()}`, facts: FACTS, test: false, now: LATER });
      expect(created, from).toBe(true);
    }
    for (const from of ["sent", "revoked", "cancelled"] as const) {
      const { memo } = await memoAt(from);
      expect(await cancelMemo(env.DB, memo.id, LATER), from).toBe(false);
      expect((await getMemo(env.DB, memo.id))!.status).toBe(from);
    }
    expect(await cancelMemo(env.DB, "nope", LATER)).toBe(false);
  });
});

describe("GET /api/clients/:id/strategy-memos", () => {
  it("lists the client's memos newest first with the owner's fields and never the token, the facts or the task id", async () => {
    const s = await seedClient();
    const first = await memoAt("sent", s.businessId);
    await env.DB.prepare(`UPDATE strategy_memos SET view_count = 2, first_viewed_at = ? WHERE id = ?`).bind(LATER, first.memo.id).run();
    const second = await memoAt("collecting", s.businessId);
    const r = await get(`/clients/${s.businessId}/strategy-memos`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const { memos } = JSON.parse(text) as { memos: Record<string, unknown>[] };
    expect(memos.map((m) => m.id)).toEqual([second.memo.id, first.memo.id]);
    expect(memos[0]).toEqual({
      id: second.memo.id, version: 2, status: "collecting", test: false, createdAt: NOW, readyAt: null, sentAt: null, viewCount: 0, firstViewedAt: null, link: null, body: null, approvalId: null,
    });
    expect(memos[1]).toEqual({
      id: first.memo.id, version: 1, status: "sent", test: false, createdAt: NOW, readyAt: NOW, sentAt: LATER, viewCount: 2, firstViewedAt: LATER,
      link: `https://clients.hellositeline.test/y/${first.memo.token}`, body: BODY, approvalId: first.memo.approvalId,
    });
    for (const secret of ["token", "facts", "claudeTaskId", "claude_task_id", "Ace Plumbing", "drain cleaning", second.memo.token]) expect(text, secret).not.toContain(secret);
    // The sent memo's token is in its link and nowhere else.
    expect(text.split(first.memo.token).length - 1).toBe(1);
  });

  it("gives a link only to a sent memo, and the words only once there are some", async () => {
    const s = await seedClient();
    for (const status of ["revoked", "cancelled", "ready"] as const) await memoAt(status, s.businessId);
    const { memos } = (await (await get(`/clients/${s.businessId}/strategy-memos`)).json()) as { memos: { status: string; link: string | null; body: unknown }[] };
    expect(memos.map((m) => m.status)).toEqual(["ready", "cancelled", "revoked"]);
    for (const m of memos) expect(m.link, m.status).toBeNull();
    expect(memos.find((m) => m.status === "ready")!.body).toEqual(BODY);
    // A cancelled memo never had words.
    expect(memos.find((m) => m.status === "cancelled")!.body).toBeNull();
  });

  it("is an empty list for a client with none, 404 for a business that does not exist, 401 without a session, and only lists this client's", async () => {
    const s = await seedClient();
    expect(await (await get(`/clients/${s.businessId}/strategy-memos`)).json()).toEqual({ memos: [] });
    await memoAt("ready");
    expect(await (await get(`/clients/${s.businessId}/strategy-memos`)).json()).toEqual({ memos: [] });
    expect((await get("/clients/nope/strategy-memos")).status).toBe(404);
    expect((await get(`/clients/${s.businessId}/strategy-memos`, false)).status).toBe(401);
  });
});

describe("POST /api/clients/:id/strategy-memos/:memoId/cancel", () => {
  it("cancels a collecting memo, closes its Claude task and answers the memo", async () => {
    const { memo, businessId } = await memoAt("collecting");
    expect((await taskOf(memo.id))!.status).toBe("pending");
    const r = await post(`/clients/${businessId}/strategy-memos/${memo.id}/cancel`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { memo: { id: string; status: string } }).memo).toMatchObject({ id: memo.id, status: "cancelled" });
    expect((await getMemo(env.DB, memo.id))!.status).toBe("cancelled");
    expect((await taskOf(memo.id))!.status).toBe("stale");
  });

  it("cancels a ready memo and rejects its pending approval", async () => {
    const { memo, businessId } = await memoAt("ready");
    expect((await approvalOf(memo.approvalId))!.status).toBe("pending");
    expect((await post(`/clients/${businessId}/strategy-memos/${memo.id}/cancel`)).status).toBe(200);
    expect((await getMemo(env.DB, memo.id))!.status).toBe("cancelled");
    expect((await approvalOf(memo.approvalId))!.status).toBe("rejected");
  });

  it("is 409 with a plain sentence for a memo that was sent, revoked or cancelled, and changes nothing", async () => {
    for (const status of ["sent", "revoked", "cancelled"] as const) {
      const { memo, businessId } = await memoAt(status);
      const r = await post(`/clients/${businessId}/strategy-memos/${memo.id}/cancel`);
      expect(r.status, status).toBe(409);
      const { error } = (await r.json()) as { error: string };
      expect(error, status).toMatch(/can be cancelled/);
      expect((await getMemo(env.DB, memo.id))!.status).toBe(status);
    }
  });

  it("is 404 for another client's memo, a memo that does not exist and a business that does not exist, and 401 without a session", async () => {
    const mine = await memoAt("collecting");
    const other = await seedClient();
    expect((await post(`/clients/${other.businessId}/strategy-memos/${mine.memo.id}/cancel`)).status).toBe(404);
    expect((await getMemo(env.DB, mine.memo.id))!.status).toBe("collecting");
    expect((await post(`/clients/${mine.businessId}/strategy-memos/nope/cancel`)).status).toBe(404);
    expect((await post(`/clients/nope/strategy-memos/${mine.memo.id}/cancel`)).status).toBe(404);
    expect((await post(`/clients/${mine.businessId}/strategy-memos/${mine.memo.id}/cancel`, false)).status).toBe(401);
  });
});

describe("POST /api/clients/:id/strategy-memos/:memoId/revoke", () => {
  it("revokes a sent memo: its link stops working", async () => {
    const { memo, businessId } = await memoAt("sent");
    const r = await post(`/clients/${businessId}/strategy-memos/${memo.id}/revoke`);
    expect(r.status).toBe(200);
    const { memo: row } = (await r.json()) as { memo: { status: string; link: string | null } };
    expect(row.status).toBe("revoked");
    expect(row.link).toBeNull();
    expect(await getMemo(env.DB, memo.id)).toMatchObject({ status: "revoked" });
    expect((await SELF.fetch(`https://x/api/public/y/${memo.token}`)).status).toBe(404);
  });

  it("revokes a ready memo and rejects its pending approval, so nothing is mailed later", async () => {
    const { memo, businessId } = await memoAt("ready");
    expect((await post(`/clients/${businessId}/strategy-memos/${memo.id}/revoke`)).status).toBe(200);
    expect((await getMemo(env.DB, memo.id))!.status).toBe("revoked");
    expect((await approvalOf(memo.approvalId))!.status).toBe("rejected");
  });

  it("is 409 for a memo that is collecting, revoked or cancelled", async () => {
    for (const status of ["collecting", "revoked", "cancelled"] as const) {
      const { memo, businessId } = await memoAt(status);
      const r = await post(`/clients/${businessId}/strategy-memos/${memo.id}/revoke`);
      expect(r.status, status).toBe(409);
      expect(((await r.json()) as { error: string }).error, status).toMatch(/ready or sent/);
      expect((await getMemo(env.DB, memo.id))!.status).toBe(status);
    }
  });

  it("is 404 for another client's memo, a memo that does not exist and a business that does not exist, and 401 without a session", async () => {
    const mine = await memoAt("sent");
    const other = await seedClient();
    expect((await post(`/clients/${other.businessId}/strategy-memos/${mine.memo.id}/revoke`)).status).toBe(404);
    expect((await getMemo(env.DB, mine.memo.id))!.status).toBe("sent");
    expect((await post(`/clients/${mine.businessId}/strategy-memos/nope/revoke`)).status).toBe(404);
    expect((await post(`/clients/nope/strategy-memos/${mine.memo.id}/revoke`)).status).toBe(404);
    expect((await post(`/clients/${mine.businessId}/strategy-memos/${mine.memo.id}/revoke`, false)).status).toBe(401);
  });
});
