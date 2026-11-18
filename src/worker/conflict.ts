import { getBusiness, siteDomain } from "./db/businesses";
import { hostWithin, listDoNotContact, normalizeEmail, normalizeHost, normalizeName } from "./db/doNotContact";
import { leadSuppression } from "./db/suppression";

export type ConflictResult =
  | { blocked: false }
  | { blocked: true; reason: string; source: "do_not_contact" | "suppression" | "client" };

const hit = (reason: string, source: "do_not_contact" | "suppression" | "client"): ConflictResult => ({ blocked: true, reason, source });

/**
 * The conflict gate, run before any outreach email is sent. Blocks when the recipient or the lead is on the do-not-contact list
 * (email, domain or any subdomain of a listed domain, normalized company name), matches the suppression list, or is an existing
 * client (`lead_status` 'won'). Without a `businessId` only the email and its domain are checked.
 */
export async function checkConflict(db: D1Database, c: { email: string; businessId?: string }): Promise<ConflictResult> {
  const email = normalizeEmail(c.email);
  const business = c.businessId ? await getBusiness(db, c.businessId) : null;
  const hosts = [...new Set([
    normalizeHost(email.slice(email.lastIndexOf("@") + 1)),
    business && siteDomain(business.domain), business && siteDomain(business.website_url),
  ].map((h) => (h ? h.replace(/\.+$/, "") : null)).filter((h): h is string => !!h))];
  const name = business ? normalizeName(business.name) : "";

  const listed = await listDoNotContact(db);
  const why = (v: string, reason: string) => hit(`${v} is on your do-not-contact list (${reason})`, "do_not_contact");
  for (const r of listed) {
    if (r.kind === "email" && r.value === email) return why(r.value, r.reason);
    if (r.kind === "domain" && hosts.some((h) => hostWithin(h, r.value))) return why(r.value, r.reason);
    if (r.kind === "name" && name && r.value === name) return why(r.value, r.reason);
  }

  if (business) {
    const s = await leadSuppression(db, business);
    if (s) return hit(`${s.kind === "place_id" ? "this business's Google place ID" : s.value} is on your suppression list (${s.reason})`, "suppression");
    if (business.lead_status === "won") return hit(`${business.name} is an existing client (marked won)`, "client");
  }
  return { blocked: false };
}
