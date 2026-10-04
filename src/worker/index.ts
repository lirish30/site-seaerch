import { Hono } from "hono";
import type { Env } from "./env";
import { requireAuth } from "./auth";
import { authRoutes } from "./routes/auth";
import { searchRoutes } from "./routes/searches";
import { leadRoutes } from "./routes/leads";
import { settingsRoutes } from "./routes/settings";
import { googleRoutes } from "./routes/google";
import { croRoutes } from "./routes/cro";

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", requireAuth);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", authRoutes);
app.route("/api/searches", searchRoutes);
app.route("/api/leads", leadRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/google", googleRoutes);
app.route("/api", croRoutes);

export default app;
export { LeadWorkflow, SearchWorkflow, CroAuditWorkflow } from "./workflows";
