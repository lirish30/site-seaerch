import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { Business, LeadStatus } from "../types";
import { getBusiness, listAllBusinesses, updateLead, domainOf } from "../db/businesses";
import { latestAudit, latestAuditsFor } from "../db/audits";
import { listContacts, contactsFor } from "../db/contacts";
import { latestDraft, updateDraftBody } from "../db/drafts";
import { pickRecipient } from "../recipient";
import { regenerateDraft } from "../pipeline/lead";
import { depsFromEnv } from "../workflows";
import { mailingSettingsMissing, MISSING_MAILING_SETTINGS } from "./compliance";

const STATUSES = ["new", "reviewed", "contacted", "replied", "won", "lost", "skip"] as const;

export async function leadRows(db: D1Database, businesses: Business[]) {
  const ids = businesses.map((b) => b.id);
  const [audits, contactMap] = await Promise.all([latestAuditsFor(db, ids), contactsFor(db, ids)]);
  return businesses.map((b) => {
    const audit = audits.get(b.id) ?? null;
    const best = pickRecipient(contactMap.get(b.id) ?? [], domainOf(b.website_url));
    return {
      business: b, score: audit?.score ?? null, topFinding: audit?.findings[0]?.evidence ?? null,
      offer: audit?.offer ?? null, bestContact: best.contact?.value ?? null, hasEmail: !!best.emailContact,
      partial: audit?.partial ?? false, platform: audit?.platform ?? null, rating: b.rating, reviewCount: b.review_count,
    };
  });
}

const DEFAULT_LIMIT = 200, MAX_LIMIT = 500;
function intParam(v: string | undefined, def: number, min: number, max: number) {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export const leadRoutes = new Hono<{ Bindings: Env }>();

leadRoutes.get("/", async (c) => {
  const status = c.req.query("status") as LeadStatus | undefined;
  if (status && !STATUSES.includes(status)) return c.json({ error: "bad status" }, 400);
  const limit = intParam(c.req.query("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = intParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  return c.json(await leadRows(c.env.DB, await listAllBusinesses(c.env.DB, { status, limit, offset })));
});

leadRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  let business = await getBusiness(c.env.DB, id);
  if (!business) return c.json({ error: "not found" }, 404);
  if (business.lead_status === "new") business = await updateLead(c.env.DB, id, { leadStatus: "reviewed" });
  const [audit, contacts, draft] = await Promise.all([latestAudit(c.env.DB, id), listContacts(c.env.DB, id), latestDraft(c.env.DB, id)]);
  const toContact = draft?.to_contact_id ? contacts.find((x) => x.id === draft.to_contact_id) ?? null : null;
  return c.json({ business, audit, contacts, draft, toContact });
});

const PatchLead = z.object({ leadStatus: z.enum(STATUSES).optional(), notes: z.string().max(5000).optional() });
leadRoutes.patch("/:id", async (c) => {
  const p = PatchLead.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  if (!(await getBusiness(c.env.DB, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  return c.json(await updateLead(c.env.DB, c.req.param("id"), p.data));
});

const PatchDraft = z.object({ subject: z.string().min(1).max(300), body: z.string().min(1).max(5000) });
leadRoutes.patch("/:id/draft", async (c) => {
  const p = PatchDraft.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const d = await latestDraft(c.env.DB, c.req.param("id"));
  if (!d) return c.json({ error: "no draft" }, 404);
  await updateDraftBody(c.env.DB, d.id, p.data);
  return c.json({ ok: true });
});

leadRoutes.post("/:id/regenerate", async (c) => {
  if (await mailingSettingsMissing(c.env.DB)) return c.json({ error: MISSING_MAILING_SETTINGS }, 400);
  const { steeringNote } = await c.req.json<{ steeringNote?: string }>().catch(() => ({ steeringNote: undefined }));
  try {
    return c.json(await regenerateDraft(depsFromEnv(c.env), c.req.param("id"), steeringNote?.trim() || null));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

leadRoutes.post("/:id/reaudit", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  if (await mailingSettingsMissing(c.env.DB)) return c.json({ error: MISSING_MAILING_SETTINGS }, 400);
  await c.env.LEAD_WORKFLOW.create({ id: `reaudit-${id}-${Date.now()}`, params: { businessId: id, searchId: null, forceDraft: true } });
  return c.json({ ok: true }, 202);
});
