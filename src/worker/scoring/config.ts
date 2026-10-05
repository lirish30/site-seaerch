import type { AuditCategory } from "../types";

/** Category weights for Site Health (0-100, higher = better site). Missing categories are dropped and the rest renormalized. */
export const CATEGORY_WEIGHTS: Record<AuditCategory, number> = {
  design: 25, content: 20, cro: 20, mobile: 15, speed: 10, technical: 10,
};

/** Points deducted from a category's 100 when a rule finding fires. */
export const DEDUCTIONS = {
  // mobile
  no_viewport: 50, mobile_overflow: 40, not_mobile_friendly: 30, small_text_mobile: 15,
  // speed (applied on top of the PageSpeed performance score)
  slow_lcp: 10, layout_shift: 10,
  // content
  stale_content: 15, old_copyright: 10, past_events: 10, thin_homepage: 15, missing_niche_page: 12, dated_build: 15,
  // cro
  no_contact_path: 45, no_cta: 20, no_phone_visible: 10, no_click_to_call: 8, no_social_proof: 10, no_nav: 25, no_footer: 10,
  // technical
  no_https: 40, no_title_or_meta: 15, broken_links: 15, no_h1: 10, no_schema: 5, no_local_schema: 5, no_open_graph: 5, images_missing_alt: 10,
  low_seo_score: 15, low_accessibility: 10, no_sitemap: 5, mixed_content: 10, no_https_redirect: 8, no_email_auth: 5,
} as const;

/** How much the AI reviewer's score counts vs the rule-based score where both exist. */
export const AI_BLEND = { content: 0.6, cro: 0.6, mobile: 0.5 } as const;

export const THRESHOLDS = {
  slowMobileBelow: 50,
  mehMobileBelow: 70,
  slowLcpMs: 4000,
  layoutShiftCls: 0.25,
  oldCopyrightYearsBack: 2,
  staleContentMonths: 18,
  brokenLinksMin: 3,
  thinHomepageWords: 120,
  smallTextPct: 0.3,
  // images_missing_alt: at least this many homepage images, and at least this share of them with no alt attribute.
  missingAltMinImages: 4,
  missingAltShare: 0.5,
  lowPriorityBelow: 25,
  // Lighthouse SEO / accessibility category scores (0-100) below these produce a finding.
  seoLowBelow: 70,
  a11yLowBelow: 70,
} as const;

/** Opportunity for sites with no usable website: health is 0 and the pitch is a new site. */
export const SITE_STATUS_SCORE = { no_website: 100, parked: 90, unreachable: 90 } as const;

export const severityFor = (points: number): "critical" | "important" | "nice" => (points >= 30 ? "critical" : points >= 12 ? "important" : "nice");
