export type LeadStatus = "new" | "reviewed" | "contacted" | "replied" | "won" | "lost" | "skip";
export interface Business { id: string; name: string; category: string | null; address: string | null; phone: string | null;
  website_url: string | null; maps_url: string | null; lead_status: LeadStatus; notes: string | null; contacted_at: string | null; last_error: string | null;
  rating: number | null; review_count: number | null; archived_at: string | null; follow_up_at: string | null; deal_value: number | null; created_at: string; }
export interface LeadRow { business: Business; score: number | null; health: number | null; niche: string | null; topFinding: string | null; offer: string | null;
  bestContact: string | null; hasEmail: boolean; partial: boolean; }

export type AuditCategory = "design" | "content" | "cro" | "mobile" | "speed" | "technical";
export type Severity = "critical" | "important" | "nice";
export interface Finding { code: string; category: AuditCategory | "site"; severity: Severity; points: number; evidence: string; recommendation: string; source: "rule" | "ai"; }
export interface AiReview {
  niche: string; value_proposition: string; scores: Record<"design" | "content" | "cro" | "mobile", number>;
  summaries: Record<"design" | "content" | "cro" | "mobile", string>; strengths: string[]; niche_checklist: { item: string; present: boolean }[];
}
export interface Audit {
  id: string; score: number; health_score: number | null; niche: string | null; offer: string; partial: boolean; site_status: string;
  findings: Finding[]; created_at: string; category_scores: Partial<Record<AuditCategory, number>>; ai_review: AiReview | null;
  screenshots: { desktop: string | null; mobile: string | null }; site_links: Record<string, string>; pagespeed_mobile: number | null;
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
export interface Search { id: string; location: string; business_type: string; max_results: number; status: "running" | "done" | "failed";
  error: string | null; found_count: number; processed_count: number; created_at: string; }
export const STATUSES: LeadStatus[] = ["new", "reviewed", "contacted", "replied", "won", "lost", "skip"];
