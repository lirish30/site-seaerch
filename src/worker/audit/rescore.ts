import type { Env } from "../env";
import { getAudit, latestAudit, updateAuditScore } from "../db/audits";
import { score, type BusinessSignals, type CrawlFacts, type MailDnsFacts, type MobileFacts, type PageSpeedFacts } from "../scoring/scorer";
import type { AiReview, SiteStatus } from "../types";
import { withProvenance } from "./provenance";

/** Everything `score()` is given except the review, as the lead pipeline stores it in R2 (`now` as an ISO string). */
export interface ScoreInputs {
  siteStatus: SiteStatus; crawl: CrawlFacts | null; pagespeed: PageSpeedFacts | null; mobile: MobileFacts | null;
  business: BusinessSignals; mailDns: MailDnsFacts | null; now: string;
}

/** The R2 file for one audit's score inputs. A random part keeps two runs of one lead apart, even when they share a clock. */
export const scoreInputsKey = (businessId: string, stamp: string) => `audits/${businessId}/${stamp}-${crypto.randomUUID().slice(0, 8)}-score-inputs.json`;

/**
 * The stored score inputs of an audit, or null when there are none for good: no key (an older audit), no object, or a file that is not valid JSON.
 * An R2 error is not that: it propagates, so the build or apply that asked fails and is tried again rather than closing a finished review as stale.
 */
export async function loadScoreInputs(env: Env, key: string | null): Promise<ScoreInputs | null> {
  if (!key) return null;
  const obj = await env.RAW.get(key);
  if (!obj) return null;
  try { return (await obj.json<ScoreInputs>()) ?? null; }
  catch (e) { if (e instanceof SyntaxError) return null; throw e; }
}

/**
 * Scores an audit again with the AI review in it: the same calculation the pipeline ran, from the same stored inputs, plus the review. Rewrites the
 * audit's score, offer, findings (with provenance), health, niche, category scores and review. Safe to run twice: it computes the same values from the
 * same inputs. `{ stale }` when the audit is gone (its lead was deleted), is no longer the lead's newest, or has no stored inputs to score from; nothing is written then.
 */
export async function rescoreAudit(env: Env, auditId: string, review: AiReview): Promise<{ lowPriority: boolean } | { stale: string }> {
  const audit = await getAudit(env.DB, auditId);
  if (!audit) return { stale: "the audit no longer exists" };
  if ((await latestAudit(env.DB, audit.business_id))?.id !== auditId) return { stale: "the lead has a newer audit" };
  const inputs = await loadScoreInputs(env, audit.score_inputs_key);
  if (!inputs) return { stale: "the audit has no stored score inputs to rescore from" };
  const s = score({ ...inputs, now: new Date(inputs.now), review });
  const written = await updateAuditScore(env.DB, auditId, {
    score: s.score, offer: s.offer, findings: withProvenance(s.findings, inputs.now), health_score: s.health, niche: s.niche,
    category_scores: s.categoryScores, ai_review: review,
  });
  return written ? { lowPriority: s.lowPriority } : { stale: "the lead has a newer audit" };
}
