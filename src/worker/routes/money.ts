import { Hono } from "hono";
import type { Env } from "../env";
import { moneyDashboard } from "../money/dashboard";
import { ownerOnError } from "../projects/http";

/**
 * Mounted at /api (behind requireAuth): GET /money. The money dashboard, read only: cash received, what is owed, MRR and churn, what is booked and not billed, profit per project, lifetime value and running costs.
 * It holds no ledger and no tax figure, and no Stripe id or token.
 */
export const moneyRoutes = new Hono<{ Bindings: Env }>();
moneyRoutes.onError(ownerOnError);

moneyRoutes.get("/money", async (c) => c.json(await moneyDashboard(c.env, new Date())));
