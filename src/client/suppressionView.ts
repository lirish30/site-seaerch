import type { LeadSuppression, SuppressionReason } from "./types";

export const REASON_LABEL: Record<SuppressionReason, string> = {
  client: "Client", opt_out: "Opted out", competitor: "Competitor", active_deal: "Active deal", other: "Other",
};
export const REASONS = Object.keys(REASON_LABEL) as SuppressionReason[];
export const reasonLabel = (r: string) => REASON_LABEL[r as SuppressionReason] ?? r;

/** Sentence for the suppressed-lead banner. */
export function suppressedMessage(s: LeadSuppression): string {
  const why = {
    client: "an existing client", opt_out: "someone who opted out", competitor: "a competitor", active_deal: "an active deal", other: "on your suppression list",
  }[s.reason] ?? "on your suppression list";
  return `Suppressed: this business is marked as ${why}. Drafting and exports are turned off.${s.note ? ` Note: ${s.note}` : ""}`;
}
