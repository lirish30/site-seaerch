import type { CareRunView, CareUpdateView } from "../worker/care/views";
import { FALLBACK_ZONE } from "../worker/sop/cadence";
import { MAJOR_WAIT_DAYS } from "../worker/care/versions";

/** The words on the Care updates board and the run view: pure functions, so the pages only lay text out. Worker types are imported as types only. */

/** "9 Dec", the day in the given zone (the owner's booking zone); a zone Intl does not know falls back to Los Angeles. */
function dayIn(ms: number, zone: string): string {
  const fmt = (timeZone: string) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });
  try { return fmt(zone); } catch { return fmt(FALLBACK_ZONE); }
}

/**
 * One update's risk in words, never colour alone. Security reads "security", a held one "held", a major still inside its wait "major · waits until 9 Dec" (first seen + 7 days),
 * anything else its risk word; an update that needs Logan's tick says so on the end ("major · needs your OK"). A held update is not going anywhere, so it never says it needs a tick.
 */
export function riskLabel(u: CareUpdateView, now: Date, zone: string): string {
  if (u.held) return "held";
  let label: string = u.security ? "security" : u.risk;
  if (!u.security && u.risk === "major") {
    const dueAt = Date.parse(u.firstSeenAt) + MAJOR_WAIT_DAYS * 86_400_000;
    if (Number.isFinite(dueAt) && now.getTime() < dueAt) label = `major · waits until ${dayIn(dueAt, zone)}`;
  }
  return u.needsTick ? `${label} · needs your OK` : label;
}

const RUN: Record<CareRunView["status"], string> = {
  queued: "Waiting for the helper to start",
  running: "Updating now",
  ok: "Updated, and every page looks the same",
  changed: "Updated, but a page looks different: have a look",
  rolled_back: "Something broke, so the updates were put back",
  failed: "The run failed",
  dropped: "Skipped: nothing here needed updating any more",
};

/** One run in a sentence, with the server's own summary after it when there is one. */
export function runLabel(r: Pick<CareRunView, "status" | "summary">): string {
  const base = RUN[r.status] ?? "Unknown";
  return r.summary ? `${base}. ${r.summary}` : base;
}

/** The server's plain reason a site can't take updates ("no SSH access") as a sentence; empty when it can. */
export function whyLabel(why: string | null): string {
  return why ? `Can't update this site: ${why}.` : "";
}

/** The batch's stage in words. */
export function batchLabel(status: "inventory" | "wave1" | "wave2" | "done" | "cancelled"): string {
  return status === "inventory" ? "Reading what each site needs" : status === "wave1" ? "First wave of sites" : status === "wave2" ? "Second wave of sites" : status === "done" ? "Done" : "Cancelled";
}

/** What the page looked like after the update, in words (the before and after pictures decide it). */
export function verdictLabel(v: "ok" | "changed" | "broken"): string {
  return v === "ok" ? "Looks the same" : v === "changed" ? "Looks different" : "Looks broken";
}

/** Where the look at a changed page stands. */
export function reviewLabel(r: "none" | "pending" | "fine" | "broken" | "unsure" | "logan_ok"): string {
  switch (r) {
    case "none": return "No look needed";
    case "pending": return "Waiting for Claude's look";
    case "fine": return "Claude says it's fine";
    case "broken": return "Claude says it's broken";
    case "unsure": return "Claude isn't sure";
    case "logan_ok": return "You said it's fine";
  }
}

/** The "Looks fine" button shows while the page is waiting for a look, or Claude was unsure or said broken (Logan's look overrides). */
export const canMarkFine = (r: "none" | "pending" | "fine" | "broken" | "unsure" | "logan_ok"): boolean => r === "pending" || r === "unsure" || r === "broken";

const num = (n: number | null): string => (n === null ? "?" : String(n));

/** "Status 200 → 200 · forms 2 → 2 · 98% alike", leaving out what was not measured. */
export function pageFacts(p: { statusBefore: number | null; statusAfter: number | null; formsBefore: number | null; formsAfter: number | null; ssim: number | null }): string {
  const parts = [`Status ${num(p.statusBefore)} → ${num(p.statusAfter)}`, `forms ${num(p.formsBefore)} → ${num(p.formsAfter)}`];
  if (p.ssim !== null) parts.push(`${Math.round(p.ssim * 100)}% alike`);
  return parts.join(" · ");
}
