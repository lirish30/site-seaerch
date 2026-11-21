import { chunks } from "../db/chunks";
import { heldBusinessIds } from "../db/holds";
import { listItemsFor, listOpenOnboardingsFor } from "../db/onboardings";
import { getSettings } from "../db/settings";
import { toSite, type AccessStatus, type SiteRow } from "../db/sites";
import { domainDaysLeft } from "../monitoring/incidents";
import { isWaitingOnClient } from "../onboarding/schedule";
import { zoneOf } from "../sop/cadence";
import { unresolved } from "../sites/access";
import { computeHealth, type Health, type HealthInput } from "./health";
import { isOverdue, isOwed, testClientSql, todayKey } from "./record";

// Gathers what `computeHealth` needs for a set of clients, reading in bulk: a handful of queries per chunk of 50 ids, however many clients there are.
// Read only. Test clients, test sites and archived sites are never counted (a client with no live real site has no checks, no domain and no access items to count).

const DAY = 86_400_000;
/** The uptime window. */
export const UPTIME_DAYS = 30;
/** Ids per chunk: well under D1's bound-parameter cap, as in Today. */
const CHUNK = 50;

const marks = (xs: unknown[]) => xs.map(() => "?").join(",");

/** What a client with nothing recorded looks like: no checks (so no uptime, which is unknown and never 0 or 100), nothing overdue, nothing missing. */
const empty = (): HealthInput => ({
  openDown: false, domainDaysLeft: null, uptime30: null, checks30: 0, overdueInvoices: 0, held: false, pastDueSubscription: false, accessUnresolved: 0, waitingOnClient: false,
});

/** The live, real sites of real clients among the ids: not archived, not a test site, not a test client. */
const LIVE_SITES = `s.archived_at IS NULL AND s.test = 0 AND NOT ${testClientSql("b")}`;

/** One entry per id asked for, in the order given. `now` decides the 30-day window, how many days a domain has left and which invoices are overdue (booking time zone). */
export async function healthInputs(db: D1Database, businessIds: string[], now: Date): Promise<Map<string, HealthInput>> {
  const out = new Map<string, HealthInput>();
  for (const id of businessIds) out.set(id, empty());
  const ids = [...out.keys()];
  if (ids.length === 0) return out;

  const settings = await getSettings(db);
  const zone = zoneOf(settings), today = todayKey(settings, now);
  const since = new Date(now.getTime() - UPTIME_DAYS * DAY).toISOString();
  const at = (id: string) => out.get(id)!;

  for (const part of chunks(ids, CHUNK)) {
    const inList = marks(part);
    const [sites, checks, down, access, invoices, held, pastDue, onboardings] = await Promise.all([
      db.prepare(`SELECT s.* FROM sites s JOIN businesses b ON b.id = s.business_id WHERE s.business_id IN (${inList}) AND ${LIVE_SITES}`).bind(...part).all<SiteRow>(),
      db.prepare(
        `SELECT s.business_id AS business_id, COUNT(*) AS n, COALESCE(SUM(c.ok), 0) AS ok
         FROM site_checks c JOIN sites s ON s.id = c.site_id JOIN businesses b ON b.id = s.business_id
         WHERE s.business_id IN (${inList}) AND ${LIVE_SITES} AND c.checked_at >= ? GROUP BY s.business_id`,
      ).bind(...part, since).all<{ business_id: string; n: number; ok: number }>(),
      db.prepare(
        `SELECT DISTINCT s.business_id AS business_id FROM site_incidents i JOIN sites s ON s.id = i.site_id JOIN businesses b ON b.id = s.business_id
         WHERE s.business_id IN (${inList}) AND ${LIVE_SITES} AND i.kind = 'down' AND i.closed_at IS NULL`,
      ).bind(...part).all<{ business_id: string }>(),
      db.prepare(
        `SELECT s.business_id AS business_id, a.status AS status FROM site_access_items a JOIN sites s ON s.id = a.site_id JOIN businesses b ON b.id = s.business_id
         WHERE s.business_id IN (${inList}) AND ${LIVE_SITES}`,
      ).bind(...part).all<{ business_id: string; status: AccessStatus }>(),
      db.prepare(`SELECT business_id, test, status, due_on FROM invoices WHERE business_id IN (${inList}) AND status IN ('open', 'failed')`)
        .bind(...part).all<{ business_id: string; test: number; status: string; due_on: string | null }>(),
      heldBusinessIds(db, part),
      db.prepare(`SELECT DISTINCT business_id FROM subscriptions WHERE business_id IN (${inList}) AND test = 0 AND status = 'past_due'`).bind(...part).all<{ business_id: string }>(),
      listOpenOnboardingsFor(db, part),
    ]);

    for (const r of sites.results) {
      const site = toSite(r);
      if (site.domainExpiresOn === null) continue;
      const days = domainDaysLeft(site.domainExpiresOn, now, zone), i = at(site.businessId);
      if (i.domainDaysLeft === null || days < i.domainDaysLeft) i.domainDaysLeft = days;
    }
    for (const r of checks.results) {
      const i = at(r.business_id);
      i.checks30 = r.n;
      i.uptime30 = r.n === 0 ? null : Math.round(((r.ok * 100) / r.n) * 10) / 10;
    }
    for (const r of down.results) at(r.business_id).openDown = true;
    const byBusiness = new Map<string, { status: AccessStatus }[]>();
    for (const r of access.results) (byBusiness.get(r.business_id) ?? byBusiness.set(r.business_id, []).get(r.business_id)!).push({ status: r.status });
    for (const [id, items] of byBusiness) at(id).accessUnresolved = unresolved(items).length;
    for (const r of invoices.results) {
      if (isOwed({ test: !!r.test, status: r.status }) && isOverdue({ dueOn: r.due_on }, today)) at(r.business_id).overdueInvoices += 1;
    }
    for (const id of held) at(id).held = true;
    for (const r of pastDue.results) at(r.business_id).pastDueSubscription = true;

    // Waiting on the client: the test Today uses for "back of the queue", on the business's open real onboardings.
    const real = onboardings.filter((o) => !o.test);
    for (const group of chunks(real.map((o) => o.id), CHUNK)) {
      const items = await listItemsFor(db, group);
      for (const o of real) if (group.includes(o.id) && isWaitingOnClient(o, items.get(o.id) ?? [], now)) at(o.businessId).waitingOnClient = true;
    }
  }
  return out;
}

/** One client's score, from the same inputs. An unknown business scores as a client with nothing recorded. */
export async function healthFor(db: D1Database, businessId: string, now: Date): Promise<Health> {
  return computeHealth((await healthInputs(db, [businessId], now)).get(businessId)!);
}
