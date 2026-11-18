import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createApproval, listApprovals, UnknownKindError } from "../src/worker/db/approvals";
import { registerHandler } from "../src/worker/approvals/registry";
import { approve, reject } from "../src/worker/approvals/decide";
import "../src/worker/approvals/leadNote";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { listActivity } from "../src/worker/db/activity";

let okCalls: unknown[] = [];
registerHandler({
  kind: "test.ok", label: "Test OK",
  parse: (p) => { const t = (p as { text?: unknown })?.text; if (typeof t !== "string" || !t) throw new Error("text required"); return { text: t }; },
  execute: async (_env, payload) => { okCalls.push(payload); },
});
registerHandler({
  kind: "test.fail", label: "Test fail",
  parse: (p) => p,
  execute: async () => { throw new Error("smtp down"); },
});

let cookie = "";
const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

const mk = (kind = "test.ok", payload: unknown = { text: "hi" }) =>
  createApproval(env.DB, { kind, title: "T", preview: "P", payload, drafted_by: "logan" });
const row = (id: string) => env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<Record<string, unknown>>();

describe("approvals", () => {
  it("create then list pending", async () => {
    await env.DB.prepare(`DELETE FROM approvals`).run();
    const a = await mk();
    expect(a.status).toBe("pending");
    expect(a.payload).toEqual({ text: "hi" });
    expect((await listApprovals(env.DB, {})).map((x) => x.id)).toEqual([a.id]);
    const r = await call("GET", "/api/approvals");
    const j = await r.json<{ items: { id: string; label: string }[]; counts: Record<string, number> }>();
    expect(j.counts).toEqual({ "test.ok": 1 });
    expect(j.items[0]).toMatchObject({ id: a.id, label: "Test OK" });
  });

  it("approve twice runs handler once", async () => {
    okCalls = [];
    const a = await mk();
    const rs = await Promise.all([approve(env, a.id), approve(env, a.id)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ ok: false, status: 409 });
    expect(okCalls).toHaveLength(1);
    expect(await approve(env, "missing")).toMatchObject({ ok: false, status: 404 });
  });

  it("failed handler leaves approval pending with error", async () => {
    const a = await mk("test.fail", {});
    expect(await approve(env, a.id)).toMatchObject({ ok: false, status: 502, error: "smtp down" });
    expect(await row(a.id)).toMatchObject({ status: "pending", error: "smtp down", decided_at: null });
  });

  it("edited payload is validated and stored", async () => {
    okCalls = [];
    const a = await mk();
    expect(await approve(env, a.id, { text: "" })).toMatchObject({ ok: false, status: 422 });
    expect(await row(a.id)).toMatchObject({ status: "pending" });
    expect(okCalls).toHaveLength(0);
    expect(await approve(env, a.id, { text: "edited" })).toEqual({ ok: true });
    expect(okCalls).toEqual([{ text: "edited" }]);
    expect(JSON.parse((await row(a.id))!.payload as string)).toEqual({ text: "edited" });
  });

  it("reject records note", async () => {
    const a = await mk();
    expect(await reject(env.DB, a.id, "nope")).toBe(true);
    expect(await row(a.id)).toMatchObject({ status: "rejected", decision_note: "nope" });
    expect(await reject(env.DB, a.id)).toBe(false);
  });

  it("unknown kind cannot be created", async () => {
    await expect(mk("nope")).rejects.toBeInstanceOf(UnknownKindError);
  });

  it("lead.note executes", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Biz", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id);
    const a = await mk("lead.note", { businessId: b.id, text: "  call Dana  " });
    expect(await approve(env, a.id)).toEqual({ ok: true });
    expect(await listActivity(env.DB, b.id)).toContainEqual(expect.objectContaining({ kind: "note", detail: "call Dana" }));
    const bad = await mk("lead.note", { businessId: "ghost", text: "x" });
    expect(await approve(env, bad.id)).toMatchObject({ ok: false, status: 502 });
  });

  it("batch approve reports per id", async () => {
    const a = await mk(), f = await mk("test.fail", {});
    const r = await call("POST", "/api/approvals/approve-batch", { ids: [a.id, f.id, "missing"] });
    const j = await r.json<{ results: { id: string; ok: boolean; error?: string }[] }>();
    expect(j.results).toEqual([{ id: a.id, ok: true }, { id: f.id, ok: false, error: "smtp down" }, { id: "missing", ok: false, error: "approval not found" }]);
    expect((await call("POST", "/api/approvals/approve-batch", { ids: [] })).status).toBe(400);
  });

  it("approve and reject routes map statuses", async () => {
    const a = await mk();
    expect((await call("POST", `/api/approvals/${a.id}/approve`, {})).status).toBe(200);
    expect((await call("POST", `/api/approvals/${a.id}/approve`, {})).status).toBe(409);
    const b = await mk();
    expect((await call("POST", `/api/approvals/${b.id}/reject`, { note: "x".repeat(501) })).status).toBe(400);
    expect((await call("POST", `/api/approvals/${b.id}/reject`, { note: "no" })).status).toBe(200);
    expect((await call("POST", `/api/approvals/${b.id}/reject`, {})).status).toBe(409);
    expect((await call("POST", `/api/approvals/zzz/reject`, {})).status).toBe(404);
  });

  it("a post-claim failure outside execute restores the row to pending", async () => {
    const a = await mk();
    await env.DB.prepare(`UPDATE approvals SET payload = 'not json' WHERE id = ?`).bind(a.id).run();
    const r = await approve(env, a.id);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(await row(a.id)).toMatchObject({ status: "pending", decided_at: null });
    expect((await row(a.id))!.error).toBeTruthy();

    registerHandler({ kind: "test.nonerror", label: "x", parse: () => { throw "weird"; }, execute: async () => {} });
    const b = await mk("test.nonerror", {});
    expect(await approve(env, b.id)).toMatchObject({ ok: false, status: 422, error: "weird" });
    expect(await row(b.id)).toMatchObject({ status: "pending", error: "weird" });
  });

  it("approve-batch reports every id even when one approve throws", async () => {
    const a = await mk(), b = await mk();
    const real = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
      if (q.startsWith("UPDATE approvals SET status = 'approved'")) { spy.mockImplementation(real); throw new Error("d1 down"); }
      return real(q);
    });
    const r = await call("POST", "/api/approvals/approve-batch", { ids: [a.id, b.id] });
    spy.mockRestore();
    expect(r.status).toBe(200);
    const j = await r.json<{ results: { id: string; ok: boolean; error?: string }[] }>();
    expect(j.results).toEqual([{ id: a.id, ok: false, error: "d1 down" }, { id: b.id, ok: true }]);
  });

  it("routes require auth", async () => {
    expect((await SELF.fetch("https://x/api/approvals")).status).toBe(401);
    expect((await SELF.fetch("https://x/api/approvals/x/approve", { method: "POST" })).status).toBe(401);
  });
});
