import { Hono } from "hono";
import { z } from "zod";
import { reject } from "../approvals/decide";
import { ownerChangeOrder, voidDraftOrSent, withdrawSendApprovals } from "../changeorders/service";
import { listChangeOrders } from "../db/changeOrders";
import { getBusiness } from "../db/businesses";
import { getDeal } from "../db/deals";
import { getDocument } from "../db/documents";
import { paidTotalForDeal } from "../db/invoices";
import { createProject, getProject, listMilestones, listProjects, PROJECT_STATUSES, projectIsLive, setProjectStatus, type Project, type ProjectStatus } from "../db/projects";
import { getSettings } from "../db/settings";
import { getTemplate, saveTemplate } from "../db/sops";
import {
  CREDENTIAL_REFUSED, deleteTask, getTask, listComments, listOpenTasksForLogan, listTasks, moveTask, setTaskStatus, TaskInputError, type Task,
} from "../db/tasks";
import { listEntriesForTask, minutesByTask, timeTotals } from "../db/time";
import type { Env } from "../env";
import { cleanText, looksLikeCredential } from "../onboarding/templates";
import { dispatchReady, requestClaudeStep } from "../projects/dispatch";
import { cancelTasksFor } from "../queue/db";
import { bodyOf, isDomainError, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";
import { runTasksChanged } from "../projects/hooks";
import { addAdhocTask, completeTask, postComment, reopenTask, setWaitingClient, skipTask, startTask, updateTask } from "../projects/service";
import { paidSignedDocument, startProjects, startTestProject } from "../projects/start";
import { projectWaiting } from "../projects/waiting";
import { stepsFromTasks } from "../sop/instantiate";
import { OWNER_TAGS, unmetRequirements } from "../sop/model";
import { parseWorkConfig } from "../time/config";
import { projectProfit } from "../time/profit";

/**
 * Mounted at /api: /projects..., /tasks..., /me/tasks, /deals/:id/projects/... (all behind requireAuth). Owner routes for projects and their tasks; the SOP editor, the time routes and
 * the change-order routes are in their own files. A refusal a service makes (a gated step, a closed project, text that is a login) is mapped in `ownerOnError`.
 */
export const projectRoutes = new Hono<{ Bindings: Env }>();
projectRoutes.onError(ownerOnError);

/** Text sent as part of a body is capped well above what the services keep, so their own messages ("A title is at most 120 characters.") are the ones the owner reads. */
const TEXT = (max: number) => z.string().max(max);
const oneLine = (s: string) => cleanText(s, s.length).replace(/\s+/g, " ");

// ---------------------------------------------------------------- projects

const STATUS_LIST = new Set<string>(PROJECT_STATUSES);

/** A project with its client's name, its task counts and whether it is waiting on the client (derived from the onboarding each time, never stored). */
projectRoutes.get("/projects", async (c) => {
  const raw = c.req.query("status");
  let status: ProjectStatus[] | undefined;
  if (raw !== undefined) {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length || parts.some((s) => !STATUS_LIST.has(s))) return c.json({ error: `status must be one or more of ${PROJECT_STATUSES.join(", ")}, separated by commas` }, 400);
    status = parts as ProjectStatus[];
  }
  const now = new Date();
  const rows = await listProjects(c.env.DB, { status, businessId: c.req.query("businessId") || undefined });
  const projects = await Promise.all(rows.map(async (p) => ({ ...p, waitingOnClient: p.status === "active" && (await projectWaiting(c.env.DB, p, now)) })));
  return c.json({ projects });
});

/**
 * What the project was sold for and what has been paid on it. The sale is the proposal's one-time money (its payment schedule's milestones); the money paid is the deal's paid invoices.
 * A Care project that follows a build on the same proposal carries neither (the build has the one-time money), a Care project on its own does, and a project made by hand has none.
 * A signed change order adds its price to what was sold, and to what was paid once it is paid.
 */
async function soldAndPaid(env: Env, p: Project, orders: { status: string; paidAt: string | null; content: { priceCents: number } }[]): Promise<{ soldCents: number; paidCents: number }> {
  let soldCents = 0, paidCents = 0;
  const doc = p.documentId ? await getDocument(env.DB, p.documentId) : null;
  const followsBuild = p.kind === "care_onboarding" && !!doc && (await listProjects(env.DB, { businessId: p.businessId })).some((x) => x.documentId === doc.id && x.kind !== "care_onboarding");
  if (doc && !followsBuild) {
    soldCents = doc.content.schedule.milestones.reduce((sum, m) => sum + m.amountCents, 0);
    paidCents = p.dealId ? await paidTotalForDeal(env.DB, p.dealId) : 0;
  }
  for (const o of orders) {
    if (o.status !== "signed") continue;
    soldCents += o.content.priceCents;
    if (o.paidAt) paidCents += o.content.priceCents;
  }
  return { soldCents, paidCents };
}

projectRoutes.get("/projects/:id", async (c) => {
  const p = await getProject(c.env.DB, c.req.param("id"));
  if (!p) return c.json(NOT_FOUND, 404);
  const db = c.env.DB;
  const [tasks, milestones, time, taskMinutes, orders, settings, template] = await Promise.all([
    listTasks(db, p.id), listMilestones(db, p.id), timeTotals(db, { projectId: p.id }), minutesByTask(db, p.id), listChangeOrders(db, p.id), getSettings(db),
    p.templateKey ? getTemplate(db, p.templateKey) : null,
  ]);
  const { soldCents, paidCents } = await soldAndPaid(c.env, p, orders);
  const costRateCentsPerHour = parseWorkConfig(settings.work_config).costRateCentsPerHour;
  const profit = { ...projectProfit({ soldCents, paidCents, minutes: time.actualMinutes, costRateCentsPerHour }), soldCents, paidCents };
  return c.json({
    project: p, tasks, taskMinutes, milestones, time, profit, costRateCentsPerHour, waitingOnClient: p.status === "active" && (await projectWaiting(db, p, new Date())),
    changeOrders: orders.map((o) => ownerChangeOrder(c.env, o)), template: template && { key: template.key, name: template.name, version: template.version },
  });
});

const NewProjectBody = z.object({
  businessId: z.string().min(1).max(100),
  name: TEXT(2000).transform(oneLine).pipe(z.string().min(1, "A project needs a name.").max(120, "A project name is at most 120 characters.").refine((n) => !looksLikeCredential(n), CREDENTIAL_REFUSED)),
}).strict();

/** A project of Logan's own, with no proposal and no template: an empty task list to fill. */
projectRoutes.post("/projects", async (c) => {
  const body = await bodyOf(c, NewProjectBody);
  if (body instanceof Response) return body;
  if (!(await getBusiness(c.env.DB, body.businessId))) return c.json(NOT_FOUND, 404);
  const { project } = await createProject(c.env.DB, {
    businessId: body.businessId, dealId: null, documentId: null, onboardingId: null, kind: "custom", name: body.name, test: false, templateKey: null, templateVersion: null,
    careDeferred: false, startedAt: new Date().toISOString(),
  });
  return c.json({ project }, 201);
});

const PatchProjectBody = z.object({ status: z.enum(["active", "paused", "cancelled"]).optional(), pausedReason: TEXT(2000).optional() }).strict()
  .refine((b) => b.status !== undefined || b.pausedReason !== undefined, { message: "nothing to change" });

/**
 * Pause (with a reason), resume or cancel. A finished or cancelled project never reopens, except that a finished Care onboarding project can be cancelled (it is the client's ongoing
 * Care service; cancelling is how Logan stops its cadences and Claude dispatch). Resuming hands the project's ready Claude steps over at once.
 */
projectRoutes.patch("/projects/:id", async (c) => {
  const body = await bodyOf(c, PatchProjectBody);
  if (body instanceof Response) return body;
  const p = await getProject(c.env.DB, c.req.param("id"));
  if (!p) return c.json(NOT_FOUND, 404);
  const careService = p.status === "done" && p.kind === "care_onboarding";
  if (careService && body.status !== "cancelled") return c.json({ error: "This Care project is finished and its Care work is running. It can only be cancelled, which stops that work." }, 409);
  if ((p.status === "done" && !careService) || p.status === "cancelled") return c.json({ error: `This project is ${p.status}, so it cannot be changed.` }, 409);
  const next: ProjectStatus = body.status ?? p.status;
  if (next !== "paused" && body.pausedReason !== undefined) return c.json({ error: "Only a paused project has a reason." }, 409);
  const reason = next === "paused" ? (body.pausedReason !== undefined ? cleanText(body.pausedReason, 300) : p.pausedReason) || null : null;
  if (reason && looksLikeCredential(reason)) return c.json({ error: CREDENTIAL_REFUSED }, 400);
  if (next === p.status && next !== "paused") return c.json({ project: p });
  const saved = await setProjectStatus(c.env.DB, p.id, next, { reason });
  if (saved.status !== next) return c.json({ error: `This project is ${saved.status}, so it cannot be changed.` }, 409);
  if (saved.status === "cancelled") await tidyCancelled(c.env, saved);
  if (p.status === "paused" && saved.status === "active") {
    // The change is saved: a failure to hand out steps now is picked up by the next change or sweep, never a reason to say the resume failed.
    try { await dispatchReady(c.env, new Date()); }
    catch (e) { console.error("projects: could not hand out steps after a resume", e instanceof Error ? e.message : "unknown error"); }
  }
  return c.json({ project: saved });
});

/**
 * After a cancel: the project's open Claude jobs are closed and the approvals waiting on it (review cards for its steps, the send approvals of its change orders) are rejected and its draft, sent and viewed
 * change orders are voided, so nothing is applied, approved, mailed or signed for a project that is gone. The cancel is saved first and each item is tried on its own: a failure is logged and the rest go on, and
 * what is missed is still refused later (a job is stale when its result arrives, a review card is refused for a project that is not active).
 */
async function tidyCancelled(env: Env, p: Project): Promise<void> {
  const log = (what: string, e: unknown) => console.error(`projects: could not ${what} after a cancel`, e instanceof Error ? e.message : "unknown error");
  let tasks: Task[] = [];
  let orders: { id: string; status: string }[] = [];
  try { tasks = await listTasks(env.DB, p.id); orders = (await listChangeOrders(env.DB, p.id)).map((o) => ({ id: o.id, status: o.status })); }
  catch (e) { log("list the project's work", e); return; }
  for (const t of tasks) {
    try { await cancelTasksFor(env.DB, "task", t.id); } catch (e) { log("close a Claude job", e); }
    if (t.reviewApprovalId) {
      try { await reject(env.DB, t.reviewApprovalId, "the project was cancelled"); } catch (e) { log("reject a review card", e); }
    }
  }
  for (const o of orders) {
    try { await withdrawSendApprovals(env.DB, [o.id], "the project was cancelled"); } catch (e) { log("withdraw a send approval", e); }
    // A draft, sent or viewed order is voided (its link stops working and its tasks are skipped); a signed one is a record and stays, and the others are already closed.
    if (o.status === "draft" || o.status === "sent" || o.status === "viewed") {
      try { await voidDraftOrSent(env, o.id, "the project was cancelled"); } catch (e) { log("void a change order", e); }
    }
  }
}

const AdhocBody = z.object({
  title: TEXT(1000), owner: z.enum(OWNER_TAGS).optional(), estMinutes: z.number().optional(), dueOn: TEXT(40).nullable().optional(), billable: z.boolean().optional(),
  requires: z.array(TEXT(100)).max(100).optional(),
}).strict();

/** A task that is not one of the SOP's steps (it never finishes the project). */
projectRoutes.post("/projects/:id/tasks", async (c) => {
  const body = await bodyOf(c, AdhocBody);
  if (body instanceof Response) return body;
  const p = await getProject(c.env.DB, c.req.param("id"));
  if (!p) return c.json(NOT_FOUND, 404);
  return c.json({ task: await addAdhocTask(c.env, { projectId: p.id, ...body, owner: body.owner ?? "logan" }, new Date()) }, 201);
});

/** Saves the project's steps as the next version of the template it was made from. Explicit and confirmed; editing a template never touches a project. */
projectRoutes.post("/projects/:id/sop/push", async (c) => {
  const body = await bodyOf(c, z.object({ confirm: z.literal(true) }).strict());
  if (body instanceof Response) return body;
  const p = await getProject(c.env.DB, c.req.param("id"));
  if (!p) return c.json(NOT_FOUND, 404);
  if (p.kind === "custom" || !p.templateKey) return c.json({ error: "This project was not made from a template, so there is nothing to push its steps back to." }, 409);
  const template = await getTemplate(c.env.DB, p.templateKey);
  if (!template) return c.json({ error: `The template ${p.templateKey} no longer exists, so there is nothing to push this project's steps back to.` }, 409);
  const saved = await saveTemplate(c.env.DB, {
    key: template.key, name: template.name, kind: template.kind, cadence: template.cadence, cadenceDay: template.cadenceDay, appliesTo: template.appliesTo, active: template.active,
    steps: stepsFromTasks(await listTasks(c.env.DB, p.id)),
  });
  return c.json({ version: saved.version });
});

// ---------------------------------------------------------------- starting projects from a deal

/** The retry for a paid deal whose projects did not start (the payment normally starts them). Repeating it finds the projects already made. */
projectRoutes.post("/deals/:id/projects/start", async (c) => {
  if (!(await getDeal(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  const found = await paidSignedDocument(c.env.DB, c.req.param("id"));
  if ("problem" in found) return c.json({ error: found.problem }, 409);
  const projects = await startProjects(c.env, found.doc);
  if (!projects.length) return c.json({ error: "Nothing on this proposal has an SOP yet, so no project was started. A note about it is on the lead's timeline." }, 409);
  return c.json({ projects });
});

/** A test project from the deal's signed test proposal: the same steps, marked test, that Claude is never sent unasked. */
projectRoutes.post("/deals/:id/projects/test", async (c) => {
  if (!(await getDeal(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  const projects = await startTestProject(c.env, c.req.param("id"));
  if (!projects.length) return c.json({ error: "Nothing on this proposal has an SOP yet, so no project was started. A note about it is on the lead's timeline." }, 409);
  return c.json({ projects }, 201);
});

// ---------------------------------------------------------------- tasks

/** Runs `fn` with the task named in the path, or answers 404. */
const onTask = (fn: (c: Ctx, t: Task) => Promise<Response>) => async (c: Ctx): Promise<Response> => {
  const t = await getTask(c.env.DB, c.req.param("id")!);
  return t ? fn(c, t) : c.json(NOT_FOUND, 404);
};
const taskOf = async (c: Ctx, id: string) => (await getTask(c.env.DB, id))!;

projectRoutes.get("/tasks/:id", onTask(async (c, task) => {
  const [comments, totals, entries] = await Promise.all([listComments(c.env.DB, task.id), timeTotals(c.env.DB, { taskId: task.id }), listEntriesForTask(c.env.DB, task.id)]);
  return c.json({ task, comments, time: { ...totals, entries } });
}));

const PatchTaskBody = z.object({
  title: TEXT(1000), description: TEXT(20_000), owner: z.enum(OWNER_TAGS), doneWhen: TEXT(5000), estMinutes: z.number(), dueOn: TEXT(40).nullable(), billable: z.boolean(), skippable: z.boolean(),
  requires: z.array(TEXT(100)).max(100), checklist: z.array(z.object({ text: TEXT(2000), done: z.boolean() }).strict()).max(100), clientSummary: TEXT(1000).nullable(),
}).partial().strict().refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

projectRoutes.patch("/tasks/:id", onTask(async (c, task) => {
  const body = await bodyOf(c, PatchTaskBody);
  if (body instanceof Response) return body;
  return c.json({ task: await updateTask(c.env, task.id, body, new Date()) });
}));

projectRoutes.post("/tasks/:id/start", onTask(async (c, task) => c.json({ task: await startTask(c.env, task.id, new Date()) })));

/**
 * The step is saved before its follow-up work (the milestone, finishing the project, the next Claude step) runs, and both are safe to run again. So a database error part-way is
 * a 500 that says which it was: the change was saved and repeating the request finishes the rest, or it was not changed at all. A refusal the service makes is passed on as it is.
 */
async function afterFailure(c: Ctx, e: unknown, taskId: string, saved: Task["status"]): Promise<Response> {
  if (isDomainError(e)) throw e;
  console.error("projects: a task change failed part-way", e instanceof Error ? e.message : "unknown error");
  const now = await getTask(c.env.DB, taskId).catch(() => null);
  if (now?.status === saved) return c.json({ error: "Your change was saved, but finishing up did not complete. Repeat the request to finish it." }, 500);
  return c.json({ error: "Something went wrong and the step was not changed. Try again." }, 500);
}

projectRoutes.post("/tasks/:id/complete", onTask(async (c, task) => {
  try { return c.json({ task: await completeTask(c.env, task.id, { by: "logan", now: new Date() }) }); }
  catch (e) { return afterFailure(c, e, task.id, "done"); }
}));

projectRoutes.post("/tasks/:id/skip", onTask(async (c, task) => {
  const body = await bodyOf(c, z.object({ reason: TEXT(2000) }).strict());
  if (body instanceof Response) return body;
  try { return c.json({ task: await skipTask(c.env, task.id, body.reason, new Date()) }); }
  catch (e) { return afterFailure(c, e, task.id, "skipped"); }
}));

projectRoutes.post("/tasks/:id/reopen", onTask(async (c, task) => c.json({ task: await reopenTask(c.env, task.id, new Date()) })));

/** `on` (default true) marks the task as waiting on the client; false takes it off again. */
projectRoutes.post("/tasks/:id/waiting", onTask(async (c, task) => {
  const body = await bodyOf(c, z.object({ on: z.boolean().optional() }).strict());
  if (body instanceof Response) return body;
  return c.json({ task: await setWaitingClient(c.env, task.id, body.on ?? true, new Date()) });
}));

projectRoutes.post("/tasks/:id/comment", onTask(async (c, task) => {
  const body = await bodyOf(c, z.object({ body: TEXT(20_000) }).strict());
  if (body instanceof Response) return body;
  await postComment(c.env, task.id, "logan", body.body, new Date());
  return c.json({ comments: await listComments(c.env.DB, task.id) }, 201);
}));

const NoteBody = z.object({ note: TEXT(20_000).optional() }).strict();

/** Hands the step to Claude now (any open step of an active project, a test project's included). */
projectRoutes.post("/tasks/:id/ask-claude", onTask(async (c, task) => {
  const body = await bodyOf(c, NoteBody);
  if (body instanceof Response) return body;
  const { queued } = await requestClaudeStep(c.env, task.id, { note: body.note });
  return c.json({ queued, task: await taskOf(c, task.id) });
}));

/**
 * Sends Claude's work on a step back with a note. Claude is asked again first; then the review card the work was waiting on is rejected ("sent back") and its link cleared. The note
 * and the step are checked before anything changes, so a refusal leaves the card waiting.
 */
projectRoutes.post("/tasks/:id/send-back", onTask(async (c, task) => {
  const body = await bodyOf(c, NoteBody);
  if (body instanceof Response) return body;
  if (task.status !== "in_review") return c.json({ error: "Only a step that is in review can be sent back." }, 409);
  const project = await getProject(c.env.DB, task.projectId);
  if (!project || !projectIsLive(project)) return c.json({ error: `This project is ${project?.status ?? "gone"}, so Claude cannot start on it.` }, 409);
  if (body.note !== undefined && looksLikeCredential(cleanText(body.note, body.note.length))) throw new TaskInputError(CREDENTIAL_REFUSED);
  const { queued } = await requestClaudeStep(c.env, task.id, { note: body.note });
  // Claude has the step again; now the old card goes. Each part is best effort: a card left waiting is no harm to the re-queue (the step has moved on from the review it asked about).
  if (task.reviewApprovalId) {
    try { await reject(c.env.DB, task.reviewApprovalId, "sent back"); } catch (e) { console.error("projects: could not reject the old review card", e instanceof Error ? e.message : "unknown error"); }
    try { await setTaskStatus(c.env.DB, task.id, "in_progress", { from: ["in_progress"], now: new Date().toISOString(), reviewApprovalId: null }); }
    catch (e) { console.error("projects: could not clear the old review link", e instanceof Error ? e.message : "unknown error"); }
  }
  return c.json({ queued, task: await taskOf(c, task.id) });
}));

/** Puts the task at `toPosition` (0 is first) and renumbers the project's tasks. Answers with the project's tasks in their new order. */
projectRoutes.post("/tasks/:id/move", onTask(async (c, task) => {
  const body = await bodyOf(c, z.object({ toPosition: z.number().int().min(0).max(100_000) }).strict());
  if (body instanceof Response) return body;
  await moveTask(c.env.DB, task.id, body.toPosition);
  await runTasksChanged(c.env, task.projectId);
  return c.json({ tasks: await listTasks(c.env.DB, task.projectId) });
}));

projectRoutes.delete("/tasks/:id", onTask(async (c, task) => {
  if (!(await deleteTask(c.env.DB, task.id))) {
    // A locked task (a change order's, until it is signed and paid) refuses a skip too: the way out is to void its change order, which skips it.
    const way = task.status === "locked" ? "Void its change order instead." : "Skip it instead.";
    return c.json({ error: `This task cannot be deleted: only a task that is still to do, was never started, has no time on it and that no other step waits on can go. ${way}` }, 409);
  }
  await runTasksChanged(c.env, task.projectId);
  return c.json({ ok: true });
}));

/**
 * Logan's own work: his tasks that are ready (every step they wait on is done, or they are already under way) and Claude's drafts waiting for his review, grouped by project,
 * soonest due first. Only active projects. A test project is included and says so.
 */
projectRoutes.get("/me/tasks", async (c) => {
  const open = await listOpenTasksForLogan(c.env.DB);
  const groups = new Map<string, { projectId: string; projectName: string; businessId: string; businessName: string; test: boolean; tasks: Task[] }>();
  const all = new Map<string, Task[]>();
  for (const t of open) {
    if (!all.has(t.projectId)) all.set(t.projectId, await listTasks(c.env.DB, t.projectId));
    if (t.status === "todo" && unmetRequirements(t.requires, all.get(t.projectId)!).length) continue;
    let g = groups.get(t.projectId);
    if (!g) {
      g = { projectId: t.projectId, projectName: t.projectName, businessId: t.businessId, businessName: t.businessName, test: !!(await getProject(c.env.DB, t.projectId))?.test, tasks: [] };
      groups.set(t.projectId, g);
    }
    const { projectName: _p, businessName: _b, ...task } = t;
    g.tasks.push(task);
  }
  return c.json({ projects: [...groups.values()] });
});
