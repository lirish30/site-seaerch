import { logActivity } from "../db/activity";
import { getSite, type Site } from "../db/sites";
import { deleteLink, getLink, saveLink, type SiteLink } from "../db/traffic";
import type { Env } from "../env";
import { GoogleApiError, timedFetch } from "../google/api";
import { googleAccess } from "../google/access";
import { ga4Hosts, listGa4Properties } from "../google/analytics";
import { getGoogleAuth } from "../db/google";
import { hasProfileScope, hasTrafficScopes, type Fetch } from "../google/oauth";
import { listGscSites } from "../google/searchConsole";
import { isGbpLocation } from "./location";

/** Analytics properties whose streams are read when looking for the ones that belong to a site (a request makes at most this many Google calls for streams). */
export const MAX_GA4_STREAM_LOOKUPS = 40;

/** A link the owner asked for that is not allowed. The message is a plain sentence to show as it is. */
export class LinkRefused extends Error {
  readonly status = 409;
}

/** The site is unknown or archived. */
export class SiteNotFound extends Error {}

export interface Candidates {
  gsc: { siteUrl: string; label: string }[];
  ga4: { id: string; name: string }[];
  /** The connected Google account, so the owner knows whose access to ask the client for. */
  email: string | null;
}

/** The host of a site, a Search Console property or a web address: lower case, no scheme, `sc-domain:`, credentials, port, path, query, trailing dot or `www.`. */
export function normalizeHost(s: string): string {
  let h = s.trim().toLowerCase().replace(/^sc-domain:/, "").replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split(/[/?#]/, 1)[0].replace(/^.*@/, "").replace(/:\d*$/, "").replace(/\.+$/, "");
  return h.replace(/^www\./, "");
}

/**
 * The one safety rule: a Google property belongs to a site only when its host EQUALS the site's host (both normalized: scheme, `www.`, port, path, query, `sc-domain:`, trailing dot and case
 * ignored). Never a parent domain and never a substring, so a stream on `com` or a franchisor's `brand.com` cannot be linked to another business's site. Two functions, one rule, and
 * nothing else decides: link time, find time and the daily pull's re-check all use these two.
 */
const sameHost = (a: string, b: string) => { const h = normalizeHost(a); return h !== "" && h === normalizeHost(b); };

/** A Search Console property (`sc-domain:` or a URL prefix), given as Google names it, is on the site's host. */
export const gscMatchesHost = (property: string, siteHost: string): boolean => sameHost(property, siteHost);

/** A web stream's host (what an Analytics property says it measures) is the site's host. */
export const ga4StreamMatchesHost = (streamHost: string, siteHost: string): boolean => sameHost(streamHost, siteHost);

const DOMAIN_PROPERTY = /^sc-domain:[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const PREFIX_PROPERTY = /^https?:\/\/[^\s/?#@]*[^\s/?#@.](\/[^\s?#]*)?$/i;
const GA4_ID = /^\d{5,15}$/;

/** The two forms Search Console names a property in. A trailing dot on the host is refused, in find and in link alike (Google never names one that way). */
const isSearchConsoleProperty = (p: string) => DOMAIN_PROPERTY.test(p) || PREFIX_PROPERTY.test(p);

/**
 * An Analytics property belongs to a site only when it has at least one web stream AND EVERY web stream is on the site's host. The Analytics report reads the whole property with no stream filter, so a property
 * that also measures another business (a franchisor's or an agency's shared one) would put that business's traffic into this client's report. Find, link and the daily pull's re-check all use this one rule.
 */
export const ga4OnlyMeasures = (hosts: string[], siteHost: string): boolean => hosts.length > 0 && hosts.every((h) => ga4StreamMatchesHost(h, siteHost));

/** The live site and its host (`""` when it has no domain), or SiteNotFound. */
async function liveSite(env: Env, siteId: string): Promise<{ site: Site; host: string }> {
  const site = await getSite(env.DB, siteId);
  if (!site || site.archivedAt) throw new SiteNotFound("not found");
  return { site, host: normalizeHost(site.domain ?? "") };
}

/** Linking and finding need the site's domain; unlinking does not (a site whose domain was removed must still be cleared). */
const needHost = (host: string) => { if (!host) throw new LinkRefused("Set the site's domain first."); };

/** A fresh Google token for reading Search Console and Analytics (GoogleNotConnected when Google is not connected). */
async function trafficAccess(env: Env, f: Fetch) {
  const { token, row } = await googleAccess(env, "", f);
  if (!hasTrafficScopes(row.scope)) throw new LinkRefused("Reconnect Google in Settings so it can read Search Console and Analytics.");
  return { token, email: row.email };
}

/** The Search Console entries and Analytics properties the connected account can see that belong to the site: nothing is linked here. */
export async function findCandidates(env: Env, siteId: string, f: Fetch = timedFetch): Promise<Candidates> {
  const { host } = await liveSite(env, siteId);
  needHost(host);
  const { token, email } = await trafficAccess(env, f);
  const [sites, props] = await Promise.all([listGscSites(f, token), listGa4Properties(f, token)]);
  const gsc = sites.filter((s) => gscMatchesHost(s.siteUrl, host) && isSearchConsoleProperty(s.siteUrl)).map((s) => ({ siteUrl: s.siteUrl, label: s.siteUrl.startsWith("sc-domain:") ? `${normalizeHost(s.siteUrl)} (the whole domain)` : s.siteUrl }));
  // A property that cannot be read (Google refused it) simply is not offered.
  const looked = props.slice(0, MAX_GA4_STREAM_LOOKUPS);
  const streams = await Promise.all(looked.map((p) =>
    ga4Hosts(f, token, p.id).catch((e) => { if (e instanceof GoogleApiError) return [] as string[]; throw e; })));
  return { gsc, ga4: looked.filter((_, i) => ga4OnlyMeasures(streams[i], host)), email };
}

/**
 * Links the site to Google properties that belong to it, or (with `null`) unlinks one source; a key that is left out is not touched. A property is refused unless its host is the site's
 * (equality after `normalizeHost`, for Search Console and Analytics alike), so one client's numbers can never reach another client's report. Search Console is checked by the property's
 * name alone; an Analytics id costs one call to read its streams. A Business Profile location (`locations/<digits>`) has no host to compare, so it is checked for its form only, and linking one needs
 * the Business Profile permission on the connection (clearing it needs nothing). A change is logged on the client's timeline.
 */
export async function linkSite(env: Env, siteId: string, p: { gscProperty?: string | null; ga4Property?: string | null; gbpLocation?: string | null }, now: Date, f: Fetch = timedFetch): Promise<SiteLink> {
  const { site, host } = await liveSite(env, siteId);
  const current = await getLink(env.DB, siteId);
  const { gscProperty, ga4Property, gbpLocation } = p;
  if (typeof gscProperty === "string" || typeof ga4Property === "string") needHost(host);
  if (typeof gscProperty === "string") {
    if (!gscMatchesHost(gscProperty, host)) throw new LinkRefused("That property is for another site.");
    if (!isSearchConsoleProperty(gscProperty)) throw new LinkRefused("That is not a Search Console property.");
  }
  if (typeof ga4Property === "string" && !GA4_ID.test(ga4Property)) throw new LinkRefused("That is not an Analytics property id.");
  if (typeof ga4Property === "string") {
    const { token } = await trafficAccess(env, f);
    const hosts = await ga4Hosts(f, token, ga4Property);
    if (hosts.length === 0 && current?.ga4Property !== ga4Property) throw new LinkRefused("That property has no website data stream.");
    if (hosts.length > 0 && !hosts.some((h) => ga4StreamMatchesHost(h, host))) throw new LinkRefused("That property is for another site.");
    if (hosts.length > 0 && !ga4OnlyMeasures(hosts, host)) throw new LinkRefused("That property also measures another site.");
  }
  if (typeof gbpLocation === "string") {
    if (!isGbpLocation(gbpLocation)) throw new LinkRefused("That is not a Business Profile location id. It looks like locations/1234567890.");
    if (!hasProfileScope((await getGoogleAuth(env.DB))?.scope)) throw new LinkRefused("Reconnect Google with the Business Profile permission.");
  }
  const gscChanged = gscProperty !== undefined && gscProperty !== (current?.gscProperty ?? null);
  const ga4Changed = ga4Property !== undefined && ga4Property !== (current?.ga4Property ?? null);
  const gbpChanged = gbpLocation !== undefined && gbpLocation !== (current?.gbpLocation ?? null);
  if (!gscChanged && !ga4Changed && !gbpChanged) {
    if (current) return current;
    throw new LinkRefused("Choose a Search Console or Analytics property to link.");
  }
  const link = await saveLink(env.DB, siteId, { gscProperty, ga4Property, gbpLocation }, now.toISOString());
  const said = [
    gscChanged && `Search Console ${gscProperty ? "linked" : "unlinked"}`,
    ga4Changed && `Analytics ${ga4Property ? "linked" : "unlinked"}`,
    gbpChanged && `Business Profile ${gbpLocation ? "linked" : "unlinked"}`,
  ].filter(Boolean).join(", ");
  await logActivity(env.DB, site.businessId, "traffic_linked", `${host || "site"}: ${said}`);
  return link;
}

/** Removes both links. The months already pulled stay. */
export async function unlinkSite(env: Env, siteId: string): Promise<void> {
  const { site, host } = await liveSite(env, siteId);
  if (!(await getLink(env.DB, siteId))) return;
  await deleteLink(env.DB, siteId);
  await logActivity(env.DB, site.businessId, "traffic_linked", `${host || "site"}: unlinked from Google`);
}
