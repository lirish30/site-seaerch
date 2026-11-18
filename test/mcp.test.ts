import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { createApproval } from "../src/worker/db/approvals";
import { listAgentActions } from "../src/worker/db/agentActions";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { suppressLead } from "../src/worker/db/suppression";

let rpcId = 0;
const rpc = (method: string, params?: unknown, token: string | null = "test-mcp-token") =>
  SELF.fetch("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

async function result(method: string, params?: unknown) {
  const r = await rpc(method, params);
  const text = await r.text();
  // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json);
}
const call = (name: string, args: unknown) => result("tools/call", { name, arguments: args });

describe("mcp", () => {
  it("mcp rejects bad token", async () => {
    expect((await rpc("tools/list", {}, null)).status).toBe(401);
    expect((await rpc("tools/list", {}, "wrong")).status).toBe(401);
    expect((await rpc("tools/list", {}, "test-mcp-token-x")).status).toBe(401);
  });

  it("throttles repeated bad tokens per IP with 429, and a valid token does not spend the budget", async () => {
    const hit = (ip: string, token: string) => SELF.fetch("https://x/mcp", {
      method: "POST", body: "{}",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "cf-connecting-ip": ip },
    });
    for (let i = 0; i < 30; i++) expect((await hit("203.0.113.50", "test-mcp-token")).status).not.toBe(401);
    for (let i = 0; i < 30; i++) expect((await hit("203.0.113.50", "test-mcp-token")).status).not.toBe(429);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await hit("203.0.113.51", "wrong")).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("answers non-POST with 405 and allow: POST once authorized", async () => {
    const r = await SELF.fetch("https://x/mcp", { method: "GET", headers: { authorization: "Bearer test-mcp-token", accept: "text/event-stream" } });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    expect((await SELF.fetch("https://x/mcp", { method: "GET" })).status).toBe(401);
  });

  it("mcp lists exactly six tools", async () => {
    const j = await result("tools/list", {});
    expect(j.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      ["complete_claude_task", "get_lead", "list_approvals", "next_claude_task", "propose_approval", "search_leads"],
    );
  });

  it("search_leads finds seeded lead", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: "Zebra Plumbing Co", category: null, address: null, phone: null, websiteUrl: "https://zebra.example", mapsUrl: null, rating: null, reviewCount: null }, s.id);
    const j = await call("search_leads", { query: "zebra plumb", limit: 5 });
    const rows = JSON.parse(j.result.content[0].text);
    expect(rows.map((r: { id: string }) => r.id)).toContain(b.id);
    expect(rows[0]).toHaveProperty("health_score");
    const g = JSON.parse((await call("get_lead", { id: b.id })).result.content[0].text);
    expect(g.business.name).toBe("Zebra Plumbing Co");
    expect(g.activity.length).toBeLessThanOrEqual(20);
  });

  it("propose with unknown kind fails", async () => {
    const j = await call("propose_approval", { kind: "nope.nothing", title: "t", preview: "p", payload: {} });
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toContain("lead.note");
  });

  it("propose lead.note creates pending approval and logs action", async () => {
    const before = (await listAgentActions(env.DB, { limit: 500 })).length;
    const j = await call("propose_approval", { kind: "lead.note", title: "Note", preview: "Add note", payload: { businessId: "b1", text: "hi" } });
    expect(j.result.isError).toBeFalsy();
    const a = JSON.parse(j.result.content[0].text);
    const row = await env.DB.prepare(`SELECT status, drafted_by FROM approvals WHERE id = ?`).bind(a.id).first<{ status: string; drafted_by: string }>();
    expect(row).toEqual({ status: "pending", drafted_by: "mcp" });
    const acts = await listAgentActions(env.DB, { limit: 500 });
    expect(acts.length).toBeGreaterThan(before);
    expect(acts.some((x) => x.actor === "mcp" && x.tool === "propose_approval")).toBe(true);
    const l = JSON.parse((await call("list_approvals", { status: "pending" })).result.content[0].text);
    expect(l.map((x: { id: string }) => x.id)).toContain(a.id);
  });

  describe("propose_approval for email.send runs the conflict gate", () => {
    const lead = async (name: string, websiteUrl: string) => {
      const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
      return upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl, mapsUrl: null, rating: null, reviewCount: null }, s.id);
    };
    const propose = (businessId: string, to: string, extra: Record<string, unknown> = {}) =>
      call("propose_approval", { kind: "email.send", title: "Email", preview: "p", payload: { mailbox: "outreach", businessId, to, subject: "Hello", body: "Hi there", includeFooter: true, ...extra } });
    const countFor = async (businessId: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'email.send' AND payload LIKE ?`).bind(`%${businessId}%`).first<{ n: number }>())!.n;

    it("refuses a recipient on the do-not-contact list and creates no approval", async () => {
      const b = await lead("Blocked Plumbing", "https://blocked-plumbing.test");
      await addDoNotContact(env.DB, { kind: "email", value: "owner@blocked-plumbing.test", reason: "opt_out" });
      const j = await propose(b.id, "Owner@Blocked-Plumbing.test");
      expect(j.result.isError).toBe(true);
      expect(j.result.content[0].text).toContain("do-not-contact");
      expect(await countFor(b.id)).toBe(0);
    });

    it("refuses a suppressed lead and an existing client", async () => {
      const sup = await lead("Suppressed Plumbing", "https://suppressed-plumbing.test");
      await suppressLead(env.DB, { domain: "suppressed-plumbing.test", place_id: null, website_url: null }, { reason: "opt_out" });
      const a = await propose(sup.id, "hi@elsewhere.test");
      expect(a.result.isError).toBe(true);
      expect(a.result.content[0].text).toContain("suppression");
      const won = await lead("Client Plumbing", "https://client-plumbing.test");
      await env.DB.prepare(`UPDATE businesses SET lead_status = 'won' WHERE id = ?`).bind(won.id).run();
      const b = await propose(won.id, "hi@client-plumbing-mail.test");
      expect(b.result.isError).toBe(true);
      expect(b.result.content[0].text).toContain("existing client");
      expect(await countFor(sup.id) + await countFor(won.id)).toBe(0);
    });

    it("refuses a payload the send handler would not accept", async () => {
      const b = await lead("Odd Plumbing", "https://odd-plumbing.test");
      const j = await propose(b.id, "not-an-email");
      expect(j.result.isError).toBe(true);
      expect(await countFor(b.id)).toBe(0);
    });

    it("still creates a pending approval for a clear recipient", async () => {
      const b = await lead("Clear Plumbing", "https://clear-plumbing.test");
      const j = await propose(b.id, "owner@clear-plumbing.test");
      expect(j.result.isError).toBeFalsy();
      const a = JSON.parse(j.result.content[0].text);
      expect(a).toMatchObject({ kind: "email.send", status: "pending", drafted_by: "mcp" });
    });
  });

  it("mcp cannot approve", async () => {
    const a = await createApproval(env.DB, { kind: "lead.note", title: "T", preview: "P", payload: { businessId: "b1", text: "x" }, drafted_by: "mcp" });
    const j = await call("approve", { id: a.id });
    expect(j.error || j.result?.isError).toBeTruthy();
    const row = await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(a.id).first<{ status: string }>();
    expect(row!.status).toBe("pending");
  });
});
