import { z } from "zod";
import { parseConfig } from "../booking/config";
import { getChangeOrder, getChangeOrderByToken, declineChangeOrder, recordView, signChangeOrder, type ChangeOrder } from "../db/changeOrders";
import { getProject } from "../db/projects";
import { getSettings } from "../db/settings";
import { ESIGN_VERSION } from "../documents/consent";
import { SignFormSchema, consentTextFor } from "../documents/public";
import { isClientToken } from "../documents/token";
import type { Env } from "../env";
import { cleanText } from "../onboarding/templates";
import { afterSigned } from "./service";

/** Stored with a signature: what a hostile client sends is cut to this, never refused. */
const USER_AGENT_MAX = 300;
const IP_MAX = 64;
/** The reason a client gives for turning an order down. */
const DECLINE_REASON_MAX = 300;

/** What the client's page shows. Never the owner's cost rate, other tasks, notes, other clients, an id, an approval or any token. */
export interface PublicChangeOrder {
  /** `open` can be signed or declined, `signed` is a record, `closed` has nothing of the order left in it (see `closedReason`). */
  state: "open" | "signed" | "closed";
  reference: string;
  clientName: string;
  contactName: string;
  projectName: string;
  title: string;
  summary: string;
  reason: string;
  deliverables: string[];
  notIncluded: string[];
  hours: number;
  rateCents: number;
  priceCents: number;
  scheduleImpactDays: number | null;
  /** The last day the order can be signed, as a calendar date in the owner's zone. Only an open order has one. */
  expiresOn: string | null;
  /** The fingerprint the client signs against: sent back with the sign request, and refused when the order is no longer this one. */
  contentSha256: string;
  /** The ESIGN disclosure and the two checkbox texts exactly as they are stored with the signature. */
  consentText: string;
  ownerName: string;
  ownerBusiness: string;
  signed: { signerName: string; signedAt: string } | null;
  payment: "none" | "paid";
  closedReason: "void" | "expired" | "declined" | null;
}

/** A sent or viewed order is open until its expiry; at the exact instant it still is (signing allows it, in the same words). */
const timeLeft = (co: ChangeOrder, now: Date): boolean => co.expiresAt !== null && Date.parse(co.expiresAt) >= now.getTime();

/** Why the order is closed, or null while it is open or signed. A sent or viewed order past its time is closed whether or not the nightly sweep has marked it yet. */
function closedReasonOf(co: ChangeOrder, now: Date): PublicChangeOrder["closedReason"] {
  if (co.status === "void") return "void";
  if (co.status === "declined") return "declined";
  if (co.status === "expired") return "expired";
  if ((co.status === "sent" || co.status === "viewed") && !timeLeft(co, now)) return "expired";
  return null;
}

/** The order behind a link, or null: not a token, unknown, revoked (no token) or still a draft. A test order is served like a real one: it is the owner's rehearsal. */
async function find(env: Env, token: string): Promise<ChangeOrder | null> {
  if (!isClientToken(token)) return null;
  const co = await getChangeOrderByToken(env.DB, token);
  return !co || co.status === "draft" || !co.token ? null : co;
}

/** A UTC instant as a `YYYY-MM-DD` calendar date in a zone. */
function dateIn(iso: string, tz: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t));
  const n = (type: string) => p.find((x) => x.type === type)?.value;
  return `${n("year")}-${n("month")}-${n("day")}`;
}

/**
 * The page for an order. Only an open one records the view (`view`): a signed, void, declined or expired one is not a client reading it. A closed page keeps who it was for
 * and which order, and nothing of what it said or cost.
 */
async function pageFor(env: Env, co: ChangeOrder, now: Date, view: { userAgent: string | null } | null): Promise<PublicChangeOrder> {
  const closedReason = closedReasonOf(co, now);
  if (!closedReason && view && (co.status === "sent" || co.status === "viewed")) {
    // Counting a visit must never stop the client reading their order.
    try { await recordView(env.DB, co.id, { now: now.toISOString(), userAgent: view.userAgent === null ? null : cleanText(view.userAgent, USER_AGENT_MAX) }); }
    catch (e) { console.error("change order: could not record a view", e instanceof Error ? e.message : "unknown error"); }
  }
  const [settings, project] = await Promise.all([getSettings(env.DB), getProject(env.DB, co.projectId)]);
  const c = co.content;
  const base = {
    reference: c.reference, clientName: c.clientName, contactName: c.contactName, projectName: project?.name ?? "", title: c.title,
    ownerName: settings.your_name.trim(), ownerBusiness: settings.business_name.trim(),
  };
  if (closedReason) {
    return {
      ...base, state: "closed", summary: "", reason: "", deliverables: [], notIncluded: [], hours: 0, rateCents: 0, priceCents: 0, scheduleImpactDays: null, expiresOn: null,
      contentSha256: "", consentText: "", signed: null, payment: "none", closedReason,
    };
  }
  const signed = co.status === "signed";
  return {
    ...base, state: signed ? "signed" : "open", summary: c.summary, reason: c.reason, deliverables: c.deliverables, notIncluded: c.notIncluded, hours: c.hours, rateCents: c.rateCents,
    priceCents: c.priceCents, scheduleImpactDays: c.scheduleImpactDays, expiresOn: !signed && co.expiresAt ? dateIn(co.expiresAt, parseConfig(settings.booking_config).timezone) : null,
    contentSha256: co.contentSha256 ?? "", consentText: consentTextFor(c.clientName), signed: signed && co.signerName && co.signedAt ? { signerName: co.signerName, signedAt: co.signedAt } : null,
    payment: signed && co.paidAt ? "paid" : "none", closedReason: null,
  };
}

/** The client's page for a link, or null for a malformed, unknown, revoked or draft one. Opening an open order records the view (and moves `sent` to `viewed`). */
export async function changeOrderPage(env: Env, token: string, o: { now: Date; userAgent: string | null }): Promise<PublicChangeOrder | null> {
  const co = await find(env, token);
  return co ? pageFor(env, co, o.now, { userAgent: o.userAgent }) : null;
}

export type ChangeOrderWriteResult = { ok: true; page: PublicChangeOrder } | { ok: false; status: 400 | 404 | 409; error: string; fields?: string[] };

const NOT_FOUND: ChangeOrderWriteResult = { ok: false, status: 404, error: "not found" };
const CLOSED: ChangeOrderWriteResult = { ok: false, status: 409, error: "this change order is no longer open" };

/**
 * Signs a change order. The token is checked before the form is looked at, so a bad form on a link that is not real is a 404. Then the form (400), then closed or past its time (409),
 * then the hash must be the one the client was shown (409). The store is conditional (`signChangeOrder`), so a second sign answers with the first signature and writes nothing, and two
 * at once leave one. `afterSigned` runs after a stored signature (new or already there: it is idempotent, so a retry repairs a follow-up that failed); a failure in it, or in building the
 * page, never turns a stored signature into an error.
 */
export async function signChangeOrderPublic(
  env: Env, token: string, form: unknown, o: { now: Date; ip: string | null; userAgent: string | null },
): Promise<ChangeOrderWriteResult> {
  const co = await find(env, token);
  if (!co) return NOT_FOUND;
  const parsed = SignFormSchema.safeParse(form);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid body", fields: Object.keys(z.flattenError(parsed.error).fieldErrors) };
  const f = parsed.data;
  if (closedReasonOf(co, o.now)) return CLOSED;
  if (f.sha256 !== co.contentSha256) return { ok: false, status: 409, error: "this change order changed, reload" };

  const at = o.now.toISOString();
  const outcome = await signChangeOrder(env.DB, co.id, {
    signerName: f.name, signerEmail: co.content.contactEmail, signedAt: at, ip: o.ip === null ? null : cleanText(o.ip, IP_MAX), userAgent: o.userAgent === null ? null : cleanText(o.userAgent, USER_AGENT_MAX),
    consentText: consentTextFor(co.content.clientName), consentVersion: ESIGN_VERSION, contentSha256: f.sha256,
  }, at);
  if (outcome === "not_open") return CLOSED;
  // The signature is the record: a failed follow-up or a failed read never takes it back.
  try { await afterSigned(env, co.id, o.now); }
  catch (e) { console.error("change order: after-signed step failed", e instanceof Error ? e.message : "unknown error"); }
  try {
    const now = await getChangeOrder(env.DB, co.id);
    return now ? { ok: true, page: await pageFor(env, now, o.now, null) } : NOT_FOUND;
  } catch (e) {
    console.error("change order: could not build the page after signing", e instanceof Error ? e.message : "unknown error");
    return { ok: true, page: signedFallback(co, f.name, at) };
  }
}

/** What the client sees when the signature is stored but the page could not be rebuilt: that it is signed. Reloading shows the rest. */
function signedFallback(co: ChangeOrder, name: string, at: string): PublicChangeOrder {
  const c = co.content;
  return {
    state: "signed", reference: c.reference, clientName: c.clientName, contactName: c.contactName, projectName: "", title: c.title, summary: c.summary, reason: c.reason, deliverables: c.deliverables,
    notIncluded: c.notIncluded, hours: c.hours, rateCents: c.rateCents, priceCents: c.priceCents, scheduleImpactDays: c.scheduleImpactDays, expiresOn: null, contentSha256: co.contentSha256 ?? "",
    consentText: consentTextFor(c.clientName), ownerName: "", ownerBusiness: "", signed: { signerName: name, signedAt: at }, payment: "none", closedReason: null,
  };
}

/**
 * The client says no. The token is checked first (a link that is not real is a 404), then the order must still be open: a signed, void or expired one is a 409, and a declined one answers
 * as declined again (a second no changes nothing). The reason is optional text, cleaned and cut to 300 characters; anything that is not text is no reason. Nothing unlocks.
 */
export async function declineChangeOrderPublic(env: Env, token: string, reason: unknown, now: Date): Promise<ChangeOrderWriteResult> {
  const co = await find(env, token);
  if (!co) return NOT_FOUND;
  if (co.status !== "declined") {
    if (closedReasonOf(co, now) || co.status === "signed") return CLOSED;
    const text = typeof reason === "string" ? cleanText(reason, DECLINE_REASON_MAX) : "";
    if ((await declineChangeOrder(env.DB, co.id, text, now.toISOString())) === "not_open") return CLOSED;
  }
  const after = await getChangeOrder(env.DB, co.id);
  return after ? { ok: true, page: await pageFor(env, after, now, null) } : NOT_FOUND;
}
