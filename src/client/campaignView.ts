import type { OffsetKind, StepKind } from "./types";

const KIND_LABEL: Record<StepKind, string> = { email: "Email", call: "Call", checkin: "Check-in" };

/** "Email · business day 5", "Call · day 7": what a step is and when it is due. */
export function stepLabel(s: { kind: StepKind; offset_days: number; offset_kind: OffsetKind }): string {
  return `${KIND_LABEL[s.kind]} · ${s.offset_kind === "business" ? "business day" : "day"} ${s.offset_days}`;
}

/** Towns typed one per line or comma separated. Blanks go, and a repeat (any capitalisation) keeps its first spelling, as the server does. */
export function parseTowns(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\n,]/).map((t) => t.trim()).filter((t) => {
    const k = t.toLowerCase();
    return !k || seen.has(k) ? false : (seen.add(k), true);
  });
}

/** The job value field: blank is "no value", otherwise a non-negative number ($ and commas allowed). */
export function parseJobValue(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false };
  return { ok: true, value: Number(t) };
}

/** The server's 400 `fields` ({ name: ["Too small"] }) as one message per field. */
export function fieldErrors(fields: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return out;
  for (const [k, v] of Object.entries(fields)) if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  return out;
}

/** POST /api/campaigns/:id/run-searches as lines for the live region: the count, then each blocked town with its reason. */
export function runSearchesLines(r: { started: number; blocked: { town: string; reason: string }[] }): string[] {
  return [`Started ${r.started} ${r.started === 1 ? "search" : "searches"}.`, ...r.blocked.map((b) => `${b.town}: blocked. ${b.reason}`)];
}

/** The question asked before Run searches: every town starts a paid search, and a second run starts them all again. */
export const runSearchesConfirm = (townCount: number): string =>
  `This will start ${townCount} search${townCount === 1 ? "" : "es"} (one per town) and uses your lead-data budget. Continue?`;

/** How a run's result reads: "ok" when every town started, "warn" when some were blocked, "bad" when none started. */
export function runResultTone(r: { started: number; blocked: unknown[] }): "ok" | "warn" | "bad" {
  return r.blocked.length === 0 ? "ok" : r.started > 0 ? "warn" : "bad";
}
