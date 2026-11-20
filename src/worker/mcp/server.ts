import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import "../approvals/leadNote"; // registers the built-in kinds for this entry path too
import "../approvals/emailSend";
import "../approvals/changeOrderDraft"; // an agent may propose this kind, so it is registered here too
import { buildEmailSendApproval, mailboxFromEmail, type EmailSendPayload } from "../approvals/emailSend";
import { getSettings } from "../db/settings";
import { createApproval, listApprovals, UnknownKindError } from "../db/approvals";
import { getHandler, registeredKinds } from "../approvals/registry";
import { checkConflict } from "../conflict";

/** The kinds the app proposes itself, with a card it builds: an agent's own title and preview over one of these could mislead the person approving it. */
const APP_PROPOSED = ["video.publish", "proposal.send", "onboarding.welcome", "onboarding.nudge", "sop.review", "change_order.send"];
/** The kinds an agent may propose: all but those the app proposes itself. */
const proposableKinds = () => registeredKinds().filter((k) => !APP_PROPOSED.includes(k));
import { logAgentAction } from "../db/agentActions";
import { getBusiness } from "../db/businesses";
import { isKnownRecipient } from "../db/contacts";
import { latestAudit, latestAuditsFor } from "../db/audits";
import { listActivity } from "../db/activity";
import "../queue/kinds"; // registers the built-in task kinds for this entry path too
import { claimNextTask, completeTask, markTaskStale, queueCounts, releaseTask } from "../queue/db";
import { buildBundle } from "../queue/bundle";
import { getTaskKind, registeredTaskKinds } from "../queue/registry";

const MAX_LEADS = 50;
/** Tasks skipped in one call because their target is gone (each is closed, so the loop always makes progress). */
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
   * The caller may not name a sequence step (it could advance someone else's sequence on send), attach a hero image (the app builds that from a published video) or use the `main` mailbox (it has no warm-up or cap).
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
    // A hero (the video's GIF and link) is built by the app from a published video and its report link. An agent could point it at any link.
    if (p.heroImage !== undefined) {
      await log("propose_approval", "refused email.send with a hero image", { type: "business", id: p.businessId });
      return fail("email.send proposals cannot carry a hero image (heroImage); the app attaches the video itself when a campaign sends one. Remove it.");
    }
    if (p.mailbox !== "outreach") {
      await log("propose_approval", `refused email.send from the ${p.mailbox} mailbox`, { type: "business", id: p.businessId });
      return fail('email.send proposals must use mailbox "outreach"');
    }
    // The lead must exist: a made-up id would skip every lead-level check below (suppression, client status, the domain lists).
    const lead = await getBusiness(db, p.businessId);
    if (!lead) {
      await log("propose_approval", `refused email.send: no such lead ${p.businessId.slice(0, 100)}`);
      return fail(`lead not found: ${p.businessId}`);
    }
    // The gate runs when the approval is made, not only when it is approved: a listed recipient, a suppressed lead or a client never gets a card.
    const c = await checkConflict(db, { email: p.to, businessId: p.businessId });
    if (c.blocked) {
      await log("propose_approval", `refused email.send to ${p.to.slice(0, 100)}: ${c.reason}`.slice(0, 300), { type: "business", id: p.businessId });
      return fail(`blocked: ${c.reason} (${c.source})`);
    }
    // Claude reads scraped pages and inbound mail and could be steered to write to someone else, so the recipient must be an address we know for THIS lead.
    if (!(await isKnownRecipient(db, p.businessId, p.to))) {
      await log("propose_approval", `refused email.send to ${p.to.slice(0, 100)}: not a known address for the lead`, { type: "business", id: p.businessId });
      return fail(`${p.to} is not a known address for ${lead.name} (only a contact found for the lead, or an address we already wrote to, can be proposed).`);
    }
    const title = a.title.replace(/\s+/g, " ").trim().slice(0, 120).trim() || `Email to ${p.to}`;
    const spec = buildEmailSendApproval({ ...p, title, drafted_by: "mcp" }, await getSettings(db), await mailboxFromEmail(db, p.mailbox));
    const created = await createApproval(db, spec);
    await log("propose_approval", `proposed email.send: ${title}`, { type: "business", id: p.businessId });
    return text(created);
  };

  server.registerTool("propose_approval", {
    description: `Propose an action for Logan to approve. Nothing runs until he approves it in the app. Registered kinds: ${proposableKinds().join(", ")}. For email.send the app builds the preview and record link itself from the payload (outreach mailbox only, no enrollmentId/stepIndex/heroImage); your preview, record_type and record_id are ignored.`,
    inputSchema: {
      kind: z.string().min(1).max(100), title: z.string().min(1).max(200), preview: z.string().max(5000), payload: z.unknown(),
      record_type: z.string().max(50).optional(), record_id: z.string().max(100).optional(),
    },
  }, async (a) => {
    try {
      if (a.kind === "email.send") return await proposeEmailSend(a);
      // A video, and a proposal (whose approval is also Logan's countersignature of what he read), are put up for approval by the app with a card it builds.
      if (APP_PROPOSED.includes(a.kind)) {
        await log("propose_approval", `refused ${a.kind}: the app proposes it itself`);
        return fail(`${a.kind} cannot be proposed by the agent; the app proposes it itself.`);
      }
      const created = await createApproval(db, { ...a, drafted_by: "mcp" });
      await log("propose_approval", `proposed ${a.kind}: ${a.title}`, a.record_type && a.record_id ? { type: a.record_type, id: a.record_id } : undefined);
      return text(created);
    } catch (e) {
      if (e instanceof UnknownKindError) {
        await log("propose_approval", `rejected unknown kind ${a.kind.slice(0, 100)}`);
        return fail(`unknown approval kind "${a.kind}". Registered kinds: ${proposableKinds().join(", ")}`);
      }
      throw e;
    }
  });

  server.registerTool("next_claude_task", {
    description: "Claim the next queued Claude task and get everything needed to do it: the instructions, the suggested model, the JSON schema of the result, and the untrusted content (a delimited block, with any screenshots as images). Returns \"no tasks\" when the queue is empty. Finish it with complete_claude_task, or hand it back with release_claude_task.",
    inputSchema: { kinds: z.array(z.string().max(100)).max(10).optional() },
  }, async ({ kinds }) => {
    // Only kinds this server can brief and complete are handed out: a claimed task of any other kind would be stranded.
    const known = registeredTaskKinds();
    const wanted = kinds ? kinds.filter((k) => known.includes(k)) : known;
    for (let skipped = 0; skipped <= MAX_SKIPPED && wanted.length; skipped++) {
      const task = await claimNextTask(env, new Date(), wanted);
      if (!task) break;
      const bundle = await buildBundle(env, task);
      if ("stale" in bundle) { // the task is closed (a kind may already have failed it), so the next claim moves on
        await markTaskStale(db, task.id, bundle.stale);
        await log("next_claude_task", `skipped ${task.kind} task ${task.id}: ${bundle.stale}`);
        continue;
      }
      await log("next_claude_task", `claimed ${task.kind} task ${task.id}`, task.target_type && task.target_id ? { type: task.target_type, id: task.target_id } : undefined);
      return { content: [{ type: "text" as const, text: bundle.text }, ...bundle.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))] };
    }
    await log("next_claude_task", "no tasks");
    return { content: [{ type: "text" as const, text: "no tasks" }] };
  });

  server.registerTool("complete_claude_task", {
    description: "Finish a claimed Claude task with its result (see the schema next_claude_task returned). The app validates it and applies the effects: it can stop outreach, schedule a check-in, or create an approval for Logan. It never sends anything. An invalid result is refused with the reasons and the task stays claimed so you can try again.",
    inputSchema: { id: z.string().min(1).max(100), result: z.unknown() },
  }, async ({ id, result }) => {
    const r = await completeTask(env, id, result);
    // A success is logged by `completeTask` itself, against the target; a refusal is logged here.
    if (!r.ok) {
      await log("complete_claude_task", `refused task ${id.slice(0, 100)}: ${r.error.replace(/\s+/g, " ")}`);
      return fail(r.error);
    }
    return { content: [{ type: "text" as const, text: "done" }] };
  });

  server.registerTool("release_claude_task", {
    description: "Hand a claimed Claude task back unfinished, with the reason you could not do it. It goes back to the queue (and fails for good after its fourth claim).",
    inputSchema: { id: z.string().min(1).max(100), reason: z.string().min(1).max(500) },
  }, async ({ id, reason }) => {
    const ok = await releaseTask(env, id, reason);
    await log("release_claude_task", `${ok ? "released" : "could not release"} task ${id.slice(0, 100)}: ${reason.replace(/\s+/g, " ").slice(0, 200)}`);
    return ok ? { content: [{ type: "text" as const, text: "released" }] } : fail("task is not claimed");
  });

  server.registerTool("queue_status", {
    description: "How much Claude work is waiting, per task kind: pending (not yet picked up), claimed (being worked) and the model that kind suggests. Kinds with nothing open, or that this server cannot work, are left out.",
    inputSchema: {},
  }, async () => {
    // Only kinds this server can brief and complete: next_claude_task never hands out the others, so counting them would send a worker round in circles.
    const counts = Object.fromEntries(Object.entries(await queueCounts(db)).filter(([kind]) => getTaskKind(kind)));
    await log("queue_status", `queue_status -> ${Object.values(counts).reduce((n, c) => n + c.pending + c.claimed, 0)} open`);
    // The model each kind suggests rides along, so the worker can pick the right subagent without opening a task.
    return text(Object.fromEntries(Object.entries(counts).map(([kind, c]) => [kind, { ...c, suggested_model: getTaskKind(kind)?.suggestedModel ?? null }])));
  });

  return server;
}
