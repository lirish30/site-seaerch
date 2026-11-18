import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { logAgentAction, listAgentActions } from "../src/worker/db/agentActions";
import { spendStatus } from "../src/worker/spend";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

describe("agent actions", () => {
  it("logs and lists by record", async () => {
    await env.DB.prepare(`DELETE FROM agent_actions`).run();
    await logAgentAction(env.DB, { actor: "mcp", tool: "add_note", summary: "first on A", record_type: "lead", record_id: "A" });
    await logAgentAction(env.DB, { actor: "job", tool: "enrich", summary: "on B", record_type: "lead", record_id: "B" });
    await logAgentAction(env.DB, { actor: "mcp", tool: "draft", summary: "second on A", record_type: "lead", record_id: "A" });
    const a = await listAgentActions(env.DB, { record_type: "lead", record_id: "A" });
    expect(a.map((x) => x.summary)).toEqual(["second on A", "first on A"]);
    expect(await listAgentActions(env.DB, {})).toHaveLength(3);
    const r = await SELF.fetch("https://x/api/agent-actions?record_type=lead&record_id=A", { headers: { cookie } });
    expect((await r.json<{ items: unknown[] }>()).items).toHaveLength(2);
  });

  it("cost feeds spend", async () => {
    const now = new Date();
    const before = (await spendStatus(env.DB, now)).variableUsd;
    await logAgentAction(env.DB, { actor: "mcp", tool: "research", summary: "paid", cost_usd: 0.5 });
    expect((await spendStatus(env.DB, now)).variableUsd).toBeCloseTo(before + 0.5, 6);
  });

  it("summary is truncated to 500 chars", async () => {
    await logAgentAction(env.DB, { actor: "job", tool: "t", summary: "x".repeat(900), record_type: "lead", record_id: "TRUNC" });
    const [a] = await listAgentActions(env.DB, { record_id: "TRUNC" });
    expect(a.summary).toHaveLength(500);
  });
});
