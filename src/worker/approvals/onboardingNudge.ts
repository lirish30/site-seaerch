import { z } from "zod";
import type { Env } from "../env";
import type { Settings } from "../types";
import { registerHandler } from "./registry";
import { logActivity } from "../db/activity";
import type { Approval } from "../db/approvals";
import { getDocument } from "../db/documents";
import { getOnboarding, listItems, listNudgeKeys, type Onboarding, type OnboardingItem } from "../db/onboardings";
import { getSettings } from "../db/settings";
import { parseConfig } from "../booking/config";
import { mainMailboxProblem } from "../booking/mail";
import { clientBase } from "../documents/mail";
import { getMailDeps } from "../mail/deps";
import { sendEmail } from "../mail/send";
import { onboardingLink } from "../onboarding/link";
import { renderFriday, renderReminder, type OnboardingMail } from "../onboarding/mail";
import { stageOf } from "../onboarding/schedule";
import { CLIENT_BASE_PROBLEM } from "./onboardingWelcome";

/**
 * The approval behind a reminder or a Friday email. The sweep drafts it (nothing is mailed by the sweep); approving it sends the mail from the `main`
 * mailbox. The payload is the onboarding and the nudge's key (`reminder:<level>:<last client activity>` or `friday:<date>`), and the mail itself is built
 * from the onboarding as it is when the approval is run, so what goes out is never older than the click.
 */
const Payload = z.object({ onboardingId: z.string().min(1), nudgeKey: z.string().min(1) }).refine((p) => !!parseNudgeKey(p.nudgeKey), "unknown nudge key");
export type OnboardingNudgePayload = z.infer<typeof Payload>;

/** The zone Friday and the clause day are counted in when the settings hold one Intl does not know (the booking config's own default). */
export const FALLBACK_TZ = "America/Los_Angeles";

/** The owner's IANA zone from the booking config, checked with the same Intl call `nudgesDue` uses: an unreadable one gives Los Angeles, not silence. */
export function ownerZone(settings: Pick<Settings, "booking_config">): string {
  const tz = parseConfig(settings.booking_config).timezone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return FALLBACK_TZ; }
}

export type ParsedKey = { kind: "reminder"; level: 1 | 2 | 3 | 4; since: string } | { kind: "friday"; level: null; since: null };

/** A nudge key's parts, or null when it is not one the schedule makes. For a reminder, `since` is the client activity the ladder was counted from ("none" before any). */
export function parseNudgeKey(key: string): ParsedKey | null {
  const r = /^reminder:([1-4]):(.+)$/.exec(key);
  if (r) return { kind: "reminder", level: Number(r[1]) as 1 | 2 | 3 | 4, since: r[2] };
  if (/^friday:\d{4}-\d{2}-\d{2}$/.test(key)) return { kind: "friday", level: null, since: null };
  return null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Who a nudge goes to: a test onboarding's mail is a message to the owner and only the owner, never the contact on the document. */
export async function recipientOf(env: Env, o: Onboarding) {
  const doc = await getDocument(env.DB, o.documentId);
  if (!doc) throw new Error("this onboarding's proposal was not found");
  const settings = await getSettings(env.DB);
  const h = doc.content.header;
  const to = o.test ? settings.contact_email.trim() : h.contactEmail.trim();
  return { settings, h, to };
}

/** The mail for one nudge, from the onboarding as it is now. Throws when the client base is not set (there is no link to put in it). */
export async function buildNudge(env: Env, o: Onboarding, items: OnboardingItem[], key: string) {
  const n = parseNudgeKey(key);
  if (!n) throw new Error(`unknown nudge key ${key}`);
  const { settings, h, to } = await recipientOf(env, o);
  const link = onboardingLink(clientBase(env) ?? undefined, o.token);
  if (!link) throw new Error(CLIENT_BASE_PROBLEM);
  const names = { clientName: h.clientName, contactName: h.contactName };
  const mail: OnboardingMail = n.kind === "reminder"
    ? renderReminder(n.level, { ...names, lastClientActivityAt: o.lastClientActivityAt ?? o.welcomeSentAt, tz: ownerZone(settings) }, link, settings)
    : renderFriday({
      ...names,
      waiting: items.filter((i) => i.status === "waiting").map((i) => i.label),
      received: items.filter((i) => i.status === "received" || i.status === "accepted").map((i) => i.label),
      questionnaireDone: !!o.questionnaireSubmittedAt,
    }, link, settings);
  return { settings, h, to, subject: o.test ? `[Test] ${mail.subject}` : mail.subject, body: mail.body, link };
}

/** The approval's title and preview: who it goes to, the subject and the words, as the mail reads now. */
export async function describeNudge(env: Env, o: Onboarding, items: OnboardingItem[], key: string): Promise<{ title: string; preview: string }> {
  const w = await buildNudge(env, o, items, key);
  const who = o.test
    ? `${w.settings.your_name.trim() || "You"} <${w.to}> (a test: nothing goes to ${w.h.contactEmail.trim() || "the client"})`
    : `${oneLine(w.h.contactName) || w.h.clientName} <${w.to}>`;
  const title = `${parseNudgeKey(key)!.kind === "friday" ? "Friday update to" : "Reminder to"} ${w.h.clientName}`;
  return { title, preview: [`To: ${who}`, `Subject: ${w.subject}`, "", w.body].join("\n") };
}

/**
 * Why this nudge is no longer worth sending, or null when it still is. A reminder is stale once the client has written since the activity it was counted
 * from (the ladder starts again), or once a newer one of its kind has an approval; every nudge is stale once the onboarding is closed, its link revoked or everything the client owed is in.
 */
async function staleReason(db: D1Database, o: Onboarding, items: OnboardingItem[], key: string, n: ParsedKey, now: Date): Promise<string | null> {
  if (o.closedAt) return "the onboarding is closed";
  if (o.revokedAt) return "the client's link was revoked";
  if (!o.welcomeSentAt) return "the welcome has not gone out";
  if (stageOf(o, items, now) === "complete") return "everything the client owed is in";
  if (n.kind === "reminder" && o.lastClientActivityAt) {
    const since = n.since === "none" ? -Infinity : Date.parse(n.since);
    if (Date.parse(o.lastClientActivityAt) > since) return "the client was in touch after it was drafted";
  }
  // A newer approved-or-pending nudge replaces an older one, so a bulk approve after time away is not a burst. Only keys that raised an approval count:
  // the lower levels marked as handled with no approval never cause a skip.
  const newer = (await listNudgeKeys(db, o.id)).filter((k) => k.approvalId && k.key !== key).map((k) => ({ k: k.key, p: parseNudgeKey(k.key) }));
  if (n.kind === "reminder" && newer.some((x) => x.p?.kind === "reminder" && x.p.since === n.since && x.p.level > n.level)) return "a newer reminder replaces it";
  if (n.kind === "friday" && newer.some((x) => x.p?.kind === "friday" && x.k > key)) return "a newer Friday update replaces it";
  return null;
}

registerHandler({
  kind: "onboarding.nudge",
  label: "Send onboarding reminder",
  parse: (p) => Payload.parse(p),
  /**
   * A nudge that no longer applies is NOT an error: a throw would put the approval back to pending for good. It sends nothing, writes a note on the lead's
   * timeline and returns, which decides the approval. Anything else that stops the mail (the mailbox, the client base, no address) throws, so it can be fixed and run again.
   * The mail goes out with the approval id as the once-only key, so running the same approval twice sends once.
   */
  async execute(env: Env, p: OnboardingNudgePayload, a: Approval) {
    const o = await getOnboarding(env.DB, p.onboardingId);
    if (!o) { console.error("onboarding nudge: the onboarding is gone, nothing sent", p.onboardingId); return; }
    const items = await listItems(env.DB, o.id);
    const reason = await staleReason(env.DB, o, items, p.nudgeKey, parseNudgeKey(p.nudgeKey)!, getMailDeps().now());
    if (reason) { await logActivity(env.DB, o.businessId, "note", `reminder skipped: ${reason}`); return; }

    const problem = await mainMailboxProblem(env);
    if (problem) throw new Error(`The main mailbox cannot send: ${problem}`);
    const w = await buildNudge(env, o, items, p.nudgeKey);
    if (!w.to) throw new Error(o.test ? "Add your contact email in Settings first: the test goes to it." : "this proposal has no contact email");
    await sendEmail(env, { mailbox: "main", to: w.to, subject: w.subject, body: w.body, includeFooter: false, ...(o.test ? {} : { businessId: o.businessId }) }, { approvalId: a.id, skipLimits: true });
  },
});
