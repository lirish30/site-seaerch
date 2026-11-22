import { LADDER_MAIL_KIND } from "../approvals/ladderMail"; // importing it registers the kind, which must exist before an approval of it is made
import { calendarDateIn, calendarDaysBetween } from "../billing/dates";
import { signOff } from "../billing/mail";
import { clientSql, testClientSql } from "../clients/record";
import { createApprovalOnce } from "../db/approvals";
import { getBusiness } from "../db/businesses";
import { dueLadderRows, insertLadderRows, moveLadder, type LadderRow } from "../db/ladder";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { backfillLadder } from "./hooks";
import { LADDER_STEP_TITLE, isLadderMailStep, ladderMail, type LadderMailStep } from "./mail";
import { clientBlock, ladderRecipient, reviewLinkFor } from "./recipient";
import { decemberRow } from "./schedule";

/** A step still waiting more than this many days after its day is skipped, not sent: a thank-you months late reads wrong. */
export const MAX_LATE_DAYS = 45;
/** The most mails one run drafts; the rest are picked up by the next run, the oldest first. */
export const MAX_DRAFTS_PER_RUN = 10;
const SCAN_LIMIT = 2000;

const SKIP_LATE = `skipped: more than ${MAX_LATE_DAYS} days late`;
const SKIP_YEAR = "skipped: the year ended before it was sent";

/** True when a waiting step is too late to send: the December letter after 31 December of its year, any other step more than `MAX_LATE_DAYS` days after its day. */
export function tooLate(row: Pick<LadderRow, "step" | "dueOn">, today: string): boolean {
  if (row.step === "december_letter") return today > `${row.dueOn.slice(0, 4)}-12-31`;
  return calendarDaysBetween(row.dueOn, today) > MAX_LATE_DAYS;
}

/** The live real clients (a client that is not a rehearsal, with a subscription that is billing or late on a bill), who each get a December letter. */
async function liveClientIds(db: D1Database): Promise<string[]> {
  return (await db.prepare(
    `SELECT b.id AS id FROM businesses b
     WHERE b.archived_at IS NULL AND ${clientSql("b")} AND NOT ${testClientSql("b")}
       AND EXISTS (SELECT 1 FROM subscriptions u WHERE u.business_id = b.id AND u.test = 0 AND u.status IN ('active', 'past_due'))
     ORDER BY b.created_at, b.id`,
  ).all<{ id: string }>()).results.map((r) => r.id);
}

/** The approval already made for a step (in any state), or null: a crash between making it and marking the step leaves one behind. */
async function approvalFor(db: D1Database, ladderId: string): Promise<string | null> {
  return (await db.prepare(`SELECT id FROM approvals WHERE kind = ? AND json_extract(payload, '$.ladderId') = ? ORDER BY created_at, id LIMIT 1`).bind(LADDER_MAIL_KIND, ladderId).first<{ id: string }>())?.id ?? null;
}

/**
 * The daily ladder sweep (Plan 15), in this order: adds the steps of any build whose hook never ran; from 1 December on, adds this year's December letter for each live real client (once); skips any waiting step that is
 * too late (more than 45 days, the December letter after 31 December) with a plain note; then takes the oldest waiting steps that are due today or earlier and, for each, in order: a client that is held, a rehearsal, ended
 * (it has a subscription and all are cancelled or ended; a build-only client with none is not), on the do-not-contact list, or (for the December letter) with no live subscription keeps its step `waiting` and is counted as held;
 * a thank-you or a case study becomes `due` (it shows on Today); a review request with no link, or any mail step with no contact email, becomes `due` with a note saying what is missing; anything else becomes one `ladder.mail`
 * approval and the step `drafted`. At most `MAX_DRAFTS_PER_RUN` approvals are made. Nothing is ever mailed here: only an approved `ladder.mail` sends.
 */
export async function sweepLadder(env: Env, now: Date): Promise<{ filled: number; drafted: number; due: number; skipped: number; held: number }> {
  const db = env.DB;
  const nowIso = now.toISOString();
  const out = { filled: 0, drafted: 0, due: 0, skipped: 0, held: 0 };
  out.filled += await backfillLadder(env, now);

  const settings = await getSettings(db);
  const today = calendarDateIn(now, zoneOf(settings));
  const year = Number(today.slice(0, 4));
  if (today >= `${year}-12-01`) out.filled += await insertLadderRows(db, (await liveClientIds(db)).map((id) => decemberRow(id, year)), nowIso);

  const rows = await dueLadderRows(db, today, SCAN_LIMIT);
  const waiting: LadderRow[] = [];
  for (const row of rows) {
    if (tooLate(row, today)) {
      if (await moveLadder(db, row.id, ["waiting"], "skipped", { note: row.step === "december_letter" ? SKIP_YEAR : SKIP_LATE, now: nowIso })) out.skipped++;
    } else waiting.push(row);
  }

  const names = new Map<string, string>();
  // A client with several steps due is read once (the December letter asks one more question than the others), so the run's reads stay bounded however many held steps are waiting.
  const whoOf = new Map<string, Awaited<ReturnType<typeof ladderRecipient>>>();
  const blockOf = new Map<string, string | null>();
  for (const row of waiting) {
    if (out.drafted >= MAX_DRAFTS_PER_RUN) break;
    if (!whoOf.has(row.businessId)) whoOf.set(row.businessId, await ladderRecipient(db, row.businessId));
    const who = whoOf.get(row.businessId) ?? null;
    const blockKey = `${row.businessId}|${row.step === "december_letter"}`;
    if (!blockOf.has(blockKey)) blockOf.set(blockKey, await clientBlock(db, row.businessId, { step: row.step, email: who?.to ?? "" }));
    const blocked = blockOf.get(blockKey);
    if (blocked) { out.held++; continue; }
    if (!isLadderMailStep(row.step)) { // a thank-you package or a case study post is the owner's own work: it shows on Today
      if (await moveLadder(db, row.id, ["waiting"], "due", {})) out.due++;
      continue;
    }
    const link = row.step === "review_request" ? await reviewLinkFor(db, row.businessId, row) : null;
    const missing = [...(row.step === "review_request" && !link ? ["the Google review link"] : []), ...(!who ? ["a contact email"] : [])];
    if (missing.length > 0 || !who) {
      if (await moveLadder(db, row.id, ["waiting"], "due", { note: `add ${missing.join(" and ")}` })) out.due++;
      continue;
    }
    if (!names.has(row.businessId)) names.set(row.businessId, ((await getBusiness(db, row.businessId))?.name ?? "the client").replace(/\s+/g, " ").trim());
    const mail = ladderMail(row.step as LadderMailStep, {
      contactName: who.contactName, yourName: signOff(settings), link, year: Number(row.step === "december_letter" ? row.dueOn.slice(0, 4) : year), personalLine: "",
    });
    const made = await createApprovalOnce(db, {
      kind: LADDER_MAIL_KIND, title: `${LADDER_STEP_TITLE[row.step]} for ${names.get(row.businessId)}`.slice(0, 200),
      preview: [`To: ${who.contactName ? `${who.contactName} <${who.to}>` : who.to}`, `Subject: ${mail.subject}`, "", mail.body, "", "Nothing is mailed until you approve. If the step is skipped or the client goes on hold first, approving sends nothing."].join("\n"),
      payload: { ladderId: row.id }, record_type: "business", record_id: row.businessId, drafted_by: "logan",
    }, "ladderId", row.id);
    const approvalId = made?.id ?? (await approvalFor(db, row.id));
    if (!approvalId) continue;
    if (await moveLadder(db, row.id, ["waiting"], "drafted", { approvalId }) && made) out.drafted++;
  }
  return out;
}
