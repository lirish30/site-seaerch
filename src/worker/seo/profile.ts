// A client's local SEO profile (Plan 14): the Google listing it is tied to, the towns and grid the rank checks use, and the check of the client's own site against the listing.
// The listing is the source of truth: the place's location, name, address and phone always come from Google, never from the request.
import type { Env } from "../env";
import { crawlSite, type Fetcher } from "../crawler/crawl";
import { getSettings } from "../db/settings";
import { ensureCitations, getProfile, upsertProfile, type SeoProfile } from "../db/seo";
import { getSite, listSites, type Site } from "../db/sites";
import { monitorableUrl } from "../monitoring/probe";
import { cleanText, looksLikeCredential } from "../onboarding/templates";
import { CITATION_DIRECTORIES, napCheck, type NapResult } from "./nap";
import { PlacesError, PlacesNotConfigured, placeDetails } from "./places";

export const MAX_TOWNS = 8;
export const MIN_TEXT = 2;
export const MAX_TEXT = 60;
export const MIN_GRID_KM = 1;
export const MAX_GRID_KM = 10;

/** A request the owner can fix, as one plain sentence. `status` is the HTTP answer the route gives it. Nothing a remote service or a site sent is ever in the message. */
export class SeoRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 | 503 = 400) {
    super(message);
    this.name = "SeoRefusal";
  }
}

export const CREDENTIAL_REFUSED = "That looks like a login, a password or a key. Keywords, towns and notes are saved as plain text, so take it out.";

// Looks `fetch` up on each call (and calls it unbound), as places.ts does, so a test can stub it.
const defaultFetch: Fetcher = (u, i) => fetch(u, i);

/** A line of text the owner typed, tidied: control characters out, runs of spaces made one. */
export const tidy = (s: string): string => cleanText(s, 1000).replace(/\s+/g, " ");

/** Turns a Google Places failure into a refusal the owner can read; anything else is not ours to explain and is passed on (null). The key and Google's own words are never repeated. */
export function placesRefusal(e: unknown): SeoRefusal | null {
  if (e instanceof PlacesNotConfigured) return new SeoRefusal("Google Places is not set up yet, so places can't be looked up. Add the Places key first.", 503);
  if (e instanceof PlacesError) {
    return e.retryable
      ? new SeoRefusal("Google could not be reached just now. Try again in a minute.", 502)
      : new SeoRefusal("Google would not give us that place. It may have no map location; pick a different place, or check the Places key.", 502);
  }
  return null;
}

function checkTowns(towns: string[]): string[] {
  if (!Array.isArray(towns)) throw new SeoRefusal("Towns must be a list.");
  if (towns.length > MAX_TOWNS) throw new SeoRefusal(`Use at most ${MAX_TOWNS} towns.`);
  const out: string[] = [];
  for (const raw of towns) {
    const t = typeof raw === "string" ? tidy(raw) : "";
    if (t.length < MIN_TEXT || t.length > MAX_TEXT) throw new SeoRefusal(`Each town must be ${MIN_TEXT} to ${MAX_TEXT} characters.`);
    if (looksLikeCredential(t)) throw new SeoRefusal(CREDENTIAL_REFUSED);
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/**
 * Ties the client to a Google place and sets how it is watched. `lat`, `lng`, the maps link and the name, address and phone are taken from Google's details for `placeId`; a place Google
 * no longer knows, or gives no location for, is refused and nothing is written. A client's first setup is `setup` status; setting up again keeps a watch that is already running, and a
 * different place forgets the last name, address and phone check (it was about the old one). The citation list is made if the client has none.
 */
export async function setupProfile(
  env: Env, businessId: string, o: { placeId: string; trade: string; towns: string[]; gridKm: number; siteId?: string }, now: string,
): Promise<SeoProfile> {
  const trade = typeof o.trade === "string" ? tidy(o.trade) : "";
  if (trade.length < MIN_TEXT || trade.length > MAX_TEXT) throw new SeoRefusal(`The trade must be ${MIN_TEXT} to ${MAX_TEXT} characters.`);
  if (looksLikeCredential(trade)) throw new SeoRefusal(CREDENTIAL_REFUSED);
  const towns = checkTowns(o.towns);
  if (typeof o.gridKm !== "number" || !Number.isFinite(o.gridKm) || o.gridKm < MIN_GRID_KM || o.gridKm > MAX_GRID_KM) {
    throw new SeoRefusal(`The grid spacing must be between ${MIN_GRID_KM} and ${MAX_GRID_KM} km.`);
  }
  const placeId = typeof o.placeId === "string" ? o.placeId.trim() : "";
  if (!placeId || placeId.length > 300) throw new SeoRefusal("Pick a place first.");
  if (o.siteId !== undefined) {
    const site = await getSite(env.DB, o.siteId);
    if (!site || site.businessId !== businessId || site.archivedAt) throw new SeoRefusal("That site is not one of this client's live sites.");
  }

  let details;
  try { details = await placeDetails(env, placeId); } catch (e) { throw placesRefusal(e) ?? e; }
  if (!details) throw new SeoRefusal("Google can't find that place any more. Search for the business again and pick it from the list.", 409);

  const existing = await getProfile(env.DB, businessId);
  const profile = await upsertProfile(env.DB, businessId, {
    placeId, mapsUrl: details.mapsUrl, napName: details.name, napAddress: details.address, napPhone: details.phone ?? "", lat: details.lat, lng: details.lng,
    trade, towns, gridKm: o.gridKm,
    ...(o.siteId !== undefined ? { siteId: o.siteId } : {}),
    ...(existing ? {} : { status: "setup" as const }),
    ...(existing && existing.placeId !== placeId ? { napResult: null } : {}),
  }, now);
  await ensureCitations(env.DB, businessId, CITATION_DIRECTORIES, now);
  return profile;
}

/** The site to check: the one the profile names if it is still the client's live site, else the client's primary live site, else the first with an address. */
async function siteToCheck(env: Env, profile: SeoProfile): Promise<Site | null> {
  if (profile.siteId) {
    const named = await getSite(env.DB, profile.siteId);
    if (named && named.businessId === profile.businessId && !named.archivedAt && named.url) return named;
  }
  const live = (await listSites(env.DB, { businessId: profile.businessId })).filter((s) => !!s.url);
  return live.find((s) => s.seedKey === "primary") ?? live[0] ?? null;
}

// The crawler also asks for robots.txt, a sitemap and a HEAD of links on the page. A name, address and phone check needs none of it, so those never leave the Worker.
const LEAN_SKIP = /\/(robots\.txt|sitemap[^/]*\.xml)$/i;
const lean = (f: Fetcher): Fetcher => (url, init) => {
  let skip = init?.method === "HEAD";
  if (!skip) { try { skip = LEAN_SKIP.test(new URL(url).pathname); } catch { skip = true; } }
  return skip ? Promise.resolve(new Response(null, { status: 404 })) : f(url, init);
};

/**
 * Reads the client's site (its home page and the contact page it links to) and compares what it says with the listing's name, address and phone. The result is stored on the profile as JSON
 * and returned. Refused, with nothing stored, when there is no profile, no site address, an address that is not public, or the site could not be read.
 */
export async function runNapCheck(env: Env, businessId: string, f: Fetcher = defaultFetch, now: Date = new Date()): Promise<NapResult> {
  const profile = await getProfile(env.DB, businessId);
  if (!profile) throw new SeoRefusal("Set up the profile first, so there is a name, address and phone to check against.", 409);
  const site = await siteToCheck(env, profile);
  if (!site?.url) throw new SeoRefusal("This client has no website address on file to check. Add the site first.", 409);
  const target = monitorableUrl(site.url);
  if (!target.ok) throw new SeoRefusal("This site's address can't be checked. Give it a public http or https address first.", 409);

  const settings = await getSettings(env.DB);
  const userAgent = `SiteSearchAudit/1.0 (+contact: ${settings.contact_email || settings.business_name || "owner"})`;
  const crawl = await crawlSite(target.url, { fetch: lean(f), userAgent, now, maxPages: 2 });
  if (crawl.siteStatus !== "ok" || crawl.pages.length === 0) throw new SeoRefusal("We couldn't load that site just now, so nothing was checked. Make sure it is up, then try again.", 409);

  const contact = crawl.links.contact;
  const pages = crawl.pages.filter((p, i) => i === 0 || p.url === contact).map((p) => ({ url: p.url, html: p.html }));
  const result = napCheck(pages, { name: profile.napName, address: profile.napAddress, phone: profile.napPhone });
  await upsertProfile(env.DB, businessId, { napResult: JSON.stringify(result) }, now.toISOString());
  return result;
}
