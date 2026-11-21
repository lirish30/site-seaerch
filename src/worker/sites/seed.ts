import { logActivityOnce } from "../db/activity";
import { siteDomain } from "../db/businesses";
import type { PackageKey } from "../db/packages";
import { adoptAsPrimary, createSite, listSites, refreshSeededSite, type HostingTier, type Site } from "../db/sites";
import { BUILD_KEYS } from "../documents/schedule";
import { normaliseSiteAddress } from "./address";

const CARE_KEYS: PackageKey[] = ["care", "care_plus", "care_fallback"];

/** Who hosts the site, from what was sold: the client's own hosting wins; a build or Care means Logan hosts it; anything else (a quick fix, SEO, hourly) says nothing. */
export function hostingTierFor(keys: PackageKey[]): HostingTier {
  if (keys.includes("client_hosted_surcharge")) return "client_hosted";
  if (keys.some((k) => BUILD_KEYS.includes(k) || CARE_KEYS.includes(k))) return "logan_hosted";
  return "unknown";
}

/**
 * Makes sure the business has its `primary` site record, from its website, when a sale starts onboarding or a project. Safe to repeat and to run twice at once: the seed key makes
 * the site one per business, and the site_added line is written once, only by the call that made it. A later call changes only two things on the site: a test site becomes real when
 * a real sale arrives (a test one never makes a real site test again), and a hosting tier that is still unknown is filled. Anything an owner edited is left alone.
 * - A live site the owner added by hand for the same domain is adopted as the primary instead of making a second one. When the lead has no usable website (no domain), the oldest
 *   live hand-added site is adopted; an archived one never is, and with no live site at all an empty primary is made.
 * - The lead's website is stored as an https address: a bare domain gets `https://`, and any login, query string or fragment is dropped (null when it is not a web address).
 * - A primary the owner archived is returned as it is and no new site is made.
 * It never throws, because it runs inside the payment and project start paths: a failure logs one plain line (nothing typed or scraped in it) and returns null.
 */
export async function ensureSite(
  db: D1Database, o: { businessId: string; packageKeys: PackageKey[]; test: boolean },
): Promise<{ site: Site; created: boolean } | null> {
  try {
    const biz = await db.prepare(`SELECT website_url FROM businesses WHERE id = ?`).bind(o.businessId).first<{ website_url: string | null }>();
    if (!biz) throw new Error("business not found");
    const url = normaliseSiteAddress(biz.website_url);
    // The domain is kept when it can be read even if the address itself cannot be stored.
    const domain = siteDomain(url) ?? siteDomain(biz.website_url);
    const hostingTier = hostingTierFor(o.packageKeys);
    const now = new Date().toISOString();
    const refresh = async (site: Site) => (await refreshSeededSite(db, site.id, { real: !o.test, hostingTier }, now)) ?? site;

    const sites = await listSites(db, { businessId: o.businessId, includeArchived: true });
    const primary = sites.find((s) => s.seedKey === "primary");
    if (primary) return { site: primary.archivedAt ? primary : await refresh(primary), created: false };

    // The same domain finds the hand-added site for it. With no domain to match on (the lead has no usable website) the oldest live hand-added site is the client's site.
    const hand = domain ? sites.find((s) => !s.archivedAt && s.seedKey === null && s.domain === domain) : sites.find((s) => !s.archivedAt && s.seedKey === null);
    const adopted = hand ? await adoptAsPrimary(db, hand.id, now) : null;
    if (adopted) return { site: await refresh(adopted), created: false };

    const made = await createSite(db, { businessId: o.businessId, seedKey: "primary", url, domain, test: o.test, hostingTier });
    if (!made.created) return { site: made.site.archivedAt ? made.site : await refresh(made.site), created: false };
    await logActivityOnce(db, o.businessId, "site_added", `Site record made for ${domain ?? "a new site"}`);
    return made;
  } catch (e) {
    console.error("sites: not seeded", (e instanceof Error ? e.message : "unknown error").replace(/\s+/g, " ").trim().slice(0, 200));
    return null;
  }
}
