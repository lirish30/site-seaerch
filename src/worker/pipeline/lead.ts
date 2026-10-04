import type { Fetcher } from "../crawler/crawl";
import { crawlSite } from "../crawler/crawl";
import { runPageSpeed, RateLimitedError } from "../pagespeed";
import { score } from "../scoring/scorer";
import { generateDraft, type ClaudeCaller } from "../drafter/draft";
import { getBusiness } from "../db/businesses";
import { replaceContacts, listContacts } from "../db/contacts";
import { insertAudit, latestAudit } from "../db/audits";
import { insertDraft } from "../db/drafts";
import { getSettings } from "../db/settings";
import { incrementProcessed } from "../db/searches";
import { recordUsage } from "../db/usage";
import { PRICES } from "../cost";
import type { Renderer } from "../render/render";
import { reviewSite, type ReviewCaller } from "../audit/review";
import { isSocialOnlyUrl } from "../crawler/extract";
import type { AiReview, Draft, SiteStatus } from "../types";

export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}
export interface LeadDeps {
  db: D1Database; raw: R2Bucket; fetch: Fetcher; pagespeedKey: string; claude: ClaudeCaller; now: () => Date;
  /** Real-browser render for screenshots and JS-built pages; absent when the Browser binding isn't configured. */
  render?: Renderer;
  /** AI design/content/conversion review of the screenshots; absent to score on rules only. */
  reviewer?: ReviewCaller;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

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

  const stamp = deps.now().toISOString();
  // Render first: the rendered DOM feeds the crawl (JS forms/nav) and the screenshots feed the AI review.
  // A render failure never fails the lead; the audit just falls back to raw HTML.
  let rendered: { finalUrl: string; htmlKey: string | null; desktop: string | null; mobile: string | null; mobileFacts: { overflowX: boolean; smallTextPct: number } | null } | null = null;
  const site = business.website_url?.trim();
  if (deps.render && site && !isSocialOnlyUrl(withScheme(site))) {
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

  let review: AiReview | null = null;
  if (deps.reviewer && measurable(crawl.siteStatus) && (rendered?.desktop || rendered?.mobile || crawl.facts)) {
    try {
      review = await step.do("review", async () => {
        const img = async (k: string | null | undefined) => (k ? deps.raw.get(k).then(async (o) => (o ? b64(await o.arrayBuffer()) : null)) : null);
        const [desktop, mobile] = await Promise.all([img(rendered?.desktop), img(rendered?.mobile)]);
        const r = await reviewSite({
          business: { name: business.name, category: business.category, address: business.address, website: crawl.finalUrl ?? site ?? "" },
          facts: crawl.facts, pagespeedScore: ps?.performanceScore ?? null, desktopJpegB64: desktop, mobileJpegB64: mobile,
        }, deps.reviewer!);
        await recordUsage(deps.db, "claude", 1, PRICES.claudePerReview);
        return r;
      });
    } catch { review = null; }
  }

  const audit = await step.do("score", async () => {
    const s = score({ siteStatus: crawl.siteStatus, crawl: crawl.facts, pagespeed: ps, now: deps.now(),
      mobile: rendered?.mobileFacts ?? null, review,
      business: { category: business.category, rating: business.rating, reviewCount: business.review_count } });
    const f = crawl.facts;
    const a = await insertAudit(deps.db, {
      business_id: p.businessId, site_status: crawl.siteStatus, partial: measurable(crawl.siteStatus) && ps === null,
      pagespeed_mobile: ps?.performanceScore ?? null, lcp_ms: ps?.lcpMs ?? null, cls: ps?.cls ?? null,
      mobile_friendly: rendered?.mobileFacts ? !rendered.mobileFacts.overflowX && (f?.hasViewport ?? true) : ps ? ps.mobileFriendly : f ? f.hasViewport : null,
      https: f?.https ?? null, has_title: f?.hasTitle ?? null, has_meta_description: f?.hasMetaDescription ?? null,
      has_contact_form: f?.hasContactForm ?? null, copyright_year: f?.copyrightYear ?? null,
      latest_content_date: f?.latestContentDate ?? null, broken_link_count: f?.brokenLinkCount ?? null,
      score: s.score, offer: s.offer, findings: s.findings, raw_r2_key: crawl.rawKey,
      health_score: s.health, niche: s.niche, category_scores: s.categoryScores, ai_review: review,
      screenshots: { desktop: rendered?.desktop ?? null, mobile: rendered?.mobile ?? null }, site_links: crawl.links ?? {},
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
