import { recordUsage } from "./usage";

export type AgentAction = {
  id: string; actor: "mcp" | "job" | "helper"; tool: string; summary: string;
  record_type: string | null; record_id: string | null; cost_usd: number; created_at: string;
};

export async function logAgentAction(db: D1Database, a: {
  actor: "mcp" | "job" | "helper"; tool: string; summary: string; record_type?: string; record_id?: string; cost_usd?: number;
}): Promise<void> {
  const cost = a.cost_usd ?? 0;
  await db.prepare(`INSERT INTO agent_actions (id, actor, tool, summary, record_type, record_id, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), a.actor, a.tool, a.summary.slice(0, 500), a.record_type ?? null, a.record_id ?? null, cost, new Date().toISOString()).run();
  if (cost > 0) await recordUsage(db, "claude_agent", 1, cost);
}

export async function listAgentActions(db: D1Database, o: { record_type?: string; record_id?: string; limit?: number }): Promise<AgentAction[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (o.record_type) { where.push("record_type = ?"); binds.push(o.record_type); }
  if (o.record_id) { where.push("record_id = ?"); binds.push(o.record_id); }
  binds.push(o.limit ?? 50);
  return (await db.prepare(
    `SELECT * FROM agent_actions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(...binds).all<AgentAction>()).results;
}
