import { dollars } from "../../client/packagesView";
import { PAUSE_NOTICE_KIND, pauseMail } from "../approvals/pauseNotice";
import { reminderBase } from "../approvals/invoiceReminder";
import { logActivityOnce } from "../db/activity";
import { createApproval } from "../db/approvals";
import { getBusiness } from "../db/businesses";
import { holdForInvoice, liftHold, placeHold } from "../db/holds";
import { listInvoices, type InvoiceRow } from "../db/invoices";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { dispatchReady } from "../projects/dispatch";
import { zoneOf } from "../sop/cadence";
import { parseBillingConfig } from "./config";
import { calendarDateIn, calendarDaysBetween } from "./dates";
import { invoiceRecipient, type Recipient } from "./mail";
import { originalMailSent } from "./reminders";

const msg = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/** What the client's pause notice will be, as far as it can be known before it is approved. */
async function previewOf(env: Env, inv: InvoiceRow): Promise<{ title: string; preview: string }> {
  const settings = await getSettings(env.DB);
  let who: Recipient | null = null, problem = "";
  try { who = await invoiceRecipient(env, inv); } catch (e) { problem = msg(e); }
  const clientName = (who?.clientName || (await getBusiness(env.DB, inv.businessId))?.name || "the client").replace(/\s+/g, " ").trim();
  const mail = pauseMail(settings, inv, inv.hostedUrl ?? "", who?.contactName ?? "");
  const toLine = !who ? `To: nobody yet (${problem})`
    : inv.test ? `To: ${settings.your_name.trim() || "You"} <${settings.contact_email.trim()}> (a test: nothing goes to ${who.to})`
    : `To: ${who.contactName ? `${who.contactName} <${who.to}>` : who.to}`;
  const preview = [
    toLine, `Subject: ${inv.test ? "[Test] " : ""}${mail.subject}`, "", mail.body, "",
    `Invoice: ${inv.description} (${dollars(inv.amountCents)}), ${inv.status === "failed" ? `payment failed ${inv.failedOn}` : `due ${inv.dueOn}`}`,
    "", "The hold is already in place: this mail only tells the client. Nothing is mailed until you approve. If the hold is lifted first (paid, voided or lifted by you), approving sends nothing.",
  ].join("\n");
  return { title: `Send pause notice for ${inv.description} to ${clientName}`.replace(/\s+/g, " ").slice(0, 200), preview };
}

/**
 * Drafts the pause notice an invoice's hold calls for, as an approval of the fixed template (nothing is written by a model). Insert-first: the `pause` step is claimed in `invoice_nudges`
 * BEFORE the approval is made, so two sweeps at the same moment make one; if the approval cannot be made the claim is taken back so the next sweep tries again. No link, no notice.
 */
async function raiseNotice(env: Env, inv: InvoiceRow, now: Date): Promise<void> {
  const db = env.DB;
  if (!inv.hostedUrl?.startsWith("https://")) return;
  const claimed = await db.prepare(`INSERT OR IGNORE INTO invoice_nudges (invoice_id, step, created_at) VALUES (?, 'pause', ?)`).bind(inv.id, now.toISOString()).run();
  if ((claimed.meta.changes ?? 0) !== 1) return; // another sweep has it
  try {
    const { title, preview } = await previewOf(env, inv);
    const a = await createApproval(db, {
      kind: PAUSE_NOTICE_KIND, title, preview, payload: { invoiceId: inv.id }, record_type: "business", record_id: inv.businessId, drafted_by: "logan",
    });
    await db.prepare(`UPDATE invoice_nudges SET approval_id = ? WHERE invoice_id = ? AND step = 'pause'`).bind(a.id, inv.id).run();
  } catch (e) {
    await db.prepare(`DELETE FROM invoice_nudges WHERE invoice_id = ? AND step = 'pause' AND approval_id IS NULL`).bind(inv.id).run();
    throw e;
  }
}

/**
 * Places the hold for every real invoice that is open or failed and has gone `pauseAfterDays` past its base date (the due date, or for an autopay failure the day it first failed), and drafts
 * its one pause notice (an approval; the hold itself is automatic). Only an invoice whose own `invoice.send` mail was really sent counts (an invoice turns open BEFORE its mail goes, so one that
 * was never received must not stop a client's work; a mirrored subscription invoice, which Stripe mails itself, is exempt: see `originalMailSent`). A test or draft invoice never holds. An invoice has
 * at most one hold, ever, so one lifted by payment, voiding or by hand is not placed again. Every part is safe to repeat: a hold placed by an earlier run that died before its timeline line or notice
 * is finished here, but one already lifted is left alone. One invoice's failure does not stop the others. Returns how many holds this call placed.
 */
export async function sweepHolds(env: Env, now: Date): Promise<number> {
  const db = env.DB;
  const settings = await getSettings(db);
  const cfg = parseBillingConfig(settings.billing_config);
  const today = calendarDateIn(now, zoneOf(settings));
  let placed = 0;

  for (const inv of await listInvoices(db, { statuses: ["open", "failed"] })) {
    if (inv.test) continue;
    const base = reminderBase(inv);
    if (!base || calendarDaysBetween(base, today) < cfg.pauseAfterDays) continue;
    try {
      if (!(await originalMailSent(db, inv))) continue;
      if (await placeHold(db, { businessId: inv.businessId, invoiceId: inv.id, now: now.toISOString() })) placed++;
      const hold = await holdForInvoice(db, inv.id);
      if (!hold || hold.liftedAt) continue; // lifted already: nothing more to say or send
      const what = inv.description.replace(/\s+/g, " ").trim().slice(0, 120);
      await logActivityOnce(db, inv.businessId, "billing_hold_placed", `${what} ${dollars(inv.amountCents)} (${inv.ref}) is overdue: work on the project is paused until it is paid`);
      await raiseNotice(env, inv, now);
    } catch (e) {
      console.error("holds: could not place a hold or draft its notice", inv.id, msg(e));
    }
  }
  return placed;
}

/**
 * Logan lifts one hold by hand (a client who will pay, a mistake). Work resumes at once: the Claude steps that were waiting are dispatched now rather than at the next sweep (best effort, since
 * the lift is already recorded). A hold that is already lifted, or unknown, changes nothing.
 */
export async function liftManually(env: Env, holdId: string, now: Date): Promise<void> {
  if (!(await liftHold(env.DB, holdId, "manual", now.toISOString()))) return;
  try { await dispatchReady(env, now); }
  catch (e) { console.error("holds: could not dispatch after a hold was lifted", msg(e)); }
}
