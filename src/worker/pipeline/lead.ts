import type { Fetcher } from "../crawler/crawl";
import { crawlSite } from "../crawler/crawl";
import { runPageSpeed, RateLimitedError } from "../pagespeed";
import { score } from "../scoring/scorer";
import { lookupMailDns, siteMailDomain, UNKNOWN_MAIL_DNS, type MailDns } from "../dns";
import { getBusiness, setScanStage } from "../db/businesses";
import { replaceContacts, listContacts } from "../db/contacts";
import { insertAudit } from "../db/audits";
import { getSettings } from "../db/settings";
import { incrementProcessed } from "../db/searches";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";
import type { Renderer } from "../render/render";
import { withProvenance } from "../audit/provenance";
import { scoreInputsKey, type ScoreInputs } from "../audit/rescore";
import { enqueueTask } from "../queue/db";
import { SITE_REVIEW_KIND, enqueueDraftIfWanted } from "../queue/siteReview"; // also registers the site.review and lead.draft task kinds
import { isSocialOnlyUrl } from "../crawler/extract";
import type { ScanStage, SiteStatus } from "../types";

export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}
export interface LeadDeps {
  db: D1Database; raw: R2Bucket; fetch: Fetcher; pagespeedKey: string; now: () => Date;
  /** Real-browser render for screenshots and JS-built pages; absent when the Browser binding isn't configured. */
  render?: Renderer;
}

const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

const measurable = (s: SiteStatus) => s === "ok" || s === "blocked";

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
        await enqueueTask(deps.db, SITE_REVIEW_KIND, { auditId: a.id, lowPriority: s.lowPriority, forceDraft: p.forceDraft, steeringNote: p.steeringNote ?? null },
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
