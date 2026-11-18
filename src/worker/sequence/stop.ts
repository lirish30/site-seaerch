import { reject } from "../approvals/decide";
import { InvalidDoNotContact, addDoNotContact } from "../db/doNotContact";
import { isDuplicateKey } from "../db/services";
import { getBusiness, updateLead } from "../db/businesses";
import { suppressLead } from "../db/suppression";
import { logActivity } from "../db/activity";
import { enrollmentsFor } from "../db/enrollments";
import type { LeadStatus } from "../types";
import type { StopReason } from "./types";

const ENDS_AS: Record<StopReason, "replied" | "stopped" | "bounced"> = { replied: "replied", opt_out: "stopped", bounced: "bounced", manual: "stopped" };
// Reasons that also move the lead; a client ('won') is never moved by an inbound stop.
const LEAD_STATUS: Partial<Record<StopReason, LeadStatus>> = { replied: "replied", opt_out: "lost" };

/**
 * Ends every channel of outreach to a lead ("any stop ends every channel"). Order matters, so that a stop beats an approval that is
 * already waiting: the enrollments are ended FIRST (the send path refuses anything for an ended sequence), then the pending approvals
 * (and every pending email.send for the lead, enrolled or not) are rejected, then the lead and the lists are updated.
 *  - replied: enrollment `replied`, lead `replied`.
 *  - opt_out: enrollment `stopped`, the lead's domain and place id are suppressed, the address goes on do-not-contact (opt_out), lead `lost`.
 *  - bounced: enrollment `bounced`, the address goes on do-not-contact (bounced).
 *  - manual: enrollment `stopped`.
 * It works for a lead that was never enrolled (a reply to a one-off email) and is safe to repeat. `email` defaults to the address the
 * lead's latest sequence was writing to.
 */
export async function stopOutreach(
  db: D1Database, o: { businessId: string; reason: StopReason; email?: string },
): Promise<{ rejectedApprovals: number }> {
  const enrollments = await enrollmentsFor(db, o.businessId);
  await db.prepare(`UPDATE enrollments SET status = ?, stopped_reason = ?, next_due_at = NULL WHERE business_id = ? AND status IN ('active','nurture')`)
    .bind(ENDS_AS[o.reason], o.reason, o.businessId).run();

  // Every pending approval that could still write to this lead: the ones tied to its enrollments AND any email.send for it made outside a
  // sequence (an MCP proposal has record_type 'lead' and no enrollmentId). A reply does not block the conflict gate, so without this a
  // stale cold email could still be approved after the lead answered. One row per approval, however many conditions it matches.
  const pending = (await db.prepare(
    `SELECT id FROM approvals WHERE status = 'pending' AND (
       (record_type = 'enrollment' AND record_id IN (SELECT id FROM enrollments WHERE business_id = ?1))
       OR (kind = 'email.send' AND json_extract(payload, '$.businessId') = ?1))`,
  ).bind(o.businessId).all<{ id: string }>()).results;
  let rejectedApprovals = 0;
  const note = `sequence stopped: ${o.reason}`;
  for (const a of pending) if (await reject(db, a.id, note)) rejectedApprovals++;

  const email = (o.email ?? enrollments[0]?.to_email)?.trim();
  const business = await getBusiness(db, o.businessId);
  if (business) {
    if (o.reason === "opt_out") {
      try { await suppressLead(db, business, { reason: "opt_out", note: "asked to stop" }); }
      catch (e) { console.error("opt-out: could not suppress the lead", o.businessId, e); } // no domain or place id to match on; the address is still listed below
    }
    const next = LEAD_STATUS[o.reason];
    if (next && business.lead_status !== "won" && business.lead_status !== next) await updateLead(db, o.businessId, { leadStatus: next });
  }
  if (email && (o.reason === "opt_out" || o.reason === "bounced")) {
    try { await addDoNotContact(db, { kind: "email", value: email, reason: o.reason, note: "added by the sequence stop" }); }
    catch (e) { if (!isDuplicateKey(e) && !(e instanceof InvalidDoNotContact)) throw e; } // an unusable stored address must not undo the stop
  }
  if (business) await logActivity(db, o.businessId, "note", `Outreach stopped (${o.reason}); ${rejectedApprovals} pending approval${rejectedApprovals === 1 ? "" : "s"} rejected`);
  return { rejectedApprovals };
}
