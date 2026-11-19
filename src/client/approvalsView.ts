export type SpendLevel = "ok" | "warn" | "capped";

/** One pending approval as GET /api/approvals returns it. */
export interface ApprovalItem {
  id: string; kind: string; label: string; title: string; preview: string; payload: unknown;
  record_type: string | null; record_id: string | null; drafted_by: "job" | "mcp" | "logan";
  status: "pending" | "approved" | "rejected"; error: string | null; decision_note: string | null;
  created_at: string; decided_at: string | null;
}

export interface ApprovalGroup { kind: string; label: string; items: ApprovalItem[] }

/** Groups by kind. Items run oldest first inside a group, and the group holding the oldest item comes first. */
export function groupApprovals(items: ApprovalItem[]): ApprovalGroup[] {
  const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const groups = new Map<string, ApprovalGroup>();
  for (const it of sorted) {
    const g = groups.get(it.kind);
    if (g) g.items.push(it); else groups.set(it.kind, { kind: it.kind, label: it.label, items: [it] });
  }
  return [...groups.values()];
}

/** Where to open the thing an approval is about, when the inbox can show a way in: a publish approval opens the lead's video editor. */
export function approvalLink(a: Pick<ApprovalItem, "kind" | "record_type" | "record_id">): { to: string; label: string } | null {
  if (a.kind === "video.publish" && a.record_type === "lead" && a.record_id) return { to: `/leads/${encodeURIComponent(a.record_id)}/video`, label: "Watch and edit the video" };
  return null;
}

export const approvalsLine = (n: number): string =>
  n === 0 ? "Nothing waiting for you." : n === 1 ? "1 thing waiting for your OK." : `${n} things waiting for your OK.`;

export function spendLine(s: { spentUsd: number; limitUsd: number; level: SpendLevel }): string {
  const base = `$${Math.round(s.spentUsd)} of $${Math.round(s.limitUsd)}`;
  if (s.level === "warn") return `${base} — over 80%, optional jobs pause at the cap`;
  if (s.level === "capped") return `${base} — cap reached, optional jobs paused`;
  return `${base} this month`;
}

export const draftedByLabel = (d: ApprovalItem["drafted_by"]): string =>
  d === "mcp" ? "Drafted by Claude" : d === "logan" ? "Drafted by you" : "Drafted by a job";

/** The edit box holds JSON; this turns it back into the payload to send, or says why it can't. */
export function parsePayloadText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, error: "That isn't valid JSON yet." }; }
}

export const whenLabel = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/** How many approvals the Home card sends per approve-batch request. Mirrors MAX_BATCH in src/worker/routes/approvals.ts (a test keeps the two in step). */
export const APPROVE_BATCH = 20;
