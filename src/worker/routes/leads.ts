import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { Business, LeadStatus } from "../types";
import { getBusiness, listAllBusinesses, updateLead, domainOf, setArchived, deleteBusiness } from "../db/businesses";
import { listPeople, createPerson, updatePerson, deletePerson } from "../db/people";
import { listActivity, logActivity } from "../db/activity";
import { latestAudit, latestAuditsFor } from "../db/audits";
import { listContacts, contactsFor } from "../db/contacts";
import { latestDraft, updateDraftBody, listDrafts } from "../db/drafts";
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
      business: b, score: audit?.score ?? null, health: audit?.health_score ?? null, niche: audit?.niche ?? null,
      topFinding: audit?.findings[0]?.evidence ?? null,
      offer: audit?.offer ?? null, bestContact: best.contact?.value ?? null, hasEmail: !!best.emailContact,
      partial: audit?.partial ?? false,
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
  const archived = c.req.query("archived") === "1";
  return c.json(await leadRows(c.env.DB, await listAllBusinesses(c.env.DB, { status, limit, offset, archived })));
});

leadRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  let business = await getBusiness(c.env.DB, id);
  if (!business) return c.json({ error: "not found" }, 404);
  if (business.lead_status === "new") business = await updateLead(c.env.DB, id, { leadStatus: "reviewed" });
  const [audit, contacts, draft, people, activity] = await Promise.all([latestAudit(c.env.DB, id), listContacts(c.env.DB, id),
    latestDraft(c.env.DB, id), listPeople(c.env.DB, id), listActivity(c.env.DB, id)]);
  const toContact = draft?.to_contact_id ? contacts.find((x) => x.id === draft.to_contact_id) ?? null : null;
  return c.json({ business, audit, contacts, draft, toContact, people, activity });
});

// Screenshots live in the private R2 bucket; serve the latest audit's copy behind the app's auth.
leadRoutes.get("/:id/screenshot/:which{desktop|mobile}", async (c) => {
  const audit = await latestAudit(c.env.DB, c.req.param("id"));
  const key = audit?.screenshots[c.req.param("which") as "desktop" | "mobile"];
  const obj = key ? await c.env.RAW.get(key) : null;
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
});

const nullableUrl = z.string().trim().max(500).nullable().transform((v) => v || null)
  .refine((v) => v === null || /^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(v), "invalid url");
const PatchLead = z.object({
  leadStatus: z.enum(STATUSES).optional(), notes: z.string().max(5000).optional(),
  followUpAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dealValue: z.number().min(0).max(10_000_000).nullable().optional(),
  websiteUrl: nullableUrl.optional(),
});
leadRoutes.patch("/:id", async (c) => {
  const p = PatchLead.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const id = c.req.param("id");
  const before = await getBusiness(c.env.DB, id);
  if (!before) return c.json({ error: "not found" }, 404);
  const after = await updateLead(c.env.DB, id, p.data);
  if (p.data.leadStatus && p.data.leadStatus !== before.lead_status) await logActivity(c.env.DB, id, "status", `${before.lead_status} → ${p.data.leadStatus}`);
  if (p.data.websiteUrl !== undefined && p.data.websiteUrl !== before.website_url) await logActivity(c.env.DB, id, "website", p.data.websiteUrl ?? "removed");
  return c.json(after);
});

leadRoutes.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  const { archived } = await c.req.json<{ archived?: boolean }>().catch(() => ({ archived: undefined }));
  const b = await setArchived(c.env.DB, id, archived !== false);
  await logActivity(c.env.DB, id, b.archived_at ? "archived" : "restored");
  return c.json(b);
});

leadRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  await deleteBusiness(c.env.DB, id);
  return c.json({ ok: true });
});

const PersonBody = z.object({
  name: z.string().trim().min(1).max(120), role: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  phone: z.string().trim().max(40).nullable().optional(), linkedin: z.string().trim().max(300).nullable().optional(),
  source: z.enum(["manual", "site"]).optional(), is_poc: z.boolean().optional(),
});
leadRoutes.post("/:id/people", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  const p = PersonBody.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  return c.json(await createPerson(c.env.DB, id, p.data), 201);
});
leadRoutes.patch("/:id/people/:pid", async (c) => {
  const p = PersonBody.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const r = await updatePerson(c.env.DB, c.req.param("id"), c.req.param("pid"), p.data);
  return r ? c.json(r) : c.json({ error: "not found" }, 404);
});
leadRoutes.delete("/:id/people/:pid", async (c) =>
  (await deletePerson(c.env.DB, c.req.param("id"), c.req.param("pid"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));

const PatchDraft = z.object({ subject: z.string().min(1).max(300), body: z.string().min(1).max(5000) });
leadRoutes.patch("/:id/draft", async (c) => {
  const p = PatchDraft.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const d = await latestDraft(c.env.DB, c.req.param("id"));
  if (!d) return c.json({ error: "no draft" }, 404);
  await updateDraftBody(c.env.DB, d.id, p.data);
  return c.json({ ok: true });
});

const Regenerate = z.object({
  steeringNote: z.string().max(1000).optional(),
  focus: z.array(z.number().int().min(0).max(200)).max(10).optional(),
  tone: z.enum(["friendly_local", "consultative", "direct", "formal"]).nullable().optional(),
});
leadRoutes.post("/:id/regenerate", async (c) => {
  if (await mailingSettingsMissing(c.env.DB)) return c.json({ error: MISSING_MAILING_SETTINGS }, 400);
  const p = Regenerate.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const id = c.req.param("id");
  try {
    const d = await regenerateDraft(depsFromEnv(c.env), id, { steeringNote: p.data.steeringNote?.trim() || null, focus: p.data.focus, tone: p.data.tone });
    await logActivity(c.env.DB, id, "draft", p.data.focus?.length ? `Regenerated around ${p.data.focus.length} chosen issue(s)` : "Regenerated");
    return c.json(d);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

leadRoutes.get("/:id/drafts", async (c) => c.json(await listDrafts(c.env.DB, c.req.param("id"))));

leadRoutes.post("/:id/reaudit", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  if (await mailingSettingsMissing(c.env.DB)) return c.json({ error: MISSING_MAILING_SETTINGS }, 400);
  const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  await c.env.LEAD_WORKFLOW.create({ id: `reaudit-${id}-${Date.now()}`, params: { businessId: id, searchId: null, forceDraft: true } });
  await logActivity(c.env.DB, id, reason?.trim() ? "score_flagged" : "reaudit", reason?.trim().slice(0, 500) || null);
  return c.json({ ok: true }, 202);
});
