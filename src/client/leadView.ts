import type { LeadStatus } from "./types";

export const STAGE_LABEL: Record<LeadStatus, string> = { new: "New", reviewed: "Reviewed", contacted: "Contacted", replied: "Replied", won: "Won", lost: "Lost", skip: "Skipped" };

/** Stage badge tones: a quiet outline for New, blue once contacted, Signal when they replied, green for won, grey for the rest. */
export const STAGE_TONE: Record<LeadStatus, "outline" | "neutral" | "info" | "signal" | "positive"> = {
  new: "outline", reviewed: "neutral", contacted: "info", replied: "signal", won: "positive", lost: "neutral", skip: "neutral",
};

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** How a follow-up date reads: red when overdue, amber on the day, plain after. `followUp` is the stored YYYY-MM-DD. */
export function followUpTone(followUp: string | null, now = new Date()): "none" | "overdue" | "today" | "later" {
  if (!followUp) return "none";
  const today = ymd(now);
  return followUp < today ? "overdue" : followUp === today ? "today" : "later";
}

/** "Oct 12 · 3 days late" / "Oct 12 · today" / "Oct 12 · in 4 days". */
export function followUpLabel(followUp: string, now = new Date()): string {
  const day = new Date(`${followUp}T00:00`);
  const date = day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day.getTime() - start.getTime()) / 86_400_000);
  if (diff === 0) return `${date} · today`;
  return diff < 0 ? `${date} · ${-diff} ${diff === -1 ? "day" : "days"} late` : `${date} · in ${diff} ${diff === 1 ? "day" : "days"}`;
}
