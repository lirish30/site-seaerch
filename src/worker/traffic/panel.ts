import { isClient } from "../clients/record";
import { getGoogleAuth } from "../db/google";
import { getSettings } from "../db/settings";
import { listSites } from "../db/sites";
import { getLink, getTrafficMonth, type TrafficStatus } from "../db/traffic";
import type { Env } from "../env";
import { hasTrafficScopes } from "../google/oauth";
import { zoneOf } from "../sop/cadence";
import { previousMonth } from "../sop/months";
import { TrafficFacts } from "./facts";

/** How many finished months the owner's Traffic panel lists for a site. */
export const PANEL_MONTHS = 6;

export interface PanelMonth {
  period: string; status: TrafficStatus; pulledAt: string;
  /** The plain sentence for why the month was not read in full; empty for an `ok` month (an `ok` month can carry an old sentence from a merged retry, which says nothing now). */
  error: string;
  search: { clicks: number; impressions: number } | null;
  visits: { sessions: number } | null;
}

export interface PanelSite {
  siteId: string; domain: string | null;
  /** The Google properties linked to the site, as Google names them; the owner sees them as they are (they are not secrets). */
  gscProperty: string | null; ga4Property: string | null;
  lastError: string;
  /** The last six finished months that were pulled, newest first. */
  months: PanelMonth[];
}

export interface ClientTraffic {
  connected: boolean;
  /** Both traffic scopes were granted. */
  hasScopes: boolean;
  /** The connected Google account, so the owner knows whose access to ask the client for. */
  email: string | null;
  sites: PanelSite[];
}

/** The `n` finished months before `now` (booking zone), newest first. */
function lastMonths(now: Date, tz: string, n: number): string[] {
  const out: string[] = [];
  let at = now;
  for (let i = 0; i < n; i++) {
    const p = previousMonth(at, tz);
    out.push(p);
    // Step into the middle of that month so the next step back cannot skip or repeat one.
    const [y, m] = p.split("-").map(Number);
    at = new Date(Date.UTC(y, m - 1, 15, 12));
  }
  return out;
}

/**
 * What the owner's Traffic panel on a client's page shows: the Google connection, and for each live site its linked properties and the last six finished months that were pulled. Field by field:
 * never a token, the stored facts beyond the two headline numbers, or what Google said. Null when the id is not a client.
 */
export async function clientTraffic(env: Env, businessId: string, now: Date): Promise<ClientTraffic | null> {
  if (!(await isClient(env.DB, businessId))) return null;
  const tz = zoneOf(await getSettings(env.DB));
  const periods = lastMonths(now, tz, PANEL_MONTHS);
  const auth = await getGoogleAuth(env.DB);
  const sites = await Promise.all((await listSites(env.DB, { businessId })).map(async (site): Promise<PanelSite> => {
    const link = await getLink(env.DB, site.id);
    const months: PanelMonth[] = [];
    for (const row of await Promise.all(periods.map((p) => getTrafficMonth(env.DB, site.id, p)))) {
      if (!row) continue;
      const facts = TrafficFacts.safeParse(row.facts);
      months.push({
        period: row.period, status: row.status, pulledAt: row.pulledAt, error: row.status === "ok" ? "" : row.error,
        search: facts.success && facts.data.search ? { clicks: facts.data.search.clicks, impressions: facts.data.search.impressions } : null,
        visits: facts.success && facts.data.visits ? { sessions: facts.data.visits.sessions } : null,
      });
    }
    return { siteId: site.id, domain: site.domain, gscProperty: link?.gscProperty ?? null, ga4Property: link?.ga4Property ?? null, lastError: link?.lastError ?? "", months };
  }));
  return { connected: !!auth, hasScopes: !!auth && hasTrafficScopes(auth.scope), email: auth?.email ?? null, sites };
}
