import type { Env } from "../../env";
import { logAgentAction } from "../../db/agentActions";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

/** What every MCP tool module is handed: the environment, the database, and the three helpers each tool uses to log what it did and to answer. */
export interface ToolCtx {
  env: Env;
  db: D1Database;
  /** Writes one `agent_actions` row. Every tool calls this exactly once per call. */
  log(tool: string, summary: string, record?: { type: string; id: string }): Promise<void>;
  /** A successful answer: the value as JSON text. */
  text(v: unknown): ToolResult;
  /** A refusal or a miss: the message as an error result. */
  fail(msg: string): ToolResult;
}

const text = (v: unknown): ToolResult => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (msg: string): ToolResult => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

export function makeCtx(env: Env): ToolCtx {
  const db = env.DB;
  return {
    env, db, text, fail,
    log: (tool, summary, record) => logAgentAction(db, { actor: "mcp", tool, summary, record_type: record?.type, record_id: record?.id }),
  };
}
