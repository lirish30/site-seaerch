import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listAgentActions } from "../src/worker/db/agentActions";

// This file imports no approval itself: everything here goes through the Worker's own entry paths.
let rpcId = 0;
const call = async (name: string, args: unknown) => {
  const r = await SELF.fetch("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-mcp-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
};
const count = async (kind: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = ?`).bind(kind).first<{ n: number }>())!.n;

describe("an agent over MCP", () => {
  it("may propose change_order.draft, which creates a waiting approval and nothing else", async () => {
    const before = { draft: await count("change_order.draft"), send: await count("change_order.send"), orders: (await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_orders`).first<{ n: number }>())!.n };
    const j = await call("propose_approval", {
      kind: "change_order.draft", title: "Draft a change order: gallery page", preview: "Pat asked for a gallery page by email.",
      payload: { projectId: "p1", title: "Gallery page", summary: "Twelve photos.", reason: "Pat emailed.", hours: 2, source: "email" },
    });
    expect(j.result.isError).toBeUndefined();
    expect(JSON.parse(j.result.content[0].text)).toMatchObject({ kind: "change_order.draft", status: "pending", drafted_by: "mcp" });
    expect(await count("change_order.draft")).toBe(before.draft + 1);
    expect(await count("change_order.send")).toBe(before.send);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_orders`).first<{ n: number }>())!.n).toBe(before.orders); // nothing is drafted until Logan approves
  });

  it("cannot propose change_order.send: the app proposes it itself", async () => {
    const before = await count("change_order.send");
    const j = await call("propose_approval", { kind: "change_order.send", title: "Send the change order", preview: "Harmless text", payload: { changeOrderId: "any" }, record_type: "project", record_id: "p1" });
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toMatch(/change_order\.send/);
    expect(await count("change_order.send")).toBe(before);
    expect((await listAgentActions(env.DB, { limit: 500 })).some((a) => a.tool === "propose_approval" && /refused change_order\.send/.test(a.summary))).toBe(true);
  });
});
