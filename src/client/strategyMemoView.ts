import type { MemoRow } from "../worker/strategy/admin";
import { dayLabel } from "./careReportPageView";

/**
 * Pure helpers for the owner's Strategy memo section on a client's page (Plan 16). Plain values in, plain text and flags out: no DOM, no fetch, no clock. The section is about the client's newest memo; which
 * button shows depends only on its state: Draft when no memo is open (collecting or ready), Try again while Claude is writing, Revoke once there is something to take back.
 */

export type { MemoRow };

/** The day of an ISO time in the given time zone as `YYYY-MM-DD`, or null when the time or the zone cannot be read. */
export function dayInZone(iso: string | null, tz: string): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t); } catch { return null; }
}

export interface MemoSectionView {
  /** The newest memo (the highest version), or null when the client has none. */
  latest: MemoRow | null;
  /** What the newest memo is doing, in plain words, or null when there is none. */
  status: string | null;
  /** The "Draft strategy memo" button: no memo is open. */
  draft: boolean;
  /** The "Try again" button: Claude's words have not come back yet, so the owner cancels this one and starts another. */
  tryAgain: boolean;
  /** The "Revoke" button: the memo is waiting for approval or has been sent. */
  revoke: boolean;
  /** The client's link, only for a sent memo. */
  link: string | null;
  test: boolean;
}

const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;

function statusLine(m: MemoRow, tz: string): string {
  switch (m.status) {
    case "collecting": return "Claude is writing it";
    case "ready": return "Waiting for your approval — it is on the Home page";
    case "revoked": return "Revoked";
    case "cancelled": return "Cancelled";
    case "sent": {
      const day = dayLabel(dayInZone(m.sentAt, tz));
      return `${day ? `Sent ${day}` : "Sent"}, ${m.viewCount === 0 ? "not opened yet" : `opened ${times(m.viewCount)}`}`;
    }
  }
}

export function memoView(rows: MemoRow[], tz: string): MemoSectionView {
  const latest = rows.reduce<MemoRow | null>((a, r) => (a === null || r.version > a.version ? r : a), null);
  if (!latest) return { latest: null, status: null, draft: true, tryAgain: false, revoke: false, link: null, test: false };
  const open = rows.some((r) => r.status === "collecting" || r.status === "ready");
  return {
    latest,
    status: statusLine(latest, tz),
    draft: !open,
    tryAgain: latest.status === "collecting",
    revoke: latest.status === "ready" || latest.status === "sent",
    link: latest.status === "sent" ? latest.link : null,
    test: latest.test,
  };
}

/** The question the owner confirms before taking a memo back. */
export function revokeQuestion(m: Pick<MemoRow, "status">): string {
  return m.status === "sent"
    ? "Take this memo back? Its link will stop working, even for the client who has it."
    : "Take this memo back? Its approval is dropped and nothing is mailed.";
}
