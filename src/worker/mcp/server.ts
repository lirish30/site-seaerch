import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import "../approvals/leadNote"; // registers the built-in kinds for this entry path too
import "../approvals/emailSend";
import { buildEmailSendApproval, mailboxFromEmail, type EmailSendPayload } from "../approvals/emailSend";
import { getSettings } from "../db/settings";
import { createApproval, listApprovals, UnknownKindError } from "../db/approvals";
import { getHandler, registeredKinds } from "../approvals/registry";
import { checkConflict } from "../conflict";
import { logAgentAction } from "../db/agentActions";
import { getBusiness } from "../db/businesses";
import { latestAudit, latestAuditsFor } from "../db/audits";
import { listActivity } from "../db/activity";
import { claimNextClaudeTask } from "../db/claudeTasks";
import { REPLY_TASK_KIND, buildReplyContext, completeReplyTask, renderReplyTask } from "../sequence/replies";

const MAX_LEADS = 50;
/** The task kinds this server can brief and complete. A claimed task of any other kind would be stranded, so it is never handed out. */
const TASK_KINDS: readonly string[] = [REPLY_TASK_KIND];
/** Tasks skipped in one call because their lead or message was deleted (each is failed, so the loop always makes progress). */
const MAX_SKIPPED = 10;
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

/** Read, propose, and work the Claude task queue. There is deliberately no approve, reject, send or execute tool: completing a task can only create approvals. */
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

  /**
   * `email.send` is built ENTIRELY here, from the validated payload: the caller's preview, record fields and any enrollment link are ignored, because
   * Claude reads scraped lead facts and inbound mail and could be steered. The Home card shows only the preview, so it must be ours, not the caller's.
   * The caller may not name a sequence step (it could advance someone else's sequence on send) or the `main` mailbox (it has no warm-up or cap).
   */
  const proposeEmailSend = async (a: { title: string; payload: unknown }) => {
    let p: EmailSendPayload;
    try { p = getHandler("email.send")!.parse(a.payload) as EmailSendPayload; }
    catch (e) {
      await log("propose_approval", "rejected an invalid email.send payload");
      return fail(`invalid email.send payload: ${e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 400) : "does not match the schema"}`);
    }
    if (p.enrollmentId !== undefined || p.stepIndex !== undefined) {
      await log("propose_approval", "refused email.send naming a sequence step", { type: "business", id: p.businessId });
      return fail("email.send proposals cannot name an enrollment or a step (enrollmentId, stepIndex); sequence steps are proposed by the app itself. Remove them.");
    }
    if (p.mailbox !== "outreach") {
      await log("propose_approval", `refused email.send from the ${p.mailbox} mailbox`, { type: "business", id: p.businessId });
      return fail('email.send proposals must use mailbox "outreach"');
    }
    // The gate runs when the approval is made, not only when it is approved: a listed recipient, a suppressed lead or a client never gets a card.
    const c = await checkConflict(db, { email: p.to, businessId: p.businessId });
    if (c.blocked) {
      await log("propose_approval", `refused email.send to ${p.to.slice(0, 100)}: ${c.reason}`.slice(0, 300), { type: "business", id: p.businessId });
      return fail(`blocked: ${c.reason} (${c.source})`);
    }
    const title = a.title.replace(/\s+/g, " ").trim().slice(0, 120).trim() || `Email to ${p.to}`;
    const spec = buildEmailSendApproval({ ...p, title, drafted_by: "mcp" }, await getSettings(db), await mailboxFromEmail(db, p.mailbox));
    const created = await createApproval(db, spec);
    await log("propose_approval", `proposed email.send: ${title}`, { type: "business", id: p.businessId });
    return text(created);
  };

  server.registerTool("propose_approval", {
    description: `Propose an action for Logan to approve. Nothing runs until he approves it in the app. Registered kinds: ${registeredKinds().join(", ")}. For email.send the app builds the preview and record link itself from the payload (outreach mailbox only, no enrollmentId/stepIndex); your preview, record_type and record_id are ignored.`,
    inputSchema: {
      kind: z.string().min(1).max(100), title: z.string().min(1).max(200), preview: z.string().max(5000), payload: z.unknown(),
      record_type: z.string().max(50).optional(), record_id: z.string().max(100).optional(),
    },
  }, async (a) => {
    try {
      if (a.kind === "email.send") return await proposeEmailSend(a);
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

  server.registerTool("next_claude_task", {
    description: "Claim the next queued Claude task (for now: classify a prospect's reply and draft the answer) and get everything needed to do it, including the JSON schema of the result. Returns \"no tasks\" when the queue is empty. Finish it with complete_claude_task.",
    inputSchema: { kinds: z.array(z.string().max(100)).max(10).optional() },
  }, async ({ kinds }) => {
    const wanted = kinds ? kinds.filter((k) => TASK_KINDS.includes(k)) : [...TASK_KINDS];
    for (let skipped = 0; skipped <= MAX_SKIPPED && wanted.length; skipped++) {
      const task = await claimNextClaudeTask(db, new Date(), wanted);
      if (!task) break;
      const ctx = await buildReplyContext(env, task);
      if (!ctx) { await log("next_claude_task", `skipped task ${task.id}: its lead or message was deleted`); continue; } // the task was failed
      const p = task.payload as { businessId?: string };
      await log("next_claude_task", `claimed ${task.kind} task ${task.id}`, p.businessId ? { type: "lead", id: p.businessId } : undefined);
      return { content: [{ type: "text" as const, text: renderReplyTask(task, ctx) }] };
    }
    await log("next_claude_task", "no tasks");
    return { content: [{ type: "text" as const, text: "no tasks" }] };
  });

  server.registerTool("complete_claude_task", {
    description: "Finish a claimed Claude task with its result (see the schema next_claude_task returned). The app validates it and applies the effects: it can stop outreach, schedule a check-in, or create an email approval for Logan. It never sends anything. An invalid result is refused with the reasons and the task stays claimed so you can try again.",
    inputSchema: { id: z.string().min(1).max(100), result: z.unknown() },
  }, async ({ id, result }) => {
    const r = await completeReplyTask(env, id, result);
    // A success is logged by `completeReplyTask` itself, against the lead; a refusal is logged here.
    if (!r.ok) {
      await log("complete_claude_task", `refused task ${id.slice(0, 100)}: ${r.error.replace(/\s+/g, " ")}`);
      return fail(r.error);
    }
    return { content: [{ type: "text" as const, text: "done" }] };
  });

  return server;
}
