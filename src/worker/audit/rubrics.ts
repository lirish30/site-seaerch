import type { PageKind } from "../types";

/**
 * What a small-business website needs, overall and per niche. This is the audit's "strategy study":
 * the universal list reflects common CRO/UX practice (clear offer above the fold, an obvious next step,
 * trust signals, findable contact info, a site that works on a phone), and each niche adds the pages
 * and features its buyers look for before they call. Fed to the AI reviewer and used by the scorer.
 */
export const UNIVERSAL_CHECKS = [
  "A clear headline above the fold that says what they do and where",
  "One obvious primary call to action (call, book, quote, order) visible without scrolling",
  "Navigation that reaches every key page in one click, and a footer with contact info, hours/address, and key links",
  "An easy contact path on every page: phone (tap-to-call on mobile), email or a short form",
  "Trust signals: reviews/testimonials, years in business, credentials, real photos of the team or work",
  "Layout that works on a phone: no sideways scrolling, readable text, thumb-sized buttons",
  "Current content: no stale dates, old copyright, or past events presented as upcoming",
  "Professional visual design: consistent type and color, quality imagery, enough whitespace, clear hierarchy",
  "Technical basics: HTTPS, page titles and descriptions, one H1, image alt text, structured data for local business",
];

export interface Niche {
  label: string;
  /** Google category / search-term keywords that suggest this niche. */
  match: RegExp;
  /** Page kinds a site in this niche should have, with the reason shown to the prospect. */
  pages: { kind: PageKind; why: string }[];
  /** Niche-specific expectations for the AI reviewer to check. */
  expects: string[];
  /** Primary conversion the site should drive. */
  goal: string;
}

export const NICHES: Record<string, Niche> = {
  restaurant: {
    label: "Restaurant / food & drink",
    match: /restaurant|cafe|coffee|bakery|bar\b|pub|pizza|grill|diner|bistro|brewery|winery|food|catering|taco|sushi|deli/i,
    pages: [{ kind: "menu", why: "Diners decide from the menu; a missing or PDF-only menu loses them to competitors" },
      { kind: "locations", why: "Hours, address and directions are the most-searched details for restaurants" }],
    expects: ["An HTML menu (not only a PDF or image)", "Hours and address on the homepage", "Online ordering or reservations link", "Food photography"],
    goal: "Reservations, online orders, and walk-ins",
  },
  trades: {
    label: "Home services / trades",
    match: /plumb|electric|hvac|roof|landscap|lawn|contractor|construction|remodel|paint|clean|pest|garage|handyman|fenc|concrete|pool|tree|moving|locksmith|flooring|window|solar/i,
    pages: [{ kind: "services", why: "Each service needs its own page to rank and to answer 'do you do X?'" },
      { kind: "contact", why: "A quote/estimate request form is the main way trades win jobs online" },
      { kind: "portfolio", why: "Before/after photos are the strongest proof of quality work" }],
    expects: ["Service area towns listed", "Request a quote / free estimate form", "License, insurance, warranty badges", "Click-to-call phone in the header", "Reviews"],
    goal: "Quote requests and phone calls",
  },
  medical: {
    label: "Medical / dental / wellness",
    match: /dentist|dental|doctor|clinic|medical|chiropract|physio|therapy|therapist|optometr|dermatolog|pediatric|orthodont|vet|veterinar|spa|massage|med spa|counsel/i,
    pages: [{ kind: "services", why: "Patients search by treatment; each needs a clear page" },
      { kind: "team", why: "Patients choose a provider they trust; bios and photos matter" },
      { kind: "booking", why: "Online booking converts patients who won't call during office hours" }],
    expects: ["Online appointment booking", "Insurance accepted / payment info", "Provider bios with credentials", "New patient information", "Accessibility and privacy notices"],
    goal: "Appointment bookings",
  },
  professional: {
    label: "Professional services / B2B",
    match: /law|attorney|lawyer|account|cpa|bookkeep|consult|agency|marketing|insurance|financial|advisor|architect|engineer|it services|software|staffing|recruit|real estate|mortgage|title|manufactur|wholesale|distribut|b2b|logistics/i,
    pages: [{ kind: "services", why: "B2B buyers need specific service pages to see fit and justify the purchase" },
      { kind: "portfolio", why: "Case studies and client results are what B2B buyers compare on" },
      { kind: "about", why: "Buyers vet the team and experience before reaching out" },
      { kind: "team", why: "Named experts with credentials build trust for high-value services" }],
    expects: ["Clear positioning: who they serve and the outcome", "Case studies or client logos", "Lead capture form or consultation booking", "Thought-leadership content", "Team credentials"],
    goal: "Qualified leads and consultation requests",
  },
  retail: {
    label: "Retail / e-commerce",
    match: /store|shop|boutique|retail|florist|jewel|furniture|gift|clothing|apparel|hardware|nursery|pet store|bike|book/i,
    pages: [{ kind: "shop", why: "Shoppers expect to browse products or check stock online" },
      { kind: "locations", why: "Hours and location drive store visits" }],
    expects: ["Product or category browsing", "Hours and location", "Online shopping or click-and-collect", "Promotions / email signup"],
    goal: "Store visits and online sales",
  },
  education: {
    label: "Education / childcare / training",
    match: /school|academy|daycare|childcare|preschool|tutor|college|university|training|driving school|music lesson|dance|martial|camp|learning|montessori/i,
    pages: [{ kind: "services", why: "Families compare programs; each needs details, ages and schedules" },
      { kind: "pricing", why: "Tuition/fees are the top question before enquiring" },
      { kind: "team", why: "Parents want to know who teaches their kids" }],
    expects: ["Programs with ages and schedules", "Tuition or pricing", "Enrollment / tour booking", "Staff credentials", "Parent testimonials"],
    goal: "Tour bookings and enrollments",
  },
  fitness_beauty: {
    label: "Fitness / beauty / personal care",
    match: /gym|fitness|yoga|pilates|crossfit|salon|barber|nail|beauty|lash|brow|tattoo|personal trainer|studio/i,
    pages: [{ kind: "pricing", why: "Memberships and service prices are the first thing visitors look for" },
      { kind: "booking", why: "Clients expect to book a class or appointment online" }],
    expects: ["Online booking or class schedule", "Prices or memberships", "Gallery of work or facility", "Intro offer"],
    goal: "Bookings and memberships",
  },
  nonprofit_community: {
    label: "Nonprofit / church / community",
    match: /church|nonprofit|non-profit|charity|foundation|association|club|museum|library|community|ministry|temple/i,
    pages: [{ kind: "events", why: "Up-to-date events are why most visitors come back" },
      { kind: "about", why: "Mission and leadership build trust with donors and members" }],
    expects: ["Current events calendar", "Donate / get involved call to action", "Mission statement", "Service times or visiting info"],
    goal: "Donations, volunteers, and attendance",
  },
  general: {
    label: "Local business (general)",
    match: /.*/,
    pages: [{ kind: "services", why: "Visitors need to see exactly what is offered" },
      { kind: "about", why: "An about page builds trust in a local business" },
      { kind: "contact", why: "A dedicated contact page is the standard path to reach out" }],
    expects: ["Clear list of services or products", "Reviews", "Contact details on every page"],
    goal: "Calls and enquiries",
  },
};

export type NicheKey = keyof typeof NICHES;

/** Best-guess niche from the Google category or search term; the AI reviewer may override it. */
export function guessNiche(category: string | null): NicheKey {
  if (!category) return "general";
  for (const [k, n] of Object.entries(NICHES)) if (k !== "general" && n.match.test(category)) return k;
  return "general";
}

export function rubricText(): string {
  const niches = Object.entries(NICHES).map(([k, n]) =>
    `- ${k} (${n.label}). Goal: ${n.goal}. Needs pages: ${n.pages.map((p) => p.kind).join(", ")}. Expects: ${n.expects.join("; ")}.`).join("\n");
  return `Universal checks for every business website:\n${UNIVERSAL_CHECKS.map((c) => `- ${c}`).join("\n")}\n\nNiches:\n${niches}`;
}
