import type { Env } from "../env";
import { getDocument } from "../db/documents";
import { paidTotalForDocument } from "../db/invoices";
import { listProjects, type Project } from "../db/projects";

/**
 * What the project was sold for and what has been paid on it. The sale is the proposal's one-time money (its payment schedule's milestones); the money paid is what the proposal's own deposit and milestone invoices have paid (a change order's money is counted through the order, never here).
 * A Care project that follows a build on the same proposal carries neither (the build has the one-time money), a Care project on its own does, and a project made by hand has none.
 * A signed change order adds its price to what was sold, and to what was paid once it is paid.
 */
export async function soldAndPaid(env: Env, p: Project, orders: { status: string; paidAt: string | null; content: { priceCents: number } }[]): Promise<{ soldCents: number; paidCents: number }> {
  let soldCents = 0, paidCents = 0;
  const doc = p.documentId ? await getDocument(env.DB, p.documentId) : null;
  const followsBuild = p.kind === "care_onboarding" && !!doc && (await listProjects(env.DB, { businessId: p.businessId })).some((x) => x.documentId === doc.id && x.kind !== "care_onboarding");
  if (doc && !followsBuild) {
    soldCents = doc.content.schedule.milestones.reduce((sum, m) => sum + m.amountCents, 0);
    paidCents = await paidTotalForDocument(env.DB, doc.id, ["deposit", "milestone"]);
  }
  for (const o of orders) {
    if (o.status !== "signed") continue;
    soldCents += o.content.priceCents;
    if (o.paidAt) paidCents += o.content.priceCents;
  }
  return { soldCents, paidCents };
}
