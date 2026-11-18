import type { Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../env";
import { loginThrottled } from "../auth";
import { buildMcpServer } from "./server";

const enc = new TextEncoder();
async function digest(s: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Constant-time bearer check: compares SHA-256 digests (fixed length) with an XOR loop, so neither content nor length leaks. */
export async function bearerOk(header: string | undefined, token: string | undefined): Promise<boolean> {
  if (!token) return false; // an unset secret must never match
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const [a, b] = await Promise.all([digest(m[1]), digest(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Stateless Streamable HTTP MCP endpoint: a fresh server and transport per request, no sessions. */
export async function mcpRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!(await bearerOk(c.req.header("authorization"), c.env.MCP_TOKEN))) {
    // Only failed attempts spend the per-IP budget, so a valid token is never throttled.
    if (await loginThrottled(c)) return c.json({ error: "too many attempts" }, 429);
    return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  // Stateless JSON-response server: GET would open an SSE stream and DELETE has no session to end.
  if (c.req.method !== "POST") return c.json({ error: "method not allowed" }, 405, { allow: "POST" });
  const server = buildMcpServer(c.env);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    c.executionCtx.waitUntil(server.close().catch(() => {}));
  }
}
