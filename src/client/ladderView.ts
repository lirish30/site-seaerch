import type { LadderRow, LadderStatus, LadderStep } from "../worker/db/ladder";
import { shortDate } from "./billingView";

/** The words on a client's post-launch ladder: pure functions, so the panel only lays text out. No sentence here looks forward to a result. */
export type { LadderRow, LadderStatus, LadderStep };

export const LADDER_LINK_MAX = 300;

export const STEP_LABEL: Record<LadderStep, string> = {
  review_request: "Review request", testimonial: "Testimonial request", thank_you: "Thank-you package", check_in: "Check-in", case_study: "Case study post", december_letter: "December letter",
};

const STATUS_LABEL: Record<LadderStatus, string> = { waiting: "Waiting", drafted: "Waiting for your OK", due: "Due now", done: "Done", skipped: "Skipped" };
export const statusWord = (s: LadderStatus): string => STATUS_LABEL[s];

/** The badge tone for a status: due is amber, a draft waiting is blue, done is green, the rest quiet. */
export const statusTone = (s: LadderStatus): "warning" | "info" | "positive" | "neutral" => (s === "due" ? "warning" : s === "drafted" ? "info" : s === "done" ? "positive" : "neutral");

/** True while the owner can still close the step by hand. */
export const isOpen = (r: Pick<LadderRow, "status">): boolean => r.status === "waiting" || r.status === "due" || r.status === "drafted";

/** The date line of a step: "22 Dec 2026", plus "(late)" for an open step that is past its day. */
export function dueLine(r: Pick<LadderRow, "dueOn" | "status">, today: string): string {
  const d = shortDate(r.dueOn, true);
  return isOpen(r) && r.status !== "drafted" && r.dueOn < today ? `${d} (past due)` : d;
}

/** Whether the owner can type a link on this step: a review request that has not had a mail drafted yet. */
export const takesLink = (r: Pick<LadderRow, "step" | "status" | "approvalId">): boolean => r.step === "review_request" && (r.status === "waiting" || r.status === "due") && !r.approvalId;

/** True for a mail step whose draft was held, turned down or already approved: it is the owner's to send by hand and mark done. */
export const sendByHand = (r: Pick<LadderRow, "step" | "status" | "approvalId">): boolean => r.status === "due" && !!r.approvalId && !["thank_you", "case_study"].includes(r.step);

/** What is wrong with a typed review link, in plain words, or null when it is empty (clears it) or fine. */
export function linkProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > LADDER_LINK_MAX) return `The link is at most ${LADDER_LINK_MAX} characters.`;
  if (!/^https:\/\/[^\s]+$/.test(v)) return "The link must be an https address.";
  return null;
}

/** Steps shown newest-needed first: the open ones soonest first, then the finished ones, latest first. */
export function ordered(rows: readonly LadderRow[]): LadderRow[] {
  const open = rows.filter(isOpen).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const closed = rows.filter((r) => !isOpen(r)).sort((a, b) => b.dueOn.localeCompare(a.dueOn));
  return [...open, ...closed];
}
