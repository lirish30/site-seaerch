import { Hono } from "hono";
import type { Env } from "./env";
import { requireAuth } from "./auth";
import { authRoutes } from "./routes/auth";
import { passkeyRoutes } from "./routes/passkeys";
import { searchRoutes } from "./routes/searches";
import { leadRoutes } from "./routes/leads";
import { settingsRoutes } from "./routes/settings";
import { googleRoutes } from "./routes/google";
import { croRoutes } from "./routes/cro";
import { publicRoutes } from "./routes/public";
import { radarRoutes } from "./routes/radar";
import { serviceRoutes } from "./routes/services";
import { fitRoutes } from "./routes/fit";
import { suppressionRoutes } from "./routes/suppressions";
import { importRoutes } from "./routes/import";
import { todayRoutes } from "./routes/today";
import { outreachRoutes } from "./routes/outreach";
import { workSampleRoutes } from "./routes/workSamples";
import { spendRoutes } from "./routes/spend";
import { approvalRoutes } from "./routes/approvals";
import { agentActionRoutes } from "./routes/agentActions";
import { mailboxRoutes } from "./routes/mailboxes";
import "./approvals/leadNote";
import { mcpRoute } from "./mcp/route";
import { runDueRadars } from "./radar-run";
import { searchWorkflowStarter } from "./search-start";

const app = new Hono<{ Bindings: Env }>();
// Outside /api/*, so the cookie middleware does not apply: /mcp does its own bearer-token check.
app.all("/mcp", mcpRoute);
app.use("/api/*", requireAuth);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", authRoutes);
app.route("/api/passkey", passkeyRoutes);
app.route("/api/searches", searchRoutes);
app.route("/api/leads", leadRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/google", googleRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/radar", radarRoutes);
app.route("/api/services", serviceRoutes);
app.route("/api/fit-profiles", fitRoutes);
app.route("/api/suppressions", suppressionRoutes);
app.route("/api/import", importRoutes);
app.route("/api/today", todayRoutes);
app.route("/api/outreach", outreachRoutes);
app.route("/api/work-samples", workSampleRoutes);
app.route("/api/spend", spendRoutes);
app.route("/api/approvals", approvalRoutes);
app.route("/api/agent-actions", agentActionRoutes);
app.route("/api/mailboxes", mailboxRoutes);
// Mounted last at /api: /api/leads/:id/cro-audit(s), /api/cro-items/:id, /api/cro-audits/:id/... (all behind requireAuth).
app.route("/api", croRoutes);

export default {
  fetch: app.fetch,
  // Cron Trigger: unattended spend, so a crash here must be logged, never thrown into a retry loop.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDueRadars({
        db: env.DB, now: () => new Date(), startWorkflow: searchWorkflowStarter(env),
      }).then((s) => console.log("radar run", JSON.stringify(s)), (e) => console.error("radar run failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;
export { LeadWorkflow, SearchWorkflow, CroAuditWorkflow } from "./workflows";
