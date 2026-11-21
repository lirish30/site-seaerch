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
import { deckRoutes } from "./routes/deck";
import { bookingRoutes } from "./routes/bookings";
import { documentRoutes } from "./routes/documents";
import { onboardingRoutes } from "./routes/onboarding";
import { projectRoutes } from "./routes/projects";
import { sopRoutes } from "./routes/sops";
import { timeRoutes } from "./routes/time";
import { changeOrderRoutes } from "./routes/changeOrders";
import { billingRoutes } from "./routes/billing";
import { moneyRoutes } from "./routes/money";
import { careRoutes } from "./routes/care";
import { clientRoutes } from "./routes/clients";
import { meetingRoutes } from "./routes/meetings";
import { stripeWebhookRoutes } from "./routes/stripeWebhook";
import "./approvals/leadNote";
import "./approvals/emailSend";
import "./approvals/videoPublish";
import "./approvals/proposalSend";
import "./approvals/onboardingWelcome";
import "./approvals/onboardingNudge";
import "./approvals/meetingFollowup";
import "./approvals/sopReview";
import "./approvals/changeOrderSend";
import "./approvals/changeOrderDraft";
import "./approvals/invoiceSend";
import "./approvals/subscriptionStart";
import "./approvals/termNotice";
import "./approvals/invoiceReminder";
import "./approvals/pauseNotice";
import "./billing/milestones"; // registers the hook that drafts and proposes a milestone invoice when a project reaches one
import "./billing/subscriptions"; // registers the hook that proposes a launch subscription when its build project is done
import "./projects/dispatch"; // registers the hook that sends the next ready Claude step when a task changes
import "./projects/start"; // registers the hook that starts Care when the build it waited for is done
import { mcpRoute } from "./mcp/route";
import { runScheduled } from "./schedule";

const app = new Hono<{ Bindings: Env }>();
// Outside /api/*, so the cookie middleware does not apply: /mcp does its own bearer-token check.
app.all("/mcp", mcpRoute);
// Also outside /api/*: the Mac helper sends a device token (never the cookie), which requireHelper checks on every /helper route.
app.route("/helper", helperRoutes);
// Also outside /api/*: Stripe calls this with no cookie; the route checks the Stripe-Signature header against STRIPE_WEBHOOK_SECRET.
app.route("/hooks/stripe", stripeWebhookRoutes);
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
app.route("/api/deals", deckRoutes()); // /:id/deck.html, /:id/deck.pdf, /:id/deck/freeze
app.route("/api/leads", leadDealRoutes); // /:id/deal
app.route("/api/bookings", bookingRoutes);
app.route("/api", documentRoutes); // /deals/:id/proposal, /documents/:id/...
app.route("/api", onboardingRoutes); // /deals/:id/onboarding..., /onboardings/:id/..., /onboarding-items/:id, /onboarding-files/:id
app.route("/api", projectRoutes); // /projects..., /tasks..., /me/tasks, /deals/:id/projects/...
app.route("/api", sopRoutes); // /sops...
app.route("/api", timeRoutes); // /time..., /timer/stop, /tasks/:id/timer/start, /tasks/:id/time
app.route("/api", clientRoutes); // /clients, /clients/:id, /clients/:id/sites, /sites/:id, /sites/:id/access/:key
app.route("/api", meetingRoutes); // /meetings/sync
app.route("/api", changeOrderRoutes); // /projects/:id/change-orders, /change-orders/:id/...
app.route("/api", billingRoutes); // /billing/..., /change-orders/:id/invoice, /projects/:id/invoices/hourly
app.route("/api", moneyRoutes); // /money
app.route("/api", careRoutes); // /care, /incidents, /sites/:id/checks, /sites/:id/monitoring
// Mounted last at /api: /api/leads/:id/cro-audit(s), /api/cro-items/:id, /api/cro-audits/:id/... (all behind requireAuth).
app.route("/api", croRoutes);
// Also mounted at /api: /api/leads/:id/video and /api/video-audits/:id/... (behind requireAuth).
app.route("/api", videoRoutes);
// /api/settings/voice-reference and /api/voice-tests/... (behind requireAuth).
app.route("/api", voiceTestRoutes);

export default {
  fetch: app.fetch,
  // Cron Trigger: unattended, so a crash here must be logged, never thrown into a retry loop (runScheduled contains every part's failure).
  // The run's time is the trigger's own `scheduledTime`, not the wall clock: a cron that Cloudflare fires twice carries the same time both times, so the monitoring
  // "two failed checks in a row" rule counts the duplicate as one moment (test/scheduled-entry.test.ts).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, controller.cron, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
export { LeadWorkflow, SearchWorkflow, CroAuditWorkflow, VideoAuditWorkflow } from "./workflows";
