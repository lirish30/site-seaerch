import type { BulkAction, BulkResult, LeadStatus } from "./types";

export const MAX_BULK = 200;
/** How long the Undo button stays on screen. The server keeps the snapshot for 10 minutes; the button is meant for "oops, just now". */
export const UNDO_VISIBLE_MS = 10_000;

export function toggleId(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (!next.delete(id)) next.add(id);
  return next;
}

export const allSelected = (sel: ReadonlySet<string>, ids: string[]) => ids.length > 0 && ids.every((id) => sel.has(id));
export const someSelected = (sel: ReadonlySet<string>, ids: string[]) => ids.some((id) => sel.has(id));

/** Header checkbox: selects every row on the page, or, when they all are already selected, deselects just those. Other pages are untouched. */
export function togglePage(sel: ReadonlySet<string>, pageIds: string[]): Set<string> {
  const next = new Set(sel);
  if (allSelected(sel, pageIds)) for (const id of pageIds) next.delete(id);
  else for (const id of pageIds) next.add(id);
  return next;
}

/** Keeps only ids still in view, so a filter change can never leave a hidden row selected. Returns the same set when nothing changed. */
export function pruneSelection(sel: ReadonlySet<string>, visibleIds: string[]): ReadonlySet<string> {
  const visible = new Set(visibleIds);
  const kept = [...sel].filter((id) => visible.has(id));
  return kept.length === sel.size ? sel : new Set(kept);
}

/** Mirrors the server's tag rules (lowercase, spaces collapsed, only a-z 0-9 space - _, at most 32 characters) so the bar can show and send the final tag. */
export function normalizeTag(raw: string): string | null {
  const t = raw.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 _-]/g, "").replace(/ {2,}/g, " ").trim();
  return t && t.length <= 32 ? t : null;
}

export interface BulkRequest { action: BulkAction; status?: LeadStatus; tag?: string }

const plural = (n: number) => `${n} lead${n === 1 ? "" : "s"}`;
/** The sentence shown after a bulk action. */
export function bulkSummary(req: BulkRequest, r: BulkResult): string {
  const skipped = r.skipped ? ` ${plural(r.skipped)} already matched or couldn't take it, so left alone.` : "";
  if (!r.updated) return `Nothing changed.${skipped}`;
  const verb = {
    status: `Set status to ${req.status} on`, archive: "Archived", restore: "Restored",
    tag: `Added tag "${req.tag}" to`, untag: `Removed tag "${req.tag}" from`,
  }[req.action];
  return `${verb} ${plural(r.updated)}.${skipped}`;
}
