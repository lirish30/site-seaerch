import { dollars } from "../../client/packagesView";
import { REMINDER_KIND, reminderBase, reminderMail } from "../approvals/invoiceReminder"; // importing it registers the kind, which must exist before an approval of it is made
import { createApproval } from "../db/approvals";
import { getBusiness } from "../db/businesses";
import { listInvoices, type InvoiceRow } from "../db/invoices";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { parseBillingConfig } from "./config";
import { calendarDateIn, calendarDaysBetween } from "./dates";
import { invoiceRecipient, signOff, type Recipient } from "./mail";

/** The 1-based index of the highest offset at or below `daysFromDue` (negative is before the due date), or null before the first. Offsets are in increasing order. */
export function reminderStep(offsets: number[], daysFromDue: number): number | null {
  let step = 0;
  for (const [i, o] of offsets.entries()) if (o <= daysFromDue) step = i + 1;
  return step === 0 ? null : step;
}

/**
 * True when the client really got the invoice's link by mail: the invoice's own `invoice.send` approval has an outbound message that was sent. An invoice turns open (and gets its sent
 * date) when Stripe makes it, BEFORE the mail goes, so a mail that failed and an approval that was dropped leave an invoice that looks sent but was never received. Stripe mails a
 * subscription's own monthly invoices itself, so those never have one and do not need one.
 */
async function originalMailSent(db: D1Database, inv: InvoiceRow): Promise<boolean> {
  if (inv.kind === "subscription") return true;
  return !!(await db.prepare(
    `SELECT 1 AS x FROM approvals a JOIN messages m ON m.approval_id = a.id
      WHERE a.kind = 'invoice.send' AND json_extract(a.payload, '$.invoiceId') = ? AND m.direction = 'out' AND m.status = 'sent' LIMIT 1`,
  ).bind(inv.id).first());
}

/** What the client's reminder will be, as far as it can be known before it is approved. */
async function previewOf(env: Env, inv: InvoiceRow, step: number, total: number): Promise<{ title: string; preview: string }> {
  const settings = await getSettings(env.DB);
  let who: Recipient | null = null, problem = "";
  try { who = await invoiceRecipient(env, inv); } catch (e) { problem = e instanceof Error ? e.message : "no recipient"; }
  const clientName = (who?.clientName || (await getBusiness(env.DB, inv.businessId))?.name || "the client").replace(/\s+/g, " ").trim();
  const mail = reminderMail(settings, inv, step, inv.hostedUrl ?? "", who?.contactName ?? "")!;
  const toLine = !who ? `To: nobody yet (${problem})`
    : inv.test ? `To: ${settings.your_name.trim() || "You"} <${settings.contact_email.trim()}> (a test: nothing goes to ${who.to})`
    : `To: ${who.contactName ? `${who.contactName} <${who.to}>` : who.to}`;
  const preview = [
    toLine, `Subject: ${inv.test ? "[Test] " : ""}${mail.subject}`, "", mail.body, "",
    `Invoice: ${inv.description} (${dollars(inv.amountCents)}), ${inv.status === "failed" ? `payment failed ${inv.failedOn}` : `due ${inv.dueOn}`}`,
    `Reminder ${step} of ${Math.max(step, total)}; work pauses on ${mail.pauseOn} if it is still unpaid.`,
    "", "Nothing is mailed until you approve. If the invoice is paid first, approving sends nothing.",
  ].join("\n");
  return { title: `Send reminder ${step} for ${inv.description} to ${clientName}`.replace(/\s+/g, " ").slice(0, 200), preview };
}

/**
 * Drafts the reminder each unpaid invoice has reached, as an approval of the fixed template (nothing is written by a model). It looks at real invoices that are open or failed, and that
 * have a date to count from (the due date, or for an autopay failure the day it first failed) and a Stripe link. A test or draft invoice is never reminded, and an invoice whose own
 * `invoice.send` mail was never sent is not either (the client never got it, so a reminder would be the first they heard of it; see `originalMailSent`). The step is the highest one reached
 * today, so a missed day or week never sends a pile, and a step is claimed in `invoice_nudges` BEFORE its approval is made, so two sweeps at the same moment make one. A step at or below one
 * already raised is left alone (the offsets may have been changed). If the approval cannot be made the claim is taken back so the next sweep tries again; one invoice's failure does not stop the
 * others. Returns how many approvals this call drafted.
 */
export async function sweepReminders(env: Env, now: Date): Promise<number> {
  const db = env.DB;
  const settings = await getSettings(db);
  const cfg = parseBillingConfig(settings.billing_config);
  const today = calendarDateIn(now, zoneOf(settings));
  let drafted = 0;

  for (const inv of await listInvoices(db, { statuses: ["open", "failed"] })) {
    if (inv.test) continue;
    const base = reminderBase(inv);
    if (!base || !inv.hostedUrl?.startsWith("https://")) continue;
    const step = reminderStep(cfg.reminderOffsets, calendarDaysBetween(base, today));
    if (step === null) continue;
    try {
      const raised = (await db.prepare(`SELECT step FROM invoice_nudges WHERE invoice_id = ? AND step LIKE 'r%'`).bind(inv.id).all<{ step: string }>()).results.map((r) => Number(r.step.slice(1)));
      if (raised.some((n) => n >= step)) continue;
      if (!(await originalMailSent(db, inv))) continue;

      const key = `r${step}`;
      const claimed = await db.prepare(`INSERT OR IGNORE INTO invoice_nudges (invoice_id, step, created_at) VALUES (?, ?, ?)`).bind(inv.id, key, now.toISOString()).run();
      if ((claimed.meta.changes ?? 0) !== 1) continue; // another sweep has it
      try {
        const { title, preview } = await previewOf(env, inv, step, cfg.reminderOffsets.length);
        const a = await createApproval(db, {
          kind: REMINDER_KIND, title, preview, payload: { invoiceId: inv.id, step }, record_type: "business", record_id: inv.businessId, drafted_by: "logan",
        });
        await db.prepare(`UPDATE invoice_nudges SET approval_id = ? WHERE invoice_id = ? AND step = ?`).bind(a.id, inv.id, key).run();
        drafted++;
      } catch (e) {
        await db.prepare(`DELETE FROM invoice_nudges WHERE invoice_id = ? AND step = ? AND approval_id IS NULL`).bind(inv.id, key).run();
        throw e;
      }
    } catch (e) {
      console.error("reminders: could not draft a reminder", inv.id, e instanceof Error ? e.message : "unknown error");
    }
  }
  return drafted;
}
