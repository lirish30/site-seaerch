import type { Env } from "../env";
import type { Finding } from "../types";
import type { MailboxKey } from "../mail/types";
import { getMailDeps } from "../mail/deps";
import { checkConflict } from "../conflict";
import { buildEmailSendApproval, mailboxFromEmail } from "../approvals/emailSend";
import { createApproval, createApprovalUnlessOpen } from "../db/approvals";
import { getBusiness, businessDomain, updateLead } from "../db/businesses";
import { getCampaign, listSteps, type SequenceStep } from "../db/campaigns";
import { listContacts } from "../db/contacts";
import { latestDraft } from "../db/drafts";
import { latestAudit } from "../db/audits";
import { ensureReport } from "../db/reports";
import { logActivity } from "../db/activity";
import { getSettings } from "../db/settings";
import { pickRecipient } from "../recipient";
import { MissingFieldError, PROBLEM_ONE_FALLBACK, pickVariant, renderTemplate } from "./template";
import { moveOn, stepAfter, stepFrom } from "./advance";
import type { Enrollment } from "./types";

export { advanceAfterSend } from "./advance";

export type StartResult =
  | { ok: true; enrollmentId: string; approvalId: string }
  | { ok: false; error: string; status: 400 | 404 | 409 | 422 };

const isUniqueViolation = (e: unknown) => /UNIQUE/i.test(String((e as Error)?.message ?? e));
const oneLine = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 500);

/**
 * Enrolls a lead in a campaign and proposes Email 1 from the lead's current draft. Nothing is sent: it creates the enrollment and one
 * `email.send` approval for Logan. The enrollment starts with no due time; that is computed when Email 1 is actually sent
 * (`advanceAfterSend`), so Email 2 can never be proposed before Email 1 has gone out.
 * Order of refusals: unknown lead or campaign 404, already enrolled 409, no draft or no address 400, conflict 422.
 */
export async function startSequence(env: Env, o: { businessId: string; campaignId: string; mailbox?: MailboxKey }): Promise<StartResult> {
  const db = env.DB;
  const [business, campaign] = await Promise.all([getBusiness(db, o.businessId), getCampaign(db, o.campaignId)]);
  if (!business) return { ok: false, error: "lead not found", status: 404 };
  if (!campaign) return { ok: false, error: "campaign not found", status: 404 };
  if (await db.prepare(`SELECT 1 AS x FROM enrollments WHERE business_id = ? AND status IN ('active','nurture')`).bind(o.businessId).first())
    return { ok: false, error: "this lead is already in a sequence", status: 409 };

  const steps = await listSteps(db, campaign.id);
  const first = steps.find((s) => s.idx === 0);
  if (!first || first.kind !== "email") return { ok: false, error: "the campaign has no first email step", status: 400 };
  const draft = await latestDraft(db, o.businessId);
  if (!draft) return { ok: false, error: "write a draft for this lead first", status: 400 };
  const contacts = await listContacts(db, o.businessId);
  const chosen = draft.to_contact_id ? contacts.find((c) => c.id === draft.to_contact_id && c.type === "email") : undefined;
  const to = (chosen ?? pickRecipient(contacts, businessDomain(business)).emailContact)?.value.trim();
  if (!to) return { ok: false, error: "no email address", status: 400 };

  const gate = await checkConflict(db, { email: to, businessId: o.businessId });
  if (gate.blocked) return { ok: false, error: gate.reason, status: 422 };

  const now = getMailDeps().now();
  const enrollmentId = crypto.randomUUID(), mailbox = o.mailbox ?? "outreach";
  let spec: ReturnType<typeof buildEmailSendApproval>;
  try { // validate the whole approval first, so a draft that cannot be sent creates nothing
    spec = buildEmailSendApproval({
      mailbox, businessId: o.businessId, to, subject: draft.subject, body: draft.body, includeFooter: draft.include_footer,
      enrollmentId, stepIndex: 0, title: `Email 1 to ${business.name}`, drafted_by: "logan",
    }, await getSettings(db), await mailboxFromEmail(db, mailbox));
  } catch (e) {
    return { ok: false, error: `the draft cannot be sent: ${oneLine(e)}`, status: 422 };
  }

  try {
    await db.prepare(`INSERT INTO enrollments (id, business_id, campaign_id, mailbox_key, to_email, status, next_step_index, next_due_at, started_at, last_sent_step)
      VALUES (?,?,?,?,?, 'active', ?, NULL, ?, NULL)`)
      .bind(enrollmentId, o.businessId, campaign.id, mailbox, to, stepAfter(steps, 0)?.idx ?? 1, now.toISOString()).run();
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "this lead is already in a sequence", status: 409 }; // lost a race with another start
    throw e;
  }
  try {
    const a = await createApproval(db, spec);
    return { ok: true, enrollmentId, approvalId: a.id };
  } catch (e) {
    await db.prepare(`DELETE FROM enrollments WHERE id = ?`).bind(enrollmentId).run();
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// problem_one

const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 3, important: 2, nice: 1 };

/**
 * What each rule finding is about, as a SINGULAR noun phrase that reads after "the" and agrees with "becomes" / "moves up your list"
 * ("If the broken link problem ever becomes a priority"). Codes not listed use the fallback.
 */
const RULE_PHRASE: Record<string, string> = {
  slow_mobile: "mobile speed", meh_mobile: "mobile speed", slow_lcp: "page load speed", layout_shift: "page layout",
  not_mobile_friendly: "mobile layout", no_viewport: "mobile layout", mobile_overflow: "mobile layout", small_text_mobile: "mobile text size",
  old_copyright: "site content", stale_content: "site content", past_events: "site content", thin_homepage: "homepage", dated_build: "site design",
  missing_niche_page: "services page", no_contact_path: "contact page", no_cta: "call to action", no_phone_visible: "phone number", no_click_to_call: "phone number",
  no_social_proof: "reviews section", no_nav: "navigation menu", no_footer: "footer", broken_links: "broken link problem",
  no_https: "site security", no_https_redirect: "site security", mixed_content: "site security",
  no_title_or_meta: "page title", no_h1: "page heading", no_schema: "search listing setup", no_local_schema: "search listing setup", no_open_graph: "link preview",
  low_seo_score: "search setup", no_sitemap: "search setup", images_missing_alt: "image alt text", low_accessibility: "accessibility", no_email_auth: "email setup",
};
/** The vetted singular phrases; a test requires the table above to use exactly these, so a plural cannot slip into outbound copy. */
export const VETTED_RULE_PHRASES: readonly string[] = [
  "accessibility", "call to action", "contact page", "email setup", "footer", "homepage", "image alt text", "link preview", "mobile layout", "mobile speed",
  "mobile text size", "navigation menu", "page heading", "page layout", "page load speed", "page title", "phone number", "reviews section", "search listing setup",
  "search setup", "services page", "site content", "site design", "site security", "broken link problem",
];
export const RULE_PHRASES: Readonly<Record<string, string>> = RULE_PHRASE;

// An AI title that opens with one of these is a verb or a negation, and does not read after "the".
const NOT_A_NOUN_PHRASE = /^(no|not|add|use|make|fix|improve|update|create|replace|remove|show|include|consider|ensure|they|there|it|its|the|a|an|is|are|was|has|have|does|do|lacks?|needs?|should|can|cannot|your|you|we)\b/i;
// A usable title is a short noun phrase: at most this many words, and none of them verb-like. "Homepage lacks a clear call to action" would read
// "If the homepage lacks a clear call to action ever becomes a priority", so a title with a verb or a negation anywhere in it is refused.
const MAX_TITLE_WORDS = 4;
const VERB_LIKE = new Set([
  "lacks", "lack", "missing", "misses", "has", "have", "is", "are", "was", "were", "does", "doesn't", "don't", "not", "no", "fails", "fail", "needs", "need",
  "uses", "loads", "takes", "shows", "show", "looks", "look", "makes", "causes", "hurts", "buries", "hides", "requires", "contains", "includes",
]);
// Only plain words ever reach the outbound email: letters, spaces and ' & / -, 3 to 60 characters. Anything else (digits, a colon, a URL or
// domain, an @, markup, other punctuation) is refused rather than escaped.
const SAFE_PHRASE = /^[A-Za-z][A-Za-z '&/-]{2,59}$/;
// Brands whose first word keeps its capital ("Google Business Profile"); a first word with a capital inside it ("WordPress", "SEO") is kept too.
const BRANDS = new Set(["google", "facebook", "yelp", "instagram", "wix", "squarespace", "shopify", "godaddy", "weebly", "webflow", "bing", "youtube", "linkedin", "tiktok", "apple", "amazon"]);

/** The title of an AI finding. The scorer stores it as the evidence's first sentence ("<title>. <evidence>"). */
function aiTitle(f: Finding): string | null {
  const text = f.evidence.trim();
  const cut = text.indexOf(". ");
  const title = (cut === -1 ? text.replace(/\.$/, "") : text.slice(0, cut)).trim();
  if (!SAFE_PHRASE.test(title) || NOT_A_NOUN_PHRASE.test(title)) return null;
  const words = title.split(/[\s/&-]+/).filter(Boolean);
  if (title.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length > MAX_TITLE_WORDS || words.some((w) => VERB_LIKE.has(w.toLowerCase()))) return null;
  const first = title.split(/[ /&-]/)[0];
  const keepCase = /[A-Z]/.test(first.slice(1)) || BRANDS.has(first.toLowerCase());
  return keepCase ? title : title.charAt(0).toLowerCase() + title.slice(1);
}

/**
 * `{problem_one}` for Email 3: a noun phrase that reads after "the", taken from the audit's single top finding (highest severity,
 * then most points, then first listed). A rule finding is named by its code; an AI finding by its title. When that cannot reasonably
 * follow "the" (a verb or negation anywhere in it, a colon, more than four words) or there is no finding, it is `PROBLEM_ONE_FALLBACK`, so Email 3 never throws.
 */
export function problemOne(findings: Finding[]): string {
  const top = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.points - a.points)[0];
  if (!top) return PROBLEM_ONE_FALLBACK;
  if (Object.hasOwn(RULE_PHRASE, top.code)) return RULE_PHRASE[top.code];
  return (top.code.startsWith("ai_") && aiTitle(top)) || PROBLEM_ONE_FALLBACK;
}

// ---------------------------------------------------------------------------------------------------------------------
// the scan

export interface ScanResult { approvalsCreated: number; calls: number; skipped: number }

/** A reason a step cannot go out yet. It is shown to Logan in `last_error` and the step is tried again on the next scan. */
class StepSkip extends Error {}

/** The cold-link base, or a StepSkip saying why there is none. Never a relative link and never a workers.dev one. */
function linkBase(env: Env): string {
  const raw = env.OUTREACH_LINK_BASE?.trim();
  if (!raw) throw new StepSkip("OUTREACH_LINK_BASE is not set");
  let u: URL;
  try { u = new URL(raw); } catch { throw new StepSkip("OUTREACH_LINK_BASE is not set to a valid URL"); }
  if (u.protocol !== "https:") throw new StepSkip("OUTREACH_LINK_BASE is not set to a valid URL");
  if (/(^|\.)workers\.dev$/i.test(u.hostname)) throw new StepSkip("OUTREACH_LINK_BASE is not set to a cold-link host (workers.dev is never used)");
  return raw.replace(/\/+$/, "");
}

const firstName = (full: string | null | undefined) => full?.trim().split(/\s+/)[0] || null;

const lastSentMessageId = (db: D1Database, enrollmentId: string) =>
  db.prepare(`SELECT message_id FROM messages WHERE enrollment_id = ? AND direction = 'out' AND status = 'sent' AND message_id IS NOT NULL ORDER BY sent_at DESC, created_at DESC LIMIT 1`)
    .bind(enrollmentId).first<{ message_id: string }>().then((r) => r?.message_id ?? null);

const setError = (db: D1Database, id: string, msg: string | null) => db.prepare(`UPDATE enrollments SET last_error = ? WHERE id = ?`).bind(msg, id).run();

/** Pending, or approved for this very step and mid-send: the enrollment already has an approval in flight. */
const IN_FLIGHT = `(a.status = 'pending' OR (a.status = 'approved' AND json_extract(a.payload, '$.stepIndex') = e.next_step_index))`;
const REJECTED_STEP = (step: string) => `EXISTS (SELECT 1 FROM approvals a WHERE a.record_type = 'enrollment' AND a.record_id = e.id AND a.status = 'rejected' AND json_extract(a.payload, '$.stepIndex') = ${step})`;
/** Enrollments handled per scan: about 18 D1 queries each must stay inside one invocation's query budget. The scan is daily and oldest-due first, so leftovers go out on the next run. */
const MAX_PER_SCAN = 40;

/**
 * The daily pass over live sequences. First it ends any sequence whose Email 1 approval was rejected. Then, for every active enrollment
 * whose previous email was sent, and every nurture enrollment (a lead that said "not now"), whose next step is due and that has no approval in flight:
 *  - a `call` step sets the lead's follow-up date and logs it, then moves on (no approval);
 *  - an `email` step is rendered (variant by `pickVariant(variants, businessId + idx)`) and proposed as an `email.send` approval
 *    (`drafted_by "job"`, `inReplyTo` the last sent message). Nothing is sent here;
 *  - a nurture enrollment's step is its campaign's `checkin`, proposed the same way (`enrollmentId` and `stepIndex` in the payload: a nurture
 *    enrollment is live). Once it is sent, or rejected, or the campaign no longer has it, the enrollment is `completed`.
 * A step Logan rejected is skipped, not proposed again. A conflict, an unfilled merge field, a missing link base or any other trouble sets
 * `last_error` and counts as skipped; one enrollment never stops the rest. Safe to run twice at once: see `createApprovalUnlessOpen`.
 */
export async function scanDueSteps(env: Env, now: Date): Promise<ScanResult> {
  const db = env.DB, out: ScanResult = { approvalsCreated: 0, calls: 0, skipped: 0 };
  await stopRejectedFirstEmails(db);
  const due = (await db.prepare(
    `SELECT e.* FROM enrollments e WHERE ((e.status = 'active' AND e.last_sent_step IS NOT NULL) OR e.status = 'nurture') AND e.next_due_at IS NOT NULL AND e.next_due_at <= ?
       AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.record_type = 'enrollment' AND a.record_id = e.id AND ${IN_FLIGHT})
     ORDER BY e.next_due_at, e.id LIMIT ?`,
  ).bind(now.toISOString(), MAX_PER_SCAN).all<Enrollment>()).results;
  for (const e of due) {
    try {
      const r = await scanOne(env, e, now);
      if (r === "approval") out.approvalsCreated++; else if (r === "call") out.calls++; else if (r === "skipped") out.skipped++;
    } catch (err) {
      out.skipped++;
      if (!(err instanceof StepSkip || err instanceof MissingFieldError)) console.error("sequence scan: enrollment failed", e.id, err);
      await setError(db, e.id, oneLine(err)).catch(() => { /* nothing more to do for this one */ });
    }
  }
  return out;
}

/** Email 1 was rejected: nothing was ever sent, so the sequence ends (the lead is not suppressed) and can be started again. */
async function stopRejectedFirstEmails(db: D1Database): Promise<void> {
  const rows = (await db.prepare(
    `SELECT e.id, e.business_id FROM enrollments e WHERE e.status = 'active' AND e.last_sent_step IS NULL AND ${REJECTED_STEP("0")}
       AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.record_type = 'enrollment' AND a.record_id = e.id AND a.status = 'pending')`,
  ).all<{ id: string; business_id: string }>()).results;
  for (const r of rows) {
    const done = await db.prepare(`UPDATE enrollments SET status = 'stopped', stopped_reason = 'step 0 rejected', next_due_at = NULL WHERE id = ? AND status = 'active' AND last_sent_step IS NULL`).bind(r.id).run();
    if ((done.meta.changes ?? 0) > 0) await logActivity(db, r.business_id, "note", "Sequence ended: the first email was rejected");
  }
}

async function scanOne(env: Env, e: Enrollment, now: Date): Promise<"approval" | "call" | "skipped" | "moved"> {
  const db = env.DB;
  const steps = await listSteps(db, e.campaign_id);
  const nurture = e.status === "nurture";
  // A nurture enrollment waits on its check-in, which the sequence's own steps never include (see `stepFrom`).
  const step = nurture ? steps.find((s) => s.idx === e.next_step_index && s.kind === "checkin") ?? null : stepFrom(steps, e.next_step_index);
  if (!step) { // the campaign's steps were edited away from under it
    await db.prepare(`UPDATE enrollments SET status = 'completed', next_due_at = NULL, last_error = NULL WHERE id = ? AND status = ?`).bind(e.id, e.status).run();
    return "moved";
  }
  const business = await getBusiness(db, e.business_id);
  if (!business) throw new StepSkip("lead not found");
  const gate = await checkConflict(db, { email: e.to_email, businessId: e.business_id });
  if (gate.blocked) throw new StepSkip(`blocked: ${gate.reason} (${gate.source})`);

  if (step.kind === "call") {
    await updateLead(db, e.business_id, { followUpAt: now.toISOString().slice(0, 10) }); // idempotent, so it comes before the claim
    if (!(await moveOn(db, e, steps, step.idx, now))) return "moved";
    await logActivity(db, e.business_id, "note", `Call due: ${business.name} (sequence step ${step.idx + 1})`);
    return "call";
  }

  const rejected = await db.prepare(`SELECT 1 AS x FROM enrollments e WHERE e.id = ? AND ${REJECTED_STEP("?")}`).bind(e.id, step.idx).first();
  if (rejected && nurture) {
    const done = await db.prepare(`UPDATE enrollments SET status = 'completed', next_due_at = NULL, last_error = NULL WHERE id = ? AND status = 'nurture'`).bind(e.id).run();
    if ((done.meta.changes ?? 0) > 0) await logActivity(db, e.business_id, "note", "Check-in skipped: you rejected it");
    return "moved";
  }
  if (rejected) {
    if (await moveOn(db, e, steps, step.idx, now)) await logActivity(db, e.business_id, "note", `Email ${emailNumber(steps, step.idx)} skipped: you rejected it`);
    return "moved";
  }

  const approval = await buildStepApproval(env, e, step, steps, business, now);
  const created = await createApprovalUnlessOpen(db, approval, step.idx);
  if (!created) return "skipped"; // another scan got there first
  await setError(db, e.id, null);
  return "approval";
}

const emailNumber = (steps: SequenceStep[], idx: number) => steps.filter((s) => s.kind === "email" && s.idx <= idx).length;

async function buildStepApproval(env: Env, e: Enrollment, step: SequenceStep, steps: SequenceStep[], business: NonNullable<Awaited<ReturnType<typeof getBusiness>>>, now: Date) {
  const db = env.DB;
  const template = pickVariant(step.variants, e.business_id + step.idx);
  const needsLink = /\{link\}/.test(step.subject + template);
  const contact = (await listContacts(db, e.business_id)).find((c) => c.type === "email" && c.value.toLowerCase() === e.to_email.toLowerCase());
  const vars: Record<string, string> = {
    Business: business.name,
    Name: firstName(contact?.person_name) ?? `${business.name} team`,
    problem_one: PROBLEM_ONE_FALLBACK,
  };
  const audit = await latestAudit(db, e.business_id);
  if (audit) vars.problem_one = problemOne(audit.findings);
  if (needsLink) {
    const base = linkBase(env);
    if (!audit) throw new StepSkip("this lead has no audit to link to");
    vars.link = `${base}/r/${(await ensureReport(db, e.business_id, audit.id, now)).token}`;
  }
  const subject = renderTemplate(step.subject, vars), body = renderTemplate(template, vars);
  const inReplyTo = await lastSentMessageId(db, e.id);
  const spec = buildEmailSendApproval({
    mailbox: e.mailbox_key, businessId: e.business_id, to: e.to_email, subject, body, includeFooter: true, enrollmentId: e.id, stepIndex: step.idx,
    ...(inReplyTo ? { inReplyTo } : {}), title: step.kind === "checkin" ? `Check-in to ${business.name}` : `Email ${emailNumber(steps, step.idx)} to ${business.name}`, drafted_by: "job",
  }, await getSettings(db), await mailboxFromEmail(db, e.mailbox_key));
  return spec;
}
