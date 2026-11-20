import { Hono } from "hono";
import { z } from "zod";
import { createChangeOrderSendApproval } from "../approvals/changeOrderSend";
import { draftChangeOrder, editDraft, markChangeOrderPaid, ownerChangeOrder, voidDraftOrSent } from "../changeorders/service";
import { getChangeOrder, listChangeOrders } from "../db/changeOrders";
import { getProject } from "../db/projects";
import type { Env } from "../env";
import { bodyOf, NOT_FOUND, ownerOnError } from "../projects/http";

/** Mounted at /api: /projects/:id/change-orders, /change-orders/:id/... (behind requireAuth). Nothing here mails the client: sending is an approval. */
export const changeOrderRoutes = new Hono<{ Bindings: Env }>();
changeOrderRoutes.onError(ownerOnError);

/** Text and lists are capped well above what the order keeps, so the order's own sentences ("The title is at most 120 characters.") are what the owner reads. */
const text = (max: number) => z.string().max(max);
const list = z.array(text(2000)).max(50);
const Fields = {
  title: text(2000), summary: text(20_000), reason: text(10_000), hours: z.number(), deliverables: list, notIncluded: list, scheduleImpactDays: z.number().nullable(),
  priceCents: z.number(), rateCents: z.number(), contactName: text(2000), contactEmail: text(2000),
};
const NewBody = z.object({
  title: Fields.title, hours: Fields.hours, summary: Fields.summary.optional(), reason: Fields.reason.optional(), deliverables: Fields.deliverables.optional(), notIncluded: Fields.notIncluded.optional(),
  scheduleImpactDays: Fields.scheduleImpactDays.optional(), priceCents: Fields.priceCents.optional(), rateCents: Fields.rateCents.optional(),
}).strict();
const EditBody = z.object(Fields).partial().strict().refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

changeOrderRoutes.get("/projects/:id/change-orders", async (c) => {
  if (!(await getProject(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  return c.json({ changeOrders: (await listChangeOrders(c.env.DB, c.req.param("id"))).map((o) => ownerChangeOrder(c.env, o)) });
});

/** Drafts an order on the project: priced at the hourly rate unless a rate or price is given, with one locked, billable task per deliverable. Nothing is sent. */
changeOrderRoutes.post("/projects/:id/change-orders", async (c) => {
  const body = await bodyOf(c, NewBody);
  if (body instanceof Response) return body;
  const project = await getProject(c.env.DB, c.req.param("id"));
  if (!project) return c.json(NOT_FOUND, 404);
  const co = await draftChangeOrder(c.env, { ...body, summary: body.summary ?? "", reason: body.reason ?? "", projectId: project.id, sourceType: "logan" });
  return c.json({ changeOrder: ownerChangeOrder(c.env, co) }, 201);
});

/** Edits a draft (anything else is frozen: 409). A send approval waiting on it is withdrawn. */
changeOrderRoutes.patch("/change-orders/:id", async (c) => {
  const body = await bodyOf(c, EditBody);
  if (body instanceof Response) return body;
  if (!(await getChangeOrder(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  return c.json({ changeOrder: ownerChangeOrder(c.env, await editDraft(c.env, c.req.param("id"), body)) });
});

/** Puts the draft up for approval. One approval waits per order: a second call returns it. Nothing is mailed until the owner approves. */
changeOrderRoutes.post("/change-orders/:id/send", async (c) => {
  const co = await getChangeOrder(c.env.DB, c.req.param("id"));
  if (!co) return c.json(NOT_FOUND, 404);
  if (co.status !== "draft") return c.json({ error: `This change order is ${co.status}, not a draft.` }, 409);
  const a = await createChangeOrderSendApproval(c.env, co);
  return c.json({ approval: { id: a.id, kind: a.kind, title: a.title, status: a.status } });
});

/** Voids a draft, sent, viewed, declined or expired order, and skips its tasks. A signed order is a record: 409. */
changeOrderRoutes.post("/change-orders/:id/void", async (c) => {
  const body = await bodyOf(c, z.object({ reason: text(5000) }).strict());
  if (body instanceof Response) return body;
  if (!(await getChangeOrder(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  return c.json({ changeOrder: ownerChangeOrder(c.env, await voidDraftOrSent(c.env, c.req.param("id"), body.reason)) });
});

/** The money is in the owner's account (outside Stripe): records it and unlocks the order's tasks. Needs `confirm: true` and a signed order (409 otherwise). */
changeOrderRoutes.post("/change-orders/:id/mark-paid", async (c) => {
  const body = await bodyOf(c, z.object({ confirm: z.literal(true) }).strict());
  if (body instanceof Response) return body;
  if (!(await getChangeOrder(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  return c.json({ changeOrder: ownerChangeOrder(c.env, await markChangeOrderPaid(c.env, c.req.param("id"), { via: "manual", now: new Date() })) });
});
