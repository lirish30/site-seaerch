import { dayKey } from "../booking/slots";
import { logActivity } from "../db/activity";
import { closeIncident, insertCheck, openIncident, recentChecks, setDomainExpiry } from "../db/monitoring";
import { getSettings } from "../db/settings";
import type { Site } from "../db/sites";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { ERROR_TEXT, type ProbeResult } from "./probe";

// The Care incident engine: turns probe results and domain expiry dates into incidents and timeline lines.
// It sends nothing to anyone and creates no task or approval; a person looks at the incident list and the activity line.
//
// Every detail written here is either a value of ProbeResult.error (null, `HTTP <n>` or ERROR_TEXT, which the probe restricts) or one of the
// fixed sentences below. Nothing a client's site or the registry sent back is ever stored in an incident or an activity line.

/** This many checks in a row (the newest one included) must fail before a site counts as down: one blip is not an outage. */
export const DOWN_AFTER = 2;
/** A domain this close to expiring (or already past) gets an incident. */
export const DOMAIN_WARN_DAYS = 30;

export interface Transition { opened: boolean; closed: boolean }

const NONE: Transition = { opened: false, closed: false };

/**
 * Stores the check, then opens or closes the site's `down` incident.
 * Opens when the last DOWN_AFTER checks all failed; closes on an ok check. Opening twice or closing with nothing open does nothing
 * (the unique index and the single-statement close decide who wins), and only the call that really changed the incident logs a line.
 */
export async function recordProbe(env: Env, site: Site, r: ProbeResult, now: Date): Promise<Transition> {
  const db = env.DB;
  const nowIso = now.toISOString();
  await insertCheck(db, { siteId: site.id, checkedAt: nowIso, ok: r.ok, status: r.status, ms: r.ms, error: r.error });

  if (r.ok) {
    const closed = await closeIncident(db, site.id, "down", nowIso);
    if (!closed) return NONE;
    const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(closed.openedAt)) / 60_000));
    await logActivity(db, site.businessId, "site_back", `back after ${minutes} min`);
    return { opened: false, closed: true };
  }

  const last = await recentChecks(db, site.id, DOWN_AFTER);
  if (last.length < DOWN_AFTER || last.some((c) => c.ok)) return NONE;
  const detail = r.error ?? ERROR_TEXT.connect;
  const { created } = await openIncident(db, { siteId: site.id, businessId: site.businessId, kind: "down", detail, now: nowIso });
  if (!created) return NONE;
  await logActivity(db, site.businessId, "site_down", detail);
  return { opened: true, closed: false };
}

/** Whole calendar days from today's date in `zone` to `expiresOn` (YYYY-MM-DD); negative once it is past. Never counted on UTC dates. */
export function domainDaysLeft(expiresOn: string, now: Date, zone: string): number {
  const toDay = (key: string) => { const [y, m, d] = key.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
  return Math.round(toDay(expiresOn) - toDay(dayKey(now.getTime(), zone)));
}

/** The one sentence for a domain incident: the same words the incident is opened with. */
export const domainDetail = (days: number): string =>
  days < 0 ? `domain expired ${-days} ${-days === 1 ? "day" : "days"} ago`
  : days === 0 ? "domain expires today"
  : `domain expires in ${days} ${days === 1 ? "day" : "days"}`;

/**
 * Stores the domain's expiry date and when it was looked up, then opens or closes the site's `domain_expiring` incident.
 * `null` (the registry could not be read) stores only the check time: the last known date stays and no incident changes.
 */
export async function recordDomainExpiry(env: Env, site: Site, expiresOn: string | null, now: Date): Promise<Transition> {
  const db = env.DB;
  const nowIso = now.toISOString();
  if (expiresOn === null) {
    await db.prepare(`UPDATE sites SET domain_checked_at = ? WHERE id = ?`).bind(nowIso, site.id).run();
    return NONE;
  }
  await setDomainExpiry(db, site.id, expiresOn, nowIso);

  const days = domainDaysLeft(expiresOn, now, zoneOf(await getSettings(db)));
  if (days > DOMAIN_WARN_DAYS) {
    return (await closeIncident(db, site.id, "domain_expiring", nowIso)) ? { opened: false, closed: true } : NONE;
  }
  const detail = domainDetail(days);
  const { created } = await openIncident(db, { siteId: site.id, businessId: site.businessId, kind: "domain_expiring", detail, now: nowIso });
  if (!created) return NONE;
  await logActivity(db, site.businessId, "domain_expiring", detail);
  return { opened: true, closed: false };
}
