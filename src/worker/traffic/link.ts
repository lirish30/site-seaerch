import { logActivity } from "../db/activity";
import { getSite, type Site } from "../db/sites";
import { deleteLink, getLink, saveLink, type SiteLink } from "../db/traffic";
import type { Env } from "../env";
import { GoogleApiError } from "../google/api";
import { googleAccess } from "../google/access";
import { ga4Hosts, listGa4Properties } from "../google/analytics";
import { hasTrafficScopes, type Fetch } from "../google/oauth";
import { listGscSites } from "../google/searchConsole";

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

/** A property's host covers a site's host when they are equal or, for a whole-domain property, the site is a subdomain of it. Never a substring match. */
const covers = (propHost: string, siteHost: string, wholeDomain: boolean) =>
  propHost !== "" && (propHost === siteHost || (wholeDomain && siteHost.endsWith(`.${propHost}`)));

const DOMAIN_PROPERTY = /^sc-domain:[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const PREFIX_PROPERTY = /^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i;
const GA4_ID = /^\d{5,15}$/;

const isSearchConsoleProperty = (p: string) => DOMAIN_PROPERTY.test(p) || PREFIX_PROPERTY.test(p);
const gscCovers = (p: string, siteHost: string) => covers(normalizeHost(p), siteHost, p.toLowerCase().startsWith("sc-domain:"));
const streamsCover = (hosts: string[], siteHost: string) => hosts.some((h) => covers(normalizeHost(h), siteHost, true));

/** The live site and its host, or the refusal to say. */
async function liveSite(env: Env, siteId: string): Promise<{ site: Site; host: string }> {
  const site = await getSite(env.DB, siteId);
  if (!site || site.archivedAt) throw new SiteNotFound("not found");
  const host = normalizeHost(site.domain ?? "");
  if (!host) throw new LinkRefused("Set the site's domain first.");
  return { site, host };
}

/** A fresh Google token for reading Search Console and Analytics (GoogleNotConnected when Google is not connected). */
async function trafficAccess(env: Env, f: Fetch) {
  const { token, row } = await googleAccess(env, "", f);
  if (!hasTrafficScopes(row.scope)) throw new LinkRefused("Reconnect Google in Settings so it can read Search Console and Analytics.");
  return { token, email: row.email };
}

/** The Search Console entries and Analytics properties the connected account can see that belong to the site: nothing is linked here. */
export async function findCandidates(env: Env, siteId: string, f: Fetch = fetch): Promise<Candidates> {
  const { host } = await liveSite(env, siteId);
  const { token, email } = await trafficAccess(env, f);
  const [sites, props] = await Promise.all([listGscSites(f, token), listGa4Properties(f, token)]);
  const gsc = sites.filter((s) => gscCovers(s.siteUrl, host)).map((s) => ({ siteUrl: s.siteUrl, label: s.siteUrl.startsWith("sc-domain:") ? `${normalizeHost(s.siteUrl)} (the whole domain)` : s.siteUrl }));
  // A property that cannot be read (Google refused it) simply is not offered.
  const looked = props.slice(0, MAX_GA4_STREAM_LOOKUPS);
  const streams = await Promise.all(looked.map((p) =>
    ga4Hosts(f, token, p.id).catch((e) => { if (e instanceof GoogleApiError) return [] as string[]; throw e; })));
  return { gsc, ga4: looked.filter((_, i) => streamsCover(streams[i], host)), email };
}

/**
 * Links the site to Google properties that belong to it, or (with `null`) unlinks one source; a key that is left out is not touched. A property is refused unless its host is the site's
 * (or, for a whole domain or an Analytics stream, a domain the site is on), so one client's numbers can never reach another client's report. Search Console is checked by the property's
 * name alone; an Analytics id costs one call to read its streams. A change is logged on the client's timeline.
 */
export async function linkSite(env: Env, siteId: string, p: { gscProperty?: string | null; ga4Property?: string | null }, now: Date, f: Fetch = fetch): Promise<SiteLink> {
  const { site, host } = await liveSite(env, siteId);
  const current = await getLink(env.DB, siteId);
  const { gscProperty, ga4Property } = p;
  if (typeof gscProperty === "string") {
    if (!isSearchConsoleProperty(gscProperty)) throw new LinkRefused("That is not a Search Console property.");
    if (!gscCovers(gscProperty, host)) throw new LinkRefused("That property is for another site.");
  }
  if (typeof ga4Property === "string" && !GA4_ID.test(ga4Property)) throw new LinkRefused("That is not an Analytics property id.");
  if (typeof ga4Property === "string") {
    const { token } = await trafficAccess(env, f);
    const hosts = await ga4Hosts(f, token, ga4Property);
    if (hosts.length === 0 && current?.ga4Property !== ga4Property) throw new LinkRefused("That property has no website data stream.");
    if (hosts.length > 0 && !streamsCover(hosts, host)) throw new LinkRefused("That property is for another site.");
  }
  const gscChanged = gscProperty !== undefined && gscProperty !== (current?.gscProperty ?? null);
  const ga4Changed = ga4Property !== undefined && ga4Property !== (current?.ga4Property ?? null);
  if (!gscChanged && !ga4Changed) {
    if (current) return current;
    throw new LinkRefused("Choose a Search Console or Analytics property to link.");
  }
  const link = await saveLink(env.DB, siteId, { gscProperty, ga4Property }, now.toISOString());
  const said = [
    gscChanged && `Search Console ${gscProperty ? "linked" : "unlinked"}`,
    ga4Changed && `Analytics ${ga4Property ? "linked" : "unlinked"}`,
  ].filter(Boolean).join(", ");
  await logActivity(env.DB, site.businessId, "traffic_linked", `${host}: ${said}`);
  return link;
}

/** Removes both links. The months already pulled stay. */
export async function unlinkSite(env: Env, siteId: string): Promise<void> {
  const { site, host } = await liveSite(env, siteId);
  if (!(await getLink(env.DB, siteId))) return;
  await deleteLink(env.DB, siteId);
  await logActivity(env.DB, site.businessId, "traffic_linked", `${host}: unlinked from Google`);
}
