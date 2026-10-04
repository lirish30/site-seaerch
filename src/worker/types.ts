export type LeadStatus = "new" | "reviewed" | "contacted" | "replied" | "won" | "lost" | "skip";
export type SiteStatus = "ok" | "no_website" | "unreachable" | "parked" | "blocked";
export type Offer = "new_site" | "performance" | "care_plan" | "seo_basics" | "conversion";
export type AuditCategory = "design" | "content" | "cro" | "mobile" | "speed" | "technical";
export type Severity = "critical" | "important" | "nice";
export type FindingCode =
  | "slow_mobile" | "meh_mobile" | "slow_lcp" | "layout_shift" | "not_mobile_friendly" | "no_viewport"
  | "mobile_overflow" | "small_text_mobile"
  | "old_copyright" | "stale_content" | "past_events" | "thin_homepage" | "missing_niche_page"
  | "no_contact_path" | "no_cta" | "no_phone_visible" | "no_social_proof" | "no_nav" | "no_footer"
  | "broken_links" | "no_https" | "no_title_or_meta" | "no_h1" | "no_schema" | "no_open_graph" | "images_missing_alt"
  | "no_website" | "site_unreachable" | "site_parked"
  | `ai_${string}`;

export interface Finding {
  code: FindingCode;
  category: AuditCategory | "site";
  severity: Severity;
  /** Points deducted from the category score (rule findings) or 0 for AI observations already reflected in its score. */
  points: number;
  evidence: string;
  recommendation: string;
  source: "rule" | "ai";
}

/** Kinds of page a business site may link to; used for niche checks and lead links. */
export type PageKind =
  | "contact" | "about" | "services" | "menu" | "pricing" | "careers" | "team" | "blog" | "events"
  | "locations" | "booking" | "portfolio" | "testimonials" | "faq" | "shop";

export type CategoryScores = Partial<Record<AuditCategory, number>>;

export interface AiReview {
  niche: string;
  value_proposition: string;
  scores: { design: number; content: number; cro: number; mobile: number };
  summaries: { design: string; content: string; cro: string; mobile: string };
  strengths: string[];
  niche_checklist: { item: string; present: boolean }[];
  findings: { category: AuditCategory; severity: Severity; title: string; evidence: string; recommendation: string }[];
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

export interface Business {
  id: string; place_id: string | null; domain: string | null; name: string; category: string | null;
  address: string | null; phone: string | null; website_url: string | null; maps_url: string | null;
  rating: number | null; review_count: number | null; first_seen_search_id: string | null;
  lead_status: LeadStatus; notes: string | null; contacted_at: string | null; last_error: string | null;
  created_at: string; archived_at: string | null; follow_up_at: string | null; deal_value: number | null;
}

export interface PersonInput {
  name: string; role?: string | null; email?: string | null; phone?: string | null; linkedin?: string | null;
  source?: "manual" | "site"; is_poc?: boolean;
}
export interface Person {
  id: string; business_id: string; name: string; role: string | null; email: string | null; phone: string | null;
  linkedin: string | null; source: "manual" | "site"; is_poc: boolean; created_at: string;
}

export type ActivityKind = "status" | "archived" | "restored" | "website" | "reaudit" | "score_flagged" | "export" | "draft";
export interface Activity { id: string; business_id: string; kind: ActivityKind; detail: string | null; created_at: string; }

export interface Audit {
  id: string; business_id: string; created_at: string; site_status: SiteStatus; partial: boolean;
  pagespeed_mobile: number | null; lcp_ms: number | null; cls: number | null; mobile_friendly: boolean | null;
  https: boolean | null; has_title: boolean | null; has_meta_description: boolean | null;
  has_contact_form: boolean | null; copyright_year: number | null; latest_content_date: string | null;
  broken_link_count: number | null;
  /** Opportunity score (0-100, higher = better lead). Kept in `score` so existing sorting keeps working. */
  score: number; offer: Offer; findings: Finding[]; raw_r2_key: string | null;
  /** Site Health (0-100, higher = better site); null when nothing could be measured. */
  health_score: number | null; niche: string | null; category_scores: CategoryScores;
  ai_review: AiReview | null; screenshots: { desktop: string | null; mobile: string | null };
  site_links: Partial<Record<PageKind, string>>;
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
  monthly_spend_limit_usd: number; tone_preset: TonePreset; email_length: EmailLength; cta_style: CtaStyle;
}
export type TonePreset = "friendly_local" | "consultative" | "direct" | "formal";
export type EmailLength = "short" | "medium" | "long";
export type CtaStyle = "mini_audit" | "call" | "reply" | "proposal";
