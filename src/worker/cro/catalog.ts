import type { BizModelKey, Level, RecArea, RecMode } from "./types";

export interface CatalogItem { id: string; title: string; models: BizModelKey[] | "all"; area: RecArea; impact: Level; effort: Level; mode: RecMode }

const L: BizModelKey = "lead_gen_phone", A: BizModelKey = "appointment", W: BizModelKey = "walk_in",
  E: BizModelKey = "ecommerce", B: BizModelKey = "b2b_consultative", M: BizModelKey = "membership";
const c = (id: string, title: string, models: BizModelKey[] | "all", area: RecArea, impact: Level, effort: Level, mode: RecMode): CatalogItem =>
  ({ id, title, models, area, impact, effort, mode });

/** Proven small-business website improvements. Guides the AI; every recommendation must still cite the site's own evidence. */
export const CATALOG: CatalogItem[] = [
  c("tap_to_call", "Tap-to-call phone number in the header", [L, A, W], "header_nav", "high", "low", "fix"),
  c("header_cta", "Primary action button in the header", "all", "header_nav", "high", "low", "fix"),
  c("nav_trim", "Cut the menu to 5-7 items and group services", "all", "header_nav", "medium", "medium", "fix"),
  c("promote_intent_pages", "Promote buried high-intent pages (financing, pricing, booking, insurance)", [L, A, M], "header_nav", "medium", "low", "fix"),
  c("specific_headline", "Headline that says service, outcome and place", "all", "hero", "high", "low", "test"),
  c("proof_subhead", "Sub-headline with 3 proof points (years, rating, guarantee)", "all", "hero", "medium", "low", "fix"),
  c("real_photos", "Real team or work photos instead of stock", [L, A, B], "hero", "medium", "medium", "test"),
  c("single_primary_cta", "One main action above the fold; demote the rest", "all", "hero", "medium", "low", "test"),
  c("sticky_mobile_bar", "Sticky mobile bar: Call / Book / Directions", [L, A, W], "mobile", "high", "low", "fix"),
  c("tap_targets", "Thumb-sized buttons; no hover-only menus", "all", "mobile", "medium", "low", "fix"),
  c("multi_step_form", "Multi-step form that starts with an easy question", [L, B, M], "forms", "high", "medium", "test"),
  c("fewer_fields", "Cut form fields to the essentials", "all", "forms", "high", "low", "fix"),
  c("response_promise", "Response-time promise next to the form", [L, B], "forms", "medium", "low", "fix"),
  c("thank_you_page", "Thank-you page with next steps and conversion tracking", "all", "forms", "medium", "low", "fix"),
  c("embedded_booking", "Online booking on the site instead of 'call to schedule'", [A, M], "booking", "high", "medium", "strategic"),
  c("insurance_near_book", "Insurance or payment options next to Book", [A], "booking", "high", "low", "fix"),
  c("review_widget", "Live Google review widget with count and recency", "all", "trust", "high", "low", "fix"),
  c("badges_near_cta", "Licenses, insurance and association badges near the main button", [L, A, B], "trust", "medium", "low", "fix"),
  c("risk_reversal", "Guarantee or risk-reversal statement", [L, E, M], "trust", "high", "low", "test"),
  c("case_studies", "Case studies with numbers or before/after galleries", [L, B], "trust", "high", "medium", "strategic"),
  c("named_testimonials", "Named, photographed testimonials on each service page", "all", "trust", "medium", "medium", "fix"),
  c("service_pages", "One page per service", [L, A, B], "services", "high", "medium", "strategic"),
  c("service_area_pages", "Service-area pages with genuinely local content", [L, A], "local_seo", "high", "medium", "strategic"),
  c("gbp_alignment", "Google Business Profile matches the site (categories, booking link, tagged website link)", "all", "local_seo", "high", "low", "fix"),
  c("local_schema", "LocalBusiness, Service and FAQ structured data", "all", "local_seo", "medium", "low", "fix"),
  c("nap_consistency", "Same name, address and phone everywhere", [L, A, W], "local_seo", "medium", "low", "fix"),
  c("review_system", "Automatic review requests after every job or visit", "all", "strategy", "high", "medium", "strategic"),
  c("pricing_transparency", "Price ranges, 'starting at' or a calculator", [L, A, M, B], "pricing_offer", "high", "medium", "test"),
  c("financing_framing", "Financing shown as a monthly payment", [L, A, E], "pricing_offer", "high", "low", "test"),
  c("packaged_tiers", "Good / better / best packages", [L, M, B], "pricing_offer", "high", "medium", "strategic"),
  c("entry_offer", "Entry offer (free inspection, new-patient special, trial class)", [L, A, M], "pricing_offer", "high", "low", "test"),
  c("positioning", "Sharper positioning: who they serve and why them over competitors", "all", "strategy", "high", "medium", "strategic"),
  c("faq_content", "Problem-led FAQ and content answering pre-sale questions", "all", "content", "medium", "medium", "strategic"),
  c("html_menu", "Menu as a web page with photos (not a PDF)", [W], "services", "high", "low", "fix"),
  c("direct_ordering", "Direct online ordering instead of only third-party apps", [W], "booking", "medium", "medium", "strategic"),
  c("free_shipping_bar", "Free-shipping threshold message", [E], "pricing_offer", "medium", "low", "test"),
  c("guest_checkout", "Guest checkout and full costs shown early", [E], "forms", "high", "low", "fix"),
  c("product_trust_block", "Returns, shipping and reviews next to Add to Cart", [E], "trust", "medium", "low", "test"),
  c("calendar_booking", "Calendar booking for consultations with one qualifying question", [B], "booking", "high", "low", "test"),
  c("lead_magnet", "Cost guide or checklist with email follow-up", [B, L, M], "content", "medium", "medium", "strategic"),
  c("tracking_plan", "Track calls, forms, bookings and direction clicks", "all", "tracking", "high", "medium", "strategic"),
  c("call_tracking", "Call tracking numbers per marketing channel", [L, A], "tracking", "high", "medium", "strategic"),
  c("speed_fixes", "Compress images and speed up the first screen", "all", "technical", "medium", "medium", "fix"),
  c("footer_essentials", "Footer with hours, map, service areas and a second action", [L, A, W], "footer", "low", "low", "fix"),
  c("chat_or_text", "Text-us or chat widget", [L, A], "booking", "medium", "medium", "test"),
  c("accessibility_fixes", "Fix contrast, image descriptions and form labels", "all", "technical", "medium", "medium", "fix"),
];

const BY_ID = new Map(CATALOG.map((x) => [x.id, x]));
export const catalogById = (id: string) => BY_ID.get(id);
export function catalogFits(id: string, model: BizModelKey): boolean {
  const x = BY_ID.get(id);
  return !!x && (x.models === "all" || x.models.includes(model));
}
export function catalogText(model?: BizModelKey): string {
  return CATALOG.filter((x) => !model || x.models === "all" || x.models.includes(model))
    .map((x) => `- ${x.id}: ${x.title} [area ${x.area}; impact ${x.impact}; effort ${x.effort}; default ${x.mode}]`).join("\n");
}
