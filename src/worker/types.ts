export type LeadStatus = "new" | "reviewed" | "contacted" | "replied" | "won" | "lost" | "skip";
export type SiteStatus = "ok" | "no_website" | "unreachable" | "parked" | "blocked";
// Detected site builder. Audit.platform is null when the site was not crawled; "other" means crawled but unrecognised.
export type Platform = "wix" | "squarespace" | "godaddy" | "wordpress" | "weebly" | "shopify" | "webflow" | "other";
export type Offer = "new_site" | "performance" | "care_plan" | "seo_basics";
export type FindingGroup = "speed" | "stale" | "basics" | "seo" | "local";
export type FindingCode =
  | "slow_mobile" | "meh_mobile" | "slow_lcp" | "layout_shift" | "not_mobile_friendly"
  | "old_copyright" | "stale_content" | "past_events" | "broken_links"
  | "no_https" | "no_title_or_meta" | "no_contact_form"
  | "low_seo_score" | "low_accessibility"
  | "no_click_to_call" | "no_local_schema" | "thin_content" | "no_h1" | "missing_alt" | "no_sitemap"
  | "mixed_content" | "no_https_redirect" | "dated_build"
  | "no_website" | "site_unreachable" | "site_parked";

export interface Finding {
  code: FindingCode;
  group: FindingGroup | "site";
  severity: "high" | "medium" | "low";
  points: number;
  evidence: string;
}

export interface Listing {
  placeId: string | null;
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  websiteUrl: string | null;
  mapsUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export interface Search {
  id: string; location: string; business_type: string; radius_km: number; max_results: number;
  status: "running" | "done" | "failed"; error: string | null;
  found_count: number; processed_count: number; created_at: string;
}

export interface Radar {
  id: string; location: string; business_type: string; radius_km: number; max_results: number;
  interval_days: number; enabled: 0 | 1; next_run_at: string; last_run_at: string | null;
  last_search_id: string | null; last_error: string | null; claimed_at: string | null; created_at: string;
}

export interface Business {
  id: string; place_id: string | null; domain: string | null; name: string; category: string | null;
  address: string | null; phone: string | null; website_url: string | null; maps_url: string | null;
  rating: number | null; review_count: number | null; first_seen_search_id: string | null;
  lead_status: LeadStatus; notes: string | null; contacted_at: string | null; last_error: string | null;
  created_at: string;
}

export interface Audit {
  id: string; business_id: string; created_at: string; site_status: SiteStatus; partial: boolean;
  pagespeed_mobile: number | null; lcp_ms: number | null; cls: number | null; mobile_friendly: boolean | null;
  https: boolean | null; has_title: boolean | null; has_meta_description: boolean | null;
  has_contact_form: boolean | null; copyright_year: number | null; latest_content_date: string | null;
  broken_link_count: number | null; platform: Platform | null; seo_score: number | null; accessibility_score: number | null; score: number; offer: Offer; findings: Finding[]; raw_r2_key: string | null;
}
export type AuditInsert = Omit<Audit, "id" | "created_at">;

export type ContactType = "email" | "form" | "phone" | "social";
export interface ContactInput {
  type: ContactType; value: string; source_url: string | null;
  person_name: string | null; role: string | null; confidence: number;
}
export interface Contact extends ContactInput { id: string; business_id: string; }

export interface Draft {
  id: string; business_id: string; audit_id: string | null; to_contact_id: string | null;
  recipient_reason: string; subject: string; body: string; offer: Offer;
  steering_note: string | null; edited: boolean; created_at: string;
}
export type DraftInsert = Omit<Draft, "id" | "created_at" | "edited">;

export interface Settings {
  your_name: string; business_name: string; contact_email: string; services_blurb: string;
  signature: string; physical_address: string; opt_out_line: string; tone_notes: string;
  monthly_spend_limit_usd: number; logo_url: string;
}
