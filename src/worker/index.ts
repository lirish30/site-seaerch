import { Hono } from "hono";
import type { Env } from "./env";
import { requireAuth } from "./auth";
import { authRoutes } from "./routes/auth";
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
import { workSampleRoutes } from "./routes/workSamples";
import { jobRoutes } from "./routes/jobs";
import { runDueRadars } from "./radar-run";
import { searchWorkflowStarter } from "./search-start";
import { jobDeps, runJobWatch } from "./jobs/run";

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", requireAuth);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", authRoutes);
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
app.route("/api/work-samples", workSampleRoutes);
app.route("/api/jobs", jobRoutes);
// Mounted last at /api: /api/leads/:id/cro-audit(s), /api/cro-items/:id, /api/cro-audits/:id/... (all behind requireAuth).
app.route("/api", croRoutes);

// Radars keep their daily cron; the job watcher runs every six hours on its own.
export const JOB_WATCH_CRON = "37 */6 * * *";

export default {
  fetch: app.fetch,
  // Cron Trigger: unattended work, so a crash here must be logged, never thrown into a retry loop.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === JOB_WATCH_CRON) {
      ctx.waitUntil(jobDeps(env).then(runJobWatch).then((s) => console.log("job watch", JSON.stringify(s)), (e) => console.error("job watch failed", e)));
      return;
    }
    ctx.waitUntil(
      runDueRadars({
        db: env.DB, now: () => new Date(), startWorkflow: searchWorkflowStarter(env),
      }).then((s) => console.log("radar run", JSON.stringify(s)), (e) => console.error("radar run failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;
export { LeadWorkflow, SearchWorkflow, CroAuditWorkflow } from "./workflows";
