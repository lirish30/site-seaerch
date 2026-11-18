import type { NicheRow, NicheVerdict } from "../worker/niche";

export type { NicheRow, NicheVerdict };

/** The verdict as one sentence. It only names the trade that leads; it never tells Logan to pick one. */
export function verdictLine(v: NicheVerdict, rows: NicheRow[]): string {
  if (!v.ready) return `${v.audited} of ${v.needed} audits. Keep searching before you pick a trade.`;
  const leader = rows.find((r) => r.campaignId === v.leaderId);
  return leader ? `${leader.name} leads on opportunity. Commit to it, or keep testing.` : "Enter a job value for each trade to compare them.";
}

/** The row to mark as leading: only once there are enough audits to say so. */
export const leaderRowId = (v: NicheVerdict): string | null => (v.ready ? v.leaderId : null);

/** Averages shown as whole numbers; a dash when there is nothing to average. */
export const statText = (n: number | null): string => (n === null ? "—" : String(Math.round(n)));

export const usdText = (n: number | null): string => (n === null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);

/** The job value box's starting text. */
export const jobValueText = (n: number | null): string => (n === null ? "" : String(n));
