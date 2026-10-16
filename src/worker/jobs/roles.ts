import type { RoleKind } from "../types";

// Order is priority: the first rule that matches names the role, so "SEO Content Writer" is seo and "Marketing Web Developer" is web_dev.
// Anchored on word boundaries so "cro" does not match "crop" and "ux" does not match "luxury".
// The bare CRO acronym is skipped when the title says chief/risk/clinical/trial/contract research, where it means an officer or a research firm.
const RULES: [RoleKind, RegExp][] = [
  ["cro", /^(?!.*\b(?:chief|risk|clinical|trial|contract research)\b).*\bcro\b|conversion( rate)? optimi[sz]ation|\bexperimentation\b|\ba\/b test/i],
  ["seo", /\bseo\b|search engine optimi[sz]ation|organic (growth|search)/i],
  ["web_dev", /\b(web|front[\s-]?end|full[\s-]?stack|wordpress|webflow|shopify|website)\b.*\b(developer|development|engineer|dev)\b|\b(developer|engineer)\b.*\b(web|front[\s-]?end|full[\s-]?stack|wordpress|webflow|shopify|website)\b|\bfront[\s-]?end\b|\bwordpress\b|\bwebflow\b/i],
  ["design", /\b(web|ui|ux|product|visual|digital|graphic)\s+designer\b|\bux\b|\bui\/ux\b/i],
  ["marketing", /\bmarketing\b|\bgrowth\b|\bppc\b|paid (media|search|social)|\bdemand gen/i],
];

/** Which part of the user's field a job title belongs to, or null when it is outside it. */
export function classifyRole(title: string): RoleKind | null {
  for (const [kind, re] of RULES) if (re.test(title)) return kind;
  return null;
}
