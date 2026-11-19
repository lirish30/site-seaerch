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
import { videoRoutes } from "./routes/video";
import { voiceTestRoutes } from "./routes/voiceTest";
import { publicRoutes } from "./routes/public";
import { radarRoutes } from "./routes/radar";
import { serviceRoutes } from "./routes/services";
import { fitRoutes } from "./routes/fit";
import { suppressionRoutes } from "./routes/suppressions";
import { doNotContactRoutes } from "./routes/doNotContact";
import { importRoutes } from "./routes/import";
import { todayRoutes } from "./routes/today";
import { outreachRoutes } from "./routes/outreach";
import { workSampleRoutes } from "./routes/workSamples";
import { spendRoutes } from "./routes/spend";
import { approvalRoutes } from "./routes/approvals";
import { agentActionRoutes } from "./routes/agentActions";
import { mailboxRoutes } from "./routes/mailboxes";
import { campaignRoutes } from "./routes/campaigns";
import { sequenceRoutes } from "./routes/sequence";
import { nicheRoutes } from "./routes/niche";
import { queueRoutes } from "./routes/queue";
import { helperRoutes } from "./routes/helper";
import { helperAdminRoutes } from "./routes/helperAdmin";
import { packageRoutes } from "./routes/packages";
import { dealRoutes, leadDealRoutes } from "./routes/deals";
import "./approvals/leadNote";
import "./approvals/emailSend";
import "./approvals/videoPublish";
import { mcpRoute } from "./mcp/route";
import { runScheduled } from "./schedule";

const app = new Hono<{ Bindings: Env }>();
// Outside /api/*, so the cookie middleware does not apply: /mcp does its own bearer-token check.
app.all("/mcp", mcpRoute);
// Also outside /api/*: the Mac helper sends a device token (never the cookie), which requireHelper checks on every /helper route.
app.route("/helper", helperRoutes);
app.use("/api/*", requireAuth);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", authRoutes);
app.route("/api/passkey", passkeyRoutes);
app.route("/api/searches", searchRoutes);
app.route("/api/leads", leadRoutes);
app.route("/api/leads", sequenceRoutes); // /:id/sequence/*; leadRoutes has no handler for these paths
app.route("/api/settings", settingsRoutes);
app.route("/api/google", googleRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/radar", radarRoutes);
app.route("/api/services", serviceRoutes);
app.route("/api/fit-profiles", fitRoutes);
app.route("/api/suppressions", suppressionRoutes);
app.route("/api/do-not-contact", doNotContactRoutes);
app.route("/api/import", importRoutes);
app.route("/api/today", todayRoutes);
app.route("/api/outreach", outreachRoutes);
app.route("/api/work-samples", workSampleRoutes);
app.route("/api/spend", spendRoutes);
app.route("/api/approvals", approvalRoutes);
app.route("/api/agent-actions", agentActionRoutes);
app.route("/api/mailboxes", mailboxRoutes);
app.route("/api/campaigns", campaignRoutes);
app.route("/api/niche", nicheRoutes);
app.route("/api/queue", queueRoutes);
app.route("/api/helper", helperAdminRoutes);
app.route("/api/packages", packageRoutes);
app.route("/api/deals", dealRoutes);
app.route("/api/leads", leadDealRoutes); // /:id/deal
// Mounted last at /api: /api/leads/:id/cro-audit(s), /api/cro-items/:id, /api/cro-audits/:id/... (all behind requireAuth).
app.route("/api", croRoutes);
// Also mounted at /api: /api/leads/:id/video and /api/video-audits/:id/... (behind requireAuth).
app.route("/api", videoRoutes);
// /api/settings/voice-reference and /api/voice-tests/... (behind requireAuth).
app.route("/api", voiceTestRoutes);

export default {
  fetch: app.fetch,
  // Cron Trigger: unattended, so a crash here must be logged, never thrown into a retry loop (runScheduled contains every part's failure).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, controller.cron, new Date()));
  },
} satisfies ExportedHandler<Env>;
export { LeadWorkflow, SearchWorkflow, CroAuditWorkflow, VideoAuditWorkflow } from "./workflows";
