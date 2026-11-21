import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClientRecord, listClients } from "../../clients/record";
import { listActivity } from "../../db/activity";
import { listAgentActions } from "../../db/agentActions";
import { getBusiness } from "../../db/businesses";
import { listChangeOrders } from "../../db/changeOrders";
import { getDeal } from "../../db/deals";
import { listInvoices } from "../../db/invoices";
import { getMeeting, listMeetings } from "../../db/meetings";
import { getProject, listMilestones, listProjects, PROJECT_STATUSES } from "../../db/projects";
import { getSite, listAccess, listSites } from "../../db/sites";
import { listOpenTasks, listTasks } from "../../db/tasks";
import { readTranscriptText } from "../../meetings/summary";
import type { ToolCtx } from "./context";
import { activityView, agentActionView, changeOrderView, clientRowView, clientView, dealView, invoiceView, meetingView, projectView, siteView, taskView } from "./views";

/** The most rows any list tool returns. */
const MAX_ROWS = 50;
const id = z.string().min(1).max(100);
const INVOICE_STATUSES = ["draft", "open", "paid", "void", "uncollectible", "failed"] as const;

/**
 * The read tools: clients, sites, projects, tasks, deals, the timeline, invoices and meetings. Each answers with a view from `views.ts` (never a row), logs one agent action,
 * answers a missing id with `<thing> not found: <id>`, and leaves test clients out of searches and lists.
 */
export function registerReadTools(server: McpServer, ctx: ToolCtx): void {
  const { db, env, log, text, fail } = ctx;
  const missing = async (tool: string, thing: string, key: string) => { await log(tool, `${tool} ${key.slice(0, 100)}: not found`); return fail(`${thing} not found: ${key}`); };

  server.registerTool("search_clients", {
    description: "Search clients by name or site domain (all clients when no query). Test clients are left out. Returns up to 50 with MRR, open invoices and missing access counts.",
    inputSchema: { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(MAX_ROWS).optional() },
  }, async ({ query, limit }) => {
    const [clients, sites] = await Promise.all([listClients(db), listSites(db)]);
    const domains = new Map<string, string[]>();
    for (const s of sites) if (s.domain) domains.set(s.businessId, [...(domains.get(s.businessId) ?? []), s.domain]);
    const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    const rows = clients
      .filter((c) => terms.every((t) => c.name.toLowerCase().includes(t) || (domains.get(c.id) ?? []).some((d) => d.toLowerCase().includes(t))))
      .slice(0, Math.min(limit ?? 20, MAX_ROWS))
      .map((c) => clientRowView(c, domains.get(c.id) ?? []));
    await log("search_clients", `search_clients query=${(query ?? "").slice(0, 100)} -> ${rows.length}`);
    return text(rows);
  });

  server.registerTool("get_client", {
    description: "One client: contacts, sites (access as key, label and status only), subscriptions, MRR, projects, invoice totals, documents, change orders and the newest 20 activity items.",
    inputSchema: { id },
  }, async ({ id: businessId }) => {
    const rec = await getClientRecord(db, businessId, new Date());
    if (!rec) return missing("get_client", "client", businessId);
    await log("get_client", `get_client ${rec.business.name}`, { type: "business", id: businessId });
    return text(clientView(rec));
  });

  server.registerTool("get_site", {
    description: "One site: its address, host, DNS, CMS and access tier, and its six access items as key, label and status. Vault names and notes are never shown.",
    inputSchema: { id },
  }, async ({ id: siteId }) => {
    const site = await getSite(db, siteId);
    if (!site) return missing("get_site", "site", siteId);
    await log("get_site", `get_site ${site.domain ?? site.id}`, { type: "site", id: siteId });
    return text(siteView(site, await listAccess(db, siteId)));
  });

  server.registerTool("list_projects", {
    description: "Projects, newest first, with task counts. Filter by business_id and/or status. Test projects are left out. Up to 50.",
    inputSchema: { business_id: id.optional(), status: z.enum(PROJECT_STATUSES).optional() },
  }, async ({ business_id, status }) => {
    const rows = (await listProjects(db, { businessId: business_id, status: status ? [status] : undefined })).filter((p) => !p.test).slice(0, MAX_ROWS);
    await log("list_projects", `list_projects business=${business_id ?? ""} status=${status ?? ""} -> ${rows.length}`);
    return text(rows.map(projectView));
  });

  server.registerTool("get_project", {
    description: "One project with its tasks, milestones and change orders as id, title and status. Tasks and change orders are capped at 50 each.",
    inputSchema: { id },
  }, async ({ id: projectId }) => {
    const project = await getProject(db, projectId);
    if (!project) return missing("get_project", "project", projectId);
    const [tasks, milestones, changeOrders, business] = await Promise.all([listTasks(db, projectId), listMilestones(db, projectId), listChangeOrders(db, projectId), getBusiness(db, project.businessId)]);
    await log("get_project", `get_project ${project.name}`, { type: "project", id: projectId });
    return text({
      ...projectView({ ...project, businessName: business?.name }),
      tasks: tasks.slice(0, MAX_ROWS).map((t) => ({ id: t.id, title: t.title, status: t.status })), taskCount: tasks.length,
      milestones: milestones.map((m) => ({ id: m.milestone, title: m.milestone, status: "reached", reachedAt: m.reachedAt })),
      changeOrders: changeOrders.slice(0, MAX_ROWS).map((c) => ({ id: c.id, title: c.content.title, status: c.status })),
    });
  });

  server.registerTool("list_open_tasks", {
    description: "Open tasks on live, real projects, soonest due first: owner logan (his own and drafts to review), claude (to do or draft) or client (waiting on them). All three when owner is left out. Up to 50.",
    inputSchema: { owner: z.enum(["logan", "claude", "client"]).optional() },
  }, async ({ owner }) => {
    const rows = await listOpenTasks(db, { owner, limit: MAX_ROWS });
    await log("list_open_tasks", `list_open_tasks owner=${owner ?? ""} -> ${rows.length}`);
    return text(rows.map(taskView));
  });

  server.registerTool("get_deal", {
    description: "One deal: its stage, the call recap and the three options.",
    inputSchema: { id },
  }, async ({ id: dealId }) => {
    const deal = await getDeal(db, dealId);
    if (!deal) return missing("get_deal", "deal", dealId);
    const business = await getBusiness(db, deal.businessId);
    await log("get_deal", `get_deal ${business?.name ?? deal.id} (${deal.stage})`, { type: "deal", id: dealId });
    return text(dealView({ ...deal, businessName: business?.name }));
  });

  server.registerTool("get_timeline", {
    description: "The newest 50 activity items and agent actions for a business, or for a project (the project's agent actions and its business's activity).",
    inputSchema: { record_type: z.enum(["business", "project"]), record_id: id },
  }, async ({ record_type, record_id }) => {
    let businessId = record_id;
    if (record_type === "project") {
      const project = await getProject(db, record_id);
      if (!project) return missing("get_timeline", "project", record_id);
      businessId = project.businessId;
    } else if (!(await getBusiness(db, record_id))) return missing("get_timeline", "business", record_id);
    const [activity, actions] = await Promise.all([listActivity(db, businessId, MAX_ROWS), listAgentActions(db, { record_type, record_id, limit: MAX_ROWS })]);
    await log("get_timeline", `get_timeline ${record_type} -> ${activity.length} activity, ${actions.length} actions`, { type: record_type, id: record_id });
    return text({ activity: activity.map(activityView), agentActions: actions.map(agentActionView) });
  });

  server.registerTool("list_invoices", {
    description: "Invoices, newest first. Filter by business_id and/or status. Test invoices are left out. Amounts are integer cents; no Stripe ids or payment links. Up to 50.",
    inputSchema: { business_id: id.optional(), status: z.enum(INVOICE_STATUSES).optional() },
  }, async ({ business_id, status }) => {
    const rows = (await listInvoices(db, { businessId: business_id, statuses: status ? [status] : undefined })).filter((i) => !i.test).slice(0, MAX_ROWS);
    await log("list_invoices", `list_invoices business=${business_id ?? ""} status=${status ?? ""} -> ${rows.length}`);
    return text(rows.map(invoiceView));
  });

  server.registerTool("list_meetings", {
    description: "Recorded meetings with their summaries, newest first, for one client or all. Meetings of test clients are left out. No transcripts. Up to 50.",
    inputSchema: { business_id: id.optional() },
  }, async ({ business_id }) => {
    const rows = await listMeetings(db, { businessId: business_id, limit: MAX_ROWS, realOnly: true });
    await log("list_meetings", `list_meetings business=${business_id ?? ""} -> ${rows.length}`);
    return text(rows.map((m) => meetingView(m)));
  });

  server.registerTool("get_meeting", {
    description: "One meeting with its summary and Meetily's notes. The transcript is left out unless include_transcript is true, and is then cut at 20000 characters.",
    inputSchema: { id, include_transcript: z.boolean().optional() },
  }, async ({ id: meetingId, include_transcript }) => {
    const meeting = await getMeeting(db, meetingId);
    if (!meeting) return missing("get_meeting", "meeting", meetingId);
    const transcript = include_transcript ? await readTranscriptText(env, meeting) : undefined;
    await log("get_meeting", `get_meeting ${meeting.title.slice(0, 100)}${include_transcript ? " with transcript" : ""}`, { type: "meeting", id: meetingId });
    return text(meetingView(meeting, { transcript, notes: true }));
  });
}
