import { z } from "zod";
import type { Env } from "../env";
import { getAudit, latestAudit } from "../db/audits";
import { getBusiness } from "../db/businesses";
import { leadSuppression } from "../db/suppression";
import { REVIEW_INSTRUCTIONS, ReviewOutput, buildReviewContent, normalizeReview } from "../audit/review";
import { loadScoreInputs, rescoreAudit } from "../audit/rescore";
import { enqueueDraftFor } from "./leadDraft";
import type { Audit, Business } from "../types";
import { registerTaskKind, type TaskKindDef } from "./registry";

/** The task kind this file handles: Claude looks at a lead's site and reviews its design, content, conversion and mobile experience. */
export const SITE_REVIEW_KIND = "site.review";

export const SiteReviewPayload = z.object({
  auditId: z.string().min(1), forceDraft: z.boolean().optional(), steeringNote: z.string().nullable().optional(),
});
export type SiteReviewPayload = z.infer<typeof SiteReviewPayload>;

const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

/**
 * Queues the lead's draft, under the rule the inline step used: a low-priority lead is not drafted unless `forceDraft` says so, and a suppressed
 * lead (or one deleted meanwhile) never is. Checked now, when the draft is queued, so a lead suppressed after its audit began gets none.
 * True only when a new draft task was queued (false too when one was already open).
 */
export async function enqueueDraftIfWanted(
  db: D1Database, p: { businessId: string; auditId: string; lowPriority: boolean; forceDraft?: boolean; steeringNote?: string | null },
): Promise<boolean> {
  if (p.lowPriority && !p.forceDraft) return false;
  const business = await getBusiness(db, p.businessId);
  if (!business || (await leadSuppression(db, business))) return false;
  return (await enqueueDraftFor(db, { businessId: p.businessId, auditId: p.auditId, forceDraft: p.forceDraft, steeringNote: p.steeringNote ?? null })).created;
}

/**
 * The audit and lead a review task is about, or why the review no longer makes sense: the lead was deleted, was re-audited (a newer audit exists),
 * or was suppressed since the task was queued. Used by `build` (nothing is shown to Claude) and, in effect, by `apply` (through `rescoreAudit`).
 */
async function loadTarget(db: D1Database, auditId: string): Promise<{ stale: string } | { audit: Audit; business: Business }> {
  const audit = await getAudit(db, auditId);
  if (!audit) return { stale: "the audit no longer exists" };
  if ((await latestAudit(db, audit.business_id))?.id !== auditId) return { stale: "the lead has a newer audit" };
  const business = await getBusiness(db, audit.business_id);
  if (!business) return { stale: "the lead no longer exists" };
  if (await leadSuppression(db, business)) return { stale: "the lead is suppressed" };
  return { audit, business };
}

const siteReview: TaskKindDef<SiteReviewPayload, ReviewOutput> = {
  kind: SITE_REVIEW_KIND,
  label: "Review a website",
  suggestedModel: "haiku",
  payload: SiteReviewPayload,
  result: ReviewOutput,

  /** The screenshots and the business and crawl facts are all copied from the site or its listing, so they are the untrusted parts; the instructions are fixed text. */
  async build(env: Env, p) {
    const t = await loadTarget(env.DB, p.auditId);
    if ("stale" in t) return { stale: t.stale };
    const facts = (await loadScoreInputs(env, t.audit.score_inputs_key))?.crawl ?? null;
    const { desktop, mobile } = t.audit.screenshots;
    if (!desktop && !mobile && !facts) return { stale: "there is nothing to review: no screenshots and no crawl facts" };
    return {
      instructions: REVIEW_INSTRUCTIONS,
      untrusted: buildReviewContent({
        business: { name: t.business.name, category: t.business.category, address: t.business.address, website: withScheme(t.business.website_url?.trim() ?? "") },
        facts, pagespeedScore: t.audit.pagespeed_mobile, desktopKey: desktop, mobileKey: mobile,
      }),
    };
  },

  /**
   * Scores the audit again with the review in it, then queues the lead's draft under the same rule the inline step used. A newer audit, a deleted or
   * suppressed lead make the result stale: nothing is written and no draft is queued. A crash-retry just repeats it: the rescore writes the same values
   * and the draft task is deduplicated per lead.
   */
  async apply(env, p, r) {
    const t = await loadTarget(env.DB, p.auditId);
    if ("stale" in t) return { stale: t.stale };
    const rescored = await rescoreAudit(env, p.auditId, normalizeReview(r));
    if ("stale" in rescored) return { stale: rescored.stale };
    const queued = await enqueueDraftIfWanted(env.DB, { businessId: t.business.id, auditId: p.auditId, lowPriority: rescored.lowPriority, forceDraft: p.forceDraft, steeringNote: p.steeringNote });
    return { log: { summary: `reviewed the site of ${t.business.name.slice(0, 100)}${queued ? "; a draft is queued" : ""}`, recordType: "lead", recordId: t.business.id } };
  },

  /** Nobody picked the review up: the audit stays on rules alone. Only a draft the user forced is still queued, from that rules-only audit. */
  async onExpire(env, p) {
    if (!p.forceDraft) return;
    const t = await loadTarget(env.DB, p.auditId);
    if ("stale" in t) return;
    await enqueueDraftIfWanted(env.DB, { businessId: t.business.id, auditId: p.auditId, lowPriority: false, forceDraft: true, steeringNote: p.steeringNote });
  },
};
registerTaskKind(siteReview);
