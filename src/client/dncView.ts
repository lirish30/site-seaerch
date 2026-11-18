import type { DncKind, DncReason } from "./types";

export const DNC_REASON_LABEL: Record<DncReason, string> = {
  client: "Client", opt_out: "Opted out", competitor: "Competitor", active_deal: "Active deal", bounced: "Bounced", webfor: "Webfor", other: "Other",
};
export const DNC_REASONS = Object.keys(DNC_REASON_LABEL) as DncReason[];
export const dncReasonLabel = (r: string) => DNC_REASON_LABEL[r as DncReason] ?? r;

export const DNC_KINDS: DncKind[] = ["domain", "email", "name"];
export const DNC_KIND_LABEL: Record<DncKind, string> = { email: "Email", domain: "Domain", name: "Company name" };

/** Placeholder text for the value field of each kind. */
export const dncValueHint = (kind: DncKind): string => ({ email: "name@company.com", domain: "company.com", name: "Company name" })[kind];
