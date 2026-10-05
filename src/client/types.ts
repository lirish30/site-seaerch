export type LeadStatus = "new" | "reviewed" | "contacted" | "replied" | "won" | "lost" | "skip";
export interface Business { id: string; name: string; category: string | null; address: string | null; phone: string | null;
  website_url: string | null; maps_url: string | null; lead_status: LeadStatus; notes: string | null; contacted_at: string | null; last_error: string | null;
  rating: number | null; review_count: number | null; archived_at: string | null; follow_up_at: string | null; deal_value: number | null; created_at: string;
  scan_stage: ScanStage; }
/** 'quick' = crawled and scored only; 'full' = also screenshots, PageSpeed, AI review and a draft. */
export type ScanStage = "quick" | "full";
export interface LeadRow { business: Business; score: number | null; health: number | null; niche: string | null; topFinding: string | null; offer: string | null;
  bestContact: string | null; hasEmail: boolean; partial: boolean; poc: { name: string; email: string | null } | null;
  platform: string | null; rating: number | null; reviewCount: number | null; fit: FitResult; scan_stage: ScanStage; }

export type AuditCategory = "design" | "content" | "cro" | "mobile" | "speed" | "technical";
export type Severity = "critical" | "important" | "nice";
export interface Finding { code: string; category: AuditCategory | "site"; severity: Severity; points: number; evidence: string; recommendation: string; source: "rule" | "ai";
  observed_at?: string; confidence?: "high" | "medium" | "low"; stale?: boolean; }
export interface AuditChanges { since: string; added: Finding[]; resolved: Finding[]; unchangedCount: number; }
export interface AiReview {
  niche: string; value_proposition: string; scores: Record<"design" | "content" | "cro" | "mobile", number>;
  summaries: Record<"design" | "content" | "cro" | "mobile", string>; strengths: string[]; niche_checklist: { item: string; present: boolean }[];
}
export interface Audit {
  id: string; score: number; health_score: number | null; niche: string | null; offer: string; partial: boolean; site_status: string;
  findings: Finding[]; created_at: string; category_scores: Partial<Record<AuditCategory, number>>; ai_review: AiReview | null;
  screenshots: { desktop: string | null; mobile: string | null }; site_links: Record<string, string>; pagespeed_mobile: number | null;
  platform: string | null; seo_score: number | null; accessibility_score: number | null; mail_warning: string | null;
}
export interface Contact { id: string; type: string; value: string; source_url: string | null; person_name: string | null; role: string | null; }
export interface Person { id: string; name: string; role: string | null; email: string | null; phone: string | null; linkedin: string | null; source: "manual" | "site"; is_poc: boolean; }
export interface Activity { id: string; kind: string; detail: string | null; created_at: string; }

export const CATEGORY_LABEL: Record<AuditCategory | "site", string> = {
  design: "Design & UX", content: "Content", cro: "Conversion", mobile: "Mobile", speed: "Speed", technical: "Technical & SEO", site: "Website",
};
export const CATEGORY_ORDER: AuditCategory[] = ["design", "content", "cro", "mobile", "speed", "technical"];
export const OFFER_LABEL: Record<string, string> = {
  new_site: "New website", performance: "Speed & mobile fix", care_plan: "Care plan", seo_basics: "SEO basics", conversion: "Conversion refresh",
};
export const NICHE_LABEL: Record<string, string> = {
  restaurant: "Restaurant", trades: "Home services", medical: "Medical & wellness", professional: "Professional / B2B", retail: "Retail",
  education: "Education", fitness_beauty: "Fitness & beauty", nonprofit_community: "Nonprofit & community", general: "Local business",
};
export interface Search { id: string; location: string; business_type: string; radius_km?: number; max_results: number; status: "running" | "done" | "failed";
  error: string | null; found_count: number; processed_count: number; created_at: string; new_only: 0 | 1; quick_scan: 0 | 1; }
export const STATUSES: LeadStatus[] = ["new", "reviewed", "contacted", "replied", "won", "lost", "skip"];
export interface Radar { id: string; location: string; business_type: string; radius_km?: number; max_results: number; interval_days: number;
  enabled: 0 | 1; next_run_at: string; last_run_at: string | null; last_search_id: string | null; last_error: string | null; created_at: string;
  newLeadCount: number; lastSearchStatus: Search["status"] | null; }

export interface Service {
  id: string; key: string; name: string; category: string; summary: string; deliverables: string[]; prerequisites: string[];
  first_engagement: string | null; finding_codes: string[]; finding_categories: AuditCategory[];
  is_specialty: boolean; active: boolean; sort: number;
}
/** What GET /api/leads/:id returns as `best_offer`; `because` findings carry the per-request `stale` flag. */
export interface BestOffer { service: Service; because: Finding[]; legacyOffer: string | null; }

export type Platform = "wix" | "squarespace" | "godaddy" | "wordpress" | "weebly" | "shopify" | "webflow" | "other";
export interface FitProfile {
  id: string; name: string; service_key: string; industries: string[]; geos: string[]; platforms: Platform[];
  min_reviews: number | null; min_rating: number | null; active: boolean;
}
/** `fit` on each lead list row and on GET /api/leads/:id; null when no active profile defines a criterion. */
export interface FitResult { fit: number | null; profile: { id: string; name: string; service_key: string } | null; matched: string[]; missing: string[]; }

export type SuppressionReason = "client" | "opt_out" | "competitor" | "active_deal" | "other";
export interface Suppression { id: string; kind: "domain" | "place_id"; value: string; reason: SuppressionReason; note: string | null; created_at: string; }
/** `suppressed` on GET /api/leads/:id: the reason and note of the list entry this lead matches, or null. */
export interface LeadSuppression { reason: SuppressionReason; note: string | null; }
