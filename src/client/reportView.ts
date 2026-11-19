export type Severity = "high" | "medium" | "low";
export interface ReportFinding { severity: Severity; evidence: string; }
export interface ReportData {
  businessName: string; website?: string; auditedAt: string; counts: Record<Severity, number>; findings: ReportFinding[]; partial: boolean;
  sender: { name: string; businessName: string; email: string; logoUrl: string }; expiresAt: string;
  /** The published video, or null; absent from an older server's answer. */
  video?: { durationMs: number; aiVoiceNote: boolean } | null;
  bookingUrl?: string;
}

export const SEVERITY_LABELS: Record<Severity, string> = { high: "Worth fixing first", medium: "Worth a look", low: "Smaller things" };

/** Findings grouped high -> low (empty groups dropped), keeping the given order inside each group. */
export function groupFindings(findings: ReportFinding[]): { severity: Severity; label: string; items: string[] }[] {
  return (["high", "medium", "low"] as const)
    .map((severity) => ({ severity, label: SEVERITY_LABELS[severity], items: findings.filter((f) => f.severity === severity).map((f) => f.evidence) }))
    .filter((g) => g.items.length > 0);
}

export function summaryText(counts: Record<Severity, number>): string {
  const n = counts.high + counts.medium + counts.low;
  return n === 0 ? "" : `${n} ${n === 1 ? "thing" : "things"} worth a look`;
}

// Defence in depth: the server already blanks non-https logos, but the client never trusts that.
export const isHttpsLogo = (url: string) => url.startsWith("https://");

export const isReportToken = (t: string | undefined) => !!t && /^[A-Za-z0-9_-]{43}$/.test(t);

/** What the owner's share control shows: any active link (current or older) can be revoked. */
export function shareState(report: { token: string } | null, otherActive: number) {
  const plural = otherActive === 1 ? "link" : "links";
  return {
    canRevoke: !!report || otherActive > 0,
    revokeLabel: otherActive > 0 ? "Revoke all" : "Revoke link",
    olderText: otherActive > 0 ? `${otherActive} older ${plural} still active` : null,
  };
}

type Sender = ReportData["sender"];

/** Two-letter avatar initials: sender name, else their business, else the email's local part; "?" when there is nothing. */
export function senderInitials(s: Sender): string {
  const src = s.name.trim() || s.businessName.trim() || s.email.split("@")[0].replace(/[^A-Za-z0-9]+/g, " ").trim();
  const words = src.split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

/** Label of the contact button: "Email Logan", or "Email us" when the sender gave no name. */
export const emailLabel = (s: Sender) => `Email ${s.name.trim().split(/\s+/)[0] || "us"}`;

/** "Irish Web Studio · logan@x.com": whichever parts exist. */
export const senderLine = (s: Sender) => [s.businessName.trim(), s.email.trim()].filter(Boolean).join(" · ");

export const hasSender = (s: Sender) => !!(s.name.trim() || s.businessName.trim() || s.email.trim());

/** Name shown next to the logo in the top bar: the sender's business, else their own name. */
export const senderTitle = (s: Sender) => s.businessName.trim() || s.name.trim();

const day = (iso: string, o: Intl.DateTimeFormatOptions) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", o);
};

/** "October 13, 2026". */
export const longDate = (iso: string) => day(iso, { year: "numeric", month: "long", day: "numeric" });

/** "Private link · expires Nov 14" (year added once it is not the current one). */
export function expiryText(expiresAt: string, now = new Date()): string {
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return "Private link";
  const sameYear = d.getFullYear() === now.getFullYear();
  return `Private link · expires ${day(expiresAt, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })}`;
}

/** "Based on an automated check of acme.com on October 13, 2026." (site omitted when unknown). */
export function basedOnText(r: Pick<ReportData, "website" | "auditedAt">): string {
  const date = longDate(r.auditedAt);
  return `Based on an automated check${r.website ? ` of ${r.website}` : ""}${date ? ` on ${date}` : ""}.`;
}

/** The one line under the player saying the voice is AI, or "" when it is not (or the server said nothing about it). */
export const videoNote = (v: { aiVoiceNote: boolean }): string => (v.aiVoiceNote ? "Narrated with an AI version of my voice." : "");

/** The booking button's words, or "" (no button) unless the link is https. The server already drops other links; the client does not trust that. */
export const bookingLabel = (url: string): string => (url.startsWith("https://") ? "Book a 20-minute call" : "");

/** Where a report's video files are served from. `token` is a report token (see `isReportToken`). */
export const mediaUrl = (token: string, name: "video.mp4" | "poster.jpg" | "preview.gif"): string => `/api/public/report/${token}/media/${name}`;
