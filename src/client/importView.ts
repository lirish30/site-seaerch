import { ApiError } from "./api";
import type { ImportCandidate, ImportCommitResult, ImportKind, ImportPreviewRow } from "./types";

/**
 * A row's chosen action, as the value of its select: "create", "skip", "link:<businessId>", or "" for an
 * ambiguous row the user has not decided yet (sent as skip, and flagged before the import button).
 */
export type Choice = string;

export const KIND_LABEL: Record<ImportKind, string> = {
  new: "New", exact: "Already a lead", ambiguous: "Needs a decision", duplicate_in_file: "Repeated in file", suppressed: "Suppressed", invalid: "Can’t import",
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
  // One obvious match: the select reads "Link to existing" (the name is already in the row's "What we found" cell).
  if (r.kind === "exact") return r.candidates.length === 1 ? [{ value: link[0].value, label: "Link to existing" }, skip] : [...link, skip];
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

/** The badge tone (a `.badge2` modifier) for each kind of row; "" is the neutral grey. */
export const KIND_TONE: Record<ImportKind, "positive" | "info" | "warning" | "critical" | ""> = {
  new: "positive", exact: "info", ambiguous: "warning", duplicate_in_file: "", suppressed: "critical", invalid: "critical",
};

/** The pieces of a row's "What we found" cell: plain text, or a name that links to an existing lead (`id`). */
export interface FoundPart { text: string; id?: string }
const names = (cs: ImportCandidate[]) => (cs.length > 3 ? [...cs.slice(0, 3), null] : cs);
const noDot = (s: string) => s.replace(/\.$/, "");

export function foundParts(r: ImportPreviewRow): FoundPart[] {
  const c = r.candidates;
  switch (r.kind) {
    case "new": return [{ text: r.nameDerived ? "Will be created as a new lead, named after its web address" : "Will be created as a new lead" }];
    case "exact": return c[0] ? [{ text: `Matches ${c[0].name}${c[0].archived_at ? " (archived)" : ""}`, id: c[0].id }] : [{ text: "Already in your leads" }];
    case "ambiguous": {
      const list = names(c), out: FoundPart[] = [{ text: "Could be " }];
      list.forEach((x, i) => {
        if (i > 0) out.push({ text: i === list.length - 1 && x !== null ? " or " : ", " });
        out.push(x ? { text: x.name, id: x.id } : { text: `${c.length - 3} more` });
      });
      return out;
    }
    case "duplicate_in_file": case "suppressed": case "invalid": return [{ text: noDot(r.reason ?? KIND_LABEL[r.kind]) }];
  }
}

export type Step = "add" | "review" | "done";
export const stepOf = (rows: ImportPreviewRow[] | null, result: ImportCommitResult | null): Step => (result ? "done" : rows ? "review" : "add");

/** Header names the server reads for each field (parse.ts ALIASES, after lowercasing and dropping punctuation). Keep in step with it. */
export const COLUMN_ALIASES = {
  name: ["name", "business", "businessname", "company", "companyname"], url: ["website", "url", "site", "websiteurl", "web"],
  address: ["address"], phone: ["phone", "telephone", "phonenumber"], category: ["category"],
} as const;
export type Column = keyof typeof COLUMN_ALIASES;
export const COLUMNS: Column[] = ["name", "url", "address", "phone", "category"];
export const COLUMN_LABEL: Record<Column, string> = { name: "Name", url: "Website", address: "Address", phone: "Phone", category: "Category" };

/** The first line of a CSV as cells (quotes honoured, like the server's reader). */
function headerCells(text: string): string[] {
  const line = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).find((l) => l.trim()) ?? "";
  const cells: string[] = []; let cell = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === "") q = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else cell += ch;
  }
  return [...cells, cell];
}

/** Which columns a pasted or uploaded CSV has, by header name; null when there is nothing to read or it is one web address. */
export function detectColumns(raw: string): { found: Column[]; missing: Column[]; hasName: boolean } | null {
  if (!raw.trim() || isSingleAddress(raw)) return null;
  const keys = headerCells(raw).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const found = COLUMNS.filter((c) => keys.some((k) => (COLUMN_ALIASES[c] as readonly string[]).includes(k)));
  return { found, missing: COLUMNS.filter((c) => !found.includes(c)), hasName: found.includes("name") };
}

/** "8 rows · source: Referral" under the file name on the review step. */
export const sourceLine = (rows: number, source: string) => `${rows} ${rows === 1 ? "row" : "rows"} · source: ${source.trim()}`;
/** What the review step's summary card calls the input: the file's name, a lone address, or "Pasted list". */
export const inputName = (fileName: string, raw: string) => fileName || (isSingleAddress(raw) ? raw.trim() : "Pasted list");
