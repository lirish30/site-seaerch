import type { Fetcher } from "../crawler/crawl";
import { crawlSite } from "../crawler/crawl";
import { runPageSpeed, RateLimitedError } from "../pagespeed";
import { score } from "../scoring/scorer";
import { lookupMailDns, siteMailDomain, UNKNOWN_MAIL_DNS, type MailDns } from "../dns";
import { generateDraft, type ClaudeCaller } from "../drafter/draft";
import { getBusiness, setScanStage } from "../db/businesses";
import { replaceContacts, listContacts, ensureContact } from "../db/contacts";
import { pocFor } from "../db/people";
import { insertAudit, latestAudit } from "../db/audits";
import { insertDraft, latestDraft } from "../db/drafts";
import { getSettings } from "../db/settings";
import { incrementProcessed } from "../db/searches";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";
import type { Renderer } from "../render/render";
import { withProvenance } from "../audit/provenance";
import { scoreInputsKey, type ScoreInputs } from "../audit/rescore";
import { enqueueTask } from "../queue/db";
import { SITE_REVIEW_KIND, enqueueDraftIfWanted } from "../queue/siteReview"; // also registers the site.review task kind
import { isSocialOnlyUrl } from "../crawler/extract";
import { croItemsForBusiness } from "../db/cro";
import type { CroItem } from "../cro/types";
import type { Draft, Finding, Offer, Purpose, ScanStage, SiteStatus, TonePreset } from "../types";

/** One-click rewrites of the current draft. */
export const TWEAKS = {
  shorter: "Make it noticeably shorter: cut it by about a third without losing the one observation or the ask.",
  warmer: "Make it warmer and more personal, like a note to someone you would like to meet. Keep the facts the same.",
  more_direct: "Make it more direct: shorter sentences, no warm-up, get to the point faster.",
} as const;
export type Tweak = keyof typeof TWEAKS;

export interface DraftOptions {
  steeringNote?: string | null; focus?: number[]; tone?: TonePreset | null; croFocus?: string[];
  /** Accepted for compatibility with older clients; every draft is freelance now. */
  purpose?: Purpose;
  /** Rewrite the current draft with one change instead of writing fresh variants. */
  tweak?: Tweak;
}

export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}
export interface LeadDeps {
  db: D1Database; raw: R2Bucket; fetch: Fetcher; pagespeedKey: string; claude: ClaudeCaller; now: () => Date;
  /** Real-browser render for screenshots and JS-built pages; absent when the Browser binding isn't configured. */
  render?: Renderer;
}

const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

/** A CRO opportunity as a prompt finding: the observation is the evidence, the change is the fix. */
const croFinding = (i: CroItem): Finding => ({ code: `cro:${i.id}` as Finding["code"], category: "cro", severity: "important", points: 0,
  evidence: i.observation, recommendation: i.change, source: "ai" });

async function draftFor(deps: LeadDeps, businessId: string, o: DraftOptions = {}): Promise<Draft> {
  const [business, audit, settings, poc, current] = await Promise.all([
    getBusiness(deps.db, businessId), latestAudit(deps.db, businessId), getSettings(deps.db), pocFor(deps.db, businessId),
    o.tweak ? latestDraft(deps.db, businessId) : Promise.resolve(null)
  ]);
  if (!business || !audit) throw new Error("Cannot draft: business or audit missing");
  if (o.tweak && !current) throw new Error("Write a draft first");
  // A point of contact with an email becomes a draftable contact so the draft can be addressed to them.
  const pocContact = poc?.email
    ? await ensureContact(deps.db, businessId, { type: "email", value: poc.email, source_url: null, person_name: poc.name, role: poc.role, confidence: 1 })
    : null;
  const contacts = await listContacts(deps.db, businessId);
  // croItemsForBusiness scopes ids to this lead's own audits, so another lead's item id is silently dropped.
  const croItems = o.croFocus?.length ? (await croItemsForBusiness(deps.db, businessId, o.croFocus)).filter((i) => i.included) : [];
  const focus = [...(o.focus ?? []).map((i) => audit.findings[i]).filter(Boolean), ...croItems.map(croFinding)];
  // Mostly-CRO picks make this a conversion pitch.
  const offer: Offer = croItems.length * 2 > focus.length ? "conversion" : audit.offer;
  const steeringNote = o.steeringNote ?? null;
  const purpose: Purpose = "freelance";
  const d = await generateDraft({
    settings, business, findings: audit.findings, offer, contacts, steeringNote, focus, tone: o.tone ?? null,
    niche: audit.niche, valueProposition: audit.ai_review?.value_proposition ?? null, poc: poc ? { name: poc.name, role: poc.role } : null,
    purpose,
    revise: o.tweak && current ? { subject: current.subject, body: current.body, instruction: TWEAKS[o.tweak] } : undefined,
  }, deps.claude, pocContact?.id ?? null);
  // Variants share a timestamp, so the first-written leads; a tweak keeps the current draft's footer choice.
  const group = crypto.randomUUID();
  const at = new Date().toISOString();
  let first: Draft | null = null;
  for (const [n, v] of d.variants.entries()) {
    const row = await insertDraft(deps.db, {
      business_id: businessId, audit_id: audit.id, offer, steering_note: steeringNote, to_contact_id: d.to_contact_id,
      recipient_reason: d.recipient_reason, subject: v.subject, body: v.body, purpose, angle: v.angle,
      include_footer: current && o.tweak ? current.include_footer : (settings.footer_freelance ?? 1) === 1, variant_group: group, variant_index: n, created_at: at,
    });
    first ??= row;
  }
  return first!;
}

const measurable = (s: SiteStatus) => s === "ok" || s === "blocked";

export function regenerateDraft(deps: LeadDeps, businessId: string, o: DraftOptions = {}) {
  return draftFor(deps, businessId, o);
}

export async function runLead(
  deps: LeadDeps, step: StepLike,
  p: { businessId: string; searchId: string | null; forceDraft?: boolean; steeringNote?: string | null; stage?: ScanStage },
) {
  // A quick run is crawl + DNS + score only. Render and PageSpeed are the paid steps (the AI review and the draft are queued work, and a quick run
  // queues neither); they are not even opened, so nothing is spent or recorded for them. Re-running as "full" later fills them in.
  const quick = p.stage === "quick";
  const business = await getBusiness(deps.db, p.businessId);
  if (!business) throw new Error(`Business ${p.businessId} not found`);

  const stamp = deps.now().toISOString();
  // Render first: the rendered DOM feeds the crawl (JS forms/nav) and the screenshots feed the AI review.
  // A render failure never fails the lead; the audit just falls back to raw HTML.
  let rendered: { finalUrl: string; htmlKey: string | null; desktop: string | null; mobile: string | null; mobileFacts: { overflowX: boolean; smallTextPct: number } | null } | null = null;
  const site = business.website_url?.trim();
  if (!quick && deps.render && site && !isSocialOnlyUrl(withScheme(site))) {
    try {
      rendered = await step.do("render", async () => {
        const r = await deps.render!(withScheme(site));
        await recordUsage(deps.db, "browser", 1, PRICES.browserPerRender);
        if (!r) return null;
        const base = `shots/${p.businessId}/${stamp}`;
        const put = async (suffix: string, body: Uint8Array | string | null, type?: string) => {
          if (!body || !body.length) return null;
          await deps.raw.put(`${base}-${suffix}`, body, type ? { httpMetadata: { contentType: type } } : undefined);
          return `${base}-${suffix}`;
        };
        const [desktop, mobile, htmlKey] = await Promise.all([
          put("desktop.jpg", r.desktopJpeg, "image/jpeg"), put("mobile.jpg", r.mobileJpeg, "image/jpeg"), put("rendered.html", r.html),
        ]);
        return { finalUrl: r.finalUrl, htmlKey, desktop, mobile, mobileFacts: r.mobile };
      });
    } catch { rendered = null; }
  }

  const crawl = await step.do("crawl", async () => {
    const settings = await getSettings(deps.db);
    const ua = `SiteSearchAudit/1.0 (+contact: ${settings.contact_email || settings.business_name || "owner"})`;
    const html = rendered?.htmlKey ? await deps.raw.get(rendered.htmlKey).then((o) => o?.text() ?? null) : null;
    const r = await crawlSite(business.website_url, { fetch: deps.fetch, userAgent: ua, now: deps.now(),
      rendered: rendered && html ? { url: rendered.finalUrl, html } : null });
    let rawKey: string | null = null;
    if (r.pages.length) {
      rawKey = `audits/${p.businessId}/${stamp}.json`;
      await deps.raw.put(rawKey, JSON.stringify({ pages: r.pages }));
    }
    await replaceContacts(deps.db, p.businessId, r.contacts);
    return { siteStatus: r.siteStatus, finalUrl: r.finalUrl, facts: r.facts, rawKey, links: r.links };
  });

  // Retries may be exhausted (e.g. rate limited); degrade to a partial audit rather than failing the lead.
  // No instanceof check: error classes may not survive Workflows' step-error serialization.
  let ps: Awaited<ReturnType<typeof runPageSpeed>>["facts"] | null = null;
  if (!quick) try {
    ps = await step.do("pagespeed", async () => {
    // Bot-blocked sites still get PageSpeed (Google's runner is usually let through).
    if (!measurable(crawl.siteStatus) || !crawl.finalUrl) return null;
    try {
      const r = await runPageSpeed(crawl.finalUrl, { apiKey: deps.pagespeedKey, fetch: deps.fetch });
      await recordUsage(deps.db, "pagespeed", 1, PRICES.pagespeedPerCall);
      if (crawl.rawKey) {
        const prev = await deps.raw.get(crawl.rawKey).then((o) => o?.json<Record<string, unknown>>());
        await deps.raw.put(crawl.rawKey, JSON.stringify({ ...prev, pagespeed: r.raw }));
      }
      return r.facts;
    } catch (e) {
      if (e instanceof RateLimitedError) throw e;
      return null;
    }
    });
  } catch {
    ps = null;
  }

  // Never throws (adaptStep retries a throwing step): DNS trouble must not fail or degrade the lead.
  // Only a domain the site itself lists an email address at is looked up: without one we know nothing about the business's mail.
  const mailDns = await step.do("dns", async (): Promise<MailDns> => {
    try {
      if (!measurable(crawl.siteStatus)) return UNKNOWN_MAIL_DNS;
      const domain = siteMailDomain(crawl.finalUrl ?? business.domain, await listContacts(deps.db, p.businessId));
      return domain ? await lookupMailDns(domain, deps.fetch) : UNKNOWN_MAIL_DNS;
    } catch { return UNKNOWN_MAIL_DNS; }
  });

  // The audit is scored on rules alone here. The AI review is queued for Claude (Claude Code works the queue); when it comes back the audit is
  // scored again from the inputs stored below, and the draft is queued then. Nothing in this run waits for Claude.
  const audit = await step.do("score", async () => {
    const f = crawl.facts;
    const inputs: ScoreInputs = { siteStatus: crawl.siteStatus, crawl: f, pagespeed: ps, mobile: rendered?.mobileFacts ?? null,
      business: { category: business.category, rating: business.rating, reviewCount: business.review_count }, mailDns, now: deps.now().toISOString() };
    const s = score({ ...inputs, now: new Date(inputs.now) });
    const reviewable = !quick && measurable(crawl.siteStatus) && !!(rendered?.desktop || rendered?.mobile || f);
    let inputsKey: string | null = null;
    if (reviewable) {
      inputsKey = scoreInputsKey(p.businessId, stamp);
      await deps.raw.put(inputsKey, JSON.stringify(inputs));
    }
    const a = await insertAudit(deps.db, {
      business_id: p.businessId, site_status: crawl.siteStatus, partial: measurable(crawl.siteStatus) && ps === null,
      pagespeed_mobile: ps?.performanceScore ?? null, lcp_ms: ps?.lcpMs ?? null, cls: ps?.cls ?? null,
      mobile_friendly: rendered?.mobileFacts ? !rendered.mobileFacts.overflowX && (f?.hasViewport ?? true) : ps ? ps.mobileFriendly : f ? f.hasViewport : null,
      https: f?.https ?? null, has_title: f?.hasTitle ?? null, has_meta_description: f?.hasMetaDescription ?? null,
      has_contact_form: f?.hasContactForm ?? null, copyright_year: f?.copyrightYear ?? null,
      latest_content_date: f?.latestContentDate ?? null, broken_link_count: f?.brokenLinkCount ?? null,
      platform: f?.platform ?? null, // null = not crawled; "other" = crawled but unrecognised
      seo_score: ps?.seoScore ?? null, accessibility_score: ps?.accessibilityScore ?? null,
      score: s.score, offer: s.offer, findings: withProvenance(s.findings, inputs.now), raw_r2_key: crawl.rawKey,
      health_score: s.health, niche: s.niche, category_scores: s.categoryScores, ai_review: null, score_inputs_key: inputsKey,
      screenshots: { desktop: rendered?.desktop ?? null, mobile: rendered?.mobile ?? null }, site_links: crawl.links ?? {},
      // A note for the owner only: not a finding, never scored, and not passed to the drafter or the report.
      mail_warning: mailDns.hasMx === false ? "A site email address is at a domain with no mail records, so emails to it will likely bounce" : null,
    });
    await setScanStage(deps.db, p.businessId, quick ? "quick" : "full");
    // A quick run is crawl + DNS + score only: no review and no draft. A full run queues the review, and its draft follows once it is applied.
    // With nothing to review (no site, or nothing readable) the draft is queued now, under the same rule.
    if (!quick) {
      if (reviewable) {
        await enqueueTask(deps.db, SITE_REVIEW_KIND, { auditId: a.id, forceDraft: p.forceDraft, steeringNote: p.steeringNote ?? null },
          { dedupeKey: a.id, targetType: "lead", targetId: p.businessId });
      } else {
        await enqueueDraftIfWanted(deps.db, { businessId: p.businessId, auditId: a.id, lowPriority: s.lowPriority, forceDraft: p.forceDraft, steeringNote: p.steeringNote });
      }
    }
    return { id: a.id };
  });

  if (p.searchId) await step.do("progress", () => incrementProcessed(deps.db, p.searchId!).then(() => true));
  return { auditId: audit.id };
}
