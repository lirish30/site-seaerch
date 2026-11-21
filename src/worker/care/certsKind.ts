import { z } from "zod";
import { dayKey } from "../booking/slots";
import { closeIncident, monitoredSites, openIncident, setCertExpiry } from "../db/monitoring";
import { getSettings } from "../db/settings";
import type { Site } from "../db/sites";
import type { Env } from "../env";
import { registerHelperKind, type HelperKindDef } from "../helper/registry";
import { enqueueHelperJob } from "../helper/jobs";
import { domainDaysLeft, domainDetail } from "../monitoring/incidents";
import { monitorableUrl } from "../monitoring/probe";
import { zoneOf } from "../sop/cadence";

/** The Mac helper reads each monitored site's TLS certificate expiry (a Worker cannot), once a day. Read-only, nothing is sent anywhere. */
export const CARE_CERTS_KIND = "care.certs";

/** A certificate this close to expiring (or already past) gets an incident. */
export const CERT_WARN_DAYS = 14;
export const MAX_CERT_HOSTS = 500;

/** The same pattern the helper checks: a plain DNS name with a letter-only last label, so an IP literal never matches. */
export const CERT_HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export const CareCertsPayload = z.object({
  hosts: z.array(z.object({ siteId: z.string().min(1), host: z.string().regex(CERT_HOST).max(253) })).min(1).max(MAX_CERT_HOSTS),
});
export type CareCertsPayload = z.infer<typeof CareCertsPayload>;

export const CareCertsResult = z.object({
  certs: z.array(z.object({ siteId: z.string().min(1), validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() })).max(MAX_CERT_HOSTS),
});
export type CareCertsResult = z.infer<typeof CareCertsResult>;

/** "certificate expires in 9 days": the domain wording with the word swapped (the same sentence `incidentView` rebuilds). */
export const certDetail = (days: number): string => domainDetail(days).replace(/^domain/, "certificate");

/** The hostname to connect to for a site, or null: its address must be monitorable and its host a plain DNS name (never an IP literal). */
export function certHostOf(site: Pick<Site, "url">): string | null {
  const u = monitorableUrl(site.url);
  if (!u.ok) return null;
  try {
    const host = new URL(u.url).hostname.toLowerCase();
    return CERT_HOST.test(host) && !/\.(local|internal)$/.test(host) ? host : null;
  } catch { return null; }
}

/**
 * Queues the day's certificate read for the monitored sites (at most 500 hosts). One job a day: the dedupe key is the zone date, and a job already made today (finished or not) is not made again.
 */
export async function queueCertCheck(env: Env, now: Date): Promise<{ queued: boolean; hosts?: number }> {
  const hosts: { siteId: string; host: string }[] = [];
  for (const site of await monitoredSites(env.DB, MAX_CERT_HOSTS)) {
    const host = certHostOf(site);
    if (host) hosts.push({ siteId: site.id, host });
  }
  if (hosts.length === 0) return { queued: false };
  const dedupeKey = `${CARE_CERTS_KIND}:${dayKey(now.getTime(), zoneOf(await getSettings(env.DB)))}`;
  if (await env.DB.prepare(`SELECT 1 AS x FROM helper_jobs WHERE kind = ? AND dedupe_key = ? AND status IN ('pending','claimed','done') LIMIT 1`).bind(CARE_CERTS_KIND, dedupeKey).first()) return { queued: false };
  const { created } = await enqueueHelperJob(env.DB, CARE_CERTS_KIND, { hosts }, { dedupeKey });
  return created ? { queued: true, hosts: hosts.length } : { queued: false };
}

/**
 * Stores the certificate's expiry date and when it was read, then opens or closes the site's `cert_expiring` incident (zone dates, like the domain's).
 * `null` (the helper could not read it) stamps nothing and changes no incident.
 */
export async function recordCertExpiry(env: Env, site: Site, validTo: string | null, now: Date): Promise<void> {
  if (validTo === null) return;
  const nowIso = now.toISOString();
  await setCertExpiry(env.DB, site.id, validTo, nowIso);
  const days = domainDaysLeft(validTo, now, zoneOf(await getSettings(env.DB)));
  if (days > CERT_WARN_DAYS) { await closeIncident(env.DB, site.id, "cert_expiring", nowIso); return; }
  await openIncident(env.DB, { siteId: site.id, businessId: site.businessId, kind: "cert_expiring", detail: certDetail(days), now: nowIso });
}

const careCerts: HelperKindDef<CareCertsPayload, CareCertsResult> = {
  kind: CARE_CERTS_KIND,
  payload: CareCertsPayload,
  result: CareCertsResult,
  inputs: () => [],
  outputs: () => [],

  /** Only a site the payload asked about and that is still monitored is touched; anything else in the result is ignored. Safe to run again. */
  async apply(env: Env, p, r) {
    const asked = new Set(p.hosts.map((h) => h.siteId));
    const sites = new Map((await monitoredSites(env.DB, 5000)).map((s) => [s.id, s]));
    const now = new Date();
    for (const c of r.certs) {
      const site = sites.get(c.siteId);
      if (!asked.has(c.siteId) || !site) continue;
      await recordCertExpiry(env, site, c.validTo, now);
    }
  },
};
registerHelperKind(careCerts);
