import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { CLIENT_BASE_PROBLEM, createWelcomeApproval } from "../approvals/onboardingWelcome";
import { logActivityOnce } from "../db/activity";
import { getDeal } from "../db/deals";
import {
  addCustomItem, closeOnboarding, getFile, getItem, getOnboarding, getOnboardingForDeal, listFiles, newToken, setItemStatus, setOwnerFields, setRevoked,
  type OnboardingItem,
} from "../db/onboardings";
import { clientBase } from "../documents/mail";
import { safeFileName } from "../onboarding/files";
import { onboardingLink } from "../onboarding/link";
import { onboardingState, ownerFile, ownerOnboarding, realStartProblem, testStartProblem, welcomeApprovalFor, type OwnerItem } from "../onboarding/owner";
import { checkKickoff, checkVideoUrl, type Checked } from "../onboarding/ownerChecks";
import { startOnboarding } from "../onboarding/start";
import { cleanText } from "../onboarding/templates";

const invalid = (error: z.ZodError) => ({ error: "invalid body", fields: z.flattenError(error).fieldErrors });

/** A zod step that runs one of the owner's checks: the field is flagged with the check's own sentence. */
const checked = <T>(check: (v: string) => Checked<T>) => (v: string, ctx: z.RefinementCtx): T => {
  const r = check(v);
  if (r.ok) return r.value;
  ctx.addIssue({ code: "custom", message: r.error });
  return z.NEVER;
};
const nullable = <T>(check: (v: string) => Checked<T | null>) => (v: string | null | undefined, ctx: z.RefinementCtx): T | null | undefined => (v == null ? v : checked(check)(v, ctx));

const oneLine = (s: string) => cleanText(s, 2000).replace(/\s+/g, " ").trim();

const PatchBody = z.object({
  welcomeVideoUrl: z.string().nullable().transform(nullable(checkVideoUrl)).optional(),
  kickoffAt: z.string().nullable().transform(nullable(checkKickoff)).optional(),
}).strict().refine((b) => b.welcomeVideoUrl !== undefined || b.kickoffAt !== undefined, { message: "nothing to change" });
const ItemBody = z.object({
  label: z.string().transform(oneLine).pipe(z.string().min(1).max(120)),
  instructions: z.string().optional().transform((s) => cleanText(s ?? "", 5000)).pipe(z.string().max(600)),
  kind: z.enum(["text", "files"]),
  phase: z.union([z.literal(1), z.literal(2)]),
  dueAt: z.string().nullable().optional().transform(nullable(checkKickoff)),
}).strict();
const StatusBody = z.object({ status: z.enum(["accepted", "not_applicable", "waiting"]) }).strict();

/** Mounted at /api: /deals/:id/onboarding..., /onboardings/:id/..., /onboarding-items/:id, /onboarding-files/:id (all behind requireAuth). */
export const onboardingRoutes = new Hono<{ Bindings: Env }>();

const NOT_FOUND = { error: "not found" };
const CLOSED = { error: "this onboarding is closed" };

onboardingRoutes.get("/deals/:id/onboarding", async (c) => {
  const id = c.req.param("id");
  if (!(await getDeal(c.env.DB, id))) return c.json(NOT_FOUND, 404);
  return c.json(await onboardingState(c.env, id, new Date()));
});

/** The real start: a deal whose latest signed, non-test proposal is paid. Idempotent (the payment normally does this; this is the retry for when it could not). */
onboardingRoutes.post("/deals/:id/onboarding/start", async (c) => {
  const id = c.req.param("id");
  if (!(await getDeal(c.env.DB, id))) return c.json(NOT_FOUND, 404);
  const existing = await getOnboardingForDeal(c.env.DB, id);
  if (existing?.test) return c.json({ error: "This deal already has a test onboarding, so a real one cannot be started beside it." }, 409);
  const ready = await realStartProblem(c.env, id);
  if ("problem" in ready) return existing ? c.json(await onboardingState(c.env, id, new Date())) : c.json({ error: ready.problem }, 409);
  const started = await startOnboarding(c.env, ready.doc);
  if (!started) return c.json({ error: "The onboarding could not be started. The reason is on the lead's timeline." }, 409);
  return c.json(await onboardingState(c.env, id, new Date()), existing ? 200 : 201);
});

/** A test onboarding for the deal's latest signed proposal (a test copy is fine): its welcome goes to the owner's own address, never to the client. */
onboardingRoutes.post("/deals/:id/onboarding/test", async (c) => {
  const id = c.req.param("id");
  if (!(await getDeal(c.env.DB, id))) return c.json(NOT_FOUND, 404);
  if (await getOnboardingForDeal(c.env.DB, id)) return c.json({ error: "This deal already has an onboarding." }, 409);
  const ready = await testStartProblem(c.env, id);
  if ("problem" in ready) return c.json({ error: ready.problem }, 409);
  const started = await startOnboarding(c.env, ready.doc, { test: true });
  if (!started) return c.json({ error: "The test onboarding could not be started. The reason is on the lead's timeline." }, 409);
  return c.json(await onboardingState(c.env, id, new Date()), 201);
});

/** Asks for the welcome again: only while it is unsent, and a welcome already waiting is the one returned. */
onboardingRoutes.post("/onboardings/:id/welcome", async (c) => {
  const o = await getOnboarding(c.env.DB, c.req.param("id"));
  if (!o) return c.json(NOT_FOUND, 404);
  if (o.closedAt) return c.json(CLOSED, 409);
  if (o.welcomeSentAt) return c.json({ error: "The welcome was already sent." }, 409);
  if (o.revokedAt) return c.json({ error: "The client's link is turned off. Make a new link first: the welcome carries it." }, 409);
  if (!clientBase(c.env)) return c.json({ error: CLIENT_BASE_PROBLEM }, 409);
  await createWelcomeApproval(c.env, o);
  return c.json({ welcomeApproval: await welcomeApprovalFor(c.env.DB, o.id) });
});

onboardingRoutes.patch("/onboardings/:id", async (c) => {
  const parsed = PatchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const o = await getOnboarding(c.env.DB, c.req.param("id"));
  if (!o) return c.json(NOT_FOUND, 404);
  if (o.closedAt) return c.json(CLOSED, 409);
  return c.json({ onboarding: ownerOnboarding(await setOwnerFields(c.env.DB, o.id, parsed.data)) });
});

const withFiles = async (db: D1Database, i: OnboardingItem): Promise<OwnerItem> => ({ ...i, files: i.kind === "files" ? (await listFiles(db, i.id)).map(ownerFile) : [] });
const isUnique = (e: unknown) => e instanceof Error && /UNIQUE/i.test(e.message);

onboardingRoutes.post("/onboardings/:id/items", async (c) => {
  const parsed = ItemBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const o = await getOnboarding(c.env.DB, c.req.param("id"));
  if (!o) return c.json(NOT_FOUND, 404);
  if (o.closedAt) return c.json(CLOSED, 409);
  const { label, instructions, kind, phase, dueAt } = parsed.data;
  // The key is made here and is unique for the onboarding; a clash (vanishingly rare) is tried again with a new one.
  for (let attempt = 0; ; attempt++) {
    try {
      const key = `custom_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      return c.json({ item: await withFiles(c.env.DB, await addCustomItem(c.env.DB, o.id, { key, label, instructions, kind, phase, dueAt: dueAt ?? null })) }, 201);
    } catch (e) {
      if (!isUnique(e) || attempt >= 2) throw e;
    }
  }
});

/** Accept, Not needed, or Ask again (back to waiting, which also lets the client upload to an accepted item again). */
onboardingRoutes.patch("/onboarding-items/:id", async (c) => {
  const parsed = StatusBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const item = await getItem(c.env.DB, c.req.param("id"));
  const o = item && (await getOnboarding(c.env.DB, item.onboardingId));
  if (!item || !o) return c.json(NOT_FOUND, 404);
  if (o.closedAt) return c.json(CLOSED, 409);
  await setItemStatus(c.env.DB, item.id, parsed.data.status);
  return c.json({ item: await withFiles(c.env.DB, (await getItem(c.env.DB, item.id))!) });
});

/** RFC 5987 percent-encoding: everything but letters, digits and `-._~` (encodeURIComponent leaves `!'()*`, which are encoded too). */
const encodeName = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
const PLAIN_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(; charset=utf-8)?$/i;

/**
 * A client's file, for the owner. It is only ever a download (never shown in the page), whatever is in it: an attachment, with the file's name cleaned again
 * (the stored one is client text), `nosniff`, the content type the server chose at upload (never one the client claimed), and a policy that lets nothing run.
 */
onboardingRoutes.get("/onboarding-files/:id", async (c) => {
  const f = await getFile(c.env.DB, c.req.param("id"));
  if (!f) return c.json(NOT_FOUND, 404);
  const object = await c.env.RAW.get(f.r2Key);
  if (!object) return c.json(NOT_FOUND, 404);
  return new Response(object.body, {
    headers: {
      "content-type": PLAIN_TYPE.test(f.contentType) ? f.contentType : "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeName(safeFileName(f.fileName))}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-length": String(object.size),
    },
  });
});

/** Turns the client's link off at once (the page 404s). */
onboardingRoutes.post("/onboardings/:id/link/revoke", async (c) => {
  const o = await getOnboarding(c.env.DB, c.req.param("id"));
  if (!o) return c.json(NOT_FOUND, 404);
  return c.json({ onboarding: ownerOnboarding(await setRevoked(c.env.DB, o.id, true, new Date().toISOString())) });
});

/** A new link on a new token: the old one is dead for good and a revoked onboarding is live again. */
onboardingRoutes.post("/onboardings/:id/link/new", async (c) => {
  const o = await getOnboarding(c.env.DB, c.req.param("id"));
  if (!o) return c.json(NOT_FOUND, 404);
  // Without a client base the new link could not be shown, and the old one would be gone for nothing.
  if (!clientBase(c.env)) return c.json({ error: CLIENT_BASE_PROBLEM }, 409);
  const fresh = await newToken(c.env.DB, o.id);
  return c.json({ link: onboardingLink(clientBase(c.env) ?? undefined, fresh.token), onboarding: ownerOnboarding(fresh) });
});

/** Closes it: the client's page becomes read-only and its writes are 409. The first close stays on record. */
onboardingRoutes.post("/onboardings/:id/close", async (c) => {
  const o = await getOnboarding(c.env.DB, c.req.param("id"));
  if (!o) return c.json(NOT_FOUND, 404);
  const now = new Date().toISOString();
  await closeOnboarding(c.env.DB, o.id, now);
  if (!o.closedAt) await logActivityOnce(c.env.DB, o.businessId, "note", "onboarding closed");
  return c.json({ onboarding: ownerOnboarding((await getOnboarding(c.env.DB, o.id))!) });
});
