import { dayKey } from "../booking/slots";
import { listActivity } from "../db/activity";
import { getBusiness } from "../db/businesses";
import { listChangeOrdersForBusiness, type ChangeOrder, type ChangeOrderStatus } from "../db/changeOrders";
import { listForBusiness, type Document, type DocumentStatus } from "../db/documents";
import { isOnHold } from "../db/holds";
import { listInvoices } from "../db/invoices";
import { listPeople } from "../db/people";
import { listProjects } from "../db/projects";
import { getSettings } from "../db/settings";
import { latestOnboardingForBusiness, listItems } from "../db/onboardings";
import { listAccess, listSites, type AccessItem, type Site } from "../db/sites";
import { listSubscriptions, type Subscription } from "../db/subscriptions";
import { zoneOf } from "../sop/cadence";
import { ACCESS_ITEM_PREFIX } from "../onboarding/templates";
import { siteFlags, type SiteFlag } from "../sites/access";
import type { Activity, Business, Person } from "../types";

/** A subscription is live (billing, or late on a bill) in these states. */
const LIVE = ["active", "past_due"] as const;
const CARE_KEYS = ["care", "care_plus", "care_fallback"] as const;
const CARE_NAMES: Record<(typeof CARE_KEYS)[number], string> = { care: "Care", care_plus: "Care Plus", care_fallback: "Care" };

/**
 * A business with no real record of any kind (site, project or subscription) and at least one test one is a rehearsal. Test records never count in the client list, MRR or Today.
 * A business with nothing at all (a won lead that has not been set up yet) is real. An archived site says nothing either way. SQL for a businesses row with this alias.
 */
export const testClientSql = (a: string): string => `(
  (EXISTS (SELECT 1 FROM sites s WHERE s.business_id = ${a}.id AND s.archived_at IS NULL AND s.test = 1)
    OR EXISTS (SELECT 1 FROM projects p WHERE p.business_id = ${a}.id AND p.test = 1)
    OR EXISTS (SELECT 1 FROM subscriptions u WHERE u.business_id = ${a}.id AND u.test = 1))
  AND NOT (EXISTS (SELECT 1 FROM sites s WHERE s.business_id = ${a}.id AND s.archived_at IS NULL AND s.test = 0)
    OR EXISTS (SELECT 1 FROM projects p WHERE p.business_id = ${a}.id AND p.test = 0)
    OR EXISTS (SELECT 1 FROM subscriptions u WHERE u.business_id = ${a}.id AND u.test = 0))
)`;

/** A client is a business that was won, or has at least one project. SQL for a businesses row with this alias. */
export const clientSql = (a: string): string => `(${a}.lead_status = 'won' OR EXISTS (SELECT 1 FROM projects cp WHERE cp.business_id = ${a}.id))`;

export async function isClient(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM businesses b WHERE b.id = ? AND ${clientSql("b")}`).bind(businessId).first());
}

/** True when the business is a rehearsal: it has test records and no real ones. */
export async function isTestClient(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM businesses b WHERE b.id = ? AND ${testClientSql("b")}`).bind(businessId).first());
}

/** What the client's subscriptions bill each month, integer cents: active and past-due rows, test rows left out. Counted per subscription, so a client's two sites never double it. Plan 10 reuses it. */
export const clientMrrCents = (subs: Subscription[]): number =>
  subs.filter((s) => !s.test && (LIVE as readonly string[]).includes(s.status)).reduce((sum, s) => sum + s.monthlyCents, 0);

const money = (cents: number): string => {
  const dollars = Math.trunc(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `$${dollars}` : `$${dollars}.${String(rest).padStart(2, "0")}`;
};

/** `"Care $129/mo"` for the client's Care row that is billing or late on a bill (the newest when it has more than one), or null. The name follows the package: Care, Care Plus. */
export function careLabel(subs: Subscription[]): string | null {
  const row = subs.find((s) => !s.test && (LIVE as readonly string[]).includes(s.status) && (CARE_KEYS as readonly string[]).includes(s.packageKey));
  return row ? `${CARE_NAMES[row.packageKey as (typeof CARE_KEYS)[number]]} ${money(row.monthlyCents)}/mo` : null;
}

/** The earliest term end among the live, real subscriptions, or null when none has a term. */
export const nextRenewalOn = (subs: Subscription[]): string | null =>
  subs.filter((s) => !s.test && (LIVE as readonly string[]).includes(s.status) && s.termEndsOn).map((s) => s.termEndsOn as string).sort()[0] ?? null;

export interface ClientRow {
  id: string; name: string; /** True for a rehearsal client (see `testClientSql`); such rows only come back with `includeTest`. */ test: boolean; careLabel: string | null; mrrCents: number; siteCount: number; accessMissing: number; openInvoiceCents: number; held: boolean; nextRenewalOn: string | null;
}

interface ListRow {
  id: string; name: string; is_test: number; mrr_cents: number; site_count: number; access_missing: number; open_cents: number; held: number; next_renewal_on: string | null;
}

/**
 * Every client, by name. The numbers come from one query (each is a subquery of the business row), plus one read of the live subscriptions for the Care label, so the list costs two
 * reads however many clients there are. Test records are left out unless `includeTest`.
 */
export async function listClients(db: D1Database, o: { includeTest?: boolean } = {}): Promise<ClientRow[]> {
  const [rows, active] = await Promise.all([
    db.prepare(
      `SELECT b.id, b.name, ${testClientSql("b")} AS is_test,
         (SELECT COALESCE(SUM(u.monthly_cents), 0) FROM subscriptions u WHERE u.business_id = b.id AND u.test = 0 AND u.status IN ('active', 'past_due')) AS mrr_cents,
         (SELECT COUNT(*) FROM sites s WHERE s.business_id = b.id AND s.archived_at IS NULL) AS site_count,
         (SELECT COUNT(*) FROM site_access_items i JOIN sites s ON s.id = i.site_id
            WHERE s.business_id = b.id AND s.archived_at IS NULL AND i.status NOT IN ('received', 'verified', 'not_applicable')) AS access_missing,
         (SELECT COALESCE(SUM(v.amount_cents), 0) FROM invoices v WHERE v.business_id = b.id AND v.test = 0 AND v.status IN ('open', 'failed')) AS open_cents,
         EXISTS (SELECT 1 FROM billing_holds h WHERE h.business_id = b.id AND h.lifted_at IS NULL) AS held,
         (SELECT MIN(u.term_ends_on) FROM subscriptions u WHERE u.business_id = b.id AND u.test = 0 AND u.status IN ('active', 'past_due') AND u.term_ends_on IS NOT NULL) AS next_renewal_on
       FROM businesses b
       WHERE ${clientSql("b")}${o.includeTest ? "" : ` AND NOT ${testClientSql("b")}`}
       ORDER BY b.name COLLATE NOCASE, b.id`,
    ).all<ListRow>(),
    listSubscriptions(db, { statuses: [...LIVE] }),
  ]);
  const byBusiness = new Map<string, Subscription[]>();
  for (const s of active) byBusiness.set(s.businessId, [...(byBusiness.get(s.businessId) ?? []), s]);
  return rows.results.map((r) => ({
    id: r.id, name: r.name, test: r.is_test === 1, careLabel: careLabel(byBusiness.get(r.id) ?? []), mrrCents: r.mrr_cents, siteCount: r.site_count, accessMissing: r.access_missing,
    openInvoiceCents: r.open_cents, held: r.held === 1, nextRenewalOn: r.next_renewal_on,
  }));
}

/** A subscription as the owner reads it: the client's payment link token is left out. */
export type ClientSubscription = Omit<Subscription, "token">;
/** A proposal or agreement as a row: no content, no signing token. */
export interface ClientDocument {
  id: string; dealId: string; version: number; status: DocumentStatus; test: boolean; reference: string; sentAt: string | null; signedAt: string | null; paidAt: string | null; createdAt: string;
}
/** A change order as a row: no content body, no signing token. */
export interface ClientChangeOrder {
  id: string; projectId: string; seq: number; status: ChangeOrderStatus; test: boolean; reference: string; title: string; priceCents: number;
  sentAt: string | null; signedAt: string | null; paidAt: string | null; createdAt: string;
}

/** One checklist line plus what the CLIENT typed for it on their onboarding page. That text is untrusted (it may be wrong, or hostile): show it as plain text and never as HTML or a link. */
export type ClientAccessItem = AccessItem & { clientAnswer: string | null };

export interface ClientRecord {
  business: Business;
  people: Person[];
  /** Live sites only. `access` is the six checklist items with the owner-only vault names and notes: this record is for the owner and nobody else. */
  sites: { site: Site; access: ClientAccessItem[]; flags: SiteFlag[] }[];
  subscriptions: ClientSubscription[];
  mrrCents: number;
  careLabel: string | null;
  projects: Awaited<ReturnType<typeof listProjects>>;
  invoices: { openCents: number; overdueCount: number; paidCents: number };
  documents: ClientDocument[];
  changeOrders: ClientChangeOrder[];
  held: boolean;
  nextRenewalOn: string | null;
  activity: Activity[];
}

const toSubscription = (s: Subscription): ClientSubscription => { const { token: _token, ...rest } = s; return rest; };
const toDocument = (d: Document): ClientDocument => ({
  id: d.id, dealId: d.dealId, version: d.version, status: d.status, test: d.test, reference: d.content.header.reference, sentAt: d.sentAt, signedAt: d.signedAt, paidAt: d.paidAt, createdAt: d.createdAt,
});
const toChangeOrder = (c: ChangeOrder): ClientChangeOrder => ({
  id: c.id, projectId: c.projectId, seq: c.seq, status: c.status, test: c.test, reference: c.content.reference, title: c.content.title, priceCents: c.content.priceCents,
  sentAt: c.sentAt, signedAt: c.signedAt, paidAt: c.paidAt, createdAt: c.createdAt,
});

/** The whole client in one object, or null for an unknown id or a lead that is not (yet) a client. `now` decides which open invoices are overdue, by date in the booking time zone. */
export async function getClientRecord(db: D1Database, businessId: string, now: Date): Promise<ClientRecord | null> {
  const [business, client] = await Promise.all([getBusiness(db, businessId), isClient(db, businessId)]);
  if (!business || !client) return null;
  const settings = await getSettings(db);
  const today = dayKey(now.getTime(), zoneOf(settings));
  const [people, subs, projects, invoices, documents, changeOrders, held, activity, sites] = await Promise.all([
    listPeople(db, businessId), listSubscriptions(db, { businessId }), listProjects(db, { businessId }), listInvoices(db, { businessId }), listForBusiness(db, businessId),
    listChangeOrdersForBusiness(db, businessId), isOnHold(db, businessId), listActivity(db, businessId), listSites(db, { businessId }),
  ]);
  const care = careLabel(subs);
  // What the client wrote for each access question, from the business's newest onboarding: one read, shared by every site.
  const onboarding = sites.length > 0 ? await latestOnboardingForBusiness(db, businessId) : null;
  const answers = new Map((onboarding ? await listItems(db, onboarding.id) : []).filter((i) => i.kind === "text").map((i) => [i.key, i.textValue?.trim() || null] as const));
  const withAccess = await Promise.all(sites.map(async (site) => {
    const items = await listAccess(db, site.id);
    const access = items.map((i) => ({ ...i, clientAnswer: answers.get(`${ACCESS_ITEM_PREFIX}${i.key}`) ?? null }));
    return { site, access, flags: siteFlags({ site, items, careActive: care !== null }) };
  }));
  const owed = invoices.filter((i) => !i.test && (i.status === "open" || i.status === "failed"));
  return {
    business, people, sites: withAccess, subscriptions: subs.map(toSubscription), mrrCents: clientMrrCents(subs), careLabel: care, projects,
    invoices: {
      openCents: owed.reduce((n, i) => n + i.amountCents, 0),
      overdueCount: owed.filter((i) => i.dueOn !== null && i.dueOn < today).length,
      paidCents: invoices.filter((i) => !i.test && i.status === "paid").reduce((n, i) => n + i.amountCents, 0),
    },
    documents: documents.map(toDocument), changeOrders: changeOrders.map(toChangeOrder), held, nextRenewalOn: nextRenewalOn(subs), activity,
  };
}
