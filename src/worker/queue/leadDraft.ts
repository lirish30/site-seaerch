import { z } from "zod";
import type { Env } from "../env";
import { activityStmt } from "../db/activity";
import { getAudit, latestAudit } from "../db/audits";
import { getBusiness } from "../db/businesses";
import { ensureContact, listContacts } from "../db/contacts";
import { croItemsForBusiness } from "../db/cro";
import { hasVariantGroup, insertDraft, insertDrafts, latestDraft } from "../db/drafts";
import { pocFor } from "../db/people";
import { getSettings } from "../db/settings";
import { leadSuppression } from "../db/suppression";
import { DraftResult, buildDraftRequest, resolveDraft, type DraftInput } from "../drafter/draft";
import type { CroItem } from "../cro/types";
import type { Audit, Business, Draft, Finding, Offer, Purpose } from "../types";
import { enqueueTask } from "./db";
import { registerTaskKind, type TaskKindDef } from "./registry";

/** The task kind this file handles: Claude writes the outreach email for a lead. */
export const LEAD_DRAFT_KIND = "lead.draft";

/** One-click rewrites of the current draft. */
export const TWEAKS = {
  shorter: "Make it noticeably shorter: cut it by about a third without losing the one observation or the ask.",
  warmer: "Make it warmer and more personal, like a note to someone you would like to meet. Keep the facts the same.",
  more_direct: "Make it more direct: shorter sentences, no warm-up, get to the point faster.",
} as const;
export type Tweak = keyof typeof TWEAKS;

/** How the sender wants one draft written. Stored on the task, so it is exactly what the sender chose when they asked. */
export const DraftOptions = z.object({
  steeringNote: z.string().nullable().optional(),
  /** Indexes into the audit's findings. */
  focus: z.array(z.number().int().min(0)).optional(),
  tone: z.enum(["friendly_local", "consultative", "direct", "formal"]).nullable().optional(),
  croFocus: z.array(z.string()).optional(),
  /** Accepted for compatibility with older clients; every draft is freelance now. */
  purpose: z.literal("freelance").optional(),
  /** Rewrite the current draft with one change instead of writing fresh variants. */
  tweak: z.enum(Object.keys(TWEAKS) as [Tweak, ...Tweak[]]).optional(),
});
export type DraftOptions = z.infer<typeof DraftOptions>;

export const LeadDraftPayload = z.object({ businessId: z.string().min(1), auditId: z.string().min(1), options: DraftOptions });
export type LeadDraftPayload = z.infer<typeof LeadDraftPayload>;

/** Open drafting tasks are keyed by lead: one at a time, so a second click while one is queued asks for nothing new. */
const dedupe = (businessId: string) => ({ dedupeKey: businessId, targetType: "lead", targetId: businessId });

/**
 * A draft request for an audit that has since been superseded can never be written (it goes stale as soon as it is read), and while it is open it would
 * keep the lead's one open slot. So a request for a newer audit closes it first. Returns nothing: it is a no-op when there is nothing to close.
 */
async function closeSupersededRequests(db: D1Database, businessId: string, auditId: string): Promise<void> {
  await db.prepare(
    `UPDATE claude_tasks SET status = 'stale', error = 'superseded by a newer audit', done_at = ?
     WHERE kind = ? AND dedupe_key = ? AND status IN ('pending','claimed') AND json_extract(payload, '$.auditId') != ?`,
  ).bind(new Date().toISOString(), LEAD_DRAFT_KIND, businessId, auditId).run();
}

async function enqueue(db: D1Database, businessId: string, auditId: string, options: DraftOptions): Promise<{ taskId: string; created: boolean }> {
  await closeSupersededRequests(db, businessId, auditId);
  const r = await enqueueTask(db, LEAD_DRAFT_KIND, { businessId, auditId, options }, dedupe(businessId));
  return { taskId: r.id, created: r.created };
}

/**
 * Queues the cold-email draft for a lead once its audit is final. `created: false` means nothing new was queued: a draft is already queued for this lead.
 * `forceDraft` is the caller's concern (it decides whether to ask at all); the steering note the lead was started with is the draft's.
 */
export async function enqueueDraftFor(
  db: D1Database, p: { businessId: string; auditId: string; forceDraft?: boolean; steeringNote?: string | null },
): Promise<{ created: boolean }> {
  const { created } = await enqueue(db, p.businessId, p.auditId, p.steeringNote ? { steeringNote: p.steeringNote } : {});
  return { created };
}

/**
 * Queues a draft (or, with `o.tweak`, a rewrite of the current draft) the sender asked for, on the lead's latest audit. A request while one is already
 * open returns that task and changes nothing.
 */
export async function requestDraft(db: D1Database, businessId: string, o: DraftOptions = {}): Promise<{ taskId: string; created: boolean }> {
  const [business, audit] = await Promise.all([getBusiness(db, businessId), latestAudit(db, businessId)]);
  if (!business || !audit) throw new Error("Cannot draft: business or audit missing");
  if (o.tweak && !(await latestDraft(db, businessId))) throw new Error("Write a draft first");
  return enqueue(db, businessId, audit.id, o);
}

/** Whether Claude has this lead's draft still to write: `queued` (nobody has picked it up), `claimed` (Claude is on it), else `idle`. */
export async function draftTaskState(db: D1Database, businessId: string): Promise<{ state: "idle" | "queued" | "claimed"; since: string | null }> {
  const t = await db.prepare(`SELECT status, created_at, claimed_at FROM claude_tasks WHERE kind = ? AND dedupe_key = ? AND status IN ('pending','claimed')`)
    .bind(LEAD_DRAFT_KIND, businessId).first<{ status: "pending" | "claimed"; created_at: string; claimed_at: string | null }>();
  if (!t) return { state: "idle", since: null };
  return t.status === "claimed" ? { state: "claimed", since: t.claimed_at } : { state: "queued", since: t.created_at };
}

/** A CRO opportunity as a prompt finding: the observation is the evidence, the change is the fix. */
const croFinding = (i: CroItem): Finding => ({ code: `cro:${i.id}` as Finding["code"], category: "cro", severity: "important", points: 0,
  evidence: i.observation, recommendation: i.change, source: "ai" });

/**
 * The audit and lead a draft task is about, or why the draft no longer makes sense: the lead was deleted, was re-audited since (a newer audit exists),
 * or was suppressed since the task was queued.
 */
async function loadTarget(db: D1Database, p: LeadDraftPayload): Promise<{ stale: string } | { audit: Audit; business: Business }> {
  const business = await getBusiness(db, p.businessId);
  if (!business) return { stale: "the lead no longer exists" };
  if (await leadSuppression(db, business)) return { stale: "lead suppressed" };
  const audit = await getAudit(db, p.auditId);
  if (!audit || audit.business_id !== business.id) return { stale: "the audit no longer exists" };
  if ((await latestAudit(db, business.id))?.id !== audit.id) return { stale: "the lead has a newer audit" };
  return { audit, business };
}

/**
 * Everything the prompt is made from. `writePoc` is for `apply`: a point of contact with an email becomes a contact of the lead (so the draft can be
 * addressed to them), which is a write, so `build` leaves it out and only reads.
 */
async function gather(db: D1Database, p: LeadDraftPayload, t: { audit: Audit; business: Business }, writePoc: boolean) {
  const o = p.options;
  const [settings, poc, current] = await Promise.all([
    getSettings(db), pocFor(db, t.business.id), o.tweak ? latestDraft(db, t.business.id) : Promise.resolve(null),
  ]);
  const pocContact = writePoc && poc?.email
    ? await ensureContact(db, t.business.id, { type: "email", value: poc.email, source_url: null, person_name: poc.name, role: poc.role, confidence: 1 })
    : null;
  const contacts = await listContacts(db, t.business.id);
  // croItemsForBusiness scopes ids to this lead's own audits, so another lead's item id is silently dropped.
  const croItems = o.croFocus?.length ? (await croItemsForBusiness(db, t.business.id, o.croFocus)).filter((i) => i.included) : [];
  const focus = [...(o.focus ?? []).map((i) => t.audit.findings[i]).filter(Boolean), ...croItems.map(croFinding)];
  // Mostly-CRO picks make this a conversion pitch.
  const offer: Offer = croItems.length * 2 > focus.length ? "conversion" : t.audit.offer;
  const purpose: Purpose = "freelance";
  const input: DraftInput = {
    settings, business: t.business, findings: t.audit.findings, offer, contacts, steeringNote: o.steeringNote ?? null, focus, tone: o.tone ?? null,
    niche: t.audit.niche, valueProposition: t.audit.ai_review?.value_proposition ?? null, poc: poc ? { name: poc.name, role: poc.role } : null, purpose,
    revise: o.tweak && current ? { subject: current.subject, body: current.body, instruction: TWEAKS[o.tweak] } : undefined,
  };
  return { input, current, pocContactId: pocContact?.id ?? null };
}

/**
 * An empty-ish draft the sender fills in by hand (Claude is not asked): addressed the way a written draft would be, with a placeholder subject and
 * a greeting. Nothing from the lead's site goes in it. For when nobody wants to wait for the queue.
 */
export async function createManualDraft(db: D1Database, businessId: string): Promise<Draft> {
  const [business, audit] = await Promise.all([getBusiness(db, businessId), latestAudit(db, businessId)]);
  if (!business || !audit) throw new Error("Cannot draft: business or audit missing");
  const g = await gather(db, { businessId, auditId: audit.id, options: {} }, { audit, business }, true);
  const d = resolveDraft({ variants: [{ angle: "", subject: "A quick note about your website", body: "Hi," }], to_contact_id: null, recipient_reason: "" }, g.input, g.pocContactId);
  return insertDraft(db, {
    business_id: businessId, audit_id: audit.id, offer: g.input.offer, steering_note: null, to_contact_id: d.to_contact_id, recipient_reason: d.recipient_reason,
    subject: d.variants[0].subject, body: d.variants[0].body, purpose: "freelance", angle: "", include_footer: (g.input.settings.footer_freelance ?? 1) === 1,
  });
}

const describeRun = (o: DraftOptions) => o.tweak ? `Rewrote the draft (${o.tweak.replace("_", " ")})`
  : (o.focus?.length ?? 0) + (o.croFocus?.length ?? 0) ? `Regenerated around ${(o.focus?.length ?? 0) + (o.croFocus?.length ?? 0)} chosen issue(s)` : "Wrote the draft";

const leadDraft: TaskKindDef<LeadDraftPayload, DraftResult> = {
  kind: LEAD_DRAFT_KIND,
  label: "Write an outreach email",
  suggestedModel: "haiku",
  payload: LeadDraftPayload,
  result: DraftResult,

  /** The lead's own text (its name, findings, contacts, and a draft being rewritten) goes in the untrusted part; the rules and what the sender typed are the instructions. */
  async build(env: Env, p) {
    const t = await loadTarget(env.DB, p);
    if ("stale" in t) return { stale: t.stale };
    const g = await gather(env.DB, p, t, false);
    if (p.options.tweak && !g.input.revise) return { stale: "the draft to rewrite no longer exists" };
    return buildDraftRequest(g.input);
  },

  /**
   * Writes the variants, exactly as the inline step did: the recipient is settled (the lead's chosen contact first), trailing signature lines are stripped,
   * and a rewrite keeps the current draft's footer choice. The lead may have been suppressed, deleted or re-audited since the task was queued: then nothing is
   * written and the task goes stale. The variants carry the task's id as their group, so a crash-retry finds them and writes nothing twice; they and the
   * lead's activity entry go in one batch, so they are never half written.
   */
  async apply(env, p, r, task) {
    const t = await loadTarget(env.DB, p);
    if ("stale" in t) return { stale: t.stale };
    const log = { summary: `wrote a draft for ${t.business.name.slice(0, 100)}`, recordType: "lead", recordId: t.business.id };
    if (await hasVariantGroup(env.DB, task.id)) return { log };

    const g = await gather(env.DB, p, t, true);
    if (p.options.tweak && !g.current) return { stale: "the draft to rewrite no longer exists" };
    const d = resolveDraft(r, g.input, g.pocContactId);
    const at = new Date().toISOString();
    await insertDrafts(env.DB, d.variants.map((v, n) => ({
      business_id: t.business.id, audit_id: t.audit.id, offer: g.input.offer, steering_note: g.input.steeringNote, to_contact_id: d.to_contact_id,
      recipient_reason: d.recipient_reason, subject: v.subject, body: v.body, purpose: "freelance", angle: v.angle,
      include_footer: g.current && p.options.tweak ? g.current.include_footer : ((g.input.settings.footer_freelance ?? 1) === 1),
      variant_group: task.id, variant_index: n, created_at: at,
    })), [activityStmt(env.DB, t.business.id, "draft", describeRun(p.options))]);
    return { log };
  },
};
registerTaskKind(leadDraft);
