import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listBatches } from "../../batches/groups";
import type { ToolCtx } from "./context";

/**
 * The batch board, read only: each recurring template's current period (and the previous one while it has open work) across live, real clients, grouped by earliest due date. The answer is built
 * field by field: a client's name, id, grade and the task's own numbers, never an email address, a phone number, a token or a link.
 */
export function registerBatchTools(server: McpServer, ctx: ToolCtx): void {
  const { db, log, text } = ctx;

  server.registerTool("list_batches", {
    description: "The batch board: for each active recurring template (a weekly update, a monthly report), the tasks of its current period across every live client, with how many are open and done and the estimated minutes left, ordered by earliest due date. The previous period appears only while it still has an open task. Each task has the client name and id, the client's grade (A, B, C or null), status, due date (YYYY-MM-DD), estimate in minutes, checklist items done of total, and held (true when the client has a billing hold: their work waits). Tasks are ordered grade A first, then client name. Test clients and paused projects are left out. No contact details.",
    inputSchema: {},
  }, async () => {
    const groups = (await listBatches(db, new Date())).map((g) => ({
      templateKey: g.templateKey, name: g.name, cadence: g.cadence, period: g.period, label: g.label, dueOn: g.dueOn, open: g.open, done: g.done, estMinutes: g.estMinutes,
      tasks: g.tasks.map((t) => ({
        taskId: t.taskId, clientId: t.businessId, client: t.client, grade: t.grade, status: t.status, dueOn: t.dueOn, estMinutes: t.estMinutes,
        checklistDone: t.checklistDone, checklistTotal: t.checklistTotal, held: t.held,
      })),
    }));
    await log("list_batches", `list_batches -> ${groups.length} ${groups.length === 1 ? "group" : "groups"}`);
    return text({ groups });
  });
}
