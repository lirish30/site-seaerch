import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { moneyDashboard } from "../../money/dashboard";
import type { ToolCtx } from "./context";

/** The money tool: the same dashboard the Money page shows (test clients are already left out of it), read only. */
export function registerMoneyTools(server: McpServer, ctx: ToolCtx): void {
  const { env, log, text } = ctx;

  server.registerTool("get_money_summary", {
    description: "The money dashboard: cash received this month and the last six, what is owed by age with the oldest unpaid invoices, MRR and churn, booked-not-billed per client, profit per project, the ten best clients by cash paid, the freedom number and running costs against the cap. Money is in cents. Test clients are left out.",
    inputSchema: {},
  }, async () => {
    const dashboard = await moneyDashboard(env, new Date());
    await log("get_money_summary", `get_money_summary -> ${dashboard.mrr.subscriptions} subscriptions, ${dashboard.ar.openCents} cents owed`);
    return text(dashboard);
  });
}
