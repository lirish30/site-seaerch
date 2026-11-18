import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import "../approvals/leadNote"; // registers the built-in kind for this entry path too
import { createApproval, listApprovals, UnknownKindError } from "../db/approvals";
import { registeredKinds } from "../approvals/registry";
import { logAgentAction } from "../db/agentActions";
import { getBusiness } from "../db/businesses";
import { latestAudit, latestAuditsFor } from "../db/audits";
import { listActivity } from "../db/activity";

const MAX_LEADS = 50;
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

/** Read and propose only. There is deliberately no approve, reject or execute tool. */
export function buildMcpServer(env: Env): McpServer {
  const db = env.DB;
  const server = new McpServer({ name: "agency-os", version: "1.0.0" });
  const log = (tool: string, summary: string, record?: { type: string; id: string }) =>
    logAgentAction(db, { actor: "mcp", tool, summary, record_type: record?.type, record_id: record?.id });

  server.registerTool("search_leads", {
    description: "Search leads by name/domain text and/or lead status. Returns up to 50.",
    inputSchema: { query: z.string().max(200).optional(), lead_status: z.string().max(40).optional(), limit: z.number().int().min(1).max(MAX_LEADS).optional() },
  }, async ({ query, lead_status, limit }) => {
    const where = ["archived_at IS NULL"];
    const args: (string | number)[] = [];
    if (lead_status) { where.push("lead_status = ?"); args.push(lead_status); }
    for (const term of (query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) {
      const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      where.push("(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(website_url,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(domain,'')) LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    const rows = (await db.prepare(`SELECT id, name, website_url AS website, lead_status FROM businesses WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(...args, Math.min(limit ?? 20, MAX_LEADS)).all<{ id: string; name: string; website: string | null; lead_status: string }>()).results;
    const audits = await latestAuditsFor(db, rows.map((r) => r.id));
    const out = rows.map((r) => ({ ...r, health_score: audits.get(r.id)?.health_score ?? null }));
    await log("search_leads", `search_leads query=${query ?? ""} status=${lead_status ?? ""} -> ${out.length}`);
    return text(out);
  });

  server.registerTool("get_lead", {
    description: "One lead: business record, latest audit summary (scores, top findings) and the last 20 activity items.",
    inputSchema: { id: z.string().min(1).max(100) },
  }, async ({ id }) => {
    const business = await getBusiness(db, id);
    if (!business) { await log("get_lead", `get_lead ${id}: not found`); return fail(`lead not found: ${id}`); }
    const [audit, activity] = await Promise.all([latestAudit(db, id), listActivity(db, id, 20)]);
    await log("get_lead", `get_lead ${business.name}`, { type: "business", id });
    return text({
      business,
      audit: audit && { score: audit.score, health_score: audit.health_score, seo_score: audit.seo_score, accessibility_score: audit.accessibility_score,
        category_scores: audit.category_scores, platform: audit.platform, niche: audit.niche,
        top_findings: audit.findings.slice(0, 5).map((f) => ({ severity: f.severity, category: f.category, evidence: f.evidence, recommendation: f.recommendation })) },
      activity,
    });
  });

  server.registerTool("list_approvals", {
    description: "List approvals by status (default pending). Up to 50, newest first.",
    inputSchema: { status: z.enum(["pending", "approved", "rejected"]).optional() },
  }, async ({ status }) => {
    const rows = await listApprovals(db, { status: status ?? "pending", limit: 50 });
    await log("list_approvals", `list_approvals ${status ?? "pending"} -> ${rows.length}`);
    return text(rows);
  });

  server.registerTool("propose_approval", {
    description: `Propose an action for Logan to approve. Nothing runs until he approves it in the app. Registered kinds: ${registeredKinds().join(", ")}.`,
    inputSchema: {
      kind: z.string().min(1).max(100), title: z.string().min(1).max(200), preview: z.string().max(5000), payload: z.unknown(),
      record_type: z.string().max(50).optional(), record_id: z.string().max(100).optional(),
    },
  }, async (a) => {
    try {
      const created = await createApproval(db, { ...a, drafted_by: "mcp" });
      await log("propose_approval", `proposed ${a.kind}: ${a.title}`, a.record_type && a.record_id ? { type: a.record_type, id: a.record_id } : undefined);
      return text(created);
    } catch (e) {
      if (e instanceof UnknownKindError) {
        await log("propose_approval", `rejected unknown kind ${a.kind.slice(0, 100)}`);
        return fail(`unknown approval kind "${a.kind}". Registered kinds: ${registeredKinds().join(", ")}`);
      }
      throw e;
    }
  });

  return server;
}
