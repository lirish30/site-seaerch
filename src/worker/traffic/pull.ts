import { monthRange } from "../care/reportFacts";
import { testClientSql } from "../clients/record";
import { getGoogleAuth } from "../db/google";
import { getSettings } from "../db/settings";
import { getSite } from "../db/sites";
import { getLink, getTrafficMonth, saveTrafficMonth, setLinkError, type SiteLink, type TrafficStatus } from "../db/traffic";
import type { Env } from "../env";
import { GoogleNotConnected, googleAccess } from "../google/access";
import { ga4Hosts, ga4Month } from "../google/analytics";
import { GoogleApiError, timedFetch } from "../google/api";
import { gbpMonth } from "../google/businessProfile";
import { hasProfileScope, hasTrafficScopes, TRAFFIC_SCOPES, type Fetch } from "../google/oauth";
import { gscMonth, gscTotals, type Range } from "../google/searchConsole";
import { localDay } from "../monitoring/rollup";
import { zoneOf } from "../sop/cadence";
import { previousMonth } from "../sop/months";
import { TrafficFacts, shapeProfile, shapeSearch, shapeVisits } from "./facts";
import { SiteNotFound, ga4OnlyMeasures, gscMatchesHost, normalizeHost } from "./link";
import { isGbpLocation } from "./location";
import { trafficProblem } from "./problem";

// The monthly pull of what Google measured for a site (Plan 16): Search Console, Analytics and (only for a site with a Business Profile location) Business Profile, read only, one month at a time, in Google's own month. The daily sweep pulls last month for every real client's
// linked site from the 4th (Google's numbers have settled by then); the report sweeps wait for it until the 7th. Nothing here sends or posts anything.

/** The first day of the month (booking zone) the sweep pulls last month: Search Console and Analytics have settled by then. */
export const PULL_FROM_DAY = 4;
/** A report waits for a month that has not been pulled yet until this day of the month; after it the report goes out without what Google never gave. */
export const REPORT_WAIT_UNTIL_DAY = 7;
/** A month is tried at most this many times for a site (one a day), and then given up on. */
export const MAX_PULL_ATTEMPTS = 5;
/** The most sites one daily run pulls; the rest are picked up by the next run. */
export const MAX_SITES_PER_RUN = 40;
/** The run starts no new site this long after it began (a scheduled run may last about 15 minutes, and the pulls are made one after another). */
export const TRAFFIC_WALL_MS = 4 * 60_000;
/** The clock the wall-time guard reads, so a test can move it. */
export const trafficClock = { now: (): number => Date.now() };

const NO_MATCH = "This property no longer matches the site's domain. Link it again.";
const NOTHING_LINKED = "Nothing is linked for this site.";
const NEEDS_SCOPES = "Reconnect Google in Settings so it can read Search Console and Analytics.";
const NEEDS_PROFILE_SCOPE = "Reconnect Google with the Business Profile permission.";
const BAD_LOCATION = "This Business Profile location id is not valid. Link it again.";

/** The traffic scopes were not granted: the same fix as a refused token. */
class ScopesMissing extends Error {}

/** The connection itself is dead (not connected, a refresh token Google refuses, a 401, the scopes not granted): trying more sites or the other source would fail the same way. */
const isDead = (e: unknown): boolean =>
  e instanceof GoogleNotConnected || e instanceof ScopesMissing || (e instanceof GoogleApiError && e.status === 401)
  || (e instanceof Error && e.message.startsWith("Google token error"));

/** The month before `period` (`YYYY-MM`) by period arithmetic: January rolls back to last year's December. */
const monthBefore = (period: string): string => {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/** Whether the link has a source the pull reads (Search Console, Analytics or a Business Profile location). */
const hasSource = (l: SiteLink | null): l is SiteLink => !!l && (l.gscProperty !== null || l.ga4Property !== null || l.gbpLocation !== null);

/** A fresh Google token, the connected account and the scopes it was granted, or the reason there is none (a sweep asks once and hands the answer to every site). Each source checks its own scope. */
type Access = { token: string; email: string | null; scope: string | null } | { failed: unknown };

/** A fresh token for reading Google, or what stopped it. */
async function resolveAccess(env: Env, f: Fetch): Promise<Access> {
  try {
    const a = await googleAccess(env, "", f);
    return { token: a.token, email: a.row.email, scope: a.row.scope };
  } catch (failed) {
    return { failed };
  }
}

interface Outcome { status: TrafficStatus; error: string; /** The connection is dead: the sweep stops. */ dead: boolean }

/**
 * Reads one month of a site from the Google properties linked to it and saves it. Before any Google call the link is checked again against the site's domain (a property that is not on the site's own host is never
 * read; Analytics costs one stream lookup; a Business Profile location has no host and is checked for its form). Each linked source is tried on its own: all read is `ok`, some `partial`, none `failed` (a source that is not
 * linked is null in the facts and does not make a month partial). A Business Profile location needs the Business Profile permission on the connection, and without it that source alone fails.
 * A later `failed` or `partial` pull never replaces an `ok` row, not even with `force` (a forced pull only replaces an `ok` row with another `ok` one), and (unless `force`) keeps, for each linked source this pull could not read, what an earlier `failed` or `partial` pull of the month already read:
 * the status is worked out from the merged facts. The link's error is set to this pull's plain sentence, or cleared. A site that is unknown or archived throws `SiteNotFound`.
 */
async function pull(env: Env, siteId: string, period: string, o: { now: Date; force?: boolean; f?: Fetch; access?: Access }): Promise<Outcome> {
  const f = o.f ?? timedFetch;
  const site = await getSite(env.DB, siteId);
  if (!site || site.archivedAt) throw new SiteNotFound("not found");
  const link = await getLink(env.DB, siteId);
  if (!hasSource(link)) return { status: "failed", error: NOTHING_LINKED, dead: false };
  const now = o.now.toISOString();
  const host = normalizeHost(site.domain ?? "");

  const tz = zoneOf(await getSettings(env.DB));
  const month = monthRange(period, tz);
  const monthBeforeRange = monthRange(monthBefore(period), tz);
  const cur: Range = { start: month.fromDay, end: month.toDay };
  const prev: Range = { start: monthBeforeRange.fromDay, end: monthBeforeRange.toDay };

  let search: TrafficFacts["search"] = null;
  let visits: TrafficFacts["visits"] = null;
  let profile: TrafficFacts["profile"] = null;
  const errors: string[] = [];
  const say = (sentence: string) => { if (!errors.includes(sentence)) errors.push(sentence); };
  let dead = false;
  const fail = (e: unknown, email: string | null, which?: "search" | "analytics" | "profile") => {
    dead ||= isDead(e);
    say(e instanceof ScopesMissing ? NEEDS_SCOPES : trafficProblem(e, { email, which }));
  };

  // Only a link that can pass the host check needs Google at all: a site with no domain, or a property of another host, makes no call.
  const gscLinked = link.gscProperty !== null;
  const ga4Linked = link.ga4Property !== null;
  const gscOk = gscLinked && gscMatchesHost(link.gscProperty!, host);
  const ga4Maybe = ga4Linked && host !== "";
  const gbpLinked = link.gbpLocation !== null;
  const gbpOk = gbpLinked && isGbpLocation(link.gbpLocation!);
  if ((gscLinked && !gscOk) || (ga4Linked && !ga4Maybe)) say(NO_MATCH);
  if (gbpLinked && !gbpOk) say(BAD_LOCATION);

  if (gscOk || ga4Maybe || gbpOk) {
    const access = o.access ?? await resolveAccess(env, f);
    if ("failed" in access) fail(access.failed, null);
    const token = "token" in access ? access.token : "";
    const email = "token" in access ? access.email : null;
    const scope = "token" in access ? access.scope : null;
    // Search Console and Analytics need the traffic scopes; without them neither is read and the connection counts as dead (the same fix as a refused token).
    if (token && (gscOk || ga4Maybe) && !hasTrafficScopes(scope)) fail(new ScopesMissing(NEEDS_SCOPES), email);
    if (token && gscOk && !dead) {
      try {
        const m = await gscMonth(f, token, link.gscProperty!, cur);
        search = shapeSearch(m, await gscTotals(f, token, link.gscProperty!, prev));
      } catch (e) { fail(e, email, "search"); }
    }
    if (token && ga4Maybe && !dead) {
      try {
        const streams = await ga4Hosts(f, token, link.ga4Property!);
        if (ga4OnlyMeasures(streams, host)) visits = shapeVisits(await ga4Month(f, token, link.ga4Property!, cur, prev));
        else say(NO_MATCH);
      } catch (e) { fail(e, email, "analytics"); }
    }
    // Business Profile is the one source with its own permission: without it only this source fails, the others are read as usual.
    if (token && gbpOk && !dead) {
      if (!hasProfileScope(scope)) say(NEEDS_PROFILE_SCOPE);
      else {
        try { profile = shapeProfile(await gbpMonth(f, token, link.gbpLocation!, cur, prev)); } catch (e) { fail(e, email, "profile"); }
      }
    }
  }

  // A retry keeps what an earlier try of the month read from a source this try could not read (a month that is `ok` is never merged: the save keeps it). A source that is no longer linked is null.
  const before = o.force ? null : await getTrafficMonth(env.DB, siteId, period);
  const kept = before && before.status !== "ok" ? TrafficFacts.safeParse(before.facts) : null;
  if (kept?.success) {
    if (gscLinked && !search) search = kept.data.search;
    if (ga4Linked && !visits) visits = kept.data.visits;
    if (gbpLinked && !profile) profile = kept.data.profile;
  }
  const read = (search ? 1 : 0) + (visits ? 1 : 0) + (profile ? 1 : 0);
  const status: TrafficStatus = read === 0 ? "failed" : read === (gscLinked ? 1 : 0) + (ga4Linked ? 1 : 0) + (gbpLinked ? 1 : 0) ? "ok" : "partial";
  const facts = TrafficFacts.parse({ version: 1, period, search, visits, profile });
  const error = errors.join(" ");
  await saveTrafficMonth(env.DB, { siteId, period, status, facts, error }, now);
  await setLinkError(env.DB, siteId, error, now);
  return { status, error, dead };
}

/** The pull of one site and month (see `pull`): what the pull made of it, which is not always what the row holds (an `ok` row is kept against a worse pull, forced or not). */
export async function pullMonth(env: Env, siteId: string, period: string, o: { now: Date; force?: boolean; f?: Fetch; access?: { token: string; email?: string | null; scope?: string | null } }): Promise<{ status: TrafficStatus; error: string }> {
  // A token handed in without its scopes is taken to carry the traffic scopes (the caller vouches for it) and not the Business Profile one.
  const { status, error } = await pull(env, siteId, period, { ...o, access: o.access && { token: o.access.token, email: o.access.email ?? null, scope: o.access.scope ?? TRAFFIC_SCOPES.join(" ") } });
  return { status, error };
}

/** The calendar day of the month `now` falls on in the booking zone. */
const dayOfMonth = (now: Date, tz: string): number => Number(localDay(now.toISOString(), tz).slice(8, 10));

/**
 * The real, live, linked sites of real clients (a billing hold does not matter: reading is free), as the SQL that is the same for the sweep and the wait: not archived, not a rehearsal site or client,
 * with a Search Console property, an Analytics property or a Business Profile location, and without a month for `?` (the period, bound first) that is done. `done` is the extra condition on a month row of that site.
 */
const readable = (done: string): string =>
  `FROM sites s JOIN site_analytics a ON a.site_id = s.id JOIN businesses b ON b.id = s.business_id
   LEFT JOIN traffic_months t ON t.site_id = s.id AND t.period = ?
   WHERE s.archived_at IS NULL AND s.test = 0 AND NOT ${testClientSql("b")} AND (a.gsc_property IS NOT NULL OR a.ga4_property IS NOT NULL OR a.gbp_location IS NOT NULL)
     AND (t.site_id IS NULL OR NOT (${done}))`;

/**
 * The daily pull: from the 4th (booking zone) it reads last month for the linked sites of real clients that have no `ok` month and fewer than `MAX_PULL_ATTEMPTS` attempts, the one tried longest ago first (a site never
 * tried comes first), at most `MAX_SITES_PER_RUN`. It starts no new site once `TRAFFIC_WALL_MS` have passed, and stops the whole run at the first dead connection (one call, not forty). A site that throws is a failed read of that site,
 * saved with a plain sentence. `skipped` counts the sites it was going to pull and did not touch. Sends nothing.
 */
export async function sweepTraffic(env: Env, now: Date, f: Fetch = timedFetch): Promise<{ pulled: number; failed: number; skipped: number }> {
  const out = { pulled: 0, failed: 0, skipped: 0 };
  const tz = zoneOf(await getSettings(env.DB));
  if (dayOfMonth(now, tz) < PULL_FROM_DAY) return out;
  const period = previousMonth(now, tz);
  const ids = (await env.DB.prepare(
    `SELECT s.id AS id ${readable("t.status = 'ok' OR t.attempts >= ?")} ORDER BY COALESCE(t.pulled_at, ''), s.created_at, s.rowid LIMIT ?`,
  ).bind(period, MAX_PULL_ATTEMPTS, MAX_SITES_PER_RUN).all<{ id: string }>()).results.map((r) => r.id);

  // One token for the whole run (and one check of the scopes): a dead connection then costs the first site that needs Google one failed row, and ends the run.
  const access = ids.length > 0 ? await resolveAccess(env, f) : undefined;
  const started = trafficClock.now();
  for (const [i, id] of ids.entries()) {
    if (trafficClock.now() - started > TRAFFIC_WALL_MS) { out.skipped = ids.length - i; break; }
    let r: Outcome;
    try {
      r = await pull(env, id, period, { now, f, access });
    } catch (e) {
      // A site archived since the list was read, or a fault in our own code: this site only.
      if (!(e instanceof SiteNotFound)) console.error("traffic pull failed", id, e);
      out.failed++;
      continue;
    }
    if (r.status === "failed") out.failed++; else out.pulled++;
    if (r.dead) { out.skipped = ids.length - i - 1; break; }
  }
  return out;
}

/**
 * True while a client's report should wait for Google's numbers of `period`: the client is real and has a live, real site with a Search Console property, an Analytics property or a Business Profile location whose month is neither `ok` nor `partial`
 * and has had fewer than `MAX_PULL_ATTEMPTS` tries, and it is before the `REPORT_WAIT_UNTIL_DAY`th (booking zone), and Google is connected with the traffic scopes (a connection that cannot pull is not waited for). A month never tried has no attempts. False for a rehearsal client.
 */
export async function trafficWait(env: Env, businessId: string, period: string, now: Date): Promise<boolean> {
  const tz = zoneOf(await getSettings(env.DB));
  if (dayOfMonth(now, tz) >= REPORT_WAIT_UNTIL_DAY) return false;
  // A dead connection cannot pull: waiting for the 7th would only delay the report.
  const auth = await getGoogleAuth(env.DB);
  if (!auth || !hasTrafficScopes(auth.scope)) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS x ${readable("t.status IN ('ok', 'partial') OR t.attempts >= ?")} AND s.business_id = ? LIMIT 1`,
  ).bind(period, MAX_PULL_ATTEMPTS, businessId).first();
  return !!row;
}

/** Whether a site has a source the pull reads: a route answers 409 for one that has not. */
export async function hasLinkedSource(env: Env, siteId: string): Promise<boolean> {
  return hasSource(await getLink(env.DB, siteId));
}
