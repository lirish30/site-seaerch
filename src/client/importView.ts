import { ApiError } from "./api";
import type { ImportCandidate, ImportCommitResult, ImportKind, ImportPreviewRow } from "./types";

/**
 * A row's chosen action, as the value of its select: "create", "skip", "link:<businessId>", or "" for an
 * ambiguous row the user has not decided yet (sent as skip, and flagged before the import button).
 */
export type Choice = string;

export const KIND_LABEL: Record<ImportKind, string> = {
  new: "New", exact: "Already a lead", ambiguous: "Needs a decision", duplicate_in_file: "Repeated in file", suppressed: "Suppressed", invalid: "Can't import",
};

/** Rows with nothing to decide: they are always skipped and show no select. */
export const isLocked = (k: ImportKind) => k === "duplicate_in_file" || k === "suppressed" || k === "invalid";

export function defaultChoice(r: ImportPreviewRow): Choice {
  if (r.kind === "new") return "create";
  if (r.kind === "exact" && r.candidates[0]) return `link:${r.candidates[0].id}`;
  return r.kind === "ambiguous" ? "" : "skip";
}

export const candidateLabel = (c: ImportCandidate) => `${c.name}${c.domain ? ` (${c.domain})` : ""}${c.archived_at ? ", archived" : ""}`;

export function choiceOptions(r: ImportPreviewRow): { value: Choice; label: string }[] {
  const link = r.candidates.map((c) => ({ value: `link:${c.id}`, label: `Link to ${candidateLabel(c)}` }));
  const skip = { value: "skip", label: "Skip" };
  if (r.kind === "new") return [{ value: "create", label: "Create new lead" }, skip];
  if (r.kind === "exact") return [...link, skip];
  if (r.kind === "ambiguous") return [{ value: "", label: "Choose…" }, { value: "create", label: "Create new lead" }, ...link, skip];
  return [skip];
}

export interface CommitRowBody { row: ImportPreviewRow["row"]; action: "create" | "link" | "skip"; businessId?: string }

/** The /commit rows: locked and undecided rows go as skip, so the server only ever acts on a decision the user made. */
export function toCommitRows(rows: ImportPreviewRow[], choices: Readonly<Record<number, Choice>>): CommitRowBody[] {
  return rows.map((r) => {
    const c = isLocked(r.kind) ? "skip" : choices[r.index] ?? defaultChoice(r);
    if (c === "create") return { row: r.row, action: "create" as const };
    if (c.startsWith("link:")) return { row: r.row, action: "link" as const, businessId: c.slice(5) };
    return { row: r.row, action: "skip" as const };
  });
}

export function choiceCounts(rows: ImportPreviewRow[], choices: Readonly<Record<number, Choice>>) {
  const out = { create: 0, link: 0, skip: 0, undecided: 0 };
  for (const r of rows) {
    const c = isLocked(r.kind) ? "skip" : choices[r.index] ?? defaultChoice(r);
    if (c === "create") out.create++; else if (c.startsWith("link:")) out.link++; else if (c === "skip") out.skip++; else { out.skip++; out.undecided++; }
  }
  return out;
}

/** One address (no commas or spaces) is sent as `url`; anything else as CSV `text`. */
export function inputBody(raw: string, name: string, source: string) {
  const t = raw.trim();
  return /^[^\s,]+$/.test(t) ? { url: t, ...(name.trim() ? { name: name.trim() } : {}), source: source.trim() } : { text: raw, source: source.trim() };
}
export const isSingleAddress = (raw: string) => /^[^\s,]+$/.test(raw.trim());

export const MAX_FILE_BYTES = 1_048_576;

/** Inline text for a failed request: the API's own message, or a generic fallback. */
export const importErrorText = (x: unknown, fallback: string) => (x instanceof ApiError ? x.message : fallback);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The result lines shown after an import (zero counts are left out; at least one line is always returned). */
export function commitSummary(r: ImportCommitResult): string[] {
  const lines: string[] = [];
  if (r.created) lines.push(`Created ${plural(r.created, "lead")}.`);
  if (r.linked) lines.push(`Linked ${plural(r.linked, "row")} to existing leads (a note was added; nothing was overwritten).`);
  if (r.alreadyExisted) lines.push(`${plural(r.alreadyExisted, "row")} already existed by website, so each was linked to the existing lead instead of creating a duplicate.`);
  if (r.skipped) lines.push(`Skipped ${plural(r.skipped, "row")}.`);
  if (r.refused.length) lines.push(`Refused ${plural(r.refused.length, "suppressed row")}.`);
  if (r.created) lines.push(`${plural(r.auditsQueued, "quick scan")} queued of ${r.created}.`);
  return lines.length ? lines : ["Nothing was imported."];
}
