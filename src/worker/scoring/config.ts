export const WEIGHTS = {
  slow_mobile: 25,
  meh_mobile: 12,
  slow_lcp: 10,
  layout_shift: 5,
  not_mobile_friendly: 20,
  old_copyright: 10,
  stale_content: 10,
  past_events: 5,
  broken_links: 8,
  no_https: 15,
  no_title_or_meta: 6,
  no_contact_form: 6,
  low_seo_score: 12,
  low_accessibility: 6,
} as const;

export const THRESHOLDS = {
  slowMobileBelow: 50,
  mehMobileBelow: 70,
  slowLcpMs: 4000,
  layoutShiftCls: 0.25,
  oldCopyrightYearsBack: 2,
  staleContentMonths: 18,
  brokenLinksMin: 3,
  lowPriorityBelow: 20,
  seoLowBelow: 70,
  a11yLowBelow: 70,
} as const;

export const SITE_STATUS_SCORE = { no_website: 100, parked: 90, unreachable: 90 } as const;

// Max points a group can add to the total score; groups not listed here are uncapped.
export const GROUP_CAPS = { seo: 20, local: 15 } as const;
