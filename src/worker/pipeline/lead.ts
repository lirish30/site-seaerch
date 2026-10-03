import type { Fetcher } from "../crawler/crawl";
import { crawlSite } from "../crawler/crawl";
import { runPageSpeed, RateLimitedError } from "../pagespeed";
import { score } from "../scoring/scorer";
import { lookupMailDns, siteMailDomain, UNKNOWN_MAIL_DNS, type MailDns } from "../dns";
import { generateDraft, type ClaudeCaller } from "../drafter/draft";
import { getBusiness } from "../db/businesses";
import { replaceContacts, listContacts } from "../db/contacts";
import { insertAudit, latestAudit } from "../db/audits";
import { insertDraft } from "../db/drafts";
import { getSettings } from "../db/settings";
import { incrementProcessed } from "../db/searches";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";
import type { Draft, SiteStatus } from "../types";

export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}
export interface LeadDeps {
  db: D1Database; raw: R2Bucket; fetch: Fetcher; pagespeedKey: string; claude: ClaudeCaller; now: () => Date;
}

async function draftFor(deps: LeadDeps, businessId: string, steeringNote: string | null): Promise<Draft> {
  const [business, audit, contacts, settings] = await Promise.all([
    getBusiness(deps.db, businessId), latestAudit(deps.db, businessId), listContacts(deps.db, businessId), getSettings(deps.db),
  ]);
  if (!business || !audit) throw new Error("Cannot draft: business or audit missing");
  const d = await generateDraft({ settings, business, findings: audit.findings, offer: audit.offer, contacts, steeringNote }, deps.claude);
  await recordUsage(deps.db, "claude", 1, PRICES.claudePerDraft);
  return insertDraft(deps.db, { business_id: businessId, audit_id: audit.id, offer: audit.offer, steering_note: steeringNote, ...d });
}

const measurable = (s: SiteStatus) => s === "ok" || s === "blocked";

export function regenerateDraft(deps: LeadDeps, businessId: string, steeringNote: string | null) {
  return draftFor(deps, businessId, steeringNote);
}

export async function runLead(
  deps: LeadDeps, step: StepLike,
  p: { businessId: string; searchId: string | null; forceDraft?: boolean; steeringNote?: string | null },
) {
  const business = await getBusiness(deps.db, p.businessId);
  if (!business) throw new Error(`Business ${p.businessId} not found`);

  const crawl = await step.do("crawl", async () => {
    const settings = await getSettings(deps.db);
    const ua = `SiteSearchAudit/1.0 (+contact: ${settings.contact_email || settings.business_name || "owner"})`;
    const r = await crawlSite(business.website_url, { fetch: deps.fetch, userAgent: ua, now: deps.now() });
    let rawKey: string | null = null;
    if (r.pages.length) {
      rawKey = `audits/${p.businessId}/${deps.now().toISOString()}.json`;
      await deps.raw.put(rawKey, JSON.stringify({ pages: r.pages }));
    }
    await replaceContacts(deps.db, p.businessId, r.contacts);
    return { siteStatus: r.siteStatus, finalUrl: r.finalUrl, facts: r.facts, rawKey };
  });

  // Retries may be exhausted (e.g. rate limited); degrade to a partial audit rather than failing the lead.
  // No instanceof check: error classes may not survive Workflows' step-error serialization.
  let ps: Awaited<ReturnType<typeof runPageSpeed>>["facts"] | null = null;
  try {
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

  const audit = await step.do("score", async () => {
    const s = score({ siteStatus: crawl.siteStatus, crawl: crawl.facts, pagespeed: ps, mailDns, now: deps.now() });
    const f = crawl.facts;
    const a = await insertAudit(deps.db, {
      business_id: p.businessId, site_status: crawl.siteStatus, partial: measurable(crawl.siteStatus) && ps === null,
      pagespeed_mobile: ps?.performanceScore ?? null, lcp_ms: ps?.lcpMs ?? null, cls: ps?.cls ?? null,
      mobile_friendly: ps ? ps.mobileFriendly : f ? f.hasViewport : null,
      https: f?.https ?? null, has_title: f?.hasTitle ?? null, has_meta_description: f?.hasMetaDescription ?? null,
      has_contact_form: f?.hasContactForm ?? null, copyright_year: f?.copyrightYear ?? null,
      latest_content_date: f?.latestContentDate ?? null, broken_link_count: f?.brokenLinkCount ?? null,
      platform: f?.platform ?? null, // null = not crawled; "other" = crawled but unrecognised
      seo_score: ps?.seoScore ?? null, accessibility_score: ps?.accessibilityScore ?? null,
      score: s.score, offer: s.offer, findings: s.findings, raw_r2_key: crawl.rawKey,
      // A note for the owner only: not a finding, never scored, and not passed to the drafter or the report.
      mail_warning: mailDns.hasMx === false ? "A site email address is at a domain with no mail records, so emails to it will likely bounce" : null,
    });
    return { id: a.id, lowPriority: s.lowPriority };
  });

  const draftId = await step.do("draft", async () => {
    if (audit.lowPriority && !p.forceDraft) return null;
    return (await draftFor(deps, p.businessId, p.steeringNote ?? null)).id;
  });

  if (p.searchId) await step.do("progress", () => incrementProcessed(deps.db, p.searchId!).then(() => true));
  return { auditId: audit.id, draftId };
}
