export type LeadStatus = "new" | "reviewed" | "contacted" | "replied" | "won" | "lost" | "skip";
export interface Business { id: string; name: string; category: string | null; address: string | null; phone: string | null;
  website_url: string | null; maps_url: string | null; lead_status: LeadStatus; notes: string | null; contacted_at: string | null; last_error: string | null;
  rating: number | null; review_count: number | null; }
export interface LeadRow { business: Business; score: number | null; topFinding: string | null; offer: string | null;
  bestContact: string | null; hasEmail: boolean; partial: boolean;
  platform: string | null; rating: number | null; reviewCount: number | null; }
export interface Search { id: string; location: string; business_type: string; radius_km?: number; max_results: number; status: "running" | "done" | "failed";
  error: string | null; found_count: number; processed_count: number; created_at: string; new_only: 0 | 1; }
export const STATUSES: LeadStatus[] = ["new", "reviewed", "contacted", "replied", "won", "lost", "skip"];
export interface Radar { id: string; location: string; business_type: string; radius_km?: number; max_results: number; interval_days: number;
  enabled: 0 | 1; next_run_at: string; last_run_at: string | null; last_search_id: string | null; last_error: string | null; created_at: string;
  newLeadCount: number; lastSearchStatus: Search["status"] | null; }
