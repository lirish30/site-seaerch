import type { PackageSnapshot } from "./packages";
import type { Option } from "../sales/options";
import type { CallPrep } from "../queue/callPrep";
import type { CallRecap } from "../queue/callRecap";
import type { DiscoveryNotes } from "../sales/notes";

export const STAGE_ORDER = ["booked", "discovery_done", "recommendation_booked", "recommended", "proposal_sent", "won", "lost"] as const;
export type DealStage = (typeof STAGE_ORDER)[number];
export const isDealStage = (s: unknown): s is DealStage => typeof s === "string" && (STAGE_ORDER as readonly string[]).includes(s);

export interface Deal {
  id: string; businessId: string; stage: DealStage; source: "booking" | "manual"; skipCall: boolean;
  options: Option[] | null; recommendedOptionId: "a" | "b" | "c" | null; priceSnapshot: PackageSnapshot[]; valueCents: number | null;
  notes: DiscoveryNotes | null; callPrep: CallPrep | null; recap: CallRecap | null;
  deckFrozenAt: string | null; lostReason: string | null; createdAt: string; updatedAt: string; closedAt: string | null;
}

/** The move is not allowed from where the deal is (a 409). */
export class DealMoveError extends Error {}
/** The request is missing something (a 400). */
export class DealInputError extends Error {}

interface Row {
  id: string; business_id: string; stage: DealStage; source: "booking" | "manual"; skip_call: number;
  options: string | null; recommended_option_id: "a" | "b" | "c" | null; price_snapshot: string; value_cents: number | null;
  notes: string | null; call_prep: string | null; recap: string | null;
  deck_frozen_at: string | null; lost_reason: string | null; created_at: string; updated_at: string; closed_at: string | null;
}

/** A JSON column read back; a missing or damaged value is `null`, never a thrown error. */
function parse<T>(s: string | null, ok: (v: unknown) => boolean): T | null {
  if (s === null) return null;
  try { const v = JSON.parse(s); return ok(v) ? (v as T) : null; } catch { return null; }
}

const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObjects = (v: unknown) => Array.isArray(v) && v.every((x) => x !== null && typeof x === "object");
/**
 * Whether a stored call prep has the shape the panel reads. The column holds what Claude's result was when it was stored, so this guards against a
 * hand-edited or older row (the panel then falls back to the fixed structure and questions) rather than re-validating a result `apply` already checked.
 */
const isCallPrep = (v: unknown): boolean => {
  const o = v as Record<string, unknown> | null;
  return o !== null && typeof o === "object" && typeof o.opener === "string" && typeof o.generatedAt === "string" && isObjects(o.flags) && isObjects(o.questionNotes)
    && isObjects(o.pushbacks) && isStrings(o.watchFor);
};

/** Whether stored notes have the shape the Notes tab and the recap read: the column holds what the notes schema accepted, so this only guards a hand-edited or older row. */
const isNotes = (v: unknown): boolean => {
  const o = v as Record<string, unknown> | null;
  const num = (x: unknown) => x === null || typeof x === "number";
  return o !== null && typeof o === "object" && isObjects(o.answers) && (o.answers as { n?: unknown; text?: unknown }[]).every((a) => typeof a.n === "number" && typeof a.text === "string")
    && isStrings(o.goals) && isStrings(o.currentState) && num(o.avgJobValueCents) && num(o.missedJobsPerMonth)
    && (o.platform === "wordpress" || o.platform === "other") && typeof o.decisionMakers === "string" && (o.callHeldAt === null || typeof o.callHeldAt === "string");
};
/** Whether a stored recap has the shape the Recap tab reads (the options are a separate column). */
const isRecap = (v: unknown): boolean => {
  const o = v as Record<string, unknown> | null;
  return o !== null && typeof o === "object" && typeof o.playback === "string" && typeof o.recommendation === "string" && typeof o.leadType === "string"
    && typeof o.generatedAt === "string" && isStrings(o.goals) && isStrings(o.currentState);
};

const toDeal = (r: Row): Deal => ({
  id: r.id, businessId: r.business_id, stage: r.stage, source: r.source, skipCall: !!r.skip_call,
  options: parse<Option[]>(r.options, Array.isArray),
  recommendedOptionId: r.recommended_option_id,
  priceSnapshot: parse<PackageSnapshot[]>(r.price_snapshot, Array.isArray) ?? [],
  valueCents: r.value_cents,
  notes: parse<DiscoveryNotes>(r.notes, isNotes), callPrep: parse<CallPrep>(r.call_prep, isCallPrep), recap: parse<CallRecap>(r.recap, isRecap),
  deckFrozenAt: r.deck_frozen_at, lostReason: r.lost_reason, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
});

const isClosed = (s: DealStage) => s === "won" || s === "lost";

/** A deal only moves forward (skipping stages is fine: a Quick Fix lead skips the call), and any open deal can be lost. Nothing leaves won or lost. */
export function canMove(from: DealStage, to: DealStage): boolean {
  if (isClosed(from)) return false;
  if (to === "lost") return true;
  return STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from);
}

export async function getDeal(db: D1Database, id: string): Promise<Deal | null> {
  const r = await db.prepare(`SELECT * FROM deals WHERE id = ?`).bind(id).first<Row>();
  return r ? toDeal(r) : null;
}

/** The lead's open deal (not won or lost), if it has one. */
export async function openDealFor(db: D1Database, businessId: string): Promise<Deal | null> {
  const r = await db.prepare(`SELECT * FROM deals WHERE business_id = ? AND stage NOT IN ('won', 'lost')`).bind(businessId).first<Row>();
  return r ? toDeal(r) : null;
}

/**
 * Starts a deal at `booked`, or at `discovery_done` when the call is skipped. A lead has one open deal: if it already has one, that one is
 * returned and nothing is created.
 */
export async function createDeal(db: D1Database, o: { businessId: string; source: "booking" | "manual"; skipCall?: boolean }): Promise<Deal> {
  const existing = await openDealFor(db, o.businessId);
  if (existing) return existing;
  const skipCall = o.skipCall === true;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO deals (id, business_id, stage, source, skip_call, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, o.businessId, skipCall ? "discovery_done" : "booked", o.source, skipCall ? 1 : 0, now, now).run();
  } catch (e) {
    // A second request won the race for the one open-deal slot: hand back its deal.
    const winner = await openDealFor(db, o.businessId);
    if (winner) return winner;
    throw e;
  }
  return (await getDeal(db, id))!;
}

/** Moves a deal to a later stage, or to lost with a reason. Won and lost close it. */
export async function moveDeal(db: D1Database, id: string, to: DealStage, opts: { lostReason?: string } = {}): Promise<Deal> {
  const deal = await getDeal(db, id);
  if (!deal) throw new DealMoveError("deal not found");
  if (!canMove(deal.stage, to)) throw new DealMoveError(`a deal cannot move from ${deal.stage} to ${to}`);
  const reason = opts.lostReason?.trim() ?? "";
  if (to === "lost" && !reason) throw new DealInputError("a lost deal needs a reason");
  const now = new Date().toISOString();
  // Guarded on the stage we read, so two moves at once cannot both succeed.
  const res = await db.prepare(`UPDATE deals SET stage = ?, lost_reason = ?, updated_at = ?, closed_at = ? WHERE id = ? AND stage = ?`)
    .bind(to, to === "lost" ? reason : deal.lostReason, now, isClosed(to) ? now : null, id, deal.stage).run();
  if ((res.meta.changes ?? 0) !== 1) throw new DealMoveError("the deal changed; reload and try again");
  return (await getDeal(db, id))!;
}

/** Stores the call prep Claude wrote. It is background work, so the deal's `updated_at` (which orders the board) is left alone. */
export function saveCallPrepStmt(db: D1Database, id: string, prep: CallPrep): D1PreparedStatement {
  return db.prepare(`UPDATE deals SET call_prep = ? WHERE id = ?`).bind(JSON.stringify(prep), id);
}

/** Stores Logan's discovery notes. It is his own work on the deal, so it counts as a touch (`updated_at`), unlike the queue's background writes. */
export async function saveNotes(db: D1Database, id: string, notes: DiscoveryNotes): Promise<void> {
  await db.prepare(`UPDATE deals SET notes = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(notes), new Date().toISOString(), id).run();
}

/** The three options with what they were priced from: the packages (at the versions used), the recommended one and its value. */
export interface DealOffer { options: Option[]; recommendedOptionId: "a" | "b" | "c"; priceSnapshot: PackageSnapshot[]; valueCents: number }

/**
 * Stores the recap Claude wrote with its options, in one statement. Background work, so `updated_at` is left alone (like the call prep). A new recap
 * brings a new price snapshot, so the deck is a draft again (`deck_frozen_at` cleared): the next view freezes the new prices.
 */
export function saveRecapStmt(db: D1Database, id: string, recap: CallRecap, o: DealOffer): D1PreparedStatement {
  return db.prepare(`UPDATE deals SET recap = ?, options = ?, recommended_option_id = ?, price_snapshot = ?, value_cents = ?, deck_frozen_at = NULL WHERE id = ?`)
    .bind(JSON.stringify(recap), JSON.stringify(o.options), o.recommendedOptionId, JSON.stringify(o.priceSnapshot), o.valueCents, id);
}

/** Stores Logan's edit of the three options. His own work, so it counts as a touch. It re-snapshots the prices, so the deck is a draft again (`deck_frozen_at` cleared). */
export async function saveOptions(db: D1Database, id: string, o: DealOffer): Promise<void> {
  await db.prepare(`UPDATE deals SET options = ?, recommended_option_id = ?, price_snapshot = ?, value_cents = ?, deck_frozen_at = NULL, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(o.options), o.recommendedOptionId, JSON.stringify(o.priceSnapshot), o.valueCents, new Date().toISOString(), id).run();
}

/** The first view of the deck freezes it: stamps the time when it is not stamped yet, and leaves the stored prices as the recap or the last option edit snapshotted them. */
export async function stampDeckFrozen(db: D1Database, id: string, now = new Date()): Promise<void> {
  await db.prepare(`UPDATE deals SET deck_frozen_at = ? WHERE id = ? AND deck_frozen_at IS NULL`).bind(now.toISOString(), id).run();
}

/** Freezes the deck on the catalog as it is now: the new price snapshot and the value that goes with it, and the time. Not a touch (`updated_at` is left alone). */
export async function freezeDeckOn(db: D1Database, id: string, o: Pick<DealOffer, "priceSnapshot" | "valueCents">, now = new Date()): Promise<void> {
  await db.prepare(`UPDATE deals SET price_snapshot = ?, value_cents = ?, deck_frozen_at = ? WHERE id = ?`).bind(JSON.stringify(o.priceSnapshot), o.valueCents, now.toISOString(), id).run();
}

/** Every deal with its lead's name, newest activity first. */
export async function listDeals(db: D1Database, o: { openOnly?: boolean } = {}): Promise<(Deal & { businessName: string })[]> {
  const rows = (await db.prepare(
    `SELECT d.*, b.name AS business_name FROM deals d JOIN businesses b ON b.id = d.business_id
     ${o.openOnly ? `WHERE d.stage NOT IN ('won', 'lost')` : ""} ORDER BY d.updated_at DESC, d.id`,
  ).all<Row & { business_name: string }>()).results;
  return rows.map((r) => ({ ...toDeal(r), businessName: r.business_name }));
}
