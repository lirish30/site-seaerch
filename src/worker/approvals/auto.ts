import { parseBillingConfig } from "../billing/config";
import { calendarDateIn } from "../billing/dates";
import { testClientSql } from "../clients/record";
import { logActivity } from "../db/activity";
import { toApproval, type Approval } from "../db/approvals";
import { listRules, recordAutoApproval, releaseAutoApproval, reserveAutoApproval } from "../db/autoApprove";
import { isOnHold } from "../db/holds";
import { getInvoice } from "../db/invoices";
import { getOnboarding } from "../db/onboardings";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { approve } from "./decide";
import { REMINDER_KIND } from "./invoiceReminder";
import { parseNudgeKey } from "./onboardingNudge";
import { getHandler } from "./registry";

/**
 * Auto-approve (Plan 15): the one place an outbound mail leaves without a person pressing Approve, and only for these two fixed reminders. It is a switch the owner turns on, per kind, in Settings.
 * The list is fixed HERE, in code: a rule row for any other kind (forged, or left over) approves nothing. The send itself is the ordinary `approve()` (claim first, then the handler), so there is
 * no second send path and a send that throws leaves the approval pending with its error, exactly as when a person clicks.
 */
export const AUTO_APPROVE_KINDS = ["invoice.reminder", "onboarding.nudge"] as const;
export type AutoApproveKind = (typeof AUTO_APPROVE_KINDS)[number];
/** At most this many approvals go through unclicked on one local (booking-zone) day; the rest wait for a person. A failed attempt counts: it was an attempt to send. */
export const AUTO_DAILY_CAP = 20;

const msg = (e: unknown) => (e instanceof Error ? e.message : "unknown error");
const isAutoKind = (k: string): k is AutoApproveKind => (AUTO_APPROVE_KINDS as readonly string[]).includes(k);

type Verdict = { ok: true; businessId: string } | { ok: false; why: string };
const no = (why: string): Verdict => ({ ok: false, why });

/** True for a client that is only a rehearsal (the same test the client list, Today and MRR use). */
async function isTestClient(db: D1Database, businessId: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM businesses b WHERE b.id = ? AND ${testClientSql("b")}`).bind(businessId).first());
}

/** The checks of the rules in the plan, in order; the business the approval is about comes back with a yes. */
async function check(env: Env, a: Approval): Promise<Verdict> {
  const db = env.DB;
  if (!isAutoKind(a.kind)) return no(`${a.kind} is not a kind that is ever approved without a click`);
  const rule = (await listRules(db)).find((r) => r.kind === a.kind);
  if (!rule || !rule.enabled || !rule.enabledAt) return no("the rule is off");
  if (a.created_at < rule.enabledAt) return no("this was drafted before the rule was switched on");
  const handler = getHandler(a.kind);
  if (!handler) return no("no handler for this kind");
  let payload: any;
  try { payload = handler.parse(a.payload); } catch { return no("the payload is not readable"); }

  if (a.kind === REMINDER_KIND) {
    const inv = await getInvoice(db, payload.invoiceId);
    if (!inv) return no("the invoice was not found");
    if (inv.test) return no("a test invoice");
    const steps = parseBillingConfig((await getSettings(db)).billing_config).reminderOffsets.length;
    // The last step names the date work pauses: it is always the owner's to read.
    if (payload.step >= steps) return no("the last reminder names the pause date, so a person sends it");
    if (await isOnHold(db, inv.businessId)) return no("the client is on hold");
    if (await isTestClient(db, inv.businessId)) return no("a test client");
    return { ok: true, businessId: inv.businessId };
  }

  const key = parseNudgeKey(payload.nudgeKey);
  if (!key || key.kind !== "reminder") return no("only the first three reminders qualify, not the Friday update");
  if (key.level > 3) return no("the fourth reminder is a person's to send");
  const o = await getOnboarding(db, payload.onboardingId);
  if (!o) return no("the onboarding was not found");
  if (o.test) return no("a test onboarding");
  if (await isOnHold(db, o.businessId)) return no("the client is on hold");
  if (await isTestClient(db, o.businessId)) return no("a test client");
  return { ok: true, businessId: o.businessId };
}

/**
 * Whether an approval may go without a click: its kind is on the fixed list, its rule is on and was switched on at or before the approval was drafted, and the kind's own rules hold. Invoice reminder: the invoice is real,
 * its step is lower than the number of steps in the billing settings, and the client is not on hold. Onboarding reminder: the key is a reminder of level 1 to 3 (not level 4, not the Friday update), the onboarding is
 * real and the client is not on hold. Neither ever goes to a test client. Reads only; the daily cap is `maybeAutoApprove`'s.
 */
export async function autoEligible(env: Env, a: Approval): Promise<{ ok: true } | { ok: false; why: string }> {
  const v = await check(env, a);
  return v.ok ? { ok: true } : v;
}

/**
 * Called by the creator of an approval (a sweep) once the approval exists and is linked to its claim. If the approval is eligible and today's cap has room it is approved through `approve()` and one `auto_approvals`
 * row says how it went: `sent` (a line is logged on the client's timeline) or `failed` with the error (the approval is left pending, with the error, for a person). NEVER throws: a failure here is logged and must not touch
 * the creator's own work (the nudge's claim, the other invoices of a sweep). "approved" means this call approved it, "left" that it is waiting for a person, "failed" that the attempt went wrong.
 */
export async function maybeAutoApprove(env: Env, a: Approval, now: Date): Promise<"approved" | "left" | "failed"> {
  let taken: Parameters<typeof reserveAutoApproval>[1] | null = null; // the place reserved for this approval, once one is
  try {
    const db = env.DB;
    // The row as it is now, never the caller's copy: it may have been decided, or removed, in between.
    const row = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(a.id).first<Parameters<typeof toApproval>[0]>();
    if (!row) return "left";
    const fresh = toApproval(row);
    if (fresh.status !== "pending") return "left";
    const v = await check(env, fresh);
    if (!v.ok) return "left";
    const day = calendarDateIn(now, zoneOf(await getSettings(db)));
    const base = { approvalId: fresh.id, kind: fresh.kind, businessId: v.businessId, decidedAt: now.toISOString(), decidedOn: day };
    // One of today's places is taken BEFORE the send, in one statement, so the cap holds even when two sweeps run at once. No place, or a place already taken for this approval: a person sends it.
    if (!(await reserveAutoApproval(db, base, AUTO_DAILY_CAP))) return "left";
    taken = base;

    const res = await approve(env, fresh.id);
    if (!res.ok && (res.status === 404 || res.status === 409)) { // a person got there first: nothing was attempted, so the place goes back
      await releaseAutoApproval(db, fresh.id);
      return "left";
    }
    if (res.ok) {
      await recordAutoApproval(db, { ...base, outcome: "sent" }).catch((e) => console.error("auto-approve: could not record the outcome", fresh.id, msg(e)));
      await logActivity(db, v.businessId, "auto_approved", fresh.title.replace(/\s+/g, " ").trim().slice(0, 200))
        .catch((e) => console.error("auto-approve: could not log the line", fresh.id, msg(e)));
      return "approved";
    }
    console.error("auto-approve: the send failed", fresh.id, res.error);
    await recordAutoApproval(db, { ...base, outcome: "failed", error: res.error }).catch((e) => console.error("auto-approve: could not record the outcome", fresh.id, msg(e)));
    return "failed";
  } catch (e) {
    console.error("auto-approve: failed", a.id, msg(e));
    // A place was taken but the attempt broke before an outcome was written: say so on the line (best effort) rather than leave it saying "sending".
    if (taken) await recordAutoApproval(env.DB, { ...taken, outcome: "failed", error: msg(e) }).catch(() => {});
    return "failed";
  }
}
