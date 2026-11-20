import { dollars } from "../../client/packagesView";
import { createApproval, toApproval, type Approval } from "../db/approvals";
import { getBusiness } from "../db/businesses";
import { getDocument, type Document } from "../db/documents";
import { getPackage } from "../db/packages";
import { getProject, type Project } from "../db/projects";
import { getSettings } from "../db/settings";
import { getSubscription, insertPlanned, listSubscriptions, markSubscription, type Subscription } from "../db/subscriptions";
import { clientBase } from "../documents/mail";
import type { Env } from "../env";
import { getMailDeps } from "../mail/deps";
import { chargedAtCheckout } from "../stripe/client";
import { onProjectDone } from "../projects/hooks";
import { zoneOf } from "../sop/cadence";
import "../approvals/subscriptionStart"; // the kind must be registered before an approval of it is made
import { addMonths, calendarDateIn } from "./dates";
import { invoiceRecipient, longDate, renderSubscriptionLink, signOff, subscriptionPlanName, type Recipient } from "./mail";

export const START_KIND = "subscription.start";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T12:00:00.000Z`).toISOString().startsWith(d);

const waiting = (db: D1Database, subscriptionId: string) => db.prepare(
  `SELECT * FROM approvals WHERE kind = '${START_KIND}' AND status = 'pending' AND json_extract(payload, '$.subscriptionId') = ? ORDER BY created_at, id`,
).bind(subscriptionId).all<Parameters<typeof toApproval>[0]>().then((r) => r.results.map(toApproval));

/**
 * Plans the subscriptions a signed, real document sold: one `planned` row for every recurring line of its frozen payment schedule, at the price and term the client signed. Only the Website
 * Subscription converts to Care at the end of its term. A test copy plans nothing, and neither does a document that is not signed. Idempotent: a second call adds nothing (one row per document
 * and package). Returns how many rows this call made. Nothing is proposed, mailed or made at Stripe.
 */
export async function planSubscriptions(env: Env, doc: Document): Promise<number> {
  if (doc.test || doc.status !== "signed") return 0;
  let made = 0;
  for (const r of doc.content.schedule.recurring) {
    const version = doc.content.packages.find((p) => p.key === r.key)?.version ?? (await getPackage(env.DB, r.key))?.version;
    if (version === undefined) { console.error("subscriptions: a recurring line has no package", r.key); continue; }
    const { created } = await insertPlanned(env.DB, {
      businessId: doc.businessId, documentId: doc.id, projectId: null, packageKey: r.key, packageVersion: version, monthlyCents: r.monthlyCents, startsWhen: r.startsOn,
      firstChargeOn: null, termMonths: r.termMonths, termEndsOn: null, endAction: r.key === "website_subscription" ? "convert_to_care" : "none", test: false,
    });
    if (created) made++;
  }
  return made;
}

/**
 * True when a `link_sent` subscription's link never reached the client and nothing is under way at Stripe: no Checkout session on record, and none of its `subscription.start` approvals has a mail
 * that went out (or is going). That is what a failed mail followed by a rejected approval leaves: a row that says the link was sent, with nobody holding it. Such a row may be put up again.
 */
export async function linkNeverReachedClient(db: D1Database, sub: Subscription): Promise<boolean> {
  if (sub.status !== "link_sent" || sub.stripeCheckoutSessionId) return false;
  const sentOrSending = await db.prepare(
    `SELECT 1 AS x FROM approvals a JOIN messages m ON m.approval_id = a.id
      WHERE a.kind = '${START_KIND}' AND json_extract(a.payload, '$.subscriptionId') = ? AND m.direction = 'out' AND m.status IN ('sent', 'sending') LIMIT 1`,
  ).bind(sub.id).first();
  return !sentOrSending;
}

/** What the mail will be, as far as it can be known before the link exists (the token is made when Logan approves). */
async function previewOf(env: Env, sub: Subscription, firstChargeOn: string): Promise<{ title: string; preview: string }> {
  const settings = await getSettings(env.DB);
  let who: Recipient | null = null, problem = "";
  try { who = await invoiceRecipient(env, sub); } catch (e) { problem = e instanceof Error ? e.message : "no recipient"; }
  const clientName = who?.clientName || (await getBusiness(env.DB, sub.businessId))?.name || "the client";
  const plan = await subscriptionPlanName(env, sub);
  const link = `${clientBase(env) ?? "(set CLIENT_LINK_BASE first)"}/s/(the link is made when you approve)`;
  const mail = renderSubscriptionLink({ ...sub, firstChargeOn }, link, { clientName, contactName: who?.contactName ?? "", yourName: signOff(settings), planName: plan, chargedNow: chargedAtCheckout(firstChargeOn, getMailDeps().now().getTime()) });
  const toLine = !who ? `To: nobody yet (${problem})`
    : sub.test ? `To: ${settings.your_name.trim() || "You"} <${settings.contact_email.trim()}> (a test: nothing goes to ${who.to})`
    : `To: ${who.contactName ? `${who.contactName} <${who.to}>` : who.to}`;
  const after = sub.endAction === "convert_to_care" ? " (then it moves to Care, unless the client chooses a refresh)" : "";
  const preview = [
    toLine, `Subject: ${sub.test ? "[Test] " : ""}${mail.subject}`, "", mail.body, "",
    `Plan: ${plan}`,
    `Monthly price: ${dollars(sub.monthlyCents)} a month`,
    `First charge: ${longDate(firstChargeOn)}`,
    `Term: ${sub.termMonths ? `${sub.termMonths} months${after}` : "no fixed term"}`,
    "", "Nothing is mailed, and no link works, until you approve. The client starts the payment on their own page, through Stripe.",
  ].join("\n");
  return { title: `Send ${plan} link to ${clientName}`.replace(/\s+/g, " ").slice(0, 200), preview };
}

/**
 * Puts a subscription up for approval: the plan, the monthly price, the first charge date, the term and the exact mail. Moves it from `planned` to `proposed` and records the date (a
 * `proposed` one can be put up again, with another date, after its approval was rejected; so can a `link_sent` one whose link never reached the client, see `linkNeverReachedClient`). One waiting approval per subscription: a second call returns the first. Approving it makes the
 * client's link and mails it (`approvals/subscriptionStart.ts`). `moved` says whether this call was the one that took it out of `planned`.
 */
async function propose(env: Env, id: string, firstChargeOn: string): Promise<{ approval: Approval; moved: boolean }> {
  const db = env.DB;
  if (!isDate(firstChargeOn)) throw new RangeError("The first charge must be a calendar date (YYYY-MM-DD).");
  const sub = await getSubscription(db, id);
  if (!sub) throw new Error("There is no such subscription.");
  const stranded = await linkNeverReachedClient(db, sub);
  if (sub.status !== "planned" && sub.status !== "proposed" && !stranded) throw new Error(`This subscription is ${sub.status}, not planned or proposed: it is already with the client or finished.`);
  const first = (await waiting(db, id))[0];
  if (first) return { approval: first, moved: false };

  const { title, preview } = await previewOf(env, sub, firstChargeOn);
  const a = await createApproval(db, {
    kind: START_KIND, title, preview, payload: { subscriptionId: id }, record_type: "business", record_id: sub.businessId, drafted_by: "logan",
  });
  // Two callers at once (the project's done hook and the daily sweep): the earliest approval stands, the other is dropped.
  const winner = (await waiting(db, id))[0];
  if (winner && winner.id !== a.id) {
    await db.prepare(`DELETE FROM approvals WHERE id = ? AND status = 'pending'`).bind(a.id).run();
    return { approval: winner, moved: false };
  }
  const moved = await markSubscription(db, id, { status: "proposed", firstChargeOn }, { from: ["planned"] });
  // A proposed one only takes the new date; a stranded link_sent one goes back to proposed (its stored token is kept: the approval reuses it, and a proposed row's link is not live).
  const again = moved || await markSubscription(db, id, { firstChargeOn }, { from: ["proposed"] }) || (stranded && await markSubscription(db, id, { status: "proposed", firstChargeOn }, { from: ["link_sent"] }));
  if (!again) {
    await db.prepare(`DELETE FROM approvals WHERE id = ? AND status = 'pending'`).bind(a.id).run();
    throw new Error("This subscription changed while it was being proposed. Look at it again.");
  }
  return { approval: a, moved };
}

export async function proposeSubscription(env: Env, id: string, firstChargeOn: string): Promise<Approval> {
  return (await propose(env, id, firstChargeOn)).approval;
}

/** Whether the first month of this subscription was paid with the deposit (the signed schedule says so). Throws when the schedule has no line for it: the date cannot be known. */
function prepaid(doc: Document, sub: Subscription): boolean {
  const line = doc.content.schedule.recurring.find((r) => r.key === sub.packageKey);
  if (!line) throw new Error(`The signed schedule has no line for ${sub.packageKey}.`);
  return line.firstMonthPrepaid;
}

/** The first charge for a subscription that starts on `startDate`: a first month already paid in the deposit is not charged again, so the first charge is a month later. */
const firstChargeFor = (doc: Document, sub: Subscription, startDate: string): string => (prepaid(doc, sub) ? addMonths(startDate, 1) : startDate);

/** The build project of a document, once it is done: the day the site launched is the day billing may start. A cancelled or test project does not count. */
const doneBuild = (db: D1Database, documentId: string) =>
  db.prepare(`SELECT id FROM projects WHERE document_id = ? AND kind = 'build' AND status = 'done' AND test = 0 ORDER BY completed_at, id LIMIT 1`).bind(documentId).first<{ id: string }>();

/**
 * Starts one planned subscription if what it waits for has happened, by proposing it: a signing-start one when its deposit is paid (the first charge is a month after the payment, in the
 * owner's calendar), a launch-start one when its document's build project is done (the first charge is the launch day, or a month later when its first month was in the deposit). A kickoff
 * one is never started here: only Logan's "Start billing" does. True when this call took it from `planned` to `proposed`.
 */
async function startOne(env: Env, sub: Subscription, now: Date): Promise<boolean> {
  if (sub.status !== "planned" || sub.test || sub.startsWhen === "kickoff") return false;
  const db = env.DB;
  const doc = await getDocument(db, sub.documentId);
  if (!doc || doc.test || doc.status !== "signed" || !doc.paidAt) return false;
  const tz = zoneOf(await getSettings(db));
  let startDate: string;
  if (sub.startsWhen === "signing") startDate = calendarDateIn(new Date(doc.paidAt), tz);
  else {
    const build = await doneBuild(db, doc.id);
    if (!build) return false;
    startDate = calendarDateIn(now, tz);
    await markSubscription(db, sub.id, { projectId: build.id }, { from: ["planned"] });
  }
  return (await propose(env, sub.id, firstChargeFor(doc, sub, startDate))).moved;
}

/** Notes a failure for one subscription without letting it stop the others. */
const failed = (what: string, e: unknown, key: string | undefined) => {
  const raw = e instanceof Error ? e.message : "unknown error";
  console.error(`subscriptions: ${what}`, oneLine(key ? raw.split(key).join("[key]") : raw).slice(0, 200));
};

/**
 * The daily step: every planned, real subscription whose trigger has happened is proposed (see `startOne`). Safe to run again, and alongside the project's done hook: of the two, one
 * proposal is made. Returns how many subscriptions this call proposed.
 */
export async function startDueSubscriptions(env: Env, now: Date): Promise<number> {
  let started = 0;
  for (const sub of await listSubscriptions(env.DB, { statuses: ["planned"] })) {
    try { if (await startOne(env, sub, now)) started++; }
    catch (e) { failed("could not start a subscription", e, env.STRIPE_SECRET_KEY); }
  }
  return started;
}

/**
 * Logan's "Start billing" for a Local SEO (kickoff) subscription: puts it up for approval with its first charge on today's date in his calendar, or a month later when its first month was
 * paid in the deposit. Returns the waiting approval. Refuses a planned subscription that does not start at kickoff, one whose deposit is not paid, and one that has gone past `proposed` (a `link_sent` one only when its link never reached the client). A signing or launch one that was proposed and rejected may be put up again here.
 */
export async function startKickoff(env: Env, id: string, now: Date): Promise<Approval> {
  const db = env.DB;
  const sub = await getSubscription(db, id);
  if (!sub) throw new Error("There is no such subscription.");
  // A signing or launch one is started by the sweep, never by hand while it is planned; but once it has been put up (proposed) or its link was lost (link_sent, see `proposeSubscription`), Logan may put it up again here.
  if (sub.startsWhen !== "kickoff" && sub.status === "planned") throw new Error(`Only a subscription that starts at kickoff is started by hand; this one starts at ${sub.startsWhen}.`);
  if (sub.status !== "planned" && sub.status !== "proposed" && sub.status !== "link_sent") throw new Error(`This subscription is ${sub.status}, not waiting to start.`);
  const doc = await getDocument(db, sub.documentId);
  if (!doc || doc.status !== "signed" || !doc.paidAt) throw new Error("The deposit for this client is not paid yet, so billing cannot start.");
  const today = calendarDateIn(now, zoneOf(await getSettings(db)));
  return proposeSubscription(env, id, firstChargeFor(doc, sub, today));
}

/**
 * Registered with `onProjectDone`: when a real build project finishes, the launch subscriptions of its document are proposed. The project is read again, so only one that is really done
 * counts. The daily sweep makes the same proposals if this never ran (one is made either way).
 */
export async function subscriptionDoneHook(env: Env, p: Project): Promise<void> {
  if (p.kind !== "build" || p.test || !p.documentId) return;
  const project = await getProject(env.DB, p.id);
  if (!project || project.status !== "done" || project.test || !project.documentId) return;
  const now = getMailDeps().now();
  for (const sub of await listSubscriptions(env.DB, { statuses: ["planned"] })) {
    if (sub.documentId !== project.documentId || sub.startsWhen !== "launch") continue;
    try { await startOne(env, sub, now); }
    catch (e) { failed("could not start a subscription when its build finished", e, env.STRIPE_SECRET_KEY); }
  }
}

onProjectDone(subscriptionDoneHook);
