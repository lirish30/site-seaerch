import type { Finding } from "./types";

const DAY_MS = 86_400_000;

export const SOURCE_LABEL: Record<Finding["source"], string> = { rule: "Rule check", ai: "AI review" };
export const CONFIDENCE_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" } as const;

/** "observed 3 days ago". A legacy finding has no observed_at, so it is as old as its audit, never "today" by default. */
export function ageLabel(observedAt: string | undefined, auditCreatedAt: string, now: Date): string {
  const at = Date.parse(observedAt ?? auditCreatedAt);
  if (!Number.isFinite(at)) return "observation date unknown";
  const days = Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
  return days === 0 ? "observed today" : `observed ${days} ${days === 1 ? "day" : "days"} ago`;
}

const SEVERITY_RANK = { critical: 0, important: 1, nice: 2 } as const;

/** The n findings most worth showing first: severity, then points, then original order. */
export function topFindings<T extends Pick<Finding, "severity" | "points">>(findings: T[], n = 5): T[] {
  return findings.map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || b.f.points - a.f.points || a.i - b.i)
    .slice(0, n).map(({ f }) => f);
}

const CHIP_LABEL: Partial<Record<string, string>> = {
  no_contact_path: "No contact form", no_cta: "No clear button", no_phone_visible: "No phone shown", no_social_proof: "No reviews shown", no_nav: "No menu", no_footer: "No footer",
  no_viewport: "Not mobile-ready", mobile_overflow: "Wider than a phone", not_mobile_friendly: "Hard to use on a phone", small_text_mobile: "Tiny text on phones",
  slow_lcp: "Slow to load", layout_shift: "Page jumps around", stale_content: "Stale content", old_copyright: "Old copyright", past_events: "Past events listed",
  thin_homepage: "Thin homepage", missing_niche_page: "Missing a key page", broken_links: "Broken links", no_https: "No HTTPS", no_title_or_meta: "No title or description",
  no_h1: "No main heading", no_schema: "No structured data", no_open_graph: "No share preview", images_missing_alt: "Images missing alt text", no_click_to_call: "No tap-to-call",
  no_local_schema: "No local business data", dated_build: "Dated build", low_seo_score: "Weak search basics", low_accessibility: "Accessibility problems", no_sitemap: "No sitemap",
  mixed_content: "Mixed content", no_https_redirect: "No https redirect", no_email_auth: "Email not authenticated", no_website: "No website", site_parked: "Parked domain", site_unreachable: "Site not loading",
};

/** A short name for an issue, for the "Build on" chips: "No contact form", "Mobile speed 38/100". */
export function findingChip(f: Pick<Finding, "code" | "evidence">): string {
  if (f.code === "slow_mobile" || f.code === "meh_mobile") {
    const n = /(\d+)\/100/.exec(f.evidence)?.[1];
    return n ? `Mobile speed ${n}/100` : "Slow on mobile";
  }
  return CHIP_LABEL[f.code] ?? (f.evidence.length > 30 ? `${f.evidence.slice(0, 29)}…` : f.evidence);
}
