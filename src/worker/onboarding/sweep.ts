import type { Env } from "../env";
import { CLIENT_BASE_PROBLEM } from "../approvals/onboardingWelcome";
import { describeNudge, ownerZone, recipientOf, type OnboardingNudgePayload } from "../approvals/onboardingNudge";
import { logActivityOnce } from "../db/activity";
import { createApproval } from "../db/approvals";
import {
  attachNudgeApproval, forgetNudge, listItems, listNudgeKeys, listOpenOnboardings, recordNudge, type Onboarding, type OnboardingItem,
} from "../db/onboardings";
import { getSettings } from "../db/settings";
import { clientBase } from "../documents/mail";
import { SILENCE_DAYS, nudgesDue, stageOf, type Nudge } from "./schedule";

const DAY = 86_400_000;
/** A test onboarding is a rehearsal: the sweep keeps drafting for it only this many days after it was made. */
export const TEST_SWEEP_DAYS = 21;
export interface SweepResult { reminders: number; fridays: number; waiting: number }

const msg = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/**
 * The daily onboarding sweep: for every open onboarding (an archived lead's too) it drafts the reminder or Friday update that is due, as an approval. It never
 * sends mail and never throws: each onboarding, and each nudge within one, is contained and logged, so one broken row cannot stop the rest.
 *
 * A reminder is drafted for the HIGHEST level that has come due and not yet been raised for the client's current stretch of silence. After a cron outage a client silent
 * for 10 days gets one level-4 reminder, not four: the lower levels are marked as handled with no approval, so they are never drafted later. Each nudge is claimed in
 * `onboarding_nudges` before its approval is made (so two sweeps at once raise it once) and released if the approval cannot be made (so tomorrow's sweep tries again).
 */
export async function sweepOnboardings(env: Env, now: Date): Promise<SweepResult> {
  const out: SweepResult = { reminders: 0, fridays: 0, waiting: 0 };
  let open: Onboarding[], tz: string;
  try {
    open = await listOpenOnboardings(env.DB);
    tz = ownerZone(await getSettings(env.DB));
  } catch (e) {
    console.error("onboarding sweep: could not list the onboardings", msg(e));
    return out;
  }
  for (const o of open) {
    try {
      const r = await sweepOne(env, o, now, tz);
      out.reminders += r.reminders; out.fridays += r.fridays; out.waiting += r.waiting;
    } catch (e) {
      console.error(`onboarding sweep: ${o.id} failed`, msg(e));
    }
  }
  return out;
}

async function sweepOne(env: Env, o: Onboarding, now: Date, tz: string): Promise<SweepResult> {
  const db = env.DB;
  const out: SweepResult = { reminders: 0, fridays: 0, waiting: 0 };
  if (!o.welcomeSentAt) return out;
  if (o.test && now.getTime() >= Date.parse(o.createdAt) + TEST_SWEEP_DAYS * DAY) return out;
  const items = await listItems(db, o.id);
  const stage = stageOf(o, items, now);
  if (stage === "complete") return out;

  // The contract's silence clause: noted once per stretch of silence (the line carries the date the client last wrote, so a new stretch is a new line).
  // A rehearsal never writes the contract's clause on the lead.
  if (stage === "waiting_on_client" && !o.test) {
    const last = (o.lastClientActivityAt ?? o.welcomeSentAt).slice(0, 10);
    if (await logActivityOnce(db, o.businessId, "onboarding_waiting", `no reply for ${SILENCE_DAYS} days (last heard from the client ${last}): the back-of-queue clause applies`)) out.waiting = 1;
  }

  const due = nudgesDue(o, items, now, tz);
  const recorded = new Set((await listNudgeKeys(db, o.id)).map((k) => k.key));
  const reminders = due.filter((n) => n.kind === "reminder");
  const top = reminders.reduce<Nudge | null>((best, n) => (!best || (n.level ?? 0) > (best.level ?? 0) ? n : best), null);
  const wanted: Nudge[] = [];
  if (top && !recorded.has(top.key)) wanted.push(top);
  // `nudgesDue` offers a Friday email on the day the welcome went out; that day the welcome is the update.
  const friday = due.find((n) => n.kind === "friday");
  if (friday && !recorded.has(friday.key) && now.getTime() - Date.parse(o.welcomeSentAt) >= DAY) wanted.push(friday);
  if (!wanted.length) return out;

  // Cases where nothing can be drafted: said once on the lead, nothing claimed, so the first sweep after the fix drafts it.
  const problem = await draftingProblem(env, o);
  if (problem) {
    await logActivityOnce(db, o.businessId, "note", `onboarding reminder not drafted: ${problem.text}`, problem.since);
    return out;
  }

  if (top && wanted[0] === top) {
    for (const lower of reminders) if (lower !== top) await recordNudge(db, o.id, lower.key, now.toISOString()); // handled, never drafted
  }
  for (const n of wanted) {
    if (!(await draft(env, o, items, n, now))) continue;
    if (n.kind === "reminder") out.reminders++; else out.fridays++;
  }
  return out;
}

/** What stops a nudge being drafted at all, with the time a repeat of the note is measured from (so a link revoked again is noted again). */
async function draftingProblem(env: Env, o: Onboarding): Promise<{ text: string; since: string } | null> {
  if (o.revokedAt) return { text: "the client's link is revoked (make a new link or restore it)", since: o.revokedAt };
  if (!clientBase(env)) return { text: CLIENT_BASE_PROBLEM, since: "" };
  if (!(await recipientOf(env, o)).to) return { text: o.test ? "add your contact email in Settings (a test goes to it)" : "the proposal has no contact email", since: "" };
  return null;
}

/** Claims the nudge, then raises its approval. True when an approval was made; a failure releases the claim and is logged. */
async function draft(env: Env, o: Onboarding, items: OnboardingItem[], n: Nudge, now: Date): Promise<boolean> {
  const db = env.DB;
  if (!(await recordNudge(db, o.id, n.key, now.toISOString()))) return false; // another sweep has it
  let approvalId: string;
  try {
    const d = await describeNudge(env, o, items, n.key);
    const a = await createApproval(db, {
      kind: "onboarding.nudge", title: d.title, preview: d.preview, payload: { onboardingId: o.id, nudgeKey: n.key } satisfies OnboardingNudgePayload,
      record_type: "deal", record_id: o.dealId, drafted_by: "job",
    });
    approvalId = a.id;
  } catch (e) {
    console.error(`onboarding sweep: could not draft ${n.key} for ${o.id}`, msg(e));
    await forgetNudge(db, o.id, n.key).catch((err) => console.error("onboarding sweep: could not release the nudge", msg(err)));
    return false;
  }
  // The approval exists: a failure here must not release the claim (that would draft it twice).
  await attachNudgeApproval(db, o.id, n.key, approvalId).catch((e) => console.error("onboarding sweep: could not link the approval to its nudge", msg(e)));
  return true;
}
