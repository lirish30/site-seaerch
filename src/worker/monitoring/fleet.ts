import { computeHealth, type Health } from "../clients/health";
import { healthInputs, UPTIME_DAYS } from "../clients/healthData";
import { careLabel, clientMrrCents, LIVE, testClientSql } from "../clients/record";
import { chunks } from "../db/chunks";
import { CARE_SUBSCRIPTION_SQL, monitoredSiteSql, openIncidentsFor, type Incident, type IncidentKind } from "../db/monitoring";
import { getSettings } from "../db/settings";
import { toSite, type Site, type SiteRow } from "../db/sites";
import { listSubscriptions, type Subscription } from "../db/subscriptions";
import { zoneOf } from "../sop/cadence";
import { UPDATE_DETAIL } from "../care/incidents";
import { domainDaysLeft, domainDetail } from "./incidents";
import { ERROR_TEXT, monitorableUrl, SLOW_MS } from "./probe";

// The Care fleet: what the owner's Care board, the client record and (later) the MCP tools show about monitoring.
// Read only. Nothing remote reaches a view beyond a status code and the fixed phrases (`ERROR_TEXT`, `HTTP <n>`, the domain sentences),
// and a site's address is never returned, only its domain. Every client's score comes from `healthInputs` + `computeHealth`, as everywhere else.

export interface SiteMonitoringView {
  siteId: string;
  domain: string | null;
  /** The probe checks this site: the rule `monitoredSiteSql` states in SQL (live, real, with an address, and switched on by hand or the client has live Care). */
  monitored: boolean;
  /** The address passes `monitorableUrl`, so switching it on can work. */
  monitorable: boolean;
  /** The newest check was ok; null when the site has never been checked. */
  up: boolean | null;
  /** The newest check was ok but took longer than SLOW_MS. */
  slow: boolean;
  lastCheckedAt: string | null;
  /** Percent of checks that were ok over the last 30 days, to one decimal; null with no checks. */
  uptime30: number | null;
  checks30: number;
  domainExpiresOn: string | null;
}

export interface IncidentView { id: string; siteId: string; domain: string | null; kind: IncidentKind; openedAt: string; closedAt: string | null; detail: string }

export interface CareRow {
  businessId: string;
  name: string;
  careLabel: string | null;
  mrrCents: number;
  health: Health;
  /** The client's uptime over 30 days, pooled over its sites (the figure its score uses); null with no checks. */
  uptime30: number | null;
  sites: SiteMonitoringView[];
  openIncidents: IncidentView[];
}

/** Ids per chunk, as in `healthData.ts`. */
const CHUNK = 50;
const marks = (xs: unknown[]) => xs.map(() => "?").join(",");
const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** A site the board may show: live, real, with an address. */
const BOARD_SITE = `s.archived_at IS NULL AND s.test = 0 AND s.url IS NOT NULL AND s.url <> ''`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Incidents

const HTTP_DETAIL = /^HTTP [1-5]\d\d$/;
/** A stored probe error as it may be shown: null stays null, `HTTP nnn` and the fixed `ERROR_TEXT` phrases pass, anything else becomes "could not connect". Nothing a remote site said gets through. */
export function safeProbeError(raw: string | null): string | null {
  if (raw === null) return null;
  return HTTP_DETAIL.test(raw) || (Object.values(ERROR_TEXT) as string[]).includes(raw) ? raw : ERROR_TEXT.connect;
}

const DOMAIN_DETAIL = /^domain (expires today|expires in \d+ days?|expired \d+ days? ago)$/;
const CERT_DETAIL = /^certificate (expires today|expires in \d+ days?|expired \d+ days? ago)$/;
/** "certificate expires in 12 days": the domain wording with the word swapped. */
const certDetail = (days: number): string => domainDetail(days).replace(/^domain/, "certificate");

/**
 * An incident as the owner reads it. A domain incident's stored sentence is frozen when it opens and goes stale, so it is worded again from the site's expiry date and today's date in `zone`
 * ("domain expires in 12 days", "domain expires today", "domain expired 3 days ago") while it is open; a closed one is the fixed phrase "domain expiry warning". With no known date the stored sentence stays, but only if it is one of those. A down incident shows
 * its stored detail, which is only ever `HTTP <n>` or a phrase of `ERROR_TEXT`: anything else is replaced, so nothing a remote site said can get through.
 */
export function incidentView(incident: Incident, site: (Pick<Site, "domain" | "domainExpiresOn"> & { certExpiresOn?: string | null }) | null, now: Date, zone: string): IncidentView {
  let detail: string;
  if (incident.kind === "domain_expiring" && incident.closedAt !== null) {
    // A closed warning says nothing about today: the date has usually been renewed since, so no number is computed and the stored text is not shown.
    detail = "domain expiry warning";
  } else if (incident.kind === "domain_expiring") {
    detail = site?.domainExpiresOn ? domainDetail(domainDaysLeft(site.domainExpiresOn, now, zone)) : DOMAIN_DETAIL.test(incident.detail) ? incident.detail : "domain expiring";
  } else if (incident.kind === "cert_expiring") {
    // Worded like a domain warning: from the certificate's date while open, a fixed phrase once closed, and a stored sentence only when it is one of the fixed ones.
    if (incident.closedAt !== null) detail = "certificate expiry warning";
    else if (site?.certExpiresOn) detail = certDetail(domainDaysLeft(site.certExpiresOn, now, zone));
    else detail = CERT_DETAIL.test(incident.detail) ? incident.detail : "certificate expiring";
  } else if (incident.kind === "update_failed") {
    // The stored sentence is built from a validated slug list, page path and backup file name; a closed one says nothing about today.
    detail = incident.closedAt === null && UPDATE_DETAIL.test(incident.detail) ? incident.detail : "update failed";
  } else {
    detail = safeProbeError(incident.detail)!;
  }
  return { id: incident.id, siteId: incident.siteId, domain: site?.domain ?? null, kind: incident.kind, openedAt: incident.openedAt, closedAt: incident.closedAt, detail };
}

/** The incidents as views, newest first as given. An incident whose site is gone or archived is left out (an archived site is gone as far as the owner's screens go). */
export async function incidentViews(db: D1Database, incidents: Incident[], now: Date): Promise<IncidentView[]> {
  if (incidents.length === 0) return [];
  const zone = zoneOf(await getSettings(db));
  const sites = new Map<string, Site>();
  for (const part of chunks([...new Set(incidents.map((i) => i.siteId))], CHUNK)) {
    const rows = (await db.prepare(`SELECT * FROM sites WHERE id IN (${marks(part)}) AND archived_at IS NULL`).bind(...part).all<SiteRow>()).results;
    for (const r of rows) sites.set(r.id, toSite(r));
  }
  return incidents.filter((i) => sites.has(i.siteId)).map((i) => incidentView(i, sites.get(i.siteId)!, now, zone));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Sites

interface Stat { id: string; last_ok: number | null; last_at: string | null; last_ms: number | null; n: number; ok: number }

/**
 * The monitoring view of each site, in the order given. `careIds` holds the businesses with a live Care subscription (a site of one of them is monitored without its own switch).
 * Two reads per 50 sites: each site's newest check and its 30-day counts come from one query.
 */
export async function monitoringViews(db: D1Database, sites: Site[], careIds: ReadonlySet<string>, now: Date): Promise<SiteMonitoringView[]> {
  const since = new Date(now.getTime() - UPTIME_DAYS * DAY).toISOString();
  const stats = new Map<string, Stat>();
  for (const part of chunks(sites.map((s) => s.id), CHUNK)) {
    const rows = (await db.prepare(
      `SELECT s.id AS id, l.ok AS last_ok, l.checked_at AS last_at, l.ms AS last_ms,
         (SELECT COUNT(*) FROM site_checks c WHERE c.site_id = s.id AND c.checked_at >= ?) AS n,
         (SELECT COALESCE(SUM(c.ok), 0) FROM site_checks c WHERE c.site_id = s.id AND c.checked_at >= ?) AS ok
       FROM sites s
       LEFT JOIN site_checks l ON l.rowid = (SELECT c.rowid FROM site_checks c WHERE c.site_id = s.id ORDER BY c.checked_at DESC, c.rowid DESC LIMIT 1)
       WHERE s.id IN (${marks(part)})`,
    ).bind(since, since, ...part).all<Stat>()).results;
    for (const r of rows) stats.set(r.id, r);
  }
  return sites.map((site) => {
    const s = stats.get(site.id);
    const up = s?.last_ok == null ? null : s.last_ok === 1;
    const n = s?.n ?? 0;
    return {
      siteId: site.id,
      domain: site.domain,
      monitored: !site.archivedAt && !site.test && !!site.url && (site.monitoring || careIds.has(site.businessId)),
      monitorable: monitorableUrl(site.url).ok,
      up,
      slow: up === true && s!.last_ms !== null && s!.last_ms > SLOW_MS,
      lastCheckedAt: s?.last_at ?? null,
      uptime30: n === 0 ? null : round1((s!.ok * 100) / n),
      checks30: n,
      domainExpiresOn: site.domainExpiresOn,
    };
  });
}

/** Which of these businesses have a live Care subscription (the same rule `monitoredSites` and `careLabel` use). */
export async function careClientIds(db: D1Database, businessIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks(businessIds, CHUNK)) {
    const rows = (await db.prepare(`SELECT b.id AS id FROM businesses b WHERE b.id IN (${marks(part)}) AND ${CARE_SUBSCRIPTION_SQL("b")}`).bind(...part).all<{ id: string }>()).results;
    for (const r of rows) out.add(r.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The fleet

/**
 * The Care board: real clients with a live Care subscription, or with a site switched on by hand, worst health first and ties by name. Test clients, test sites, archived sites and
 * sites with no address are never on it. A bounded number of reads however many clients there are: one for the clients, one for the live subscriptions, then per 50 clients the
 * sites, their checks, their open incidents and the health inputs.
 */
export async function careFleet(db: D1Database, now: Date): Promise<CareRow[]> {
  const [clients, live] = await Promise.all([
    db.prepare(
      `SELECT b.id AS id, b.name AS name, ${CARE_SUBSCRIPTION_SQL("b")} AS care FROM businesses b
       WHERE NOT ${testClientSql("b")}
         AND (${CARE_SUBSCRIPTION_SQL("b")}
           OR EXISTS (SELECT 1 FROM sites s WHERE s.business_id = b.id AND ${monitoredSiteSql("s", "b")}))`,
    ).all<{ id: string; name: string; care: number }>(),
    listSubscriptions(db, { statuses: [...LIVE] }),
  ]);
  if (clients.results.length === 0) return [];
  const ids = clients.results.map((r) => r.id);
  const careIds = new Set(clients.results.filter((r) => r.care === 1).map((r) => r.id));
  const subs = new Map<string, Subscription[]>();
  for (const s of live) (subs.get(s.businessId) ?? subs.set(s.businessId, []).get(s.businessId)!).push(s);

  const [settings, health] = await Promise.all([getSettings(db), healthInputs(db, ids, now)]);
  const zone = zoneOf(settings);

  const sitesOf = new Map<string, Site[]>();
  const openOf = new Map<string, Incident[]>();
  for (const part of chunks(ids, CHUNK)) {
    const [sites, incidents] = await Promise.all([
      db.prepare(`SELECT s.* FROM sites s WHERE s.business_id IN (${marks(part)}) AND ${BOARD_SITE} ORDER BY s.created_at, s.rowid`).bind(...part).all<SiteRow>(),
      openIncidentsFor(db, part),
    ]);
    for (const r of sites.results) (sitesOf.get(r.business_id) ?? sitesOf.set(r.business_id, []).get(r.business_id)!).push(toSite(r));
    for (const i of incidents) (openOf.get(i.businessId) ?? openOf.set(i.businessId, []).get(i.businessId)!).push(i);
  }
  const allSites = ids.flatMap((id) => sitesOf.get(id) ?? []);
  const views = new Map((await monitoringViews(db, allSites, careIds, now)).map((v) => [v.siteId, v]));

  const rows = clients.results.map((r): CareRow => {
    const sites = sitesOf.get(r.id) ?? [];
    const byId = new Map(sites.map((s) => [s.id, s]));
    const input = health.get(r.id)!;
    const mine = subs.get(r.id) ?? [];
    return {
      businessId: r.id, name: r.name, careLabel: careLabel(mine), mrrCents: clientMrrCents(mine), health: computeHealth(input), uptime30: input.uptime30,
      sites: sites.map((s) => views.get(s.id)!),
      openIncidents: (openOf.get(r.id) ?? []).filter((i) => byId.has(i.siteId)).map((i) => incidentView(i, byId.get(i.siteId)!, now, zone)),
    };
  });
  return rows.sort((a, b) =>
    a.health.score - b.health.score || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.businessId < b.businessId ? -1 : 1));
}
