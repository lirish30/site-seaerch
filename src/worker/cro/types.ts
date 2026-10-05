import type { PageKind } from "../types";

export const BIZ_MODEL_KEYS = ["lead_gen_phone", "appointment", "walk_in", "ecommerce", "b2b_consultative", "membership"] as const;
export type BizModelKey = (typeof BIZ_MODEL_KEYS)[number];
export type CroStage = "model" | "pages" | "synthesize";
export type CroStep = "capture" | "evidence" | CroStage | "done";
export type CroFrom = "capture" | CroStage;
export type CroStatus = "running" | "done" | "failed";
export type Device = "desktop" | "mobile";
export type CroPageKind = PageKind | "home";

export interface Box { x: number; y: number; w: number; h: number }

// What the in-page probe returns for one viewport.
export interface CtaEl { text: string; href: string | null; box: Box; aboveFold: boolean; inHeader: boolean; contrast: number | null; fontPx: number }
export interface NavItem { text: string; href: string | null; children: NavItem[] }
export interface FormField { label: string; name: string; type: string; required: boolean }
export interface FormSnap { fields: FormField[]; hasCaptcha: boolean; privacyNote: boolean; submitText: string; box: Box }
export interface TelLink { text: string; href: string; inHeader: boolean; box: Box }
export interface TrustSnap {
  reviewWidget: string | null; testimonialCount: number; attributedTestimonials: number; badgeCount: number;
  guaranteeText: string | null; yearsText: string | null;
}
export interface PageSnapshot {
  url: string; title: string; viewport: { w: number; h: number };
  h1: string[]; heroText: string;
  ctas: CtaEl[]; nav: NavItem[]; stickyHeader: boolean;
  telLinks: TelLink[]; headerPhoneText: string | null; mailtoCount: number;
  forms: FormSnap[]; trust: TrustSnap;
  scripts: string[]; globals: string[];
  overflowX: boolean; smallTextPct: number;
  text: string;
}

export interface FlowResult {
  ctaText: string; href: string; finalUrl: string; offDomain: boolean; vendor: string | null;
  formFields: number | null; opensModal: boolean;
}
export interface AxeSummary { critical: number; serious: number; top: { id: string; help: string; nodes: number }[] }

/** One page as captured by the browser (binary screenshots are separate). */
export interface PageCapture {
  ok: boolean; finalUrl: string;
  desktop: PageSnapshot | null; mobile: PageSnapshot | null;
  desktopJpeg: Uint8Array | null; mobileJpeg: Uint8Array | null;
  desktopTopJpeg: Uint8Array | null; mobileTopJpeg: Uint8Array | null;
  axe: AxeSummary | null; consoleErrors: string[]; failedRequests: string[]; requestHosts: string[];
  flow: FlowResult | null;
}

export interface CroPage { url: string; kind: CroPageKind }
/** Stored per page in cro_audits.pages; key points at the CapturedPage JSON in R2. */
export interface CroPageRef { index: number; url: string; kind: CroPageKind; ok: boolean; key: string | null }
/** The JSON stored in R2 for a page (snapshots + probe results, no images). */
export interface CapturedPage extends CroPageRef {
  desktop: PageSnapshot | null; mobile: PageSnapshot | null;
  axe: AxeSummary | null; consoleErrors: string[]; failedRequests: string[]; requestHosts: string[];
  flow: FlowResult | null;
}

export type EvidenceFamily = "cta" | "nav" | "contact" | "form" | "flow" | "trust" | "copy" | "martech" | "listing" | "health";
export interface Crop extends Box { device: Device; pageIndex: number }
export interface Evidence {
  id: string; page: string; pageKind: CroPageKind; family: EvidenceFamily; fact: string;
  data?: Record<string, unknown>; device?: Device | "both"; crop?: Crop;
}
export type EvidenceDraft = Omit<Evidence, "id">;

export interface BusinessModel {
  model: BizModelKey; secondary_model: BizModelKey | null;
  primary_conversion: string; micro_conversions: string[]; customer_jobs: string[];
  deal_value_band: { low: number; high: number; rationale: string; evidence_ids: string[] };
  sales_cycle: { label: string; rationale: string };
  traffic_tier: "low" | "medium" | "high"; confidence: "low" | "medium" | "high";
}

export interface PageIssue {
  observation: string; quote: string | null; principle: string;
  evidence_ids: string[]; catalog_id: string | null; crop_evidence_id: string | null;
}
export interface PageReview {
  page: string;
  five_second_read: { thinks_business_does: string; would_do_next: string };
  strengths: string[]; issues: PageIssue[];
}

export const REC_AREAS = ["header_nav", "hero", "services", "trust", "forms", "booking", "mobile", "pricing_offer",
  "content", "local_seo", "tracking", "footer", "technical", "strategy"] as const;
export type RecArea = (typeof REC_AREAS)[number];
export type RecMode = "fix" | "fix_measure" | "test" | "strategic";
export type Level = "high" | "medium" | "low";
export interface Recommendation {
  title: string; observation: string; change: string; why: string;
  area: RecArea; mode: RecMode; impact: Level; effort: Level;
  evidence_ids: string[]; catalog_id: string | null; we_can_do_it: string;
}
export interface TrackingEvent { event: string; why: string }
export interface Positioning { says_now: string; should_say: string }
export interface Synthesis { strengths: string[]; positioning: Positioning; tracking_plan: TrackingEvent[]; recommendations: Recommendation[] }

export type Horizon = 30 | 60 | 90;
export interface RankedItem extends Recommendation { rank: number; horizon: Horizon; pxl_score: number }
export interface CroItem extends RankedItem { id: string; cro_audit_id: string; included: boolean; edited: boolean; created_at: string }

// `edited` marks numbers the user saved themselves; until then the scenario follows the assumptions (job value, traffic, model).
export interface ScenarioInputs { visitors: number; currentRate: number; targetRate: number; closeRate: number; dealValue: number; edited?: true }

export interface CroAudit {
  id: string; business_id: string; status: CroStatus; step: CroStep; error: string | null; warning: string | null;
  partial: boolean; pages: CroPageRef[]; evidence: Evidence[];
  business_model: BusinessModel | null; model_overrides: Partial<BusinessModel>; reviewed_as: BizModelKey | null;
  page_reviews: PageReview[]; strengths: string[]; positioning: Positioning | null; tracking_plan: TrackingEvent[];
  scenario_inputs: ScenarioInputs | null; models_used: Partial<Record<CroStage, string>>; est_cost_usd: number;
  created_at: string; started_at: string; completed_at: string | null;
}
