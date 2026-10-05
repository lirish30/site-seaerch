import type { BizModelKey } from "./types";

export interface BizModelInfo { label: string; primary: string; levers: string[]; signals: string[]; closeRate: number }

/** How each kind of business makes money online; drives what "better" means for its website. */
export const BIZ_MODELS: Record<BizModelKey, BizModelInfo> = {
  lead_gen_phone: { label: "Phone and quote-led service business", primary: "Phone call or quote request", closeRate: 0.4,
    levers: ["Tap-to-call phone and quote button in the header", "Emergency / same-day signal", "Service area", "Reviews near the call to action", "Financing"],
    signals: ["Free estimate", "service area lists", "24/7", "financing", "license numbers"] },
  appointment: { label: "Appointment booking", primary: "Booked appointment", closeRate: 0.7,
    levers: ["Online booking without leaving the site", "Insurance or payment options near Book", "New-customer offer", "Provider bios"],
    signals: ["Zocdoc, Vagaro, Jane, Calendly, Mindbody links", "Book now", "insurance lists"] },
  walk_in: { label: "Walk-in, reservation or ordering", primary: "Reservation, order or directions", closeRate: 0.8,
    levers: ["Menu as a web page, not a PDF", "Hours and address up top", "Reserve or Order buttons", "Food or product photos"],
    signals: ["OpenTable, Resy, Toast, DoorDash links", "menu", "prominent hours"] },
  ecommerce: { label: "Online store", primary: "Purchase", closeRate: 1,
    levers: ["Product pages with reviews", "Shipping cost shown early", "Guest checkout", "Returns policy near Add to Cart"],
    signals: ["Cart", "Shopify or WooCommerce", "product schema", "Add to cart"] },
  b2b_consultative: { label: "High-value consultative service", primary: "Consultation booked", closeRate: 0.25,
    levers: ["Case studies with numbers", "Clear process", "Who it's for", "Calendar booking"],
    signals: ["Case studies", "Schedule a consultation", "industries served", "partners"] },
  membership: { label: "Membership or enrollment", primary: "Enrollment or free trial", closeRate: 0.5,
    levers: ["Prices shown", "Free trial or tour", "Class schedule", "Outcomes and testimonials"],
    signals: ["Tuition or membership tiers", "class schedule", "Enroll", "Free trial"] },
};

export function modelsText(): string {
  return Object.entries(BIZ_MODELS).map(([k, m]) =>
    `- ${k} (${m.label}): primary conversion = ${m.primary}. Highest-leverage: ${m.levers.join("; ")}. Signals: ${m.signals.join("; ")}.`).join("\n");
}
