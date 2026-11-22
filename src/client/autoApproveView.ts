import type { AutoApproveState, OutcomeView, RuleView } from "../worker/routes/autoApprove";

/** The words on Settings > Auto-approve: pure functions, so the page only lays text out. Types come from the worker; nothing here decides what may go unclicked (the worker does). */
export type { AutoApproveState, OutcomeView, RuleView };

/** "3 of 20 sent without a click today". The count is of attempts, so a failed send counts. */
export const todayLine = (today: number, cap: number): string => `${today} of ${cap} done without a click today`;

/** The sentence under a switch: when it was turned on, or that it is off. */
export function switchLine(r: Pick<RuleView, "enabled" | "enabledAt">, timeZone?: string): string {
  if (!r.enabled) return "Off. Nothing of this kind goes without your click.";
  const when = r.enabledAt ? whenLine(r.enabledAt, timeZone) : "";
  return when ? `On since ${when}. Only reminders drafted after that go on their own.` : "On. Only reminders drafted after it was switched on go on their own.";
}

/** "22 Nov, 10:15 AM", in the zone given (the browser's when none). A time that does not read gives an empty string. */
export function whenLine(iso: string, timeZone?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

/** A recent row's status chip: a sent one is green; one that failed was left waiting for you. */
export const outcomeChip = (o: Pick<OutcomeView, "outcome">): { tone: "positive" | "critical"; text: string } =>
  o.outcome === "sent" ? { tone: "positive", text: "Sent" } : { tone: "critical", text: "Not sent: waiting for you" };

/** The client a row is about, or a plain fallback for a client that has since been removed. */
export const outcomeWho = (o: Pick<OutcomeView, "businessName">): string => o.businessName?.trim() || "A client";
