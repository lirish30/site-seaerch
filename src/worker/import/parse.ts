import type { ImportRow } from "./match";

export const MAX_IMPORT_ROWS = 500; // each created lead costs ~7 subrequests (D1 + workflow), and a Worker invocation has a ceiling
export const MAX_IMPORT_BYTES = 1_048_576;

/** Input too large to import in one go. The message is safe to show. */
export class ImportLimitError extends Error {}
/** The text is not a usable CSV (no header, no name column). The message is safe to show. */
export class CsvFormatError extends Error {}

/** One data row of the file. `line` is the 1-based line it starts on; `error` is set when the row cannot be imported (its `row` is still returned). */
export interface ParsedRow { line: number; row: ImportRow; error?: string }

const ALIASES: Record<"name" | "url" | "address" | "phone" | "category", string[]> = {
  name: ["name", "business", "businessname", "company", "companyname"],
  url: ["website", "url", "site", "websiteurl", "web"],
  address: ["address"],
  phone: ["phone", "telephone", "phonenumber"],
  category: ["category"],
};
const keyOf = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

/** RFC-4180-ish records: quoted fields may hold commas, doubled quotes and newlines; CR, LF and CRLF all end a record. Returns [startLine, cells][] with blank records dropped. */
function records(text: string): [number, string[]][] {
  const out: [number, string[]][] = [];
  let cells: string[] = [], cell = "", quoted = false, line = 1, start = 1, i = 0;
  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim())) out.push([start, cells]);
    cells = []; cell = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else { if (ch === "\n") line++; cell += ch; }
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { cells.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord(); line++; start = line;
    } else cell += ch;
    i++;
  }
  if (cell || cells.length) endRecord();
  return out;
}

/** Parses a pasted or uploaded CSV with a header row (`name` required; `website|url|site`, `address`, `phone`, `category` optional). A row with no name comes back with `error` set instead of throwing. */
export function parseCsv(text: string, source = ""): ParsedRow[] {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new ImportLimitError("That file is over 1 MB. Split it into smaller files.");
  const recs = records(text.replace(/^﻿/, ""));
  if (!recs.length) throw new CsvFormatError("The file is empty. It needs a header row such as: name,website");
  const header = recs[0][1].map(keyOf);
  const col = (k: keyof typeof ALIASES) => header.findIndex((h) => ALIASES[k].includes(h));
  const idx = { name: col("name"), url: col("url"), address: col("address"), phone: col("phone"), category: col("category") };
  if (idx.name < 0) throw new CsvFormatError("The first line must be a header row with a name column, for example: name,website,address,phone,category");
  const data = recs.slice(1);
  if (data.length > MAX_IMPORT_ROWS) throw new ImportLimitError(`That file has ${data.length} rows. Import at most ${MAX_IMPORT_ROWS} at a time.`);
  const cell = (cells: string[], i: number) => (i >= 0 ? cells[i]?.trim() || null : null);
  return data.map(([line, cells]) => {
    const name = cell(cells, idx.name);
    const row: ImportRow = { name: name ?? "", url: cell(cells, idx.url), address: cell(cells, idx.address), phone: cell(cells, idx.phone), category: cell(cells, idx.category), source };
    return name ? { line, row } : { line, row, error: "This row has no name." };
  });
}
