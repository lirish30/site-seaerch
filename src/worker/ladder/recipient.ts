// Who a ladder mail goes to, which review link it carries, and whether a client may be written to at all (Plan 15).
import { isTestClient } from "../clients/record";
import { checkConflict } from "../conflict";
import { isSingleAddress } from "../db/changeOrders";
import { isOnHold } from "../db/holds";
import type { LadderRow, LadderStep } from "../db/ladder";
import { listPeople } from "../db/people";
import { getProfile } from "../db/seo";
import { listSubscriptions } from "../db/subscriptions";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const usable = (e: string | null | undefined): e is string => !!e && e.includes("@") && isSingleAddress(e);

/**
 * The person a ladder mail goes to: the first person on the client with an email, preferring (the role is free text, so matched in any case, as a part of the words) an owner, then a decision
 * maker, then billing, then anyone. Inside one group the point of contact comes first, then the oldest. Null when nobody has a usable email.
 */
export async function ladderRecipient(db: D1Database, businessId: string): Promise<{ to: string; contactName: string } | null> {
  const people = (await listPeople(db, businessId)).map((p) => ({ p, email: (p.email ?? "").replace(/[\r\n\t]/g, "").trim() })).filter((x) => usable(x.email));
  for (const word of ["owner", "decision", "billing"]) {
    const hit = people.find((x) => (x.p.role ?? "").toLowerCase().includes(word));
    if (hit) return { to: hit.email, contactName: oneLine(hit.p.name) };
  }
  const first = people[0];
  return first ? { to: first.email, contactName: oneLine(first.p.name) } : null;
}

/** The https link a review request carries: the step's own link when it has one, else the Google "write a review" page of the client's Local SEO place id, else null. */
export async function reviewLinkFor(db: D1Database, businessId: string, row: Pick<LadderRow, "link">): Promise<string | null> {
  const own = (row.link ?? "").trim();
  if (own.startsWith("https://")) return own;
  const placeId = (await getProfile(db, businessId))?.placeId?.trim();
  return placeId ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}` : null;
}

/**
 * Why a client must not be written to right now, in plain words, or null when it may be: a billing hold, a rehearsal client, a client that has ended (it has at least one subscription and every one of
 * them is cancelled or ended; a client with no subscription at all, a build-only client, is NOT ended), a do-not-contact or suppression hit (an "existing client" hit is the point of the ladder and does not
 * count), and, for the December letter only, a client with no active or past-due subscription. Test subscriptions are not counted.
 */
export async function clientBlock(db: D1Database, businessId: string, o: { step: LadderStep; email: string }): Promise<string | null> {
  if (await isOnHold(db, businessId)) return "the client is on a billing hold";
  if (await isTestClient(db, businessId)) return "the client is a test client";
  const subs = (await listSubscriptions(db, { businessId })).filter((s) => !s.test);
  if (subs.length > 0 && subs.every((s) => s.status === "cancelled" || s.status === "ended")) return "the client has ended";
  if (o.step === "december_letter" && !subs.some((s) => s.status === "active" || s.status === "past_due")) return "the client has no live subscription";
  const conflict = await checkConflict(db, { email: o.email, businessId });
  if (conflict.blocked && conflict.source !== "client") return `blocked: ${conflict.reason}`;
  return null;
}
