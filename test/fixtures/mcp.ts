import { env, SELF } from "cloudflare:test";

let rpcId = 1000;

/** One JSON-RPC call to the MCP route with the test bearer token. */
export async function mcp(method: string, params?: unknown) {
  const r = await SELF.fetch("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer test-mcp-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await r.text();
  // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json);
}

/** A tool call: the raw text the tool answered with, and whether it was an error. */
export async function tool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const j = await mcp("tools/call", { name, arguments: args });
  if (j.error) return { text: JSON.stringify(j.error), isError: true };
  return { text: j.result.content[0].text as string, isError: !!j.result.isError };
}

/** A tool call that must succeed, parsed. */
export async function ok<T = any>(name: string, args: unknown): Promise<T> {
  const r = await tool(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return JSON.parse(r.text) as T;
}

/** How many agent_actions rows a tool has written. */
export const actionCount = async (toolName: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_actions WHERE tool = ?`).bind(toolName).first<{ n: number }>())!.n;
