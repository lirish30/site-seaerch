const ADDRESS_MAX = 320;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** An address fit for the do-not-contact list, or undefined. A mail system's odd Final-Recipient must never make the stop throw (it would block the mailbox on that message). */
const usable = (a: string | null | undefined): string | undefined => {
  const t = a?.trim().replace(/^<|>$/g, "").toLowerCase();
  return t && t.length <= ADDRESS_MAX && EMAIL.test(t) ? t : undefined;
};

/**
 * The address to list as do-not-contact for a stop or a hard bounce. `claimed` is what the mail says (a DSN's Final-Recipient, a sender's From),
 * and a forged message can claim anyone. It is used only when it is an address we wrote to for this lead (the enrollment's `to_email`, or an outbound
 * message's recipient); otherwise it is the enrollment's `to_email`, the address we actually wrote to. Undefined when there is neither.
 * Shared by the mail sync (a stop or a bounce in the inbox) and a reply Claude classified as `stop`.
 */
export async function listableAddress(db: D1Database, businessId: string, enrollmentTo: string | null | undefined, claimed: string | null | undefined): Promise<string | undefined> {
  const known = usable(enrollmentTo);
  const c = usable(claimed);
  if (c && c === known) return c;
  if (c) {
    const sent = await db.prepare(`SELECT 1 AS x FROM messages WHERE direction = 'out' AND business_id = ? AND LOWER(counterpart) = ? LIMIT 1`).bind(businessId, c).first();
    if (sent) return c;
  }
  return known;
}
