import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startFullScan } from "../../audit/start";
import { calendarDateIn } from "../../billing/dates";
import { logActivity } from "../../db/activity";
import { getBusiness } from "../../db/businesses";
import { getSettings } from "../../db/settings";
import { getTask, TaskInputError } from "../../db/tasks";
import { TimeStateError } from "../../db/time";
import { cleanText, looksLikeCredential } from "../../onboarding/templates";
import { addAdhocTask, postComment, TaskStateError } from "../../projects/service";
import { zoneOf } from "../../sop/cadence";
import { addManualEntry } from "../../time/service";
import type { ToolCtx } from "./context";

const id = z.string().min(1).max(100);
const NOTE_MAX = 500;
const CLAUDE_WORK_REFUSED = "add_task only adds to-dos for Logan. Logan assigns Claude work in the app.";
const NOTE_CREDENTIAL_REFUSED = "This looks like a login or password. Never put those in a note; note where they are stored instead.";
/** The errors the app raises for a request it cannot do: each message is a plain sentence that never repeats what was sent. */
const isRefusal = (e: unknown) => e instanceof TaskInputError || e instanceof TimeStateError || e instanceof TaskStateError;

/**
 * The act tools: run a full audit, log time, add a task, comment on a task and add a note. Each does one small, reversible thing inside the app. None sends, approves or
 * deletes anything: outbound work only ever becomes an Approval, through `propose_approval`. Each call logs exactly one agent action, refused or not, and no refusal or log
 * line repeats the text it was sent (a login in a title or a note is never echoed).
 */
export function registerActTools(server: McpServer, ctx: ToolCtx): void {
  const { db, env, log, text, fail } = ctx;
  /** Logs the call and answers it as a refusal. */
  const refuse = async (tool: string, message: string, record?: { type: string; id: string }) => { await log(tool, `${tool} refused: ${message}`, record); return fail(message); };
  /** Runs a domain call: a refusal from the app is logged and answered with its message; anything else is a real fault and is left to throw. */
  const attempt = async <T>(tool: string, record: { type: string; id: string }, run: () => Promise<T>): Promise<{ value: T } | { refused: ReturnType<typeof fail> }> => {
    try { return { value: await run() }; } catch (e) {
      if (isRefusal(e)) return { refused: await refuse(tool, (e as Error).message, record) };
      throw e;
    }
  };

  server.registerTool("run_audit", {
    description: "Start a full scan of a lead: screenshots, PageSpeed, the AI review and a draft. Costs a little browser time, so it is refused when the month's spend limit would be passed. Answers { ok: true } once the scan is started, or not found / spend limit.",
    inputSchema: { business_id: id },
  }, async ({ business_id }) => {
    const r = await startFullScan(env, business_id);
    if (!r.ok) return refuse("run_audit", r.error, { type: "business", id: business_id });
    await log("run_audit", `run_audit full scan started for ${business_id.slice(0, 100)}`, { type: "business", id: business_id });
    return text({ ok: true });
  });

  server.registerTool("log_time", {
    description: "Log time on a task after the fact: whole minutes from 1 to 1440 on a day (a calendar date like 2026-12-03, today in the booking time zone when left out, never a day to come). A locked task cannot take time. Billable defaults to the task's own flag.",
    inputSchema: { task_id: id, minutes: z.number(), day: z.string().max(10).optional(), note: z.string().max(NOTE_MAX).optional(), billable: z.boolean().optional() },
  }, async ({ task_id, minutes, day, note, billable }) => {
    const record = { type: "task", id: task_id };
    const r = await attempt("log_time", record, async () => addManualEntry(env, {
      taskId: task_id, minutes, billable, note, day: day ?? calendarDateIn(new Date(), zoneOf(await getSettings(db))),
    }, new Date()));
    if ("refused" in r) return r.refused;
    const e = r.value;
    await log("log_time", `log_time ${e.minutes} min on task ${task_id.slice(0, 100)}`, record);
    return text({ id: e.id, taskId: e.taskId, minutes: e.minutes, billable: e.billable, note: e.note, startedAt: e.startedAt });
  });

  server.registerTool("add_task", {
    description: "Adds a to-do for Logan; Claude work is assigned by Logan in the app. An extra task on a project (not one of the SOP's steps, so it never finishes the project). Owner is logan, which is also the default. Estimate is whole minutes up to 600; due date is a calendar date. A cancelled project cannot take tasks, and a title that reads like a login is refused.",
    inputSchema: { project_id: id, title: z.string().min(1).max(300), owner: z.string().max(40).optional(), est_minutes: z.number().optional(), due_on: z.string().max(10).optional() },
  }, async ({ project_id, title, owner, est_minutes, due_on }) => {
    const record = { type: "project", id: project_id };
    // Anything the MCP adds must stay out of the Claude queue: a job reading untrusted text could otherwise start a chain of unreviewed Claude work.
    if (owner !== undefined && owner !== "logan") return refuse("add_task", CLAUDE_WORK_REFUSED, record);
    const r = await attempt("add_task", record, () => addAdhocTask(env, { projectId: project_id, title, owner: "logan", estMinutes: est_minutes, dueOn: due_on }, new Date()));
    if ("refused" in r) return r.refused;
    const t = (await getTask(db, r.value.id)) ?? r.value; // the queue may have picked the task up since it was added
    await log("add_task", `add_task ${t.title.slice(0, 100)} (${t.owner})`, { type: "task", id: t.id });
    return text({ id: t.id, projectId: t.projectId, title: t.title, owner: t.owner, status: t.status, estMinutes: t.estMinutes, dueOn: t.dueOn });
  });

  server.registerTool("add_task_comment", {
    description: "Add a note to a task, written as Claude. Up to 4000 characters; a note that reads like a login or password is refused.",
    inputSchema: { task_id: id, body: z.string().min(1).max(4000) },
  }, async ({ task_id, body }) => {
    const record = { type: "task", id: task_id };
    const r = await attempt("add_task_comment", record, () => postComment(env, task_id, "claude", body, new Date()));
    if ("refused" in r) return r.refused;
    await log("add_task_comment", `add_task_comment on task ${task_id.slice(0, 100)}`, record);
    return text({ ok: true });
  });

  server.registerTool("add_note", {
    description: `Add a note to a client's or lead's timeline (up to ${NOTE_MAX} characters). A note that reads like a login or password is refused.`,
    inputSchema: { business_id: id, text: z.string().min(1).max(NOTE_MAX) },
  }, async ({ business_id, text: body }) => {
    const record = { type: "business", id: business_id };
    if (!(await getBusiness(db, business_id))) return refuse("add_note", `business not found: ${business_id.slice(0, 100)}`);
    const clean = cleanText(body, NOTE_MAX);
    if (!clean) return refuse("add_note", "A note cannot be empty.", record);
    if (looksLikeCredential(clean)) return refuse("add_note", NOTE_CREDENTIAL_REFUSED, record);
    await logActivity(db, business_id, "note", clean);
    await log("add_note", `add_note on ${business_id.slice(0, 100)}`, record);
    return text({ ok: true });
  });
}
