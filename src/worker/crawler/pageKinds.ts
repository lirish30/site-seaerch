import type { PageKind } from "../types";

// Matched against "<path> <anchor text>"; order is crawl priority (most useful pages first).
export const PAGE_KINDS: [PageKind, RegExp][] = [
  ["contact", /contact|get[\s-]?in[\s-]?touch|reach[\s-]us/i],
  ["services", /services?|what[\s-]we[\s-]do|solutions|capabilities|practice[\s-]areas|treatments|procedures/i],
  ["menu", /\bmenus?\b|food|drinks|wine[\s-]list/i],
  ["about", /about|our[\s-]story|who[\s-]we[\s-]are|history/i],
  ["team", /team|staff|people|our[\s-]doctors|providers|attorneys|leadership/i],
  ["careers", /careers?|jobs?|employment|hiring|join[\s-](our[\s-])?team|work[\s-]with[\s-]us/i],
  ["pricing", /pricing|prices|rates|plans|packages|fees/i],
  ["booking", /book(ing)?|reserv|appointment|schedule|order[\s-]online|request[\s-]a[\s-]quote|free[\s-]estimate/i],
  ["locations", /locations?|service[\s-]areas?|directions|find[\s-]us|hours/i],
  ["portfolio", /portfolio|gallery|projects|our[\s-]work|case[\s-]stud/i],
  ["testimonials", /testimonials?|reviews|what[\s-]clients[\s-]say/i],
  ["faq", /\bfaqs?\b|questions/i],
  ["blog", /blog|news|articles|insights|updates/i],
  ["events", /events?|calendar|upcoming/i],
  ["shop", /shop|store|products|cart/i],
];

export function kindOf(url: string, text: string): PageKind | null {
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url; }
  if (path === "/" || path === "") return null;
  const hay = `${path.replace(/[/_-]+/g, " ")} ${text}`;
  for (const [k, re] of PAGE_KINDS) if (re.test(hay)) return k;
  return null;
}
