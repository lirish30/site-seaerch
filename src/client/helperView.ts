/** GET /api/helper/status. `pending` is the open jobs (waiting or being worked) per kind. */
export interface HelperStatus { online: boolean; lastSeenAt: string | null; pending: Record<string, number> }

/** The Mac helper's state in one line, from GET /api/helper/status. `pending` is the open jobs per kind. */
export function helperLine(s: Pick<HelperStatus, "online" | "pending">): string {
  if (s.online) return "Your Mac helper is online.";
  const n = Object.values(s.pending).reduce((sum, c) => sum + c, 0);
  return n === 0 ? "Your Mac helper is offline." : `Your Mac helper is offline. ${n} job${n === 1 ? "" : "s"} waiting.`;
}
