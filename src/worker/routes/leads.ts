import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import type { Business, LeadStatus } from "../types";
import { getBusiness, listAllBusinesses, updateLead, domainOf, setArchived, deleteBusiness } from "../db/businesses";
import { listPeople, createPerson, updatePerson, deletePerson, pocsFor } from "../db/people";
import { listActivity, logActivity } from "../db/activity";
import { latestAudit, latestAuditsFor, listAudits } from "../db/audits";
import { diffFindings, type AuditChanges } from "../audit/diff";
import { isStale, urgencyOf } from "../audit/provenance";
import { listServices } from "../db/services";
import { bestOffer } from "../services/best-offer";
import { listContacts, contactsFor } from "../db/contacts";
import { latestDraft, updateDraftBody, listDrafts } from "../db/drafts";
import { activeReportFor, createReport, otherActiveCount, revokeReports, type ReportRow } from "../db/reports";
import { pickRecipient } from "../recipient";
import { regenerateDraft } from "../pipeline/lead";
import { depsFromEnv } from "../workflows";
import { mailingSettingsMissing, MISSING_MAILING_SETTINGS } from "./compliance";
import { reportFor, reportFileName } from "../report/data";
import { htmlToPdf } from "../render/render";
import { renderDoc } from "../report/html";
import { googleAccess, GoogleNotConnected } from "./google";
import { buildMime, createGmailDraft, ensureFolder, uploadFile } from "../google/api";
import { setGoogleFolder } from "../db/google";
import { pocFor } from "../db/people";

const STATUSES = ["new", "reviewed", "contacted", "replied", "won", "lost", "skip"] as const;

export async function leadRows(db: D1Database, businesses: Business[]) {
  const ids = businesses.map((b) => b.id);
  const [audits, contactMap, pocs] = await Promise.all([latestAuditsFor(db, ids), contactsFor(db, ids), pocsFor(db, ids)]);
  return businesses.map((b) => {
    const audit = audits.get(b.id) ?? null;
    const best = pickRecipient(contactMap.get(b.id) ?? [], domainOf(b.website_url));
    return {
      business: b, score: audit?.score ?? null, health: audit?.health_score ?? null, niche: audit?.niche ?? null,
      topFinding: audit?.findings[0]?.evidence ?? null,
      offer: audit?.offer ?? null, bestContact: best.contact?.value ?? null, hasEmail: !!best.emailContact || !!pocs.get(b.id)?.email,
      poc: pocs.get(b.id) ? { name: pocs.get(b.id)!.name, email: pocs.get(b.id)!.email } : null,
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
  const archived = c.req.query("archived") === "1";
  return c.json(await leadRows(c.env.DB, await listAllBusinesses(c.env.DB, { status, limit, offset, archived })));
});

leadRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  let business = await getBusiness(c.env.DB, id);
  if (!business) return c.json({ error: "not found" }, 404);
  if (business.lead_status === "new") business = await updateLead(c.env.DB, id, { leadStatus: "reviewed" });
  const [recent, contacts, draft, people, activity] = await Promise.all([listAudits(c.env.DB, id, 2), listContacts(c.env.DB, id),
    latestDraft(c.env.DB, id), listPeople(c.env.DB, id), listActivity(c.env.DB, id)]);
  const [audit = null, previous] = recent;
  let changes: AuditChanges | null = null;
  if (audit && previous) {
    const d = diffFindings(previous.findings, audit.findings);
    changes = { since: previous.created_at, added: d.added, resolved: d.resolved, unchangedCount: d.unchanged.length };
  }
  const toContact = draft?.to_contact_id ? contacts.find((x) => x.id === draft.to_contact_id) ?? null : null;
  // `stale` is derived per request (it depends on now), so it rides on the response, never on the stored finding.
  const now = new Date();
  const shown = audit && { ...audit, findings: audit.findings.map((f) => ({ ...f, stale: isStale(f, audit.created_at, now) })) };
  // Matched on the stale-flagged findings so `because` carries each finding's `stale` for the evidence badge.
  const best_offer = shown ? bestOffer(shown.findings, await listServices(c.env.DB, { activeOnly: true }), shown.offer) : null;
  return c.json({ business, audit: shown, contacts, draft, toContact, people, activity, changes, urgency: audit ? urgencyOf(audit.findings) : 0, best_offer });
});

// Screenshots live in the private R2 bucket; serve the latest audit's copy behind the app's auth.
leadRoutes.get("/:id/screenshot/:which{desktop|mobile}", async (c) => {
  const audit = await latestAudit(c.env.DB, c.req.param("id"));
  const key = audit?.screenshots[c.req.param("which") as "desktop" | "mobile"];
  const obj = key ? await c.env.RAW.get(key) : null;
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
});

// Client-facing audit deck: HTML to view/print, PDF to download (needs Browser Rendering).
leadRoutes.get("/:id/report.html", async (c) => {
  const r = await reportFor(c.env, c.req.param("id"));
  if (!r) return c.json({ error: "No audit yet" }, 404);
  return c.html(r.html);
});
leadRoutes.get("/:id/report.pdf", async (c) => {
  if (!c.env.BROWSER) return c.json({ error: "PDF export needs the Browser Rendering binding" }, 501);
  const id = c.req.param("id");
  const r = await reportFor(c.env, id);
  if (!r) return c.json({ error: "No audit yet" }, 404);
  const pdf = await htmlToPdf(c.env.BROWSER, r.html);
  await logActivity(c.env.DB, id, "export", "Downloaded audit PDF");
  return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${reportFileName(r.data.business.name, "pdf")}"` } });
});

// Exports to the connected Google account. Gmail gets a draft only; nothing is ever sent.
async function exportGuard(c: any, fn: () => Promise<Response>) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof GoogleNotConnected) return c.json({ error: e.message }, 400);
    return c.json({ error: (e as Error).message }, 502);
  }
}

leadRoutes.post("/:id/gmail-draft", (c) => exportGuard(c, async () => {
  const id = c.req.param("id");
  const { attachReport } = await c.req.json<{ attachReport?: boolean }>().catch(() => ({ attachReport: false }));
  const draft = await latestDraft(c.env.DB, id);
  if (!draft) return c.json({ error: "Write a draft first" }, 400);
  const { token } = await googleAccess(c.env, new URL(c.req.url).origin);
  const contacts = await listContacts(c.env.DB, id);
  const poc = await pocFor(c.env.DB, id);
  const to = contacts.find((x) => x.id === draft.to_contact_id)?.value ?? poc?.email ?? null;
  let attachment: { name: string; bytes: Uint8Array } | undefined;
  if (attachReport) {
    if (!c.env.BROWSER) return c.json({ error: "Attaching the PDF needs the Browser Rendering binding" }, 501);
    const r = await reportFor(c.env, id);
    if (r) attachment = { name: reportFileName(r.data.business.name, "pdf"), bytes: await htmlToPdf(c.env.BROWSER, r.html) };
  }
  const g = await createGmailDraft(fetch, token, buildMime({ to, subject: draft.subject, body: draft.body, attachment }));
  await logActivity(c.env.DB, id, "export", `Gmail draft${attachment ? " with audit PDF" : ""}${to ? ` to ${to}` : ""}`);
  return c.json({ ok: true, url: g.url });
}));

leadRoutes.post("/:id/drive", (c) => exportGuard(c, async () => {
  const id = c.req.param("id");
  const r = await reportFor(c.env, id);
  if (!r) return c.json({ error: "No audit yet" }, 404);
  const { token, row } = await googleAccess(c.env, new URL(c.req.url).origin);
  const folder = await ensureFolder(fetch, token, row.folder_id, "Site Search reports");
  if (folder !== row.folder_id) await setGoogleFolder(c.env.DB, folder);
  const name = r.data.business.name;
  const draft = await latestDraft(c.env.DB, id);
  const doc = await uploadFile(fetch, token, { name: `${name} – website audit & proposal`, parents: [folder], mimeType: "application/vnd.google-apps.document" },
    { type: "text/html", bytes: renderDoc(r.data, draft ? { subject: draft.subject, body: draft.body } : null) });
  let pdfUrl: string | null = null;
  if (c.env.BROWSER) {
    const pdf = await uploadFile(fetch, token, { name: reportFileName(name, "pdf"), parents: [folder] },
      { type: "application/pdf", bytes: await htmlToPdf(c.env.BROWSER, r.html) });
    pdfUrl = pdf.webViewLink;
  }
  await logActivity(c.env.DB, id, "export", "Saved audit to Google Drive");
  return c.json({ ok: true, docUrl: doc.webViewLink, pdfUrl });
}));

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
  croFocus: z.array(z.string().min(1).max(64)).max(10).optional(),
  tone: z.enum(["friendly_local", "consultative", "direct", "formal"]).nullable().optional(),
});
leadRoutes.post("/:id/regenerate", async (c) => {
  if (await mailingSettingsMissing(c.env.DB)) return c.json({ error: MISSING_MAILING_SETTINGS }, 400);
  const p = Regenerate.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const id = c.req.param("id");
  try {
    const d = await regenerateDraft(depsFromEnv(c.env), id, { steeringNote: p.data.steeringNote?.trim() || null, focus: p.data.focus, croFocus: p.data.croFocus, tone: p.data.tone });
    const picked = (p.data.focus?.length ?? 0) + (p.data.croFocus?.length ?? 0);
    await logActivity(c.env.DB, id, "draft", picked ? `Regenerated around ${picked} chosen issue(s)` : "Regenerated");
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

const reportView = (r: ReportRow) => ({ token: r.token, url: `/r/${r.token}`, expiresAt: r.expires_at });

leadRoutes.post("/:id/report", async (c) => {
  const id = c.req.param("id");
  const audit = (await getBusiness(c.env.DB, id)) ? await latestAudit(c.env.DB, id) : null;
  if (!audit) return c.json({ error: "not found" }, 404);
  const existing = await activeReportFor(c.env.DB, id, audit.id);
  if (existing) return c.json(reportView(existing));
  return c.json(reportView(await createReport(c.env.DB, id, audit.id)), 201);
});

leadRoutes.get("/:id/report", async (c) => {
  const id = c.req.param("id");
  const audit = await latestAudit(c.env.DB, id);
  const report = audit ? await activeReportFor(c.env.DB, id, audit.id) : null;
  return c.json({ report: report ? reportView(report) : null, otherActive: await otherActiveCount(c.env.DB, id, report?.token ?? null) });
});

leadRoutes.delete("/:id/report", async (c) => {
  await revokeReports(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});
